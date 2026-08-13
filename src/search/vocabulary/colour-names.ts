/**
 * @file The named colours a query may write instead of a hex triplet.
 *
 * The vocabulary is the CSS named-colour list, adopted rather than invented: it is the set every web user has already
 * met, and a name outside it is refused rather than guessed at. The list itself is the `color-name` package; this
 * module only packs its channel triplets into the 0xRRGGBB integers the data stores. Names are read on input and
 * never written — a stored colour always prints as its hex triplet.
 */
import colors from "color-name";

/** Every CSS named colour, packed as 0xRRGGBB. Keys are lowercase; fold the operand before looking one up. */
export const COLOUR_NAMES: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries(
    Object.entries(colors).map(([name, [r, g, b]]) => [name, (r << 16) | (g << 8) | b])));
