/**
 * @file Normalising text so that two spellings of the same thing compare equal.
 *
 * Both sides of a comparison are normalised with the same function. Normalising only the query would strand data
 * rather than reach it: a spell name containing an em dash would become unreachable by a typed hyphen instead of more
 * reachable.
 *
 * Two levels, because they answer different questions:
 *
 * - {@link fold} preserves the shape of the text and only removes differences a user cannot see or control:
 *   letter case, and characters that editors and chat clients substitute silently. Used where the whole value is
 *   being compared.
 * - {@link squash} additionally removes every character that is not a letter or a digit, so `antimagic` finds
 *   `Anti-Magic`. Used for partial matching, where a user typing a name from memory should not have to reproduce its
 *   punctuation.
 */

import {SPELLING_FOLDS} from "./spelling-folds";

/**
 * Characters that carry the same meaning as a plainer character.
 *
 * Word processors, browsers and chat clients substitute these silently, so text pasted from a conversation arrives
 * carrying them while the game's own data does not.
 *
 * Written as escapes rather than literals: several are invisible, or indistinguishable from the character they fold
 * to, and a literal one cannot be reviewed in a diff.
 */
const SUBSTITUTIONS: readonly (readonly [RegExp, string])[] = [
    /** Typographic double quotes to the plain quote that delimits a phrase. */
    [/[“”„‟]/g, '"'],
    /**
     * Typographic single quotes and both stray accents to a plain apostrophe. The grave accent (backtick) is a
     * chat-era stand-in for one — zero names carry it while 14,819 carry the apostrophe, so folding cannot strand
     * data (measured on 9.2.7).
     */
    [/[‘’‛´`]/g, "'"],
    /** En dash, em dash, figure dash and the minus sign to a plain hyphen. */
    [/[–—‒−]/g, "-"],
    /** Every non-breaking, thin and zero-width space to a plain space. */
    [/[  -‍  　﻿]/g, " "],
    /** Full-width colon to the colon that binds an axis to its value. */
    [/：/g, ":"],
];

/**
 * Regional spellings folded to the spelling the game data uses, whole words only.
 *
 * The game is written in American English, so its data says color where a reader may equally type colour. Folding
 * the pair — on both sides, like everything here — makes either spelling reach data written in either. The pairs
 * come generated from VarCon via {@link ./spelling-folds!SPELLING_FOLDS}; inflections are their own pairs, which
 * is why the match is word-bounded rather than substring.
 *
 * These change the text's length, so they belong to {@link fold} and never to {@link foldTypography}, whose
 * one-character-to-one-character contract the parser depends on. Match-time only.
 */
const SPELLING_MAP = new Map(SPELLING_FOLDS);
const SPELLING = new RegExp(`\\b(?:${SPELLING_FOLDS.map(([variant]) => variant).join("|")})\\b`, "g");

/** Anything that is not a letter or a digit, in any script. */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

/**
 * The client's UI escape sequences, so that markup never becomes a search term.
 *
 * Spell text carries the same escapes the game renders: colour runs, inline textures, atlas sprites, spell links and
 * pluralisation. They are shipped rather than stripped, because a reader is meant to see the colours — which leaves
 * matching to remove them, on both sides, exactly as it removes letter case.
 *
 * Written to match the lowercased text {@link fold} has already produced, so the uppercase spellings the game also
 * uses (`|C`, `|R`) need no second branch.
 *
 * What each arm keeps is a judgement about what a reader was shown:
 *
 * - A hyperlink keeps its display text and drops the target: `|Hspell:195131|h[Aldrachi Brand]|h` reads as
 *   `[Aldrachi Brand]`, which is the phrase on screen.
 * - A texture and an atlas sprite are dropped whole. Their payload is a file path or a sheet region, not prose, and
 *   keeping it would make every description carrying an icon match `interface` or `blp`.
 * - Pluralisation keeps both forms, so `|4Icicle:Icicles;` is reachable by either.
 * - `|n` is a line break, so it becomes a space rather than nothing; `||` is a literal pipe.
 */
const MARKUP =
    /\|\||\|h[^|]*\|h(.*?)\|h|\|t[^|]*\|t|\|a:[^|]*\|a|\|4([^;]*);|\|cniq\d+:|\|cn[a-z_]+:|\|c[0-9a-f]{8}|\|r|\|n|\|w/g;

/**
 * Returns text with the UI escape sequences removed and the words they wrapped kept.
 *
 * @param text Lowercased text from a query or from the game data.
 * @returns The same text carrying no markup.
 */
function stripMarkup(text: string): string {
    // Measured on 9.2.7: 98.7% of spell text carries no pipe at all, so the test earns its place.
    if (!text.includes("|")) return text;
    return text.replace(MARKUP, (match, linked?: string, plural?: string) => {
        if (match === "||") return "|";
        if (linked !== undefined) return linked;
        if (plural !== undefined) return plural.replace(/:/g, " ");
        return match === "|n" ? " " : "";
    });
}

/**
 * Returns text with the typographic substitutions applied and nothing else.
 *
 * Every substitution replaces one character with one character, so each position in the result lines up with the same
 * position in the input. The parser depends on that: it reads the substituted text while reporting every span against
 * the text as typed.
 *
 * @param text Text as typed or pasted.
 * @returns The same text with substituted characters restored to their plain forms.
 */
export function foldTypography(text: string): string {
    let out = text;
    for (const [pattern, replacement] of SUBSTITUTIONS) out = out.replace(pattern, replacement);
    return out;
}

/**
 * Returns text with letter case, invisible typographic variation, UI markup and regional spellings removed.
 *
 * Structure is preserved: spacing, punctuation and word order are untouched, so a phrase still means the sequence of
 * characters it appears to mean. Length may change — a folded regional spelling is shorter, and a stripped colour run
 * shorter still — so positions in the result do not line up with the input; {@link foldTypography} is the
 * position-preserving subset.
 *
 * Case folding is locale-independent by design. A locale-aware fold would make the same query return different
 * results for a Turkish reader, whose dotless i lowercases differently.
 *
 * @param text Text from a query or from the game data.
 * @returns The normalised form, for comparing whole values.
 */
export function fold(text: string): string {
    return stripMarkup(foldTypography(text.normalize("NFC").toLowerCase()))
        .replace(SPELLING, (word) => SPELLING_MAP.get(word) ?? word);
}

/**
 * Returns text reduced to its letters and digits, with case and typography folded first.
 *
 * `Anti-Magic Shell` becomes `antimagicshell`, so a reader who remembers a name but not its punctuation still finds
 * it. Applying this to both sides of a partial match is what makes the behaviour symmetric rather than a trick that
 * works in one direction.
 *
 * Not suitable for whole-value comparison: it makes `Fire Ball` and `Fireball` indistinguishable, which is correct
 * for a substring search and wrong for an exact one.
 *
 * @param text Text from a query or from the game data.
 * @returns The normalised form, for partial matching.
 */
export function squash(text: string): string {
    return fold(text).replace(NON_ALPHANUMERIC, "");
}
