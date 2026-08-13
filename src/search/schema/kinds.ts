/**
 * @file What a kind IS: the shape one is declared in, and how a declaration is read.
 *
 * A column yields rows; a row has a kind; a kind declares properties; a property has a type. A kind is a noun naming
 * what a row IS -- a chain, a missile, a morph -- and its properties are what that thing HAS. The kinds themselves
 * are `catalogue.ts`; this file is the shape they are written in, and the registry every one of them lands in.
 *
 * Naming both ends of a pair matters. A beam carries a source attachment and a destination attachment, and they
 * differ on two thirds of the rows that have them, so a single unioned attachment cannot say which end a reader
 * meant. Two properties sharing one type is the whole mechanism; there is no separate notion of a role.
 *
 * One declaration feeds every surface: matching, autocomplete, generated help, the query bar, and the rendered pill.
 * Surfaces read a declaration through the accessors below rather than through its fields, because several of them
 * answer from more than one place: a word may be a shortcut for a longer name, a hint may be inherited from the
 * property's first type, a door may be the property's own name. Reading a field directly gets the shortcut and
 * misses the rule.
 *
 * TODO: declare the pill and the incomplete-chip placeholder once the renderer and the query bar exist to read them.
 */
import type {Column} from "./columns";
import {fold} from "../text/normalize";
import type {Sentinels} from "../vocabulary/units";
import type {AxisType, Value} from "../vocabulary/value-types";

/**
 * Relevance tiers for chipless search. Only the order matters: the best tier a spell matched in decides its rank.
 *
 * Without tiers a description-only hit ranks alongside an exact name match, with nothing to separate them.
 */
export const TIER = {
    /** The spell's own name. */
    name: 0,
    /** Its id, typed exactly. */
    id: 1,
    /** An asset it uses: a model, a sound, an animation, an icon. */
    asset: 2,
    /** What it says it does. */
    description: 3,
} as const;

/** One property of one kind. */
export interface Prop {
    /**
     * The notations this property accepts, in order. The first whose `parse` accepts an operand wins, so a thing
     * with both a name and an id declares `[id, text]`.
     *
     * A control offers only the operators every notation accepts, since an operator only one notation could answer
     * would behave differently depending on what the operand happened to look like. Matching is decided separately,
     * by dispatch: a bare word on an `[id, text]` property still matches the name, because the word dispatches to
     * `text`.
     */
    readonly types: readonly AxisType[];

    /**
     * The notations chipless search reads, always a subset of `types`. Absent means the property stays out of it.
     *
     * Declared per notation rather than per property because the two halves of an `[id, text]` property differ:
     * the name belongs in chipless search and the id does not, since a bare number there means the spell's own id
     * and nothing else. The one identity notation chipless search reads is the spell id's, and the schema checks
     * that it stays the only one.
     */
    readonly plain?: readonly AxisType[];

    /** The relevance tier a chipless hit on this property ranks at. Required with `plain`, meaningless without. */
    readonly tier?: number;

    /**
     * A top-level head reaching this property alone, such as `cast:` for the delivery kind's cast length.
     *
     * A door is earned, not automatic: most properties are reached through their kind and declare none.
     */
    readonly prefix?: string;

    /**
     * The unabbreviated name, where the property's name is a shortcut for a longer word.
     *
     * Reading and writing are declared apart because they are not symmetric, exactly as a numeric type's notations
     * are: every spelling reads, one spelling writes per surface. The name is what compact surfaces write — chips,
     * capsules, `format()` — and the full name is what naming surfaces write: help headings, control labels,
     * tooltips. It resolves wherever the name does: inside the kind's scope, and at the prefix door where one is
     * declared. Absent means the name is not a shortcut and names itself — read it with {@link propNameOf} rather
     * than the field.
     */
    readonly full?: string;

    /**
     * Equal alternative spellings of the property's words: regional variants, plurals, localised words if a locale
     * vocabulary ever ships. Ways in only — read wherever the name is, written nowhere.
     */
    readonly synonyms?: readonly string[];

    /**
     * Stored values that are not quantities, and the word each one means: a channel's -1 is `unlimited`, a cast
     * bar's 0 is `instant`.
     *
     * On the property rather than the type, because the word is this axis's vocabulary — the duration type the two
     * share knows neither. A sentinel word is read before any notation, so it can never be misread as a quantity.
     */
    readonly sentinels?: Sentinels;

    /**
     * One line describing the property, where the type's own hint is not specific enough.
     *
     * Absent means the first type's hint is used, which is the right text whenever the property adds nothing to what
     * the type already says. Read it with {@link hintOf} rather than the field.
     */
    readonly hint?: string;

    /**
     * Whether this property only refines another predicate rather than naming a subject of its own.
     *
     * A target is the first: "plays on the caster" says nothing about what kind of row is doing the playing. A scope
     * whose only positive constraint is a qualifier is legal but weak, so the parser warns on it instead of refusing
     * it.
     */
    readonly qualifier?: boolean;
}

export interface Kind {
    /** Stable identity, derived by {@link defineKind} as `column.word`. Never declared, never shown to a reader. */
    readonly id: string;

    /** The column this kind's rows appear in. A reference rather than a key, so a typo fails to compile. */
    readonly column: Column;

    /**
     * The word that names this kind inside its column, as in `model:mount` or `fx:{chain from:chest}`.
     *
     * Omitted when the column's own head already reaches this kind unambiguously.
     */
    readonly word?: string;

    /**
     * The unabbreviated name, where {@link word} is a shortcut for a longer word: `desc` is short for `description`.
     *
     * Reading and writing are declared apart because they are not symmetric, exactly as a numeric type's notations
     * are: every spelling reads, one spelling writes per surface. The word is what compact surfaces write — chips,
     * capsules, `format()` — and the full name is what naming surfaces write: help headings, control labels,
     * tooltips. It resolves exactly where the word does: inside the column, and at the top level when the kind is
     * global. Absent means the word is not a shortcut and names itself — read it with {@link nameOf} rather than
     * the field.
     */
    readonly full?: string;

    /**
     * Equal alternative spellings of {@link word}: regional variants, plurals, localised words if a locale
     * vocabulary ever ships. Ways in only — read wherever the word is, written nowhere.
     */
    readonly synonyms?: readonly string[];

    /**
     * Whether the word is also a top-level head, so `missile:{from:chest}` works without naming the column.
     *
     * A top-level door is earned: the word must be unique across every column, must name its subject with the column
     * removed, and must ask a question that is meaningful alone. Kinds that fail any of those stay reachable through
     * their column, where the column supplies the missing noun.
     */
    readonly global?: boolean;

    /**
     * The cluster this kind belongs to within its column, for surfaces that present kinds grouped.
     *
     * A label, not a mechanism: moving a kind between groups is an edit to this field and nothing else.
     */
    readonly group?: string;

    /**
     * Whether a spell carries at most one row of this kind, ever.
     *
     * The declaration that licenses reasoning across clauses: two top-level bounds on one of this kind's properties
     * describe the same row, so they may fuse to a range. Omitted means rows may repeat, and every clause stays its
     * own existential — declare it only where the row source guarantees the bound.
     */
    readonly single?: boolean;

    /** One line describing the kind to a reader. */
    readonly hint: string;

    readonly props: Readonly<Record<string, Prop>>;
}

/** Every declared kind, by id. */
export const KINDS = new Map<string, Kind>();

export function defineKind(spec: Omit<Kind, "id">): Kind {
    const kind: Kind = {...spec, id: `${spec.column.key}.${spec.word ?? spec.column.key}`};
    if (KINDS.has(kind.id)) throw new Error(`kind "${kind.id}" already defined`);
    KINDS.set(kind.id, kind);
    return kind;
}

/**
 * The operators a property offers a reader.
 *
 * @param prop The property.
 * @returns The operator names every one of the property's notations accepts.
 */
export function operatorsOf(prop: Prop): string[] {
    const [first, ...rest] = prop.types;
    return first.accepts
        .filter((op) => rest.every((type) => type.accepts.includes(op)))
        .map((op) => op.name);
}

/**
 * The line describing a property to a reader.
 *
 * @param prop The property.
 * @returns The property's own hint, or its first type's when it declares none.
 */
export function hintOf(prop: Prop): string {
    return prop.hint ?? prop.types[0].hint;
}

/**
 * The spelling compact surfaces write for a kind — chips, capsules, `format()`.
 *
 * @param kind The kind.
 * @returns Its word, or its column's key where it declares none and the column head is how it is reached.
 */
export function wordOf(kind: Kind): string {
    return kind.word ?? kind.column.key;
}

/**
 * The spelling naming surfaces write for a kind — help headings, control labels, tooltips.
 *
 * The default is defined here, not at each surface: an absent `full` means the word is not a shortcut and names
 * itself. Read it with this rather than the field, as {@link hintOf} reads hints.
 *
 * @param kind The kind.
 * @returns Its full name, or {@link wordOf} where it declares none.
 */
export function nameOf(kind: Kind): string {
    return kind.full ?? wordOf(kind);
}

/**
 * The spelling naming surfaces write for a property.
 *
 * @param name The property's own name — its key in the kind's declaration.
 * @param prop The property.
 * @returns Its full name, or the name itself where it declares none.
 */
export function propNameOf(name: string, prop: Prop): string {
    return prop.full ?? name;
}

/**
 * The spelling a property's top-level door is written with.
 *
 * @param name The property's own name — its key in the kind's declaration.
 * @param prop The property.
 * @returns Its prefix, or the name itself where it declares none.
 */
export function doorOf(name: string, prop: Prop): string {
    return prop.prefix ?? name;
}

/** One operand resolved against a property: the value, and the notation that accepted it. */
export interface ParsedValue {
    readonly type: AxisType;
    readonly value: Value;
}

/**
 * Reads one operand as a sentinel word, the one rule for every reader: folded, ignoring surrounding space.
 *
 * @param prop The property whose sentinels answer.
 * @param written One operand, as typed.
 * @returns The sentinel's stored value, or `null` when the operand names none.
 */
export function sentinelOf(prop: Prop, written: string): ParsedValue | null {
    const folded = fold(written.trim());
    for (const [stored, word] of Object.entries(prop.sentinels ?? {})) {
        if (folded === fold(word)) return {type: prop.types[0], value: Number(stored)};
    }
    return null;
}

/**
 * Reads one operand as a property's value.
 *
 * Sentinel words are read first, so a stored value that is not a quantity is reachable by its name and can never be
 * misread as one. The notations are then tried in declaration order, and the first to accept the operand wins —
 * which is the whole of multi-notation dispatch.
 *
 * @param prop The property.
 * @param written One operand, as typed.
 * @returns The value and the notation that read it, or `null` when nothing accepted the operand.
 */
export function parseValue(prop: Prop, written: string): ParsedValue | null {
    const sentinel = sentinelOf(prop, written);
    if (sentinel !== null) return sentinel;
    for (const type of prop.types) {
        const value = type.parse?.(written);
        if (value !== null && value !== undefined) return {type, value};
    }
    return null;
}

/**
 * Writes a property's stored value the way a pill prints it.
 *
 * @param prop The property.
 * @param value The stored value.
 * @returns The sentinel's word where one is declared, otherwise the first type's spelling.
 */
export function formatValue(prop: Prop, value: Value): string {
    const word = typeof value === "number" ? prop.sentinels?.[value] : undefined;
    if (word !== undefined) return word;
    return prop.types[0].format?.(value) ?? String(value);
}
