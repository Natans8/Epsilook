/**
 * @file The result columns, and the words that reach them in a query.
 *
 * A column is a source of rows and the results column that renders them. Its key is also a query head, reaching
 * every row in the column at once; a kind's own word is the narrower door, which is why a spell's name is reached
 * as `name:` rather than through something invented to avoid a collision.
 */

export interface Column {
    /** What a query writes before the colon: `model:{...}`. */
    readonly key: string;
    /** The results header, and the word the help uses. */
    readonly label: string;
    /** One line describing what the column is about. */
    readonly hint: string;

    /**
     * Whether the key is also a query head, reaching every row in the column.
     *
     * Defaults to true. A column may decline where asking about it as a whole is not a question anyone has, leaving
     * the key free and the words to its kinds. Every current column keeps it.
     */
    readonly head?: boolean;
}

export const COLUMNS = new Map<string, Column>();

export function defineColumn(column: Column): Column {
    if (COLUMNS.has(column.key)) throw new Error(`column "${column.key}" already defined`);
    const frozen = Object.freeze({...column});
    COLUMNS.set(column.key, frozen);
    return frozen;
}


/**
 * The spell itself: its name, description, icon, and how it goes off. The head is total — every spell has a name —
 * so it is answered when asked and never offered; the kinds' words are how a reader actually arrives.
 */
export const spellColumn = defineColumn({
    key: "spell",
    label: "Spell",
    hint: "the spell itself — its name, what it says it does, its icon, and how it casts",
});

/** A spell's number and the expansion it arrived in. */
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
