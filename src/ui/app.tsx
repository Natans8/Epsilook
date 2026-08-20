/**
 * @file Increment 1 of the input layer: the bar shell — one plain input at 1.0's metrics, a live worker-backed
 * count in a 1.0-style status line, and the URL carrying the query.
 *
 * Deliberately nothing else: no chips, no transformation, no completion, no controls. Each of those arrives as
 * its own increment, tested and judged, per the rebuild ruling.
 */
import type {ReactElement} from "react";
import {useEffect, useMemo, useRef, useState} from "react";
import {useTranslation} from "react-i18next";
import type {PackInfo, Searcher} from "./searcher";
import {expansionArt} from "./art";
import {formatQuery, parse, simplify} from "../search/index";
import type {Diagnostic} from "../search/index";
import {recentQueries} from "./history";
import {BASE} from "./pack";
import type {BarHandle} from "./bar/bar";
import {Bar} from "./bar/bar";
import {PlainBar} from "./bar/plain";
import {settledQuery} from "./bar/plan";
import styles from "./app.module.css";

/** The query the URL carries, or nothing. */
const urlQuery = (): string => new URLSearchParams(location.search).get("q") ?? "";

/** Whether the URL asks for the plaintext view — a view choice worth surviving a reload. A bare flag. */
const urlPlain = (): boolean => new URLSearchParams(location.search).has("plain");

/** Rewrites one URL parameter and reloads — the knob transitions that need a refetch. */
function reloadWith(param: string, value: string): void {
    const url = new URL(location.href);
    url.searchParams.set(param, value);
    location.href = url.toString();
}

/** The interface languages a catalog is bundled for. */
const APP_LANGUAGES = ["en", "ru"];

/**
 * The simplify button, to the bar's right, with its preview.
 *
 * Simplification is explicit-only, so the button is the one door — but a rewrite the reader cannot see before
 * taking it is a gamble, so hovering or focusing the button previews the simpler spelling (the WRITTEN tier,
 * as the law requires of every surface handing a simplified query back) and the press applies exactly what the
 * preview showed. A query already in its simplest form says so and the press does nothing.
 */
function Simplify({text, plain, apply}: {
    readonly text: string;
    /** Whether the plain view stands — there no commit converges anything, so any respell is an offer. */
    readonly plain: boolean;
    /** Applies the rewrite — through the bar's own undo machinery, so Ctrl+Z takes it back. */
    readonly apply: (next: string) => void;
}): ReactElement {
    const {t} = useTranslation();
    // The button ALWAYS stands, so the bar never resizes as typing moves it in and out of having something
    // to offer — only its enabled state and its preview change.
    const after = useMemo(() => {
        const none = {spelled: "", changed: false, notes: [] as readonly string[]};
        if (text.trim() === "") return none;
        const parsed = parse(text, {mode: "final"});
        // A broken query has nothing to respell — the bar is already saying what is wrong.
        if (parsed.diagnostics.some((d) => d.severity === "error")) return none;
        const result = simplify(parsed);
        const spelled = formatQuery(result.parsed, "written");
        // In chip mode the offer compares against the SETTLED query, so an open chip's editing braces — which
        // the commit converges on its own — never light the button, while a real difference lights it wherever
        // the caret is. The plain view converges nothing itself, so there the typed text is the baseline.
        const baseline = plain ? text.trim() : settledQuery(text).trim();
        return {spelled, changed: spelled !== baseline, notes: result.notes};
    }, [text, plain]);
    return (
        <span className={styles.simplify}>
            <button
                type="button"
                className={styles.simplifyButton}
                disabled={!after.changed}
                onClick={() => {
                    if (after.changed) apply(after.spelled);
                }}
            >
                {t("bar.simplify")}
            </button>
            <span className={styles.simplifyPreview} role="tooltip">
                {after.changed
                    ? t("tray.simplified", {query: after.spelled})
                    : t("tray.simplifyNone")}
                {after.notes.map((note) => <span key={note} className={styles.simplifyNote}>{note}</span>)}
            </span>
        </span>
    );
}

/**
 * The page.
 */
export function App({info, searcher}: {
    readonly info: PackInfo;
    readonly searcher: Searcher;
}): ReactElement {
    const {t, i18n} = useTranslation();
    const [text, setText] = useState(urlQuery);
    const [plain, setPlain] = useState(urlPlain);
    const [result, setResult] = useState<{ count: number; ms: number; for: string } | null>(null);
    // The bar's rewrite door, for the panel controls whose rewrites must be undoable inside the bar.
    const barRef = useRef<BarHandle>(null);
    const asked = useRef("");

    // The count runs in the worker; the page debounces the ask and shows the last answer dimmed until the
    // current one lands.
    useEffect(() => {
        searcher.counts((count, ms) => {
            setResult({count, ms, for: asked.current});
        });
    }, [searcher]);
    useEffect(() => {
        const timer = setTimeout(() => {
            asked.current = text;
            searcher.query(text, "final");
        }, 120);
        return (): void => {
            clearTimeout(timer);
        };
    }, [searcher, text]);

    // The URL is the view: the query lands in it once typing pauses.
    useEffect(() => {
        const timer = setTimeout(() => {
            const url = new URL(location.href);
            // The URL carries the SETTLED query, trimmed: an open chip's editing braces and a commit's
            // trailing separator are editing state, not query content. The plain view settles nothing, and
            // its URL keeps exactly what was typed — a reload must not respell the reader's text.
            const carried = plain ? text.trim() : settledQuery(text).trim();
            if (carried === "") url.searchParams.delete("q");
            else url.searchParams.set("q", carried);
            // A bare flag: the view has no value to carry, so the URL says `plain` and nothing more.
            url.searchParams.delete("plain");
            let search = url.searchParams.toString();
            if (plain) search = search === "" ? "plain" : `${search}&plain`;
            url.search = search;
            window.history.replaceState(null, "", url);
        }, 400);
        return (): void => {
            clearTimeout(timer);
        };
    }, [text, plain]);

    const stale = result === null || result.for !== text;
    // A query the parser REFUSES does not get to answer. An invalid clause is dropped from the evaluable
    // groups, so `xpac:zzz` constrained nothing and reported the whole pack — a wrong answer wearing the
    // authority of a number. The bar already squiggles the clause; the count says what is wrong instead of
    // counting. Only in final text: while typing, anything a further keystroke could rescue stays quiet.
    const finalParse = useMemo(() => parse(text, {mode: "final"}), [text]);
    const broken = finalParse.diagnostics.filter((d: Diagnostic) => d.severity === "error");
    // Under a limit the status line reports what is LISTED, not the query's full count — the user's call: the
    // honest number with an explainer read worse than the simple one.
    const shown = (count: number): number =>
        (finalParse.limit === null ? count : Math.min(Math.abs(finalParse.limit.value), count));

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
                            onChange={(e) => {
                                reloadWith("v", e.target.value);
                            }}
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
                            onChange={(e) => {
                                reloadWith("lang", e.target.value);
                            }}
                        >
                            {info.locales.map((locale) => (
                                <option key={locale} value={locale}>{locale}</option>
                            ))}
                        </select>
                    </label>
                </span>
            </header>

            <section className={styles.searchbox}>
                {/* data-query mirrors the state so a browser assertion can read the text without racing the
                  * debounced URL sync */}
                <div className={styles.barRow} data-query={text}>
                    {plain
                        ? <PlainBar text={text} onText={setText} placeholder={t("bar.placeholder")}
                                    label={t("bar.placeholder")} history={recentQueries()}
                                    vocab={{
                                        rungs: info.ladder, art: expansionArt(info.ladder, BASE),
                                        enums: info.enums
                                    }}/>
                        : <Bar text={text} onText={setText} placeholder={t("bar.placeholder")}
                               handle={barRef}
                               vocab={{
                                   rungs: info.ladder, art: expansionArt(info.ladder, BASE),
                                   enums: info.enums
                               }}/>}
                    <Simplify
                        text={text}
                        plain={plain}
                        apply={(next) => {
                            // Through the bar's undo stack where the bar stands; the plain view has only
                            // the text.
                            if (barRef.current !== null) barRef.current.rewrite(next);
                            else setText(next);
                        }}
                    />
                </div>
                <div className={styles.statusRow}>
                    <div
                        className={`${styles.status} ${stale ? styles.statusStale : ""}`}
                        role="status"
                    >
                        {broken.length > 0 ? broken[0].message
                            : result !== null && (
                            `${shown(result.count).toLocaleString()} `
                            + t("count.result", {count: shown(result.count)})
                            + `, ${t("count.elapsed", {ms: result.ms})}`
                        )}
                    </div>
                    {/* A view switch, not a command: it changes how the query is shown and never what it says.
                        Its home is this row rather than the bar, because nothing beside the bar should read as
                        part of the ask. */}
                    <button
                        type="button"
                        role="switch"
                        aria-checked={plain}
                        className={`${styles.viewToggle} ${plain ? styles.viewOn : ""}`}
                        title={t("bar.plaintextHint")}
                        onClick={() => {
                            setPlain((was) => !was);
                        }}
                    >
                        <span className={styles.switchTrack} aria-hidden="true">
                            <span className={styles.switchKnob}/>
                        </span>
                        {t("bar.plaintext")}
                    </button>
                </div>
            </section>

            <footer className={styles.footer}>
                <label className={styles.knob}>
                    {t("harness.appLanguage")}
                    <select
                        value={i18n.resolvedLanguage ?? "en"}
                        onChange={(e) => {
                            reloadWith("lng", e.target.value);
                        }}
                    >
                        {APP_LANGUAGES.map((code) => <option key={code} value={code}>{code}</option>)}
                    </select>
                </label>
            </footer>
        </div>
    );
}
