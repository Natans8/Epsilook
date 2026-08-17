/**
 * @file The bar's one highlighter: a stretch of query text as classed spans.
 *
 * Wherever raw text shows — a settled segment, the open slot's backdrop — it is painted through this component
 * and the engine's own `classify()`, so the colouring can never disagree with what the language layer reads.
 */
import type {ReactElement} from "react";
import {useMemo} from "react";
import {classify, paint} from "../../search/index";
import styles from "./bar.module.css";

/** The colour class per run kind; a plain word paints nothing and inherits the text colour. */
const RUN_CLASS: Record<string, string | undefined> = {
    head: styles.runHead, op: styles.runOp, delim: styles.runOp, quote: styles.runOp, number: styles.runNumber,
};

/** The tone class per column key — the same families the chips wear, so one query reads one colour language. */
const TONE_CLASS: Record<string, string | undefined> = {
    model: styles.runModel, sound: styles.runSound, anim: styles.runAnim,
    fx: styles.runFx, mech: styles.runMech, spell: styles.runSpell, id: styles.runSpell,
};

/**
 * One stretch of text as classed spans.
 *
 * `rich` reads the whole query through the parse as well as the lexer, so a head wears the tone of the column
 * it reaches, a broken clause carries its squiggle and a vocabulary word is marked as one. It needs a whole
 * query to parse — the open slot holds a fragment, and paints lexically.
 */
export function Classed({text, rich}: { readonly text: string; readonly rich?: boolean }): ReactElement {
    const runs = useMemo(() => (rich === true ? paint(text) : classify(text)), [text, rich]);
    return (
        <>
            {runs.map((run, i) => {
                const classes = [
                    run.tone === undefined ? RUN_CLASS[run.kind] : TONE_CLASS[run.tone] ?? RUN_CLASS[run.kind],
                    run.vocab === true ? styles.runVocab : undefined,
                    run.state === "error" ? styles.runError
                        : run.state === "warning" ? styles.runWarn : undefined,
                ].filter((held) => held !== undefined);
                return (
                    <span key={i} className={classes.length === 0 ? undefined : classes.join(" ")}>
                        {text.slice(run.start, run.end)}
                    </span>
                );
            })}
        </>
    );
}
