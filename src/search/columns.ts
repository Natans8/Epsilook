/* SEARCH 2.0 — L3 schema. THE COLUMNS.
 *
 * A column is a SOURCE OF ROWS and the results column that renders them. In
 * 1.0 it was a `run()` function per field — `spellsByModel`, `spellsBySound`,
 * `spellsByAnim`, `spellsByFx`, `spellsByName` and the mech sweep, six
 * hand-written matchers that had to agree with each other about what a chip
 * means. In 2.0 it is a NAME and nothing else.
 *
 * ⭐ WHY THERE IS NO `rows()` HERE, WHICH IS THE 2026-08-11 CORRECTION
 * (PLAN §3.2b): `rows(d, spellId): Row[]` forces every backend to answer "give
 * me the rows of spell N" — N round trips for SQL, absurd for HTTP. So the row
 * source moved BELOW the backend seam, into `backend/memory.ts`, where it is
 * one implementation's business rather than part of the language contract. A
 * SQL backend would emit a WHERE clause and never mention a row.
 *
 * What is left is the identity every layer shares: the key a query writes
 * (`model:`), and the label a header prints.
 *
 * ⚠ NO `icon` FIELD YET. SEARCH.md §2.3 sketches one and points at §6, which
 * is the list of things "designed for, not built" — column iconography is on
 * it. Declaring glyphs here would mean inventing eight of them, and this repo
 * has been bitten by declarations nothing can be wrong about. It is one line
 * when the icons exist.
 */

export interface Column {
    /** What a query writes before the colon: `model:{...}`. */
    readonly key: string;
    /** The results header, and the word the help uses. */
    readonly label: string;
    /** One line: what this column is ABOUT, in the user's terms. */
    readonly hint: string;
}

export const COLUMNS = new Map<string, Column>();

export function defineColumn(column: Column): Column {
    if (COLUMNS.has(column.key)) throw new Error(`column "${column.key}" already defined`);
    const frozen = Object.freeze({...column});
    COLUMNS.set(column.key, frozen);
    return frozen;
}

/* ══════════════════════════════════════════════════ THE SEVEN ══════════
 *
 * ⚠ SEVEN, NOT 1.0's EIGHT: `all` is gone. It was never a column — it is
 * chipless search, which L7 makes a DECLARED UNION of the axes that opt in
 * (`plain: true`) rather than a pseudo-field holding seven hand-written calls.
 * SEARCH.md §8.4.
 *
 * THE LINE BETWEEN `fx` AND `mech` IS "CAN YOU SEE IT?" — the rule 1.0's own
 * registry states and which decides several placements that look arbitrary
 * from outside. fx is what the spell LOOKS like; mech is what it DOES. So a
 * vehicle seat, an invisibility channel, a bound key and a movement-speed
 * change all sit in mech and render nothing, while `scale` stays in fx despite
 * being an aura exactly like speed, because a size change is visible.
 */

export const nameColumn = defineColumn({
    key: "name",
    label: "Name",
    hint: "what the spell is called, what it says it does, and its icon",
});

export const idColumn = defineColumn({
    key: "id",
    label: "ID",
    hint: "the spell's own number, and the expansion that introduced it",
});

export const modelColumn = defineColumn({
    key: "model",
    label: "Models",
    hint: "the 3D models a spell draws — missiles, ground effects, attachments",
});

export const soundColumn = defineColumn({
    key: "sound",
    label: "Sounds",
    hint: "the sound files a spell plays, and the kits they come from",
});

export const animColumn = defineColumn({
    key: "anim",
    label: "Animations",
    hint: "how the character moves — replacements, kits, loose animations",
});

export const fxColumn = defineColumn({
    key: "fx",
    label: "Effects",
    hint: "what the spell looks like — beams, glows, tints, morphs, size changes",
});

export const mechColumn = defineColumn({
    key: "mech",
    label: "Mechanics",
    hint: "what the spell does — effects, auras, timing, links and gates",
});
