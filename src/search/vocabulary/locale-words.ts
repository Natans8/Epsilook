/**
 * @file The active language's query words: extra ways IN to the words the schema declares.
 *
 * A locale vocabulary lands as more synonym rows, never as a second mechanism: these words resolve exactly where a
 * declared synonym does, collide under the same checks, and are written by no surface — chips, capsules and
 * formatted queries spell the canonical word. The table is plain data selected by language, so the schema stays one
 * set of declarations whatever the reader speaks.
 *
 * This module holds only the active table. Validation against the schema and the rebuild of the head index live
 * with the schema, which this layer must not import.
 */

/** One language's query words. Every list is extra spellings, folded the way query input is. */
export interface QueryWords {
    /** Extra spellings of a column head, by column key. */
    readonly columns?: Readonly<Record<string, readonly string[]>>;

    /** Extra spellings of a kind's word, by kind id (`column.word`). */
    readonly kinds?: Readonly<Record<string, readonly string[]>>;

    /** Extra spellings of a property's name, by `<kind id>.<name>`. */
    readonly props?: Readonly<Record<string, readonly string[]>>;

    /** Extra spellings of a unit symbol, by the symbol itself. */
    readonly units?: Readonly<Record<string, readonly string[]>>;
}

let active: QueryWords = {};
let generation = 0;

/** One shared empty list, so a lookup that finds nothing allocates nothing — these run inside per-token scans. */
const NONE: readonly string[] = [];

/**
 * Replaces the active query-word table.
 *
 * Callers go through the door's apply function, which validates the table against the schema and rebuilds the head
 * index; setting the table alone leaves the top-level words stale.
 */
export function setQueryWords(words: QueryWords): void {
    active = words;
    generation += 1;
}

/** A counter that moves whenever the active table changes, for caches built over what these getters return. */
export function queryWordsGeneration(): number {
    return generation;
}

/** The active table's extra spellings for a column head. */
export function localeColumnWords(key: string): readonly string[] {
    return active.columns?.[key] ?? NONE;
}

/** The active table's extra spellings for a kind's word. */
export function localeKindWords(id: string): readonly string[] {
    return active.kinds?.[id] ?? NONE;
}

/** The active table's extra spellings for a property's name, keyed `<kind id>.<name>`. */
export function localePropWords(ref: string): readonly string[] {
    return active.props?.[ref] ?? NONE;
}

/** The active table's extra spellings for a unit symbol. */
export function localeUnitWords(symbol: string): readonly string[] {
    return active.units?.[symbol] ?? NONE;
}
