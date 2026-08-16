/**
 * @file The harness page: the bar with its tray, a live count standing in for the whole output side, and the two
 * language knobs split by geography — the pack's beside the version selector, the interface's in the footer.
 *
 * The URL carries the whole view: `q` the query, `v` the version, `lang` the pack language, `lng` the interface
 * language (the i18n detector's own key). Changing a knob rewrites the URL and reloads, because a pack switch is a
 * refetch and the engine's language tables resolve at import time. Counting happens in the search worker, so the
 * page never blocks on a keystroke; a stale count dims until its replacement lands.
 */
import type {ReactElement} from "react";
import {useEffect, useMemo, useRef, useState} from "react";
import {useTranslation} from "react-i18next";
import type {Parsed, Suggestion} from "../search/index";
import {formatQuery, parse, suggestions} from "../search/index";
import type {PackInfo, Searcher} from "./searcher";
import {useQueryState} from "./bar/state";
import {Bar} from "./bar/bar";
import {Tray, trayRows} from "./bar/tray";
import {recentQueries, rememberQuery} from "./history";
import styles from "./app.module.css";

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

/** The written tier is what every surface handing a query back prints. */
const formatWritten = (offer: Suggestion): string => formatQuery(offer.parsed, "written");

/**
 * The page.
 */
export function App({info, searcher}: {
    readonly info: PackInfo;
    readonly searcher: Searcher;
}): ReactElement {
    const {t, i18n} = useTranslation();
    const state = useQueryState(urlQuery());
    const [linked, setLinked] = useState<number | null>(null);
    const [offers, setOffers] = useState<readonly Suggestion[] | null>(null);
    const [history, setHistory] = useState<readonly string[]>(recentQueries);
    const [result, setResult] = useState<{ count: number; ms: number; seq: number } | null>(null);
    const asked = useRef(0);

    const parsed: Parsed = useMemo(
        () => parse(state.text, {mode: state.editing ? "typing" : "final"}),
        [state.text, state.editing]);

    // The count runs in the worker; the page only debounces the ask and drops answers that are no longer newest.
    useEffect(() => {
        searcher.counts((seq, count, ms) => {
            if (seq === asked.current) setResult({count, ms, seq});
        });
    }, [searcher]);
    useEffect(() => {
        const timer = setTimeout(() => {
            asked.current = searcher.query(state.text, state.editing ? "typing" : "final");
        }, 120);
        return (): void => { clearTimeout(timer); };
    }, [searcher, state.text, state.editing]);

    // A committed query lands in the URL and the history — on the commit transition, not on every keystroke.
    const wasEditing = useRef(false);
    useEffect(() => {
        const committed = wasEditing.current && !state.editing;
        wasEditing.current = state.editing;
        if (state.editing) return;
        const url = new URL(location.href);
        if (state.text.trim() === "") url.searchParams.delete("q");
        else url.searchParams.set("q", state.text);
        window.history.replaceState(null, "", url);
        if (committed && state.text.trim() !== "" && parsed.groups.length > 0) {
            rememberQuery(state.text);
            setHistory(recentQueries());
        }
    }, [state.editing, state.text, parsed]);

    // The simplify offers describe one query; edit it and they are stale.
    useEffect(() => { setOffers(null); }, [state.text]);

    const editStart = state.pieces.before.length;
    const editEnd = editStart + state.pieces.edit.length;
    const editedClause = state.editing
        ? parsed.clauses.findIndex((clause) => clause.span.start < editEnd && clause.span.end > editStart)
        : -1;

    const stale = result === null || result.seq !== asked.current;
    return (
        <div className={styles.page}>
            <header className={styles.header}>
                <h1 className={styles.title}>{t("harness.title")}</h1>
                <span className={styles.subtitle}>{t("harness.subtitle")}</span>
                <span className={styles.knobs}>
                    <label className={styles.knob}>
                        {t("harness.version")}
                        <select
                            value={info.version.id}
                            onChange={(e) => { reloadWith("v", e.target.value); }}
                        >
                            {info.versions.filter((v) => v.hidden !== true).map((v) => (
                                <option key={v.id} value={v.id}>{v.label}</option>
                            ))}
                        </select>
                    </label>
                    <label
                        className={styles.knob}
                        title={info.locales.length < 2 ? t("harness.onlyLanguage") : undefined}
                    >
                        {t("harness.packLanguage")}
                        <select
                            value={info.locale}
                            disabled={info.locales.length < 2}
                            onChange={(e) => { reloadWith("lang", e.target.value); }}
                        >
                            {info.locales.map((locale) => (
                                <option key={locale} value={locale}>{locale}</option>
                            ))}
                        </select>
                    </label>
                </span>
            </header>

            <Bar
                state={state}
                parsed={parsed}
                domains={info.domains}
                history={history}
                linked={linked}
                onSimplify={() => { setOffers(suggestions(parse(state.text, {mode: "final"}))); }}
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
                <span>{result === null || stale ? t("count.searching") : t("count.result", {count: result.count})}</span>
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
