/**
 * @file The result columns, and the words that reach them in a query.
 *
 * A column is a source of rows and the results column that renders them. Its key is also a query head, reaching
 * every row in the column at once; a kind's own word is the narrower door, which is why a spell's name is reached
 * as `name:` rather than through something invented to avoid a collision.
 */
import {t} from "../../i18n";

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

    /**
     * Equal alternative spellings of the key, resolved wherever the key is a head: plurals, full words, localised
     * words if a locale vocabulary ever ships. Ways in only — every rendering surface writes the key or the label.
     *
     * Reading and writing are declared apart because they are not symmetric, exactly as a numeric type's notations
     * are: every spelling reads, one spelling writes per surface. A column's two writing roles already exist — the
     * key is its compact form and the label its name — so unlike a kind or a property it needs no `full` field.
     */
    readonly synonyms?: readonly string[];
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
    label: t("ui:column.spell"),
    hint: t("tooltips:column.spell"),
});

/** A spell's number and the expansion it arrived in. */
export const idColumn = defineColumn({
    key: "id",
    label: t("ui:column.id"),
    hint: t("tooltips:column.id"),
});

export const modelColumn = defineColumn({
    key: "model",
    label: t("ui:column.model"),
    synonyms: ["models"],
    hint: t("tooltips:column.model"),
});

export const soundColumn = defineColumn({
    key: "sound",
    label: t("ui:column.sound"),
    synonyms: ["sounds"],
    hint: t("tooltips:column.sound"),
});

export const animColumn = defineColumn({
    key: "anim",
    label: t("ui:column.anim"),
    synonyms: ["animation", "animations"],
    hint: t("tooltips:column.anim"),
});

export const fxColumn = defineColumn({
    key: "fx",
    label: t("ui:column.fx"),
    synonyms: ["effects"],
    hint: t("tooltips:column.fx"),
});

export const mechColumn = defineColumn({
    key: "mech",
    label: t("ui:column.mech"),
    synonyms: ["mechanics"],
    hint: t("tooltips:column.mech"),
});
