/**
 * @file The tone a column wears, in both the forms a query is drawn in.
 *
 * A column's colour is one decision and three surfaces spend it: a committed chip fills its enclosure with it, a
 * raw run of query text tints its head with it, and the control surface draws an offer as the chip it would
 * become. The classes differ because the surfaces differ — a fill is not an ink — but WHICH columns have a tone
 * is one answer, so it is stated once here rather than as a table beside each drawing.
 *
 * Written as three tables it had already spread that far, and a column added to one of them would have shown two
 * colours for one axis with nothing declaring the disagreement.
 */
import chips from "./chip.module.css";
import runs from "./classed.module.css";

/** The two classes one column's tone is spent as: an enclosure's fill, and raw text's ink. */
interface Tone {
    /** What a chip, a lane or an offer's head cell fills itself with. */
    readonly chip: string;
    /** What a head reaching this column is inked in, wherever raw query text is painted. */
    readonly run: string;
}

/**
 * The toned columns. A column absent here renders neutral, which is what an undeclared tone means.
 *
 * `id` takes the spell column's tone deliberately: it asks about the same subject from the other side, and a
 * colour of its own would say the two were different axes.
 */
const TONES: Record<string, Tone | undefined> = {
    model: {chip: chips.toneModel, run: runs.runModel},
    sound: {chip: chips.toneSound, run: runs.runSound},
    anim: {chip: chips.toneAnim, run: runs.runAnim},
    fx: {chip: chips.toneFx, run: runs.runFx},
    mech: {chip: chips.toneMech, run: runs.runMech},
    spell: {chip: chips.toneSpell, run: runs.runSpell},
    id: {chip: chips.toneSpell, run: runs.runSpell},
};

/**
 * The fill one column wears, for any surface drawing in the chip language.
 *
 * @param column The column's key, or nothing where the thing drawn reaches no column.
 * @returns Its tone class, or an empty string where the column declares none — a class list joins either way.
 */
export const toneOf = (column: string | undefined): string => (column === undefined ? "" : TONES[column]?.chip ?? "");

/**
 * The ink one column wears, wherever raw query text is painted.
 *
 * @param column The column's key.
 * @returns Its tone class, or undefined where the column declares none — the caller then falls back to the
 *   colour the run's own KIND asks for, which is a different question and not this one's to answer.
 */
export const runToneOf = (column: string): string | undefined => TONES[column]?.run;
