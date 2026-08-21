/**
 * @file The simplify button: the one door to an explicit rewrite, and the preview that says what it would write.
 *
 * Its own component because it carries its own reading of the query — a parse, a simplification, a format and a
 * settle — which is the page's most expensive read and none of the page's business. What it needs from the page
 * is the text, which view is standing, and somewhere to hand the rewrite back.
 */
import type {ReactElement} from "react";
import {useDeferredValue, useId, useMemo} from "react";
import {useTranslation} from "react-i18next";
import {formatQuery, parse, simplify} from "../../search/index";
import {carriedQuery} from "../utils/query";
import styles from "./simplify.module.css";

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
export function Simplify({text, plain, apply}: {
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
