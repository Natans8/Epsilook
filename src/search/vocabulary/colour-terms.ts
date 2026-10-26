/*! The colour-word table is derived from c3, https://github.com/StanfordHCI/c3
 *
 * Copyright (c) 2011, Stanford University
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
 * following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice, this list of conditions and the following
 *   disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
 *   following disclaimer in the documentation and/or other materials provided with the distribution.
 *
 * * The name Stanford University may not be used to endorse or promote products derived from this software without
 *   specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
 * INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL STANFORD UNIVERSITY BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
 * OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
 * STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 * EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * Its naming data is the xkcd colour survey, released by Randall Munroe under CC0.
 */
/**
 * @file The words a query may name a colour by, and which stored colours answer to each.
 *
 * A colour word asks what people call a colour rather than how near it sits to one value: `purple` finds the muted
 * lilac a ghost is drawn in, which no single purple within a tolerance would. The answer is a colour-naming model's,
 * c3's, built from the names the xkcd survey's respondents gave; `tools/colour_terms.py` turns it into the table this
 * reads, so everything here is a lookup and nothing is worked out.
 *
 * The table is English and so is this vocabulary. Colour categories are not one to one between languages, so another
 * language brings a model of its own rather than a list of spellings onto these words.
 *
 * A colour carries every name that, taken with the likelier ones, covers half of what people called it, and a word
 * also stands for the more specific words under it: lavender, lilac and violet sit under purple, each word under the
 * basic colour terms people use for the same colours. So `purple` finds the colours people call purple and the ones
 * they call lavender, which is what a reader who types the general word means. A word names a set of colours, never
 * one, so anchoring it asks nothing more; an exact colour is written as a hex triplet.
 */
import table from "./colour-terms.json";
import {fold} from "../text/normalize";

/** Lookup cells per sRGB channel: a stored colour is read by the cell it falls in, so no colour arithmetic is done. */
const CELLS = 32;

/** The width of one cell in a channel. */
const SPAN = 256 / CELLS;

/** Every spelling a colour word is read from, folded, mapped to the word as it is written. */
export const COLOUR_WORDS: ReadonlyMap<string, string> = new Map(
    table.words.flatMap((word) => [[word, fold(word)], [fold(word), fold(word)]]));

/** The distinct sets of names a stored colour may carry, each the likeliest first. */
const NAMES: readonly (readonly string[])[] = table.names.map((names) => names.map(fold));

/** The words each word sits under, by word. A basic colour term sits under none. */
const BROADER: ReadonlyMap<string, readonly string[]> = new Map(
    Object.entries(table.broader).map(([word, above]) => [fold(word), above.map(fold)]));

/**
 * The cell a stored colour falls in.
 *
 * @param packed A colour as 0xRRGGBB.
 * @returns Its index into the table's cells.
 */
function cellOf(packed: number): number {
    const red = Math.floor(((packed >> 16) & 0xff) / SPAN);
    const green = Math.floor(((packed >> 8) & 0xff) / SPAN);
    const blue = Math.floor((packed & 0xff) / SPAN);
    return (red * CELLS + green) * CELLS + blue;
}

/**
 * Reads a colour word.
 *
 * @param written One operand, as typed.
 * @returns The word as it is written, or `undefined` when the operand names no colour in this vocabulary.
 */
export function colourWordOf(written: string): string | undefined {
    return COLOUR_WORDS.get(fold(written.trim()));
}

/**
 * The names people give a stored colour.
 *
 * @param packed A colour as 0xRRGGBB.
 * @returns Its names, the likeliest first; empty for a colour nobody named with a word in this vocabulary.
 */
export function namesOf(packed: number): readonly string[] {
    return NAMES[table.cells[cellOf(packed)]] ?? [];
}

/** Each word's test, built on first use: a matcher asks once per stored value, and the words are few. */
const TESTS = new Map<string, (packed: number) => boolean>();

/**
 * The test for one colour word against stored colours: a colour answers to a word it is called, or to a word over
 * one it is called.
 *
 * Each set of names is decided once, when the word's test is first built, so testing a stored colour is a lookup.
 *
 * @param word A word as {@link colourWordOf} returns it.
 * @returns Whether a stored colour answers to the word.
 */
export function answersTo(word: string): (packed: number) => boolean {
    const built = TESTS.get(word);
    if (built !== undefined) return built;
    const hits = NAMES.map((names) => names.some(
        (name) => name === word || (BROADER.get(name) ?? []).includes(word)));
    const test = (packed: number): boolean => hits[table.cells[cellOf(packed)]] ?? false;
    TESTS.set(word, test);
    return test;
}

/**
 * The table in the shape an engine in another language reads: the spellings that reach a word, the sets of names,
 * the words each sits under, and the set each cell carries, by position. Exported once, here, so the second engine
 * looks up exactly the folded words this one does.
 */
export const COLOUR_TERMS = Object.freeze({
    cells: CELLS,
    spellings: Object.fromEntries(COLOUR_WORDS),
    names: NAMES,
    broader: Object.fromEntries(BROADER),
    index: table.cells,
});
