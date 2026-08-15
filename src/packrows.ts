/**
 * @file Reading the pack's row tables, and handing 1.0 back the columns it was written against.
 *
 * The pack ships rows now: per column, the distinct rows of each kind pooled once, and per spell how many rows it has
 * and which pooled rows they are. That is the shape search 2.0 evaluates, and the shape this file exists to read.
 *
 * It also exists to keep the shipped app working without rewriting it. Every 1.0 reader in `data.ts` was written
 * against parallel arrays with the spell repeated beside each value, so {@link expand} puts the rows back into exactly
 * that shape once at load. The reader above it is unchanged; only where it gets its arrays from moved. When PHASE 14
 * deletes 1.0, this half of the file goes with it and the row reading stays.
 *
 * The expansion is not a cost the old shape avoided: `buildIndexes` walked those same arrays into maps anyway, so the
 * work is the same walk one step earlier.
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

/* ------------------------------------------------------------------ the 1.0 bridge */

/**
 * The arrays one legacy section was made of: `spellIds` and the rest, all parallel.
 *
 * Named rather than left a bare record of arrays so the readers that take one keep their own shape check: a caller
 * handing over something with no `spellIds` finds out here rather than at runtime.
 */
export type LegacyColumns = { spellIds: number[] } & Record<string, number[]>;

/**
 * One legacy array: where its value comes from, and what it holds when a row has none.
 *
 * `from` is a list because one legacy array often served several properties the row model names apart — `srcAttach`
 * held a missile's launch point and everything else's single attachment, which are `from` and `attach` here. The first
 * property the row's kind actually declares wins.
 */
interface LegacyColumn {
    readonly from: readonly string[];
    /**
     * What to write where the kind declares none of `from`.
     *
     * Declared per array rather than read off the kind, because the kind has nothing to say about a property it does
     * not have: an unset attachment is `-1` to every reader below and an unset file is `0`, and guessing one would
     * quietly turn the other into a real value.
     */
    readonly missing: number;
}

/** One legacy section: which kinds' rows filled it, and what each of its arrays read. */
interface Legacy {
    /** The kinds contributing rows, and the value the `cats` array carries for each where one is wanted. */
    readonly kinds: Readonly<Record<string, number>>;
    /** The legacy array name, and where it came from. */
    readonly columns: Readonly<Record<string, LegacyColumn>>;
    /** Whether the legacy shape carries a `cats` array naming which kind each row came from. */
    readonly cats?: boolean;
    /**
     * The columns that identify one legacy row, where the rows expand past it.
     *
     * Three fx families expand one effect into a row per texture it paints with, so the rows outnumber the effects and
     * the section they replaced had one row per effect. Naming what identified a row there collapses them back, and
     * every other column is taken from the first row of the run — which is sound because the expansion varies nothing
     * else.
     *
     * It is a LIST because that is what a legacy row was keyed by: `spellFx` held one row per (chain, attach pair,
     * mask), so a beam drawn between two different attachment points was two rows and naming the chain alone would
     * silently lose one of them.
     */
    readonly unique?: readonly string[];
}

/** One column of one kind's pool, wherever it lives: a declared property, or a column the row carries. */
function columnOf(table: RowTable, kind: string, name: string): readonly number[] | undefined {
    return table.values[kind]?.[name] ?? table.carried?.[kind]?.[name];
}

/**
 * The columns several legacy sections were made of, rebuilt from the rows that replaced them.
 *
 * One walk for all of them, because the walk is the expensive half: the mech table holds three quarters of a million
 * references and the eight sections it replaced would otherwise each sweep every one.
 *
 * Absence is written back as the legacy sentinel rather than dropped: `data.ts` reads `-1` for an unset attachment and
 * `0` for an unset file, and a shorter array would silently shift every row after the gap.
 *
 * @param table The column's row table.
 * @param spellIds Every spell id, in the pack's own order — the order `counts` is parallel to.
 * @param specs Per section name, which kinds fill it and what each of its arrays reads.
 * @returns Per section name, the legacy arrays, `spellIds` first and each parallel to the others.
 */
export function expandAll<K extends string>(
    table: RowTable, spellIds: readonly number[], specs: Readonly<Record<K, Legacy>>,
): Record<K, LegacyColumns> {
    const index = indexRows(table);
    const entries = Object.entries(specs) as [K, Legacy][];
    const out = {} as Record<K, LegacyColumns>;
    for (const [name, spec] of entries) {
        const columns: LegacyColumns = {spellIds: []};
        for (const column of Object.keys(spec.columns)) columns[column] = [];
        if (spec.cats) columns.cats = [];
        out[name] = columns;
    }

    // Per spell, the keys already taken for each `unique` section — allocated once and cleared, because a spell's
    // rows are a handful and a fresh set per spell per section is a quarter of a million allocations.
    const seen = entries.map(() => new Set<string>());
    for (let i = 0; i < spellIds.length; i++) {
        for (const set of seen) set.clear();
        for (let at = index.at[i]; at < index.at[i + 1]; at++) {
            const row = index.owner[table.refs[at]];
            for (let s = 0; s < entries.length; s++) {
                const [name, spec] = entries[s];
                const cat = spec.kinds[row.kind];
                if (cat === undefined) continue;
                if (spec.unique !== undefined) {
                    const key = spec.unique
                        .map((one) => columnOf(table, row.kind, one)?.[row.slot]).join("|");
                    if (seen[s].has(key)) continue;
                    seen[s].add(key);
                }
                const columns = out[name];
                columns.spellIds.push(spellIds[i]);
                if (spec.cats) columns.cats.push(cat);
                for (const [column, source] of Object.entries(spec.columns)) {
                    const found = source.from
                        .map((one) => columnOf(table, row.kind, one))
                        .find((column_) => column_ !== undefined);
                    columns[column].push(found === undefined ? source.missing : found[row.slot]);
                }
            }
        }
    }
    return out;
}

/**
 * The columns one legacy section was made of, rebuilt from the rows that replaced it.
 *
 * @param table The column's row table.
 * @param spellIds Every spell id, in the pack's own order — the order `counts` is parallel to.
 * @param spec Which kinds fill the section and what each of its arrays reads.
 * @returns The legacy arrays, `spellIds` first, each parallel to the others.
 */
export function expand(
    table: RowTable, spellIds: readonly number[], spec: Legacy,
): LegacyColumns {
    return expandAll(table, spellIds, {only: spec}).only;
}

/**
 * The rider's animations as (spell, anim, role) rows.
 *
 * A passenger row carries one property per role and sets exactly one of them, so the role is which property is set —
 * the shape 1.0 reads as a role number is recovered from the property's position.
 *
 * @param table The anim column's row table.
 * @param spellIds Every spell id, in the pack's own order.
 * @param roles The role words in role order, from the pack's own `passengerRoleNames`.
 * @returns The legacy arrays.
 */
export function passengerRows(
    table: RowTable, spellIds: readonly number[], roles: readonly string[],
): { spellIds: number[]; animIds: number[]; roles: number[] } {
    const index = indexRows(table);
    const out = {spellIds: [] as number[], animIds: [] as number[], roles: [] as number[]};
    for (let i = 0; i < spellIds.length; i++) {
        for (const row of rowsAt(index, i)) {
            if (row.kind !== "passenger") continue;
            for (let role = 0; role < roles.length; role++) {
                const anim = storedAt(table, row, roles[role]);
                if (anim === undefined) continue;
                out.spellIds.push(spellIds[i]);
                out.animIds.push(anim);
                out.roles.push(role);
            }
        }
    }
    return out;
}
