/**
 * @file The page: the query bar, the count it answers with, and the knobs around them.
 *
 * The bar comes in two forms and the reader picks which — chips, or the query as its own text — so the page
 * holds the query text and the view choice and hands both to whichever bar is standing. Everything else here
 * is chrome: the pack and language selects, the simplify button, and the URL, which carries the query so a
 * search can be shared or reloaded.
 */
import type {ReactElement} from "react";
import {useDeferredValue, useEffect, useId, useMemo, useRef, useState} from "react";
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
 * One line of status, held back until it stops changing — what a live region should announce.
 *
 * The count answers every keystroke, and a live region that followed it would queue an announcement per
 * keystroke and read a stream of half-typed answers over the reader's own typing. What is on SCREEN still
 * updates live; only the announcement waits for the query to settle.
 *
 * @param line The status line as it now reads.
 * @param after How long the line must stand unchanged before it is announced, in milliseconds.
 * @returns The line to announce.
 */
function useSettled(line: string, after = 700): string {
    const [held, setHeld] = useState(line);
    useEffect(() => {
        const timer = setTimeout(() => {
            setHeld(line);
        }, after);
        return (): void => {
            clearTimeout(timer);
        };
    }, [line, after]);
    return held;
}

/**
 * The query the page considers written, as against the one the bar is holding mid-edit.
 *
 * Two things ask this and they must not answer differently: what the URL carries, and what the simplify button
 * compares against. In the chip view an open chip's editing braces and a commit's trailing separator are
 * editing state rather than query content, so the settled spelling is the query. The plain view settles
 * nothing — a reader who asked to see their own text is shown exactly it — so there the query is what stands.
 *
 * @param text The bar's text, editing structure and all.
 * @param plain Whether the plaintext view is the one standing.
 * @returns The query, trimmed.
 */
function carriedQuery(text: string, plain: boolean): string {
    return (plain ? text : settledQuery(text)).trim();
}

/** What one query simplifies to: the written-tier respell, whether it differs, and the rules that fired. */
interface Simpler {
    readonly spelled: string;
    readonly changed: boolean;
    readonly notes: readonly string[];
}

/** Nothing to offer: an empty bar, or one whose query the parser refuses. */
const NO_SIMPLER: Simpler = {spelled: "", changed: false, notes: []};

/**
 * The simpler spelling of one query, if it has one.
 *
 * @param text The query text as it stands.
 * @param plain Whether the plaintext view is the one standing.
 * @returns The respell and whether it differs from what is written.
 */
function simplerOf(text: string, plain: boolean): Simpler {
    if (text.trim() === "") return NO_SIMPLER;
    const parsed = parse(text, {mode: "final"});
    // A broken query has nothing to respell — the bar is already saying what is wrong.
    if (parsed.diagnostics.some((d) => d.severity === "error")) return NO_SIMPLER;
    const result = simplify(parsed);
    const spelled = formatQuery(result.parsed, "written");
    // The offer compares against the query as WRITTEN, so an open chip's editing braces — which the commit
    // converges on its own — never light the button, while a real difference lights it wherever the caret is.
    return {spelled, changed: spelled !== carriedQuery(text, plain), notes: result.notes};
}

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
    const previewId = useId();
    // Deferred, because this is the most expensive read in the bar — a parse, a simplification, a format and a
    // whole-query settle — and nothing depends on the answer until the reader looks at the button. React keeps
    // the last answer on screen and recomputes when typing pauses, so a keystroke never waits on it.
    const settling = useDeferredValue(text);
    // The button ALWAYS stands, so the bar never resizes as typing moves it in and out of having something
    // to offer — only its enabled state and its preview change.
    const after = useMemo(() => simplerOf(settling, plain), [settling, plain]);
    return (
        <span className={styles.simplify}>
            <button
                type="button"
                className={styles.simplifyButton}
                disabled={!after.changed}
                // The preview says what the press would write, so it is the button's DESCRIPTION: without the
                // association it reaches a reader who can see the hover and nobody else.
                aria-describedby={previewId}
                onClick={() => {
                    // Read afresh from the text as it stands, never from the deferred value the preview was
                    // drawn against: a press is rare enough to pay for, and applying a respell of older text
                    // would drop whatever was typed after it.
                    const now = simplerOf(text, plain);
                    if (now.changed) apply(now.spelled);
                }}
            >
                {t("bar.simplify")}
            </button>
            <span id={previewId} className={styles.simplifyPreview} role="tooltip">
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

    // The pack's own vocabularies, built once. Read as a MEMO dependency by both bars, so a fresh object each
    // render would re-run the offers read on every answer the worker returns, whatever the reader had typed.
    const vocab = useMemo(
        () => ({rungs: info.ladder, art: expansionArt(info.ladder, BASE), enums: info.enums}),
        [info]);
    // Held in state rather than read per render: reading it touches storage and parses every stored query,
    // and it changes only when a search is remembered. The chip bar keeps its own for the same reason.
    const [history] = useState(recentQueries);

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
            const carried = carriedQuery(text, plain);
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
    // Under a limit the status line reports what is LISTED, not the query's full count: the honest number with
    // an explainer beside it reads worse than the plain one.
    const shown = (count: number): number =>
        (finalParse.limit === null ? count : Math.min(Math.abs(finalParse.limit.value), count));
    const line = broken.length > 0 ? broken[0].message
        : result === null ? ""
            : `${shown(result.count).toLocaleString()} `
            + t("count.result", {count: shown(result.count)})
            + `, ${t("count.elapsed", {ms: result.ms})}`;
    const announced = useSettled(line);

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
                                    label={t("bar.placeholder")} history={history} vocab={vocab}/>
                        : <Bar text={text} onText={setText} placeholder={t("bar.placeholder")}
                               handle={barRef} vocab={vocab}/>}
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
                    {/* The line updates with every answer; what is ANNOUNCED settles first — see `announced`. */}
                    <div
                        className={`${styles.status} ${stale ? styles.statusStale : ""}`}
                        aria-hidden="true"
                    >
                        {line}
                    </div>
                    <div className={styles.announce} role="status">{announced}</div>
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
