/**
 * @file The harness page: the bar with its tray, a live count standing in for the whole output side, and the two
 * language knobs split by geography — the pack's beside the version selector, the interface's in the footer.
 *
 * The URL carries the whole view: `q` the query, `v` the version, `lang` the pack language, `lng` the interface
 * language (the i18n detector's own key). Changing a knob rewrites the URL and reloads, because a pack switch is a
 * refetch and the engine's language tables resolve at import time.
 */
import type {ReactElement} from "react";
import {useEffect, useMemo, useRef, useState} from "react";
import {useTranslation} from "react-i18next";
import type {PackDomain, VersionEntry} from "../data";
import type {Parsed, Suggestion} from "../search/index";
import {formatQuery, parse, run, suggestions} from "../search/index";
import type {Dataset} from "../search/index";
import type {LoadedPack} from "../dataset";
import {useQueryState} from "./bar/state";
import {Bar} from "./bar/bar";
import {Tray, trayRows} from "./bar/tray";
import {recentQueries, rememberQuery} from "./history";
import styles from "./app.module.css";

/** Everything the harness loaded before mounting the page. */
export interface HarnessData {
    readonly dataset: Dataset;
    readonly loaded: LoadedPack;
    /** The languages the loaded pack ships. */
    readonly locales: readonly string[];
    readonly versions: readonly VersionEntry[];
}

/** The query the URL carries, or nothing. */
const urlQuery = (): string => new URLSearchParams(location.search).get("q") ?? "";

/** Rewrites one URL parameter and reloads — the knob transitions that need a refetch. */
function reloadWith(param: string, value: string): void {
    const url = new URL(location.href);
    url.searchParams.set(param, value);
    location.href = url.toString();
}

/** The interface languages a catalog is bundled for. */
const APP_LANGUAGES = ["en", "ru"];

/**
 * The page.
 */
export function App({data}: { readonly data: HarnessData }): ReactElement {
    const {t, i18n} = useTranslation();
    const state = useQueryState(urlQuery());
    const [linked, setLinked] = useState<number | null>(null);
    const [offers, setOffers] = useState<readonly Suggestion[] | null>(null);
    const [history, setHistory] = useState<readonly string[]>(recentQueries);
    const [result, setResult] = useState<{ count: number; ms: number; key: string } | null>(null);

    const parsed: Parsed = useMemo(
        () => parse(state.text, {mode: state.editing ? "typing" : "final"}),
        [state.text, state.editing]);

    // The count is the whole results placeholder: parse and run, debounced so typing stays responsive. The engine
    // is slower per keystroke than 1.0 was — a standing expectation, not a defect to fix here.
    const runSeq = useRef(0);
    useEffect(() => {
        const seq = runSeq.current += 1;
        const timer = setTimeout(() => {
            if (seq !== runSeq.current) return;
            const t0 = performance.now();
            const found = run(parsed, data.dataset);
            setResult({count: found.size, ms: Math.round(performance.now() - t0), key: state.text});
        }, 250);
        return (): void => { clearTimeout(timer); };
    }, [parsed, data.dataset, state.text]);

    // A committed query lands in the URL and the history — the URL is the source of truth for the view.
    useEffect(() => {
        if (state.editing) return;
        const url = new URL(location.href);
        if (state.text.trim() === "") url.searchParams.delete("q");
        else url.searchParams.set("q", state.text);
        window.history.replaceState(null, "", url);
        if (state.text.trim() !== "" && parsed.groups.length > 0) {
            rememberQuery(state.text);
            setHistory(recentQueries());
        }
    }, [state.editing, state.text, parsed]);

    // The simplify offers describe one query; edit it and they are stale.
    useEffect(() => { setOffers(null); }, [state.text]);

    const meta = (data.loaded.pack as unknown as {
        meta?: { domains?: Record<string, PackDomain> };
    }).meta;

    const editStart = state.pieces.before.length;
    const editEnd = editStart + state.pieces.edit.length;
    const editedClause = state.editing
        ? parsed.clauses.findIndex((clause) => clause.span.start < editEnd && clause.span.end > editStart)
        : -1;

    const stale = result === null || result.key !== state.text;
    return (
        <div className={styles.page}>
            <header className={styles.header}>
                <h1 className={styles.title}>{t("harness.title")}</h1>
                <span className={styles.subtitle}>{t("harness.subtitle")}</span>
                <span className={styles.knobs}>
                    <label className={styles.knob}>
                        {t("harness.version")}
                        <select
                            value={data.loaded.entry.id}
                            onChange={(e) => { reloadWith("v", e.target.value); }}
                        >
                            {data.versions.filter((v) => v.hidden !== true).map((v) => (
                                <option key={v.id} value={v.id}>{v.label} {v.id}</option>
                            ))}
                        </select>
                    </label>
                    <label
                        className={styles.knob}
                        title={data.locales.length < 2 ? t("harness.onlyLanguage") : undefined}
                    >
                        {t("harness.packLanguage")}
                        <select
                            value={data.loaded.locale}
                            disabled={data.locales.length < 2}
                            onChange={(e) => { reloadWith("lang", e.target.value); }}
                        >
                            {data.locales.map((locale) => (
                                <option key={locale} value={locale}>{locale}</option>
                            ))}
                        </select>
                    </label>
                </span>
            </header>

            <Bar
                state={state}
                parsed={parsed}
                domains={meta?.domains}
                history={history}
                linked={linked}
                onSimplify={() => { setOffers(suggestions(parsed)); }}
            />
            <Tray
                diagnostics={trayRows(parsed, state.text, editedClause >= 0 ? editedClause : null)}
                offers={offers}
                linked={linked}
                onLink={setLinked}
                onApply={state.replaceAll}
                onApplyOffer={(offer) => {
                    setOffers(null);
                    state.replaceAll(formatWritten(offer));
                }}
            />

            <div className={styles.count}>
                <span className={`${styles.countNumber} ${stale ? styles.countStale : ""}`}>
                    {result === null ? "…" : result.count.toLocaleString()}
                </span>
                <span>{stale ? t("count.searching") : t("count.result", {count: result.count})}</span>
                {result !== null && !stale && (
                    <span className={styles.countMs}>{t("count.elapsed", {ms: result.ms})}</span>
                )}
            </div>

            <footer className={styles.footer}>
                <label className={styles.knob}>
                    {t("harness.appLanguage")}
                    <select
                        value={i18n.resolvedLanguage ?? "en"}
                        onChange={(e) => { reloadWith("lng", e.target.value); }}
                    >
                        {APP_LANGUAGES.map((code) => <option key={code} value={code}>{code}</option>)}
                    </select>
                </label>
            </footer>
        </div>
    );
}

/** The written tier is what every surface handing a query back prints. */
const formatWritten = (offer: Suggestion): string => formatQuery(offer.parsed, "written");
