/**
 * @file The bar's one highlighter: a stretch of query text as classed spans.
 *
 * Wherever raw text shows — a settled segment, the open slot's backdrop — it is painted through this component
 * and the engine's own `classify()`, so the colouring can never disagree with what the language layer reads.
 */
import type {ReactElement, ReactNode} from "react";
import {useMemo} from "react";
import type {Run, Span} from "../../../search/index";
import {classify, paint, quieted} from "../../../search/index";
import type {PatternKind} from "../utils/pattern";
import {patternRuns} from "../utils/pattern";
import {runToneOf} from "./tone";
import frame from "./bar.module.css";
import styles from "./classed.module.css";

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

/**
 * The colour class per part of a PATTERN — the second language a query can embed.
 *
 * Between the slashes the characters stop being a value and become regex syntax, so they are coloured by what
 * that syntax says rather than by the column the clause reaches. Literal text takes nothing and keeps the
 * value's own colour, which is what makes the marked parts read as the marked ones.
 */
const PATTERN_CLASS: Record<PatternKind, string | undefined> = {
    literal: undefined, escaped: styles.rxEscaped, meta: styles.rxMeta, group: styles.rxGroup,
    backref: styles.rxBackref, class: styles.rxClass, error: styles.rxError,
    // A class's brackets, its range hyphen and a metasequence inside it are all the pattern saying something
    // about itself rather than matching a character, which is the one thing the tone means here. The library
    // keeps them apart and this palette does not; they are separate the moment a reason to separate them shows.
    classBoundary: styles.rxMeta, classMeta: styles.rxMeta, classRange: styles.rxMeta,
};

/**
 * One pattern as coloured spans.
 *
 * The committed form of a regular expression, where the chip is selected whole and there is nothing to cut: the
 * bar's raw surfaces paint the same colours through {@link Classed}, which splits them by character because a
 * selection there is a range.
 */
export function Pattern({pattern}: { readonly pattern: string }): ReactElement {
    const runs = useMemo(() => patternRuns(pattern), [pattern]);
    return (
        <>
            {runs.map((run) => (
                <span key={run.start} className={PATTERN_CLASS[run.kind]} title={run.note}>
                    {pattern.slice(run.start, run.end)}
                </span>
            ))}
        </>
    );
}

/**
 * One stretch of text as classed spans.
 *
 * `rich` reads the whole query through the parse as well as the lexer, so a head wears the tone of the column
 * it reaches, a broken clause carries its squiggle and a vocabulary word is marked as one. It needs a whole
 * query to parse — the open slot holds a fragment, and paints lexically.
 */
export function Classed({text, rich, runs: given, mirrored, selected, aimed}: {
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
    /** The stretch something outside the bar is pointing at, drawn with the aim band; never together with a selection. */
    readonly aimed?: Span;
}): ReactElement {
    const banded = selected ?? aimed;
    const bandClass = selected === undefined ? frame.aimed : frame.selected;
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
                : run.tone === undefined ? byKind[run.kind] : runToneOf(run.tone) ?? byKind[run.kind],
            // Loudness is spent on the any-word alone — the one word that is a VALUE and yet not data. A door
            // needs none: it already wears its column's tone, and a value never wears one, so the colour has
            // already said which of the two this is. Marking doors as well made the same door read two ways,
            // since only the ones inside an enclosure were reached. Under a field the mark is a rule rather
            // than weight: weight would move the text out from under the caret, a decoration costs no width.
            run.kind === "meta" ? (mirrored === true ? styles.runDoor : styles.runMeta) : undefined,
            run.vocab === true ? styles.runVocab : undefined,
            run.state === "error" ? styles.runError
                : run.state === "warning" ? styles.runWarn : undefined,
        ].filter((held) => held !== undefined);
        const cls = classes.length === 0 ? undefined : classes.join(" ");
        // A pattern paints as its own parts, and ONLY as those: between the slashes the query's own colour
        // language stops applying, so the clause's tone, its exclusion red and its vocabulary mark are all
        // dropped rather than combined with. Two languages layered would say neither. Every other run paints
        // as one piece, so the selection below has a single shape to cut.
        // A pattern reads in a code face wherever the painting stands on its own; under a field the face is the
        // wrap's business, since field and mirror must change together.
        const pieces = run.kind === "regex"
            ? patternRuns(text.slice(run.start, run.end)).map((part) => ({
                start: run.start + part.start,
                end: run.start + part.end,
                cls: mirrored === true ? PATTERN_CLASS[part.kind] : `${PATTERN_CLASS[part.kind]} ${styles.rxMono}`,
                note: part.note,
            }))
            : [{start: run.start, end: run.end, cls, note: undefined}];
        for (const piece of pieces) {
            if (banded === undefined) {
                out.push(
                    <span key={`${String(i)}-${String(piece.start)}`} className={piece.cls} title={piece.note}>
                        {text.slice(piece.start, piece.end)}
                    </span>,
                );
                continue;
            }
            // A piece is split where the selection starts or ends inside it: the selection is a range of
            // characters and so is a classed piece, so neither can be made to respect the other's boundaries.
            const cut = [
                piece.start,
                ...[banded.start, banded.end].filter((edge) => edge > piece.start && edge < piece.end),
                piece.end,
            ];
            for (let cutAt = 0; cutAt + 1 < cut.length; cutAt++) {
                const [from, to] = [cut[cutAt], cut[cutAt + 1]];
                const inSel = from >= banded.start && to <= banded.end;
                out.push(
                    <span key={`${String(i)}-${String(from)}`} title={piece.note}
                          className={inSel ? `${piece.cls ?? ""} ${bandClass}` : piece.cls}>
                        {text.slice(from, to)}
                    </span>,
                );
            }
        }
    }
    return <>{out}</>;
}

/**
 * A quotation of query text, painted as the bar paints it, with every diagnostic state quieted.
 *
 * What a surface beside the bar shows when it names a clause: the head in its column's tone, a kind word with its
 * mark, an operator as itself. The squiggles stay with the bar, since whoever quotes a clause is saying how it
 * fared in their own way, and the painting is remembered per text so a list of quotations costs one parse each.
 */
export function QueryText({text}: { readonly text: string }): ReactElement {
    const runs = useMemo(() => paint(text).map(quieted), [text]);
    return <Classed text={text} runs={runs}/>;
}
