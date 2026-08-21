/**
 * @file The scanner: query text to segments, with every leaf's own escape rule stated once.
 *
 * A value token is not one string. Quotes open a phrase, slashes a pattern, parentheses a group, and each of those
 * is a leaf whose insides the grammar does not touch — so scanning them is what tells the parser where a value ends
 * without the parser knowing what any of them mean. Everything here answers a question about characters and
 * positions; nothing here knows about heads, kinds or types.
 *
 * The scanner reads two strings. Structure is decided on the typography-folded text, so a curly quote opens a phrase
 * exactly as a straight one does; a regular expression takes its characters from the query as typed, because a
 * pattern matches stored text as written and folding it would change what it matches. Folding is one-to-one, so the
 * two strings share every position.
 */
import {GRAMMAR, PREFIX_OPERATORS} from "./grammar";

/** The query in the two readings every scan needs: folded for structure, as typed for a pattern's own characters. */
export interface Source {
    /** The query, typography folded — what every structural decision reads. */
    readonly text: string;
    /** The query as typed, for the one value that must not fold. */
    readonly raw: string;
}

export const isWs = (c: string): boolean => /\s/.test(c);

/**
 * The value an escaped spelling reads as: each escape drops, the character it shielded stays.
 *
 * The escape works EVERYWHERE outside a regex, not only inside a phrase: `\-a` is text starting with a dash and
 * negates nothing, `\model:` opens no door. The scanner keeps the pair in a bare run's text so every position
 * survives for the surfaces that draw the query as typed; this is the one read that turns the spelling into the
 * value. A trailing lone escape is kept as itself — there is nothing after it to shield.
 */
export function unescaped(text: string): string {
    let out = "";
    for (let i = 0; i < text.length; i++) {
        if (text[i] === GRAMMAR.escape && i + 1 < text.length) {
            out += text[i + 1];
            i++;
            continue;
        }
        out += text[i];
    }
    return out;
}

/** Whether the character at `at` is escaped: shielded by an odd run of escapes just before it. */
export function escapedAt(text: string, at: number): boolean {
    let backslashes = 0;
    for (let i = at - 1; i >= 0 && text[i] === GRAMMAR.escape; i--) backslashes++;
    return backslashes % 2 === 1;
}

/** Splits a bare run at the alternation character, stepping over escaped pairs; empty parts drop. */
export function splitBare(text: string): string[] {
    const parts: string[] = [];
    let cur = "";
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === GRAMMAR.escape && i + 1 < text.length) {
            cur += c + text[i + 1];
            i++;
            continue;
        }
        if (c === GRAMMAR.or) {
            parts.push(cur);
            cur = "";
            continue;
        }
        cur += c;
    }
    parts.push(cur);
    return parts.filter((p) => p !== "");
}

/** One piece of a value token: a bare run, a phrase, a regular expression, or a parenthesised group. */
export interface Seg {
    readonly form: "bare" | "phrase" | "regex" | "group";
    /** Bare: the run itself. Phrase: the content, unescaped. Regex: the pattern. Group: the raw inner text. */
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly closed: boolean;
}

/**
 * Reads a phrase opened at `at`: a leaf — nothing inside is active — whose escape restores a literal quote. Every
 * walker that must step over a phrase goes through this, so the escape rule exists once.
 */
export function scanPhrase(text: string, at: number, limit: number): Seg {
    let out = "";
    let i = at + 1;
    let closed = false;
    while (i < limit) {
        const c = text[i];
        if (c === GRAMMAR.escape && i + 1 < limit) {
            out += text[i + 1];
            i += 2;
            continue;
        }
        if (c === GRAMMAR.phrase) {
            closed = true;
            i++;
            break;
        }
        out += c;
        i++;
    }
    return {form: "phrase", text: out, start: at, end: i, closed};
}

/** Whether a parenthesised value is really a scope: whitespace or a bind at its own depth zero says so. */
export function scopeShaped(inner: string): boolean {
    let depth = 0;
    let i = 0;
    while (i < inner.length) {
        const c = inner[i];
        if (c === GRAMMAR.escape && i + 1 < inner.length) {
            i += 2;
            continue;
        }
        if (c === GRAMMAR.phrase) {
            i = scanPhrase(inner, i, inner.length).end;
            continue;
        }
        if (c === GRAMMAR.group.open) depth++;
        if (c === GRAMMAR.group.close) depth--;
        if (depth === 0 && (isWs(c) || c === GRAMMAR.bind)) return true;
        i++;
    }
    return false;
}

/** Splits a group's inner text into alternatives at its own depth zero. */
export function splitAlternatives(inner: string): string[] {
    const parts: string[] = [];
    let cur = "";
    let depth = 0;
    let i = 0;
    while (i < inner.length) {
        const c = inner[i];
        if (c === GRAMMAR.escape && i + 1 < inner.length) {
            cur += inner.slice(i, i + 2);
            i += 2;
            continue;
        }
        if (c === GRAMMAR.phrase) {
            const end = scanPhrase(inner, i, inner.length).end;
            cur += inner.slice(i, end);
            i = end;
            continue;
        }
        if (c === GRAMMAR.group.open) depth++;
        if (c === GRAMMAR.group.close) depth--;
        if (c === GRAMMAR.or && depth === 0) {
            parts.push(cur);
            cur = "";
            i++;
            continue;
        }
        cur += c;
        i++;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** A scan over one query. Holds the source so a position-based reader never has to be handed it twice. */
export class Scanner {
    constructor(private readonly src: Source) {
    }

    private get text(): string {
        return this.src.text;
    }

    /**
     * Scans one value token: everything to the next whitespace at depth zero, or to the brace closing the scope.
     *
     * Quotes always open a phrase; parens open a group only where `groups` says a value is expected — in top-level
     * free text they are ordinary characters, which is what keeps every parenthesised spell name searchable.
     *
     * `glue` ends the token at a glue character too, for a caller reading one value of a glued run. It is off by
     * default because the character is ordinary text everywhere a run is not being read — a spell name may carry a
     * comma — and a phrase, a pattern and a group each consume their own interior, so the escapes come for free.
     */
    token(from: number, limit: number, opts: { inScope: boolean; groups: boolean; glue?: boolean }):
        { segs: Seg[]; end: number } {
        const segs: Seg[] = [];
        let cur = "";
        let curStart = from;
        let i = from;
        const flush = (end: number): void => {
            if (cur !== "") segs.push({form: "bare", text: cur, start: curStart, end, closed: true});
            cur = "";
        };
        // A regex opens only in value position, and only where the token begins — in free text and mid-token a
        // slash is an ordinary character, which is what keeps pasted path fragments searchable.
        const regexHere = opts.inScope || opts.groups;
        while (i < limit) {
            const c = this.text[i];
            // An escape shields the next character from every structural reading below — it joins the bare run
            // as the pair it was typed as, and `unescaped` is the one read that turns the pair into its value.
            if (c === GRAMMAR.escape && i + 1 < limit && !isWs(this.text[i + 1])) {
                cur += c + this.text[i + 1];
                i += 2;
                continue;
            }
            if (isWs(c)) break;
            if (opts.glue === true && c === GRAMMAR.glue) break;
            if (opts.inScope && (c === GRAMMAR.scope.close || c === GRAMMAR.scope.open)) break;
            // …or straight after a lone operator symbol, so that `=/fire/` parses far enough to be refused
            // as the contradiction it is instead of reading as literal text.
            if (regexHere && c === GRAMMAR.regex && segs.length === 0
                && (cur === "" || PREFIX_OPERATORS.some((op) => op.symbol === cur))) {
                flush(i);
                const pattern = this.regex(i, limit);
                segs.push(pattern);
                i = pattern.end;
                curStart = i;
                continue;
            }
            if (c === GRAMMAR.phrase) {
                flush(i);
                const phrase = scanPhrase(this.text, i, limit);
                segs.push(phrase);
                i = phrase.end;
                curStart = i;
                continue;
            }
            if (opts.groups && c === GRAMMAR.group.open) {
                flush(i);
                const group = this.group(i, limit);
                segs.push(group);
                i = group.end;
                curStart = i;
                continue;
            }
            cur += c;
            i++;
        }
        flush(i);
        return {segs, end: i};
    }

    /**
     * A regex is a leaf like a phrase, with one difference: the backslash survives, because the pattern needs it.
     * Only an escaped slash unwraps. The value still ends at whitespace — a pattern writes a space as `\s` — so tag
     * closure holds everywhere.
     */
    regex(at: number, limit: number): Seg {
        let out = "";
        let i = at + 1;
        let closed = false;
        while (i < limit) {
            const c = this.text[i];
            if (isWs(c)) break;
            if (c === GRAMMAR.escape && i + 1 < limit) {
                out += this.text[i + 1] === GRAMMAR.regex ? GRAMMAR.regex : c + this.src.raw[i + 1];
                i += 2;
                continue;
            }
            if (c === GRAMMAR.regex) {
                closed = true;
                i++;
                break;
            }
            out += this.src.raw[i];
            i++;
        }
        return {form: "regex", text: out, start: at, end: i, closed};
    }

    /** A group runs to its matching close; nested pairs and phrases inside are respected. */
    group(at: number, limit: number): Seg {
        let depth = 1;
        let i = at + 1;
        const innerStart = i;
        while (i < limit) {
            const c = this.text[i];
            if (c === GRAMMAR.phrase) {
                i = scanPhrase(this.text, i, limit).end;
                continue;
            }
            if (c === GRAMMAR.group.open) depth++;
            if (c === GRAMMAR.group.close && --depth === 0) {
                return {form: "group", text: this.text.slice(innerStart, i), start: at, end: i + 1, closed: true};
            }
            i++;
        }
        return {form: "group", text: this.text.slice(innerStart, limit), start: at, end: limit, closed: false};
    }
}
