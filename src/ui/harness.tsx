/**
 * @file The harness entry: fetch the pack the URL names, then mount the page.
 *
 * A second bundle entry beside the shipped app, never part of it — `node tools/build.mjs --harness` bundles and
 * serves it. The URL picks everything: `v` the version, `lang` the pack language, `lng` the interface language.
 */
import type {ReactElement} from "react";
import {StrictMode, useEffect, useState} from "react";
import {createRoot} from "react-dom/client";
import {I18nextProvider, useTranslation} from "react-i18next";
import {i18n} from "../i18n";
import {packDataset} from "../dataset";
import type {HarnessData} from "./app";
import {App} from "./app";
import {fetchPack, fetchVersions, pickEntry} from "./pack";
import styles from "./app.module.css";

/** Where the site's files live relative to the served root. */
const BASE = "/site/";

/** What the loader has so far. */
type Loading =
    | { readonly is: "loading"; readonly pack: string; readonly done: number; readonly total: number }
    | { readonly is: "failed"; readonly error: string }
    | { readonly is: "ready"; readonly data: HarnessData };

/** Fetches everything the page needs, reporting module-level progress. */
async function load(onProgress: (pack: string, done: number, total: number) => void): Promise<HarnessData> {
    const params = new URLSearchParams(location.search);
    const versions = await fetchVersions(BASE);
    const entry = pickEntry(versions, params.get("v"));
    onProgress(entry.id, 0, 1);
    const {loaded, locales} = await fetchPack(
        BASE, entry, params.get("lang") ?? undefined,
        (done, total) => { onProgress(entry.id, done, total); });
    return {dataset: packDataset(loaded), loaded, locales, versions};
}

/** The loading screen, then the page. */
function Harness(): ReactElement {
    const {t} = useTranslation();
    const [state, setState] = useState<Loading>({is: "loading", pack: "", done: 0, total: 1});

    useEffect(() => {
        load((pack, done, total) => { setState({is: "loading", pack, done, total}); })
            .then((data) => { setState({is: "ready", data}); })
            .catch((error: unknown) => { setState({is: "failed", error: String(error)}); });
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
                        style={{width: `${String(Math.round((state.done / Math.max(1, state.total)) * 100))}%`}}
                    />
                </div>
                <div>{t("harness.modules", {done: state.done, total: state.total})}</div>
            </div>
        );
    }
    return <App data={state.data}/>;
}

const host = document.getElementById("app");
if (host === null) throw new Error("harness page has no #app element");
createRoot(host).render(
    <StrictMode>
        <I18nextProvider i18n={i18n}>
            <Harness/>
        </I18nextProvider>
    </StrictMode>,
);
