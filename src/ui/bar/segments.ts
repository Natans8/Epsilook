/**
 * @file The chip's content: one committed clause rendered as the MEANING it parsed to.
 *
 * A committed chip draws the parse, not the minimal spelling — an elided `count` surfaces as a meta word, a bare
 * number surfaces the symbol of the notation that read it, display glyphs stand in for typed operators. The verbatim
 * text stays in the query underneath; this module only decides what the chip shows.
 *
 * Three text classes, all visually distinct by ruling: corpus free text is a VALUE, a closed-vocabulary word
 * (kind words, enum words) is VOCAB with a dotted mark, and a word that speaks about the query (`any`, the surfaced
 * `count`) is META and renders bold. Sentinel words are answers, not structure, so they stay value-styled.
 */
import type {
    Ask, AxisType, Clause, Kind, ParsedOperand, PropRef, ScopeTerm, ValueExpr,
} from "../../search/index";
import {
    COLOUR_NAMES, COUNT_PROP, doorOf, fold, formatValue, GRAMMAR, propOf, sentinelOf, TYPES, wordOf,
} from "../../search/index";

/** How one run of chip text is classed, which is what the stylesheet reads. */
export type SegmentKind = "value" | "vocab" | "meta" | "op" | "or" | "quote" | "unit";

/** One run of chip text. A colour value additionally carries the swatch to draw beside it. */
export interface Segment {
    readonly kind: SegmentKind;
    readonly text: string;
    /** CSS colour for the swatch a colour value draws, absent everywhere else. */
    readonly swatch?: string;
}

/** One item inside a lane: a text run of segments, an inner bind chip with its own head, or the or connective. */
export type LaneItem =
    | { readonly is: "text"; readonly negated: boolean; readonly segments: readonly Segment[] }
    | { readonly is: "chip"; readonly negated: boolean; readonly head: string;
        readonly segments: readonly Segment[]; readonly span: {start: number; end: number} }
    | { readonly is: "raw"; readonly text: string }
    | { readonly is: "or" };

/** One committed clause as the bar renders it. */
export type ClauseView =
    /** A structured ask: the sectioned chip, or the lane when several conditions share the row. */
    | { readonly is: "chip"; readonly head: string; readonly tone: string; readonly negated: boolean;
        readonly body: readonly Segment[] }
    | { readonly is: "lane"; readonly head: string; readonly tone: string; readonly negated: boolean;
        readonly items: readonly LaneItem[] }
    /** A freeform term: plain text in the bar by ruling, never a chip. */
    | { readonly is: "text"; readonly negated: boolean; readonly segments: readonly Segment[] }
    /** An ask that failed to parse: raw squiggled text — a red error never chipifies. */
    | { readonly is: "raw"; readonly text: string };

/** Heads are capitalised everywhere: `Attach`, never `attach`. */
export const headCase = (word: string): string => (word === "" ? word : word[0].toUpperCase() + word.slice(1));

/** The display glyph of a comparison, standing in for the typed spelling. */
const OP_GLYPHS: Record<string, string> = {lt: "<", lte: "≤", gt: ">", gte: "≥"};

/** The swatch colour of a colour value, from its packed int or its written name, or null when unreadable. */
function swatchOf(value: string | number, written?: string): string | null {
    if (typeof value === "number") return `#${value.toString(16).padStart(6, "0")}`;
    const packed = COLOUR_NAMES[fold(written ?? value)];
    if (packed !== undefined) return `#${packed.toString(16).padStart(6, "0")}`;
    return /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : null;
}

/**
 * A bare-written number with the symbol of the notation that read it made explicit.
 *
 * A bare number never displays bare by ruling — `5` on scale reads as a factor and displays `×5`. The notation is
 * recovered from the type's own declarations: the one whose bare claim covers the written magnitude and whose
 * conversion reproduces the stored value is the one that read it.
 */
function explicitNotation(type: AxisType | undefined, written: string, value: string | number): string | null {
    if (type?.notations === undefined || typeof value !== "number" || !/^\d+(?:\.\d+)?$/.test(written)) return null;
    const magnitude = Number(written);
    for (const notation of type.notations) {
        const bare = notation.bare ?? "any";
        if (bare === "never") continue;
        if (typeof bare === "object" && "atMost" in bare && magnitude > bare.atMost) continue;
        if (typeof bare === "object" && "above" in bare && magnitude <= bare.above) continue;
        if (notation.sign === "required") continue;
        const stored = magnitude * notation.factor + (notation.offset ?? 0);
        const scaled = type.storage === "int" ? Math.round(stored) : stored;
        if (Math.abs(scaled - value) > 1e-6) continue;
        return notation.position === "before" ? `${notation.unit}${written}` : `${written}${notation.unit}`;
    }
    return null;
}

/** Whether the operand's value class is a closed vocabulary — enum-flavoured types draw the vocab mark. */
function vocabClassed(at?: PropRef): boolean {
    const first = at === undefined ? undefined : propOf(at).types[0];
    return first !== undefined && (first.ui === "picker" || first.ui === "glyphs" || first.ui === "toggle");
}

/** One operand as segments: the written spelling upheld, its notation made explicit, a swatch where it is one. */
function operandSegments(operand: ParsedOperand, at?: PropRef): Segment[] {
    if ("text" in operand) {
        const kind: SegmentKind = vocabClassed(at) ? "vocab" : "value";
        if (/\s/.test(operand.text)) {
            return [{kind: "quote", text: '"'}, {kind, text: operand.text}, {kind: "quote", text: '"'}];
        }
        return [{kind, text: operand.text}];
    }

    const at0 = at === undefined ? undefined : propOf(at);
    const type = TYPES.get(operand.type);
    if (type?.name === "colour") {
        const written = operand.written ?? (at0 ? formatValue(at0, operand.value) : String(operand.value));
        const colour = swatchOf(operand.value, operand.written);
        return [{kind: "vocab", text: written, ...(colour === null ? {} : {swatch: colour})}];
    }

    // A sentinel word is an answer, value-styled; formatValue writes it before any notation.
    if (at0 !== undefined && typeof operand.value === "number" && at0.sentinels?.[operand.value] !== undefined) {
        return [{kind: "value", text: formatValue(at0, operand.value)}];
    }

    const written = operand.written;
    if (written !== undefined) {
        const explicit = explicitNotation(type, written, operand.value);
        return [{kind: vocabClassed(at) ? "vocab" : "value", text: explicit ?? written}];
    }
    const canonical = at0 ? formatValue(at0, operand.value) : type?.format?.(operand.value) ?? String(operand.value);
    return [{kind: vocabClassed(at) ? "vocab" : "value", text: canonical}];
}

/** Whether every alternative is a whole number ask — the identity list, rendered as a comma list. */
function identityList(alternatives: readonly ValueExpr[]): boolean {
    return alternatives.every((alt) => {
        if (alt.op !== "exact" && alt.op !== "contains") return false;
        const operand = alt.operand;
        if ("text" in operand) return /^\d+$/.test(operand.text);
        return typeof operand.value === "number" && TYPES.get(operand.type)?.quantity === true;
    });
}

/**
 * One value expression as segments.
 *
 * @param value The expression.
 * @param at The property it binds, when known — it holds sentinels, notations and the value class.
 * @returns The segments, in reading order.
 */
export function valueSegments(value: ValueExpr, at?: PropRef): Segment[] {
    switch (value.op) {
        case "present":
            return [{kind: "meta", text: "any"}];
        case "contains":
            return operandSegments(value.operand, at);
        case "glob":
        case "regex":
            return operandSegments(value.operand, at);
        case "exact": {
            const at0 = at === undefined ? undefined : propOf(at);
            const text = "text" in value.operand ? value.operand.text : undefined;
            if (at0 !== undefined && text !== undefined && sentinelOf(at0, text) !== null) {
                return [{kind: "value", text}];
            }
            if (at0 !== undefined && typeof ("value" in value.operand ? value.operand.value : null) === "number"
                && "value" in value.operand && at0.sentinels?.[value.operand.value as number] !== undefined) {
                return operandSegments(value.operand, at);
            }
            return [{kind: "op", text: "="}, ...operandSegments(value.operand, at)];
        }
        case "lt":
        case "lte":
        case "gt":
        case "gte":
            return [{kind: "op", text: OP_GLYPHS[value.op]}, ...operandSegments(value.operand, at)];
        case "range":
            // The unit rides on BOTH bounds by ruling, which the canonical per-bound spelling carries.
            return [
                ...boundSegments(value.lo, at), {kind: "op", text: "–"}, ...boundSegments(value.hi, at),
            ];
        case "anyOf": {
            const out: Segment[] = [];
            const commas = identityList(value.alternatives);
            value.alternatives.forEach((alt, i) => {
                if (i > 0) out.push(commas ? {kind: "op", text: ","} : {kind: "or", text: "or"});
                out.push(...valueSegments(alt, at));
            });
            return out;
        }
    }
    return value;
}

/** A range bound in its canonical spelling, so the unit lands on the bound itself. */
function boundSegments(operand: ParsedOperand, at?: PropRef): Segment[] {
    if ("text" in operand || at === undefined) return operandSegments(operand, at);
    return [{kind: "value", text: formatValue(propOf(at), operand.value)}];
}

/** One scope term's segments — the body of a lane text run or an inner chip. */
function termSegments(ask: NonNullable<ScopeTerm["ask"]>): Segment[] {
    switch (ask.on) {
        case "content":
            return valueSegments(ask.value);
        case "kindWord":
            return [{kind: "vocab", text: wordOf(ask.kind)}];
        case "count":
            return [{kind: "meta", text: GRAMMAR.countWord}, ...valueSegments(ask.value, COUNT_REF)];
        case "props":
            return valueSegments(ask.value, ask.props[0]);
    }
    return ask;
}

/** A property reference for the synthetic count property, so its values format like any numeric axis. */
const COUNT_REF: PropRef = {
    kind: {id: "count", column: {key: "count", label: "count", hint: ""}, hint: "", props: {value: COUNT_PROP}} as Kind,
    prop: "value",
};

/** The inner-chip head of one structured term, or null where the term renders as text. */
function termHead(ask: NonNullable<ScopeTerm["ask"]>): string | null {
    if (ask.on === "count") return headCase(GRAMMAR.countWord);
    if (ask.on === "props") return headCase(doorOf(ask.props[0].prop, propOf(ask.props[0])));
    return null;
}

/** A count term drops its meta word when it sits under its own `Count` head. */
function innerChipSegments(ask: NonNullable<ScopeTerm["ask"]>): Segment[] {
    if (ask.on === "count") return valueSegments(ask.value, COUNT_REF);
    return termSegments(ask);
}

/** The lane's items for one scope test, alternation runs joined by the or connective. */
function laneItems(terms: ReadonlyArray<readonly ScopeTerm[]>, text: string): LaneItem[] {
    const items: LaneItem[] = [];
    terms.forEach((run, i) => {
        if (i > 0) items.push({is: "or"});
        for (const term of run) {
            if (term.state !== "ok" || term.ask === null) {
                items.push({is: "raw", text: text.slice(term.span.start, term.span.end)});
                continue;
            }
            const head = termHead(term.ask);
            if (head === null) items.push({is: "text", negated: term.not, segments: termSegments(term.ask)});
            else {
                items.push({
                    is: "chip", negated: term.not, head, segments: innerChipSegments(term.ask),
                    span: {start: term.span.start, end: term.span.end},
                });
            }
        }
    });
    return items;
}

/** The evaluable terms of a scope, flattened — what decides chip against lane. */
const scopeTermCount = (terms: ReadonlyArray<readonly ScopeTerm[]>): number =>
    terms.flat().length;

/**
 * One committed clause as the bar renders it.
 *
 * Chip against lane is the kernel law `{x} ≡ x`, never style: one condition on the row is a compact chip whatever
 * its spelling, two or more are the lane.
 *
 * @param clause The clause.
 * @param text The query text its spans index.
 * @returns The view.
 */
export function clauseView(clause: Clause, text: string): ClauseView {
    const raw = text.slice(clause.span.start, clause.span.end);
    if (clause.state === "invalid" || clause.ask === null) return {is: "raw", text: raw};
    const ask = clause.ask;

    if (ask.on === "plain") {
        return {is: "text", negated: clause.not, segments: valueSegments(ask.value)};
    }

    if (ask.on === "prop") {
        const head = headCase(doorOf(ask.ref.prop, propOf(ask.ref)));
        const tone = ask.ref.kind.column.key;
        if (ask.value === null) return {is: "raw", text: raw};
        return {is: "chip", head, tone, negated: clause.not, body: valueSegments(ask.value, ask.ref)};
    }

    const column = ask.on === "column" ? ask.column : ask.kind.column;
    const tone = column.key;
    const test = ask.test;
    if (test === null) return {is: "raw", text: raw};

    // The head is the door the ask went through: a kind word with a test of its own heads the chip; bare existence
    // of a kind spells through its column, so the column heads it and the word is the body.
    if (test.is === "exists") {
        if (ask.on === "kind" && ask.kind.word !== undefined) {
            return {
                is: "chip", head: headCase(column.key), tone, negated: clause.not,
                body: [{kind: "vocab", text: wordOf(ask.kind)}],
            };
        }
        return {
            is: "chip", head: headCase(column.key), tone, negated: clause.not,
            body: [{kind: "meta", text: "any"}],
        };
    }

    const head = ask.on === "kind" ? headCase(wordOf(ask.kind)) : headCase(column.key);
    if (test.is === "content") {
        return {is: "chip", head, tone, negated: clause.not, body: valueSegments(test.value)};
    }
    if (test.is === "props") {
        return {is: "chip", head, tone, negated: clause.not, body: valueSegments(test.value, test.props[0])};
    }

    if (scopeTermCount(test.terms) === 1) {
        const term = test.terms[0][0];
        if (term.state === "ok" && term.ask !== null) {
            const segments = termSegments(term.ask);
            const body = term.not ? [{kind: "op", text: GRAMMAR.negate} as Segment, ...segments] : segments;
            return {is: "chip", head, tone, negated: clause.not, body};
        }
        return {is: "raw", text: raw};
    }
    return {is: "lane", head, tone, negated: clause.not, items: laneItems(test.terms, text)};
}
