/**
 * @file The bar's one highlighter: a stretch of query text as classed spans.
 *
 * Wherever raw text shows — a settled segment, the open slot's backdrop — it is painted through this component
 * and the engine's own `classify()`, so the colouring can never disagree with what the language layer reads.
 */
import type {ReactElement, ReactNode} from "react";
import {useMemo} from "react";
import type {Span} from "../../search/index";
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
export function Classed({text, rich, selected}: {
    readonly text: string;
    readonly rich?: boolean;
    /** The stretch of this text the bar's selection covers, in the text's own coordinates. */
    readonly selected?: Span;
}): ReactElement {
    const runs = useMemo(() => (rich === true ? paint(text) : classify(text)), [text, rich]);
    const out: ReactNode[] = [];
    for (const [i, run] of runs.entries()) {
        const classes = [
            // Exclusion outranks the column's tone, exactly as it does on a chip: the minus and the word it
            // excludes are one red unit, and the tone says which column that unit reaches.
            run.negated === true ? styles.runNeg
                : run.tone === undefined ? RUN_CLASS[run.kind] : TONE_CLASS[run.tone] ?? RUN_CLASS[run.kind],
            // Loudness is not a colour: a word about the query keeps its column's tone and gains the weight.
            run.kind === "meta" || run.door === true ? styles.runMeta : undefined,
            run.vocab === true ? styles.runVocab : undefined,
            run.state === "error" ? styles.runError
                : run.state === "warning" ? styles.runWarn : undefined,
        ].filter((held) => held !== undefined);
        const cls = classes.length === 0 ? undefined : classes.join(" ");
        if (selected === undefined) {
            out.push(<span key={i} className={cls}>{text.slice(run.start, run.end)}</span>);
            continue;
        }
        // A run is split where the selection starts or ends inside it: the selection is a range of characters,
        // and a classed run is a range of characters, so neither can be made to respect the other's boundaries.
        const cut = [
            run.start,
            ...[selected.start, selected.end].filter((edge) => edge > run.start && edge < run.end),
            run.end,
        ];
        for (let piece = 0; piece + 1 < cut.length; piece++) {
            const [from, to] = [cut[piece], cut[piece + 1]];
            const inSel = from >= selected.start && to <= selected.end;
            out.push(
                <span key={`${String(i)}-${String(from)}`} className={inSel ? `${cls ?? ""} ${styles.selected}` : cls}>
                    {text.slice(from, to)}
                </span>,
            );
        }
    }
    return <>{out}</>;
}
