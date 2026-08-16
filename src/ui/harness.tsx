/**
 * @file The harness entry: stand the search worker up, wait for its pack, then mount the page.
 *
 * A second bundle entry beside the shipped app, never part of it — `node tools/build.mjs --harness` bundles and
 * serves it together with the worker. The URL picks everything: `v` the version, `lang` the pack language, `lng`
 * the interface language.
 */
import type {ReactElement} from "react";
import {useEffect, useRef, useState} from "react";
import {createRoot} from "react-dom/client";
import {I18nextProvider, useTranslation} from "react-i18next";
import {i18n} from "../i18n";
import {App} from "./app";
import type {PackInfo} from "./searcher";
import {Searcher} from "./searcher";
import styles from "./app.module.css";

/** Where the site's files live relative to the served root. */
const BASE = "/site/";

/** What the loader has so far. */
type Loading =
    | { readonly is: "loading"; readonly pack: string; readonly done: number; readonly total: number }
    | { readonly is: "failed"; readonly error: string }
    | { readonly is: "ready"; readonly info: PackInfo };

/** The loading screen, then the page. */
function Harness(): ReactElement {
    const {t} = useTranslation();
    const [state, setState] = useState<Loading>({is: "loading", pack: "", done: 0, total: 1});
    const searcher = useRef<Searcher | null>(null);

    useEffect(() => {
        const params = new URLSearchParams(location.search);
        const held = new Searcher(new Worker("/dev/harness/worker.js"), {
            progress: (pack, done, total) => { setState({is: "loading", pack, done, total}); },
            ready: (info) => { setState({is: "ready", info}); },
            failed: (error) => { setState({is: "failed", error}); },
        });
        held.load(BASE, params.get("v"), params.get("lang"));
        searcher.current = held;
        return (): void => { held.dispose(); };
    }, []);

    if (state.is === "failed") {
        return <div className={`${styles.loading} ${styles.error}`}>{t("harness.failed", {error: state.error})}</div>;
    }
    if (state.is === "loading" || searcher.current === null) {
        return (
            <div className={styles.loading}>
                <div>{t("harness.loading", {pack: state.is === "loading" ? state.pack : ""})}</div>
                <div className={styles.loadingBar}>
                    <div
                        className={styles.loadingFill}
                        style={{width: `${String(Math.round(
                            (state.is === "loading" ? state.done / Math.max(1, state.total) : 0) * 100))}%`}}
                    />
                </div>
            </div>
        );
    }
    return <App info={state.info} searcher={searcher.current}/>;
}

const host = document.getElementById("app");
if (host === null) throw new Error("harness page has no #app element");
createRoot(host).render(
    <I18nextProvider i18n={i18n}>
        <Harness/>
    </I18nextProvider>,
);
