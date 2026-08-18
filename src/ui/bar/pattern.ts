/**
 * @file A regular expression's own colouring, read from `regex-colorizer`.
 *
 * The query language embeds a second language: between the slashes a value stops being words and becomes a
 * pattern, whose parts mean what JavaScript's own regex grammar says they mean. Working out those parts is
 * `regex-colorizer`'s job -- it targets the ES2023 flavour as browsers actually interpret it, which is the same
 * flavour {@link https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/RegExp | RegExp}
 * gives the evaluator -- so nothing here decides what a character does.
 *
 * What IS here is the shape conversion. The library returns HTML for insertion into a page; this bar paints
 * character RANGES, because a run has to be splittable wherever a selection ends inside it. So the markup is
 * read straight back into ranges of the pattern, and the surfaces render their own spans from those.
 */
import {colorizePattern} from "regex-colorizer";

/**
 * The flags the evaluator compiles a pattern under.
 *
 * The colouring and the matching must agree about what is even valid: under `u` a stray brace is an error and
 * without it an ordinary character. Kept beside the evaluator's own literal rather than imported, because
 * reaching for it would drag the matching layer into the interface.
 */
const FLAGS = "iu";

/**
 * What one range of a pattern is, in the library's own vocabulary.
 *
 * The names come from its emitter: a `<b>` is a metasequence, quantifier or alternator, told apart only by the
 * group depth it carries; a `<i>` is a character class, whose brackets, metasequences and range hyphen are its
 * own three inner kinds. Nothing is collapsed here that the library kept apart.
 */
export type PatternKind =
    /** Ordinary text: what the pattern matches literally. */
    | "literal"
    /** A backslash escape standing for the literal character. */
    | "escaped"
    /** A metasequence, quantifier or alternator standing outside every group. */
    | "meta"
    /** The same, coloured by the group it belongs to. */
    | "group"
    /** A backreference to a capture. */
    | "backref"
    /** Text inside a character class. */
    | "class"
    /** A character class's own brackets. */
    | "classBoundary"
    /** A metasequence inside a character class. */
    | "classMeta"
    /** The hyphen spanning a character class's range. */
    | "classRange"
    /** What the library refuses, carrying its reason. */
    | "error";

/** One coloured range of a pattern, in the pattern's own coordinates. */
export interface PatternRun {
    readonly start: number;
    readonly end: number;
    readonly kind: PatternKind;
    /** The group nesting the library assigned, 1 to 5 and cycling; 0 outside every group. */
    readonly depth: number;
    /** The library's reason, on an error range only. */
    readonly note?: string;
}

/** The library's markup, one tag or one stretch of text at a time. */
const TOKEN = /<(?<close>\/?)(?<tag>b|i|u|span)(?<attrs>[^>]*)>|(?<text>[^<]+)/gu;

/** What a tag says about the range it opens, read from the attributes the library writes. */
interface Frame {
    readonly tag: string;
    readonly cls: string;
    readonly depth: number;
    readonly note?: string;
}

/** Undoes the two entities the library writes, so a range's length is the pattern's own. */
function shrinkEntities(text: string): string {
    return text.replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

/** The kind a stretch of text wears, given the tags open around it. */
function kindOf(stack: readonly Frame[]): {kind: PatternKind; depth: number; note?: string} {
    const inClass = stack.some((frame) => frame.tag === "i");
    const top = stack.at(-1);
    if (top === undefined) return {kind: inClass ? "class" : "literal", depth: 0};
    if (top.cls === "err") return {kind: "error", depth: top.depth, note: top.note};
    if (top.cls === "bref") return {kind: "backref", depth: top.depth};
    if (inClass) {
        return {
            kind: top.tag === "span" ? "classBoundary" : top.tag === "u" ? "classRange"
                : top.tag === "b" ? "classMeta" : "class",
            depth: top.depth,
        };
    }
    if (top.tag === "span") return {kind: "escaped", depth: 0};
    return top.depth > 0 ? {kind: "group", depth: top.depth} : {kind: "meta", depth: 0};
}

/**
 * Colours one pattern.
 *
 * @param pattern The pattern as it stands between the slashes, exactly as typed.
 * @returns Its ranges, in order, abutting and together covering the pattern.
 */
export function patternRuns(pattern: string): readonly PatternRun[] {
    const html = colorizePattern(pattern, {flags: FLAGS});
    const runs: PatternRun[] = [];
    const stack: Frame[] = [];
    let at = 0;
    for (const match of html.matchAll(TOKEN)) {
        const {close, tag, attrs, text} = match.groups ?? {};
        if (text !== undefined) {
            const end = at + shrinkEntities(text).length;
            const {kind, depth, note} = kindOf(stack);
            runs.push({start: at, end, kind, depth, ...(note === undefined ? {} : {note})});
            at = end;
            continue;
        }
        if (close === "/") {
            stack.pop();
            continue;
        }
        const cls = /class="(?<name>[^"]*)"/u.exec(attrs ?? "")?.groups?.name ?? "";
        const note = /title="(?<msg>[^"]*)"/u.exec(attrs ?? "")?.groups?.msg;
        const group = /^g(?<n>[1-5])$/u.exec(cls)?.groups?.n;
        stack.push({
            tag: tag ?? "", cls,
            depth: group === undefined ? stack.at(-1)?.depth ?? 0 : Number(group),
            ...(note === undefined ? {} : {note}),
        });
    }
    return runs;
}
