/**
 * @file The bar's one highlighter: a stretch of query text as classed spans.
 *
 * Wherever raw text shows — a settled segment, the open slot's backdrop — it is painted through this component
 * and the engine's own `classify()`, so the colouring can never disagree with what the language layer reads.
 */
import type {ReactElement, ReactNode} from "react";
import {useMemo} from "react";
import type {Run, Span} from "../../search/index";
import {classify, paint} from "../../search/index";
import styles from "./bar.module.css";

/** The colour class per run kind; a plain word paints nothing and inherits the text colour. */
const RUN_CLASS: Record<string, string | undefined> = {
    head: styles.runHead, op: styles.runOp, delim: styles.runOp, quote: styles.runOp,
};

/**
 * The same kinds under a FIELD, where the reader is placing these characters rather than reading past them.
 *
 * At rest a chip has already drawn the structure, so the raw delimiters recede. While editing they are the
 * thing being manipulated — and they have to read apart from a GHOST, which is text that is not there yet and
 * was landing on the same quiet colour.
 */
const LIVE_CLASS: Record<string, string | undefined> = {
    head: styles.runHead, op: styles.runLive, delim: styles.runLive, quote: styles.runLive,
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
export function Classed({text, rich, runs: given, mirrored, selected}: {
    readonly text: string;
    readonly rich?: boolean;
    /**
     * Whether this painting sits UNDER a field rather than standing on its own.
     *
     * A mirror and its field must measure identically or the caret drifts from the text: the ink is a row of
     * spans and the field is one string, so anything that changes a glyph's advance — weight above all — makes
     * the two wrap at different words, and from the second line on the caret lands somewhere else entirely.
     * Colour, decoration and background are free; weight is not.
     */
    readonly mirrored?: boolean;
    /**
     * The runs to paint, where the caller already has them.
     *
     * A slot holds a FRAGMENT, and the rich painting needs a whole query to know what a head reached — so the
     * bar paints the query once and hands each surface its own slice, rather than each one guessing.
     */
    readonly runs?: readonly Run[];
    /** The stretch of this text the bar's selection covers, in the text's own coordinates. */
    readonly selected?: Span;
}): ReactElement {
    // The caller's runs win where it has them: a slot cannot paint itself, and lexing the same characters a
    // second time here would only produce the poorer answer.
    const runs = useMemo(() => given ?? (rich === true ? paint(text) : classify(text)), [given, text, rich]);
    const byKind = mirrored === true ? LIVE_CLASS : RUN_CLASS;
    const out: ReactNode[] = [];
    for (const [i, run] of runs.entries()) {
        const classes = [
            // Exclusion outranks the column's tone, exactly as it does on a chip: the minus and the word it
            // excludes are one red unit, and the tone says which column that unit reaches.
            run.negated === true ? styles.runNeg
                : run.tone === undefined ? byKind[run.kind] : TONE_CLASS[run.tone] ?? byKind[run.kind],
            // Loudness: a word about the query keeps its column's tone and gains the weight. Under a field it
            // gains a rule beneath it instead — weight would move the text out from under the caret, and a
            // decoration costs no advance width at all.
            run.kind === "meta" || run.door === true
                ? (mirrored === true ? styles.runDoor : styles.runMeta) : undefined,
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
