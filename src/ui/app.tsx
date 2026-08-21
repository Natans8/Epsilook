/**
 * @file The page: the query bar, the count it answers with, and the knobs around them.
 *
 * The bar comes in two forms and the reader picks which — chips, or the query as its own text — so the page
 * holds the query text and the view choice and hands both to whichever bar is standing. Everything else here
 * is chrome: the pack and language selects, the simplify button, and the URL, which carries the query so a
 * search can be shared or reloaded.
 */
import type {ReactElement} from "react";
import {useEffect, useMemo, useRef, useState} from "react";
import {useTranslation} from "react-i18next";
import type {PackInfo, Searcher} from "./searcher";
import {expansionArt} from "./art";
import {parse} from "../search/index";
import type {Diagnostic} from "../search/index";
import {recentQueries} from "./history";
import {BASE} from "./pack";
import type {BarHandle} from "./bar/index";
import {Bar, PlainBar} from "./bar/index";
import {Simplify} from "./components/simplify";
import {carriedQuery, reloadWith, urlPlain, urlQuery} from "./utils/query";
import styles from "./app.module.css";

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
 * One knob: a captioned select whose choice is a URL parameter.
 *
 * The three of them differ only in what they list and which parameter they write, and every one needs a refetch —
 * another pack, another pack language, another bundled catalog — so the reload belongs to the control rather than
 * to each caller's own change handler.
 */
function Knob({caption, param, value, options, disabled, hint}: {
    readonly caption: string;
    /** The URL parameter this knob writes. Writing it reloads, which is what fetches the choice. */
    readonly param: string;
    readonly value: string;
    /** What it lists: the value written, and what the row reads as. */
    readonly options: readonly { readonly value: string; readonly label: string }[];
    /**
     * Whether the choice is refused. A knob with one option is drawn and disabled rather than hidden — the axis
     * exists whether or not this pack has anything to say on it, and a control that vanishes says nothing.
     */
    readonly disabled?: boolean;
    /** Why it is refused, where it is. */
    readonly hint?: string;
}): ReactElement {
    return (
        <label className={styles.knob} title={hint}>
            {caption}
            <select
                value={value}
                disabled={disabled}
                onChange={(e) => {
                    reloadWith(param, e.target.value);
                }}
            >
                {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
        </label>
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
                    <Knob
                        caption={t("harness.version")}
                        param="v"
                        value={info.version.id}
                        options={info.versions.filter((v) => v.hidden !== true)
                            .map((v) => ({value: v.id, label: v.label}))}
                    />
                    <Knob
                        caption={t("harness.packLanguage")}
                        param="lang"
                        value={info.locale}
                        options={info.locales.map((locale) => ({value: locale, label: locale}))}
                        disabled={info.locales.length < 2}
                        hint={info.locales.length < 2 ? t("harness.onlyLanguage") : undefined}
                    />
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
                <Knob
                    caption={t("harness.appLanguage")}
                    param="lng"
                    value={i18n.resolvedLanguage ?? "en"}
                    options={APP_LANGUAGES.map((code) => ({value: code, label: code}))}
                />
            </footer>
        </div>
    );
}
