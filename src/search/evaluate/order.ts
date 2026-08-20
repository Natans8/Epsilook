/**
 * @file Ordering a query's answer by its sort directives.
 *
 * A directive selects nothing — the answer set is the kernel's and stays exactly as counted — so ordering is a
 * separate read over the spells the kernel admitted. A spell's key on a door is its EXTREME over the rows it has
 * there, taken in the sort's direction, and a spell with no value on the door sorts last either way. A column or
 * a kind door whose rows can repeat keys by how many rows the spell has; a one-row column keys by its first
 * kind's subject, which is what sorting by it means — the spell's name, its id.
 */
import type {SortDirective} from "../language/ast";
import type {Kind} from "../schema/kinds";
import {kindsOf} from "../schema/schema";
import {fold} from "../text/normalize";
import {ordinal, ordinalRank} from "../vocabulary/value-types";
import type {Dataset, Row, Stored} from "./rows";

/** One spell's key on one door: a folded string, a number, or nothing to be ordered by. */
type Key = string | number | null;

/** The stored value one property carries on one row, read for ordering: named text first, then the value. */
function keyOf(stored: Stored | undefined): Key {
    if (stored === undefined) return null;
    if (typeof stored === "number") return stored;
    // An empty string is no value: a spell with a blank name has nothing to be ordered by, and an empty key
    // would sort FIRST ascending where the law says nothing sorts last.
    if (typeof stored === "string") return stored === "" ? null : fold(stored);
    const text = stored.text;
    return typeof text === "string" && text !== "" ? fold(text) : null;
}

/** A rung's key is its rank on the ladder: expansions order by age, never by how their names spell. */
function rungKey(stored: Stored | undefined): Key {
    const key = keyOf(stored);
    if (typeof key !== "string") return key;
    const rank = ordinalRank(key);
    return rank >= 0 ? rank : null;
}

/**
 * The key of a spell's values on one property of one kind: the extreme in the sort's direction, null with none.
 *
 * A single kind keys by its subject row — the first of the kind — never by an extreme over secondary rows: a
 * spell sorts by its name, not by whichever of its name and subtext happens to fold lower.
 */
function extreme(
    rows: readonly Row[], kind: Kind, name: string, descending: boolean, read: (stored: Stored | undefined) => Key,
): Key {
    let best: Key = null;
    for (const row of rows) {
        if (row.kind !== kind) continue;
        const value = read(row.props[name]);
        if (kind.single === true) return value;
        if (value === null) continue;
        if (best === null || (descending ? value > best : value < best)) best = value;
    }
    return best;
}

/**
 * A reader of one spell's key on one directive, closed over the dataset.
 *
 * A column whose rows can repeat keys by how many the spell has; a one-row column keys by its first kind's
 * subject. A kind door keys by ITS subject's value — sorting by what the door names — and only a kind with no
 * property at all falls back to counting its rows.
 */
function keyReader(sort: SortDirective, dataset: Dataset): (spell: number) => Key {
    const head = sort.head;
    const column = head.role === "column" ? head.column : head.kind.column;
    const source = dataset.source(column);
    if (source === null) return () => null;
    let kind: Kind | undefined;
    let name: string | undefined;
    if (head.role === "prop") {
        kind = head.kind;
        name = head.name;
    } else if (head.role === "column") {
        if (kindsOf(column).some((held) => held.single !== true)) {
            return (spell) => source.size?.(spell) ?? source.rows(spell).length;
        }
        kind = kindsOf(column)[0];
        name = kind === undefined ? undefined : Object.keys(kind.props)[0];
    } else {
        kind = head.kind;
        name = Object.keys(kind.props)[0];
    }
    if (kind === undefined) return () => null;
    const of = kind;
    if (name === undefined) return (spell) => source.rows(spell).filter((row) => row.kind === of).length;
    const prop = name;
    const read = of.props[prop]?.types[0] === ordinal ? rungKey : keyOf;
    return (spell) => extreme(source.rows(spell), of, prop, sort.descending, read);
}

/**
 * The answer in the directives' order: the found spells sorted by each directive in turn, nothing last.
 *
 * @param found The kernel's answer — ordering never changes what it holds.
 * @param sorts The directives, in written order.
 * @param dataset The dataset the keys are read from.
 * @returns The spells as a sorted array; insertion order where no directive stands.
 */
export function order(found: ReadonlySet<number>, sorts: readonly SortDirective[], dataset: Dataset): number[] {
    const spells = [...found];
    if (sorts.length === 0) return spells;
    const readers = sorts.map((sort) => keyReader(sort, dataset));
    const keys = spells.map((spell) => readers.map((read) => read(spell)));
    const at = new Map(spells.map((spell, index) => [spell, index]));
    spells.sort((a, b) => {
        const ka = keys[at.get(a) ?? 0];
        const kb = keys[at.get(b) ?? 0];
        for (const [k, sort] of sorts.entries()) {
            const va = ka[k];
            const vb = kb[k];
            if (va === vb) continue;
            // Nothing sorts last either way; a number and a string never meet on one door, but a defect that
            // put them there must order deterministically rather than throw.
            if (va === null) return 1;
            if (vb === null) return -1;
            if (typeof va !== typeof vb) return typeof va === "number" ? -1 : 1;
            if (sort.descending) return va < vb ? 1 : -1;
            return va < vb ? -1 : 1;
        }
        // Equal on every directive: the spell's own order keeps the result stable.
        return a - b;
    });
    return spells;
}
