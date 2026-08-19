/**
 * @file The harness entry: stand the search worker up, wait for its pack, then mount the page.
 *
 * A second bundle entry beside the shipped app, never part of it — `node tools/build.mjs --harness` bundles and
 * serves it together with the worker. The URL picks everything: `v` the version, `lang` the pack language, `lng`
 * the interface language.
 */
import type {ReactElement} from "react";
import {useEffect, useState} from "react";
import {createRoot} from "react-dom/client";
import {I18nextProvider, useTranslation} from "react-i18next";
import {setOrdinalLadder} from "../search/index";
import {i18n} from "../i18n";
import {App} from "./app";
import {BASE} from "./pack";
import type {PackInfo} from "./searcher";
import {Searcher} from "./searcher";
import styles from "./app.module.css";

/**
 * What the loader has so far.
 *
 * The searcher rides the ready state rather than a ref beside it: it is only ever reachable once its pack has
 * landed, which is the one state that carries it, and a ref written in the effect would leave the render that
 * reads it holding whatever was there before.
 */
type Loading =
    | { readonly is: "loading"; readonly pack: string; readonly done: number; readonly total: number }
    | { readonly is: "failed"; readonly error: string }
    | { readonly is: "ready"; readonly info: PackInfo; readonly searcher: Searcher };

/** The loading screen, then the page. */
function Harness(): ReactElement {
    const {t} = useTranslation();
    const [state, setState] = useState<Loading>({is: "loading", pack: "", done: 0, total: 1});

    useEffect(() => {
        const params = new URLSearchParams(location.search);
        const held = new Searcher(new Worker("/dev/harness/worker.js"), {
            progress: (pack, done, total): void => {
                setState({is: "loading", pack, done, total});
            },
            ready: (info): void => {
                // The ordinal type is read against a vocabulary the PACK carries, so the page has to be told
                // it too: without this an expansion cannot be completed here, and a rung the worker refuses
                // would be accepted by the page's own parse.
                setOrdinalLadder(info.ladder);
                setState({is: "ready", info, searcher: held});
            },
            failed: (error): void => {
                setState({is: "failed", error});
            },
        });
        held.load(BASE, params.get("v"), params.get("lang"));
        return (): void => {
            held.dispose();
        };
    }, []);

    if (state.is === "failed") {
        return <div className={`${styles.loading} ${styles.error}`}>{t("harness.failed", {error: state.error})}</div>;
    }
    if (state.is === "loading") {
        return (
            <div className={styles.loading}>
                <div>{t("harness.loading", {pack: state.pack})}</div>
                <div className={styles.loadingBar}>
                    <div
                        className={styles.loadingFill}
                        style={{
                            width: `${String(Math.round(state.done / Math.max(1, state.total) * 100))}%`
                        }}
                    />
                </div>
            </div>
        );
    }
    return <App info={state.info} searcher={state.searcher}/>;
}

const host = document.getElementById("app");
if (host === null) throw new Error("harness page has no #app element");
createRoot(host).render(
    <I18nextProvider i18n={i18n}>
        <Harness/>
    </I18nextProvider>,
);
