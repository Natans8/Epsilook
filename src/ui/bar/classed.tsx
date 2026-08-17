/**
 * @file The bar's one highlighter: a stretch of query text as classed spans.
 *
 * Wherever raw text shows — a settled segment, the open slot's backdrop — it is painted through this component
 * and the engine's own `classify()`, so the colouring can never disagree with what the language layer reads.
 */
import type {ReactElement} from "react";
import {useMemo} from "react";
import {classify} from "../../search/index";
import styles from "./bar.module.css";

/** The colour class per run kind; a plain word paints nothing and inherits the text colour. */
const RUN_CLASS: Record<string, string | undefined> = {
    head: styles.runHead, op: styles.runOp, delim: styles.runOp, quote: styles.runOp, number: styles.runNumber,
};

/**
 * One stretch of text as classed spans.
 */
export function Classed({text}: { readonly text: string }): ReactElement {
    const runs = useMemo(() => classify(text), [text]);
    return (
        <>
            {runs.map((run, i) => (
                <span key={i} className={RUN_CLASS[run.kind]}>{text.slice(run.start, run.end)}</span>
            ))}
        </>
    );
}
