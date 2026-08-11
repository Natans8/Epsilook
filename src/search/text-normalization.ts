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
    /** Typographic single quotes and the acute accent to a plain apostrophe. */
    [/[‘’‛´]/g, "'"],
    /** En dash, em dash, figure dash and the minus sign to a plain hyphen. */
    [/[–—‒−]/g, "-"],
    /** Every non-breaking, thin and zero-width space to a plain space. */
    [/[  -‍  　﻿]/g, " "],
    /** Full-width colon to the colon that binds an axis to its value. */
    [/：/g, ":"],
];

/** Anything that is not a letter or a digit, in any script. */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

/**
 * Returns text with letter case and invisible typographic variation removed.
 *
 * Structure is preserved: spacing, punctuation and word order are untouched, so a phrase still means the sequence of
 * characters it appears to mean.
 *
 * Case folding is locale-independent by design. A locale-aware fold would make the same query return different
 * results for a Turkish reader, whose dotless i lowercases differently.
 *
 * @param text Text from a query or from the game data.
 * @returns The normalised form, for comparing whole values.
 */
export function fold(text: string): string {
    let out = text.normalize("NFC").toLowerCase();
    for (const [pattern, replacement] of SUBSTITUTIONS) out = out.replace(pattern, replacement);
    return out;
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
