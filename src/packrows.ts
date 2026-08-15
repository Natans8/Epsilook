/**
 * @file Reading the pack's row tables, and handing 1.0 back the columns it was written against.
 *
 * The pack ships rows now: per column, the distinct rows of each kind pooled once, and per spell how many rows it has
 * and which pooled rows they are. That is the shape search 2.0 evaluates, and the shape this file exists to read.
 *
 * Nothing here serves the shipped 1.0 engine. That engine is dead code being replaced, not a compatibility target,
 * so a pack shape it cannot read is not a problem this file solves.
 */

/** One kind's pooled rows: its property columns, and how each property resolves. */
export interface KindPool {
    /** Per property, one value per pooled row. A kind carrying no property has no entry at all. */
    readonly values: Readonly<Record<string, readonly number[]>>;
    /** Per property, the vocabulary its stored number is keyed by. A property absent from this IS its number. */
    readonly vocab: Readonly<Record<string, string>>;
    /** Per property, the stored value meaning it has none. */
    readonly absent: Readonly<Record<string, number>>;
}

/**
 * One query column's rows.
 *
 * `refs` numbers rows across the whole column: the pools are laid end to end in `kinds` order, so one integer names
 * both the kind and the row within it. `counts` is how many rows each spell has, in spell order — a count rather than
 * an offset because the counts are almost all nought, one or two and compress to nothing, where a running offset is a
 * rising six-digit number. The offsets are the prefix sum, computed once by {@link indexRows}.
 *
 * `carried` holds columns no property of the kind declares — which dissolve a row is, the aura sharing an effect's
 * row. They are what the 1.0 bridge below rebuilds its arrays from, and they sit apart from `values` so that what the
 * evaluator reads stays exactly what the catalogue declares.
 */
export interface RowTable {
    readonly kinds: readonly string[];
    readonly sizes: readonly number[];
    readonly values: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>>;
    readonly carried?: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>>;
    readonly vocab: Readonly<Record<string, Readonly<Record<string, string>>>>;
    readonly absent: Readonly<Record<string, Readonly<Record<string, number>>>>;
    readonly counts: readonly number[];
    readonly refs: readonly number[];
}

/** Where one vocabulary lives, and how it is keyed. */
export interface VocabWhere {
    /** The section holding it. */
    readonly in: string;
    /** The column holding the keys, where the vocabulary is two parallel arrays. Absent means index by the number. */
    readonly keys?: string;
    /**
     * The column holding the values.
     *
     * With `keys`, the two are parallel arrays a reader pairs into a map. Without it, this column is itself indexed
     * by the stored number. Absent altogether, the section IS the lookup.
     */
    readonly values?: string;
}

/** A pooled row, located: which kind it is and which slot of that kind's pool. */
export interface RowAt {
    readonly kind: string;
    readonly slot: number;
}

/**
 * The column's rows, indexed for reading.
 *
 * `at` is the prefix sum of the counts, one longer than the spell count, so a spell's rows are `refs[at[i]..at[i+1]]`.
 * `owner` maps a reference to its kind and slot without a search per reference.
 */
export interface RowIndex {
    readonly table: RowTable;
    readonly at: Int32Array;
    readonly owner: readonly RowAt[];
}

/**
 * Prefix-sums a row table's counts and lays out its pool bases.
 *
 * @param table The column's row table.
 * @returns The table with the two lookups a reader needs.
 */
export function indexRows(table: RowTable): RowIndex {
    const at = new Int32Array(table.counts.length + 1);
    for (let i = 0; i < table.counts.length; i++) at[i + 1] = at[i] + table.counts[i];

    const owner: RowAt[] = [];
    for (let k = 0; k < table.kinds.length; k++) {
        for (let slot = 0; slot < table.sizes[k]; slot++) owner.push({kind: table.kinds[k], slot});
    }
    return {table, at, owner};
}

/**
 * Every row one spell has, as the kind it is and the slot holding its values.
 *
 * @param index The indexed table.
 * @param spell The spell's index, dense from zero.
 * @returns Its rows, in the order the pack ships them.
 */
export function rowsAt(index: RowIndex, spell: number): RowAt[] {
    const rows: RowAt[] = [];
    for (let i = index.at[spell]; i < index.at[spell + 1]; i++) rows.push(index.owner[index.table.refs[i]]);
    return rows;
}

/**
 * One property's stored number on one pooled row, or `undefined` where the row has no value for it.
 *
 * @param table The column's row table.
 * @param row The located row.
 * @param prop The property name.
 * @returns The stored number, or `undefined` when the property is absent from this kind or unset on this row.
 */
export function storedAt(table: RowTable, row: RowAt, prop: string): number | undefined {
    const column = table.values[row.kind]?.[prop];
    if (column === undefined) return undefined;
    const value = column[row.slot];
    return value === (table.absent[row.kind]?.[prop] ?? 0) ? undefined : value;
}

/**
 * What a loaded pack looks like to the row reader.
 *
 * Declared here rather than taken from the shipped engine's `SpellPack`, because that type describes the sections the
 * OLD app reads and this reads the ones it does not. The index signature is the honest form: a pack is a bag of
 * sections by name, and which of them a vocabulary points at is the pack's own business.
 */
export interface RowPack {
    readonly rowVocabs?: Readonly<Record<string, VocabWhere>>;

    readonly [section: string]: unknown;
}

/**
 * One query column's row table.
 *
 * @param pack The loaded pack.
 * @param column The column key, as the pack names it: `model`, `sound`, `anim`, `fx`, `mech`.
 * @returns The table.
 * @throws If the pack ships none — a pack too old to carry rows cannot be read at all, and saying so beats every
 *   column quietly answering nothing.
 */
export function rowTableOf(pack: RowPack, column: string): RowTable {
    const table = pack[`${column}Rows`] as RowTable | undefined;
    if (table === undefined) throw new Error(`pack ships no ${column}Rows`);
    return table;
}
