/**
 * @file The count line: how many spells the query answers with, or the word that it was not asked.
 *
 * Its own component because it carries two readings of one line — what is drawn, which follows every answer,
 * and what is announced, which waits for the line to settle — and neither is the page's business. A query the
 * parser refuses is not counted: an invalid clause drops out of the evaluable groups, so `xpac:zzz` would
 * constrain nothing and report the whole pack, a wrong answer wearing the authority of a number. The strip above
 * says what is wrong; this line says only that no count was taken.
 */
import type {ReactElement} from "react";
import {useEffect, useState} from "react";
import {useTranslation} from "react-i18next";
import type {Diagnostic, Parsed} from "../../search/index";
import styles from "./count.module.css";

/** One answer from the worker: the count, how long it took, and the text it was the answer to. */
export interface Answer {
    readonly count: number;
    readonly ms: number;
    readonly for: string;
}

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
 * The count line and its announcement.
 */
export function Count({parsed, result, stale}: {
    /** The query as read in final mode, which says whether a count was taken at all and how much of it is listed. */
    readonly parsed: Parsed;
    /** The last answer the worker gave, or nothing yet. */
    readonly result: Answer | null;
    /** Whether that answer is to an older text than the one standing, so the line dims until the next lands. */
    readonly stale: boolean;
}): ReactElement {
    const {t} = useTranslation();
    const broken = parsed.diagnostics.filter((d: Diagnostic) => d.severity === "error");
    // Under a limit the line reports what is LISTED, not the query's full count: the honest number with an
    // explainer beside it reads worse than the plain one.
    const shown = (count: number): number =>
        (parsed.limit === null ? count : Math.min(Math.abs(parsed.limit.value), count));
    const counted = result === null ? ""
        : `${shown(result.count).toLocaleString()} `
        + t("count.result", {count: shown(result.count)})
        + `, ${t("count.elapsed", {ms: result.ms})}`;
    // The eye reads the strip's reason and this line's refusal; a listener has no strip, so the announcement
    // carries the reason itself.
    const drawn = broken.length > 0 ? t("count.refused") : counted;
    const announced = useSettled(broken.length > 0 ? broken[0].message : counted);
    return (
        <>
            {/* The line updates with every answer; what is ANNOUNCED settles first — see `announced`. */}
            <div className={`${styles.status} ${stale ? styles.statusStale : ""}`} aria-hidden="true">
                {drawn}
            </div>
            <div className={styles.announce} role="status">{announced}</div>
        </>
    );
}
