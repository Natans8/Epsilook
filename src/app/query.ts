import {syncBar} from "./bar";
import type {Chip} from "./state";
import {qInput, state} from "./state";
import {ensureFieldsVisible} from "./url";
import * as P from "../pills";
import * as Search from "../search";
import type {QueryGroup, QueryToken} from "../search";
/* ------------------------------------------------- query <-> chips */

// legacy prefixes silently convert to their current field — effect: was
// the fx: column's name before the effect:->mech: split; soundkit: and
// animkit: folded into sound:/anim: 2026-07-19 (numeric chips match kit IDs)
const FIELD_ALIASES: Record<string, string> = {effect: "fx", soundkit: "sound", animkit: "anim"};
export const canonField = (f: string): string => FIELD_ALIASES[f] || f;

// Epsilon commands go straight into the bar: ".cast 12345" / ".aura 12345"
// (and truncations down to .c / .au — .a stays plain text) mean id:, the
// space after the command acting as the tag's ":". One alternation,
// three uses: rewriting parsed strings (quoted spans stay literal),
// sniffing pastes, and live typing (the \s just typed ends the match).
const ID_CMDS = "cast|cas|ca|c|aura|aur|au";
const ID_CMD_REWRITE = new RegExp(`"[^"]*"|(^|\\s)\\.(?:${ID_CMDS})\\s+(?=\\S)`, "gi");
export const ID_CMD_PASTE = new RegExp(`(^|\\s)\\.(?:${ID_CMDS})\\s+\\S`, "i");
export const ID_CMD_TYPED = new RegExp(`(^|\\s)\\.(?:${ID_CMDS})\\s$`, "i");

export function isChipField(f: string): boolean {
    return !!f && f !== "all" && !!Search.FIELDS[f];
}

// canonical string form: model:"fel reaver" -mechanic:knockback free words.
// The live input's contribution is spliced in at state.pos, so a query
// typed before or between chips serializes (and round-trips) in place.
// one chip as query text. The rule lives in pills.js (P.tagQuery) because
// pill queries are built there and the two must agree character for
// character — a pill click that did not serialize like a typed chip would
// not survive the URL.
export const tagStr = P.tagQuery;

// how ONE chip is written. Both serializers below go through it, so a chip
// list that is not the bar's own can never be quoted differently from one
// that is.
const chipStr = (c: Chip) => c.field === "all" ? c.text : tagStr(c.field, c.text, c.not);

// a chip list as query text — the inverse of parseQueryParts, and the form a
// URL carries. Split out from serializeQuery because a chip list that is NOT
// the bar's own also has to be written: a middle-click serializes the chips a
// click WOULD have committed, without committing them.
export const serializeChips = (chips: Chip[]): string => chips.map(chipStr).join(" ");

export function serializeQuery() {
    const parts = state.chips.map(chipStr);
    const at = Math.min(state.pos, state.chips.length);
    const inputText = qInput.value.trim();
    if (inputText) {
        parts.splice(at, 0, state.activeField ? tagStr(state.activeField, inputText, state.activeNot) : inputText);
    } else if (state.activeField) {
        parts.splice(at, 0, `${state.activeNot ? "-" : ""}${state.activeField}:`);
    }
    return parts.join(" ");
}

// parse a canonical string into an ordered chip list — field tags become
// field chips, runs of free words between them coalesce into single
// field:"all" chips, so the original word order survives the round-trip.
// A tag's value is one word, a "quoted group" (quotes stripped) or a
// (paren group) kept verbatim — the paren form carries values that contain
// phrase quotes. Everything else (bare "phrases" included, quotes kept so
// their exact-match meaning survives) is free text.
export function parseQueryParts(str: string): Chip[] {
    // Epsilon commands become id: tags (".cast 12345" -> id:12345);
    // inside "quoted phrases" the text stays literal
    str = (str || "").replace(ID_CMD_REWRITE,
        (m, pre: string | undefined) => pre === undefined ? m : pre + "id:");
    // `model:fire | frost` is ONE tag with two alternatives, so the bar's
    // air has to come out before the tag/free-text split runs — otherwise
    // `frost` lands outside the tag and means something else entirely.
    // (Inside a chip the tokenizer handles the same spacing; this is the
    // one thing it cannot see, because chip boundaries are decided here.)
    // Two exemptions: quoted spans, where a pipe is a literal character,
    // and a pipe before a REAL field tag — `a | model:b` is two search
    // terms with a stray bar, and joining would eat the tag.
    str = str.split(/("[^"]*"?)/).map((part, i): string => (i % 2 ? part
        : part.replace(/\s*\|\s*/g, (m, off: number, s: string) => {
            const tag = /^-?([a-z]+):/i.exec(s.slice(off + m.length));
            return tag && isChipField(canonField(tag[1].toLowerCase())) ? m : "|";
        }))).join("");
    const parts: Chip[] = [];
    const pushFree = (word: string) => {
        const last = parts[parts.length - 1];
        if (last && last.field === "all") last.text += " " + word;
        else parts.push({field: "all", text: word});
    };
    for (const m of (str || "").matchAll(/(?:(-)?([a-z]+):)?(?:\(([^)]*)\)|"([^"]*)"|([^\s"]+))/gi)) {
        const not = !!m[1];
        const field = canonField((m[2] || "").toLowerCase());
        if (isChipField(field)) {
            const text = (m[3] ?? m[4] ?? m[5] ?? "").trim();
            if (text) parts.push({field, text, not});
        } else {
            const t = m[0].trim(); // unknown prefixes and quotes stay literal
            if (t && t !== '""') pushFree(t);
        }
    }
    return parts;
}

// put a parsed chip list in the bar, caret after the last one; syncBar
// pulls the trailing free run back into the input
export function setChips(parts: Chip[]): void {
    ensureFieldsVisible(parts);
    state.chips = parts;
    state.activeField = null;
    state.activeNot = false;
    qInput.value = "";
    state.pos = state.chips.length;
    syncBar();
}

// load a canonical string into the bar: field tags become committed chips
export function loadQueryString(str: string): void {
    setChips(parseQueryParts(str));
}

// a numeric alternative, with the id sigil optional
const NUM_ALT = /^#?\d+$/;

/* The three shapes tokenSpans needs to recognise a comparison however it is
   spaced: an operator standing alone, the number that belongs to it, and a
   word with the whole comparison glued onto it. All three are built from the
   numeric grammar's own alphabet (pills.ts), so the tokenizer cannot come to
   read a different set of operators than the matcher accepts. */
const LONE_OP = new RegExp(`^(${P.CMP_OPS})$`);
const NUMBER = new RegExp(`^${P.NUM_SRC}$`);
const GLUED_CMP = new RegExp(`^([a-z][a-z_]*)((?:${P.CMP_OPS})${P.NUM_SRC})$`);

/**
 * A token's ALTERNATIVES — the values any one of which satisfies it.
 *
 * `|` always separates them: no corpus in any pack contains a pipe
 * (measured across names, model/sound paths, animations and fx on 9.2.7),
 * so it can never collide with real data.
 *
 * A COMMA separates them only when every piece is a number. Spell names
 * really do contain commas — 399 of them match "e," on 9.2.7 — so a
 * literal comma has to keep working, while `id:133,134` still reads as OR.
 * The rule is SYNTACTIC, not per-field: a comma between numbers means the
 * same thing in every chip, which is why this is not a return to
 * field-specific parsing.
 *
 * A "quoted phrase" is exempt — quoting is how you ask for the literal
 * character.
 */
/** One tokenizer span: the exact characters it covers, plus its reading. */
export interface TokenSpan {
    start: number;
    end: number;
    text: string;
    quoted: boolean;
    alts: string[];
}

function altsOf(text: string): string[] {
    if (text.includes("|")) {
        const parts = text.split("|").filter(Boolean);
        if (parts.length > 1) return parts;
    }
    if (text.includes(",")) {
        const parts = text.split(",").filter(Boolean);
        if (parts.length > 1 && parts.every((p) => NUM_ALT.test(p))) return parts;
    }
    return [text];
}

/**
 * THE tokenizer. One function, two readers: the search engine takes each
 * span's text and alternatives, the search bar's highlighting takes its
 * character offsets. Neither can disagree with the other about what a token
 * is — which is precisely how `fire | frost` once came to search correctly
 * and highlight as nothing at all.
 *
 * A span covers the EXACT characters it came from. Words split on
 * whitespace, except:
 *   - "quoted spans" stay whole — an exact phrase, spaces and word order
 *     preserved. An unclosed quote runs to the end (a phrase matches while
 *     it is still being typed).
 *   - an ALTERNATION is one span however it is spaced. `fire|frost`,
 *     `fire | frost` and `fire |frost` are the same token, so the operator
 *     means the same thing whether or not you put air around it.
 *   - a COMPARISON is one span however it is spaced, and never glued to the
 *     word in front of it: `seat >2`, `seat > 2` and `seat>2` all tokenize
 *     to `seat` + `>2`. Spacing is the last thing anyone should have to
 *     remember about a number, and doing it here means the engine, the
 *     capsule and the autocomplete all get it at once.
 */
export function tokenSpans(text: string): TokenSpan[] {
    const lower = text.toLowerCase();
    const spans: { start: number, end: number, text: string, quoted: boolean }[] = [];
    for (const m of lower.matchAll(/"([^"]*)(?:"|$)|([^\s"]+)/g)) {
        const quoted = m[1] !== undefined;
        const raw = quoted ? m[1] : m[2];
        const prev = spans[spans.length - 1];
        // a bar touching either side joins the two words into one token
        if (prev && !prev.quoted && !quoted
            && (prev.text.endsWith("|") || raw.startsWith("|"))) {
            prev.text += raw;
            prev.end = m.index + m[0].length;
            continue;
        }
        // a lone operator adopts the number after it (`> 2` -> `>2`). Only a
        // LONE one: `c'thun -> phase 2` must keep its arrow, and 265 spell
        // names on 9.2.7 carry one of these characters as ordinary text.
        if (prev && !prev.quoted && !quoted
            && LONE_OP.test(prev.text) && NUMBER.test(raw)) {
            prev.text += raw;
            prev.end = m.index + m[0].length;
            continue;
        }
        spans.push({start: m.index, end: m.index + m[0].length, text: raw, quoted});
    }
    const out: TokenSpan[] = [];
    for (const s of spans) {
        const t = s.text.replace(/\s+/g, " ").trim();
        // a token of nothing but separators is punctuation left over from a
        // half-written alternation; it can never match, so it must not
        // narrow the search to nothing either
        if (!t || (!s.quoted && /^[|,]+$/.test(t))) continue;
        // a glued `word>2` is the same two tokens, split back apart. Safe to
        // do blind: nothing in any pack's corpus has this shape (checked
        // across names, paths, animations and effect names on 9.2.7).
        const glued = !s.quoted && s.end - s.start === t.length && GLUED_CMP.exec(t);
        if (glued) {
            const cut = s.start + glued[1].length;
            out.push({start: s.start, end: cut, text: glued[1], quoted: false, alts: [glued[1]]});
            out.push({start: cut, end: s.end, text: glued[2], quoted: false, alts: [glued[2]]});
            continue;
        }
        out.push({...s, text: t, alts: s.quoted ? [t] : altsOf(t)});
    }
    return out;
}

/** The engine's view of a chip: just the text and the alternatives. */
function tokenizeQuery(text: string): QueryToken[] {
    return tokenSpans(text).map((s) => ({text: s.text, alts: s.alts}));
}

// group list for the engine: one group per chip + one for the live input,
// spliced in at state.pos so mid-bar typing groups correctly. Words in a
// group must match the same entity; groups AND together (not: true groups
// exclude instead).
export function currentGroups(): QueryGroup[] {
    const toGroup = (field: string, text: string, not?: boolean): QueryGroup | null => {
        const tokens = tokenizeQuery(text);
        return tokens.length ? {field, tokens, not: !!not} : null;
    };
    const groups = state.chips.map((c) => toGroup(c.field, c.text, c.not));
    const live = toGroup(state.activeField || "all", qInput.value, state.activeField ? state.activeNot : false);
    if (live) groups.splice(Math.min(state.pos, groups.length), 0, live);
    return groups.filter((g): g is QueryGroup => g !== null);
}
