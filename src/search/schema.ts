/**
 * @file Assembling the declarations into a schema, and refusing to run on a broken one.
 *
 * The columns, kinds and types are declared in their own files. Here they become a schema: one index the parser looks
 * a top-level query word up in, and the checks that hold the declarations to their contract.
 *
 * Words live in two namespaces. The top-level namespace holds column keys, the kind words declared global, and
 * property prefixes — everything that may open a tag at the start of a clause. Each column additionally holds its own
 * namespace of kind words, usable inside that column's scope; those may repeat across columns without colliding,
 * because the column has already been named by the time one is read.
 *
 * The checks run at import time and throw. A uniqueness rule that lives only in a document is one that gets broken
 * silently, and the failure is invisible from the outside: two things reachable by one spelling means a query means
 * different things depending on which declaration was registered first. Throwing at import makes the application, the
 * command line tools, the tests and the repository checks all fail identically and immediately.
 */
import type {Column} from "./columns";
import {COLUMNS} from "./columns";
import type {Kind, Prop} from "./kinds";
import {KINDS, operatorsOf} from "./kinds";
import {TYPES} from "./value-types";

/**
 * What a top-level word before a colon resolves to.
 *
 * The roles are told apart by which declaration claimed the word, not by anything in the text.
 */
export type Head =
    | { readonly role: "column"; readonly column: Column }
    | { readonly role: "kind"; readonly kind: Kind }
    | { readonly role: "prop"; readonly kind: Kind; readonly name: string; readonly prop: Prop };

/** Every top-level word that may open a tag, resolved. */
export const HEADS = new Map<string, Head>();

/**
 * Checks every declaration against its contract.
 *
 * @returns One line per problem, in declaration order, or an empty array when the schema is sound.
 */
export function schemaProblems(): string[] {
    const problems: string[] = [];
    const topLevel = new Map<string, string>();
    const perColumn = new Map<string, Map<string, string>>();

    const claim = (words: Map<string, string>, word: string, by: string): void => {
        const holder = words.get(word);
        if (holder !== undefined) {
            problems.push(`G1: "${word}" is claimed by both ${holder} and ${by}`);
            return;
        }
        words.set(word, by);
    };
    const columnWords = (key: string): Map<string, string> => {
        const words = perColumn.get(key) ?? new Map<string, string>();
        perColumn.set(key, words);
        return words;
    };

    for (const column of COLUMNS.values()) {
        if (column.head !== false) claim(topLevel, column.key, `column ${column.key}`);
    }

    // Chipless search answers a bare number as one identity, the spell's own id. A second plain notation that can
    // only match by equality would give the same digits a second meaning, so the check collects them all and allows
    // exactly one.
    const identityDoors: string[] = [];

    for (const kind of KINDS.values()) {
        if (COLUMNS.get(kind.column.key) !== kind.column) {
            problems.push(`kind ${kind.id} names an unregistered column "${kind.column.key}"`);
        }
        if (kind.word !== undefined) {
            claim(columnWords(kind.column.key), kind.word, `kind ${kind.id}`);
            if (kind.global === true) claim(topLevel, kind.word, `kind ${kind.id}`);
        } else if (kind.global === true) {
            problems.push(`kind ${kind.id} is global but has no word to be global with`);
        }

        for (const [name, prop] of Object.entries(kind.props)) {
            const where = `${kind.id}.${name}`;
            if (prop.prefix !== undefined) claim(topLevel, prop.prefix, `property ${where}`);
            const identity = prop.plain?.some((type) =>
                type.accepts.some((op) => op.name === "exact")
                && !type.accepts.some((op) => op.name === "contains"));
            if (identity === true) identityDoors.push(where);
            problems.push(...propProblems(where, prop));
        }
    }

    // A scoped word may repeat across columns, because the column has been named by the time one is read — but it
    // may not shadow a top-level word, or the same spelling would ask two different questions depending on where it
    // sits. Checked after every claim above, so declaration order cannot decide whether it fires.
    for (const kind of KINDS.values()) {
        if (kind.word === undefined || kind.global === true) continue;
        const holder = topLevel.get(kind.word);
        if (holder !== undefined && holder !== `kind ${kind.id}`) {
            problems.push(`"${kind.word}" of kind ${kind.id} shadows the top-level word of ${holder}`);
        }
    }

    if (identityDoors.length > 1) {
        problems.push(
            "chipless search reads more than one identity notation, so a bare number would mean "
            + `several things: ${identityDoors.join(", ")}`);
    }

    return problems;
}

/**
 * Checks one property against its contract.
 *
 * @param where The property's path, for the message.
 * @param prop The property.
 * @returns One line per problem.
 */
function propProblems(where: string, prop: Prop): string[] {
    const problems: string[] = [];

    if (prop.types.length === 0) {
        problems.push(`${where} declares no type`);
        return problems;
    }
    for (const type of prop.types) {
        if (TYPES.get(type.name) !== type) {
            problems.push(`${where} names an unregistered type "${type.name}"`);
        }
    }

    // A control offers only the operators every notation accepts. Presence alone is a legitimate property when one
    // type declares it, since a flag is nothing but presence, but several notations sharing only presence means each
    // was declared to be matched and none of them can be: the property can be asked whether it has a value and never
    // which one.
    if (prop.types.length > 1 && !operatorsOf(prop).some((op) => op !== "present")) {
        const names = prop.types.map((type) => type.name).join(" + ");
        problems.push(`${where} combines ${names}, which share no operator beyond presence`);
    }

    const plain = prop.plain ?? [];
    for (const type of plain) {
        if (!prop.types.includes(type)) {
            problems.push(`${where} reads "${type.name}" in chipless search but does not declare it`);
        }
    }

    // Chipless search is a ranked union. A contributing property with no tier ranks alongside every other, which puts
    // a description hit level with an exact name match and nothing to separate them.
    if (plain.length > 0 && prop.tier === undefined) {
        problems.push(`${where} is plain but declares no relevance tier`);
    }
    if (plain.length === 0 && prop.tier !== undefined) {
        problems.push(`${where} declares a relevance tier but is not plain`);
    }

    // A plain term arrives as a bare token, so a contributing notation must be able to answer one: `contains` for
    // anything textual, `exact` for the spell id. One that can only answer presence would join the union and silently
    // match nothing.
    for (const type of plain) {
        if (!type.accepts.some((op) => op.name === "contains" || op.name === "exact")) {
            problems.push(`${where} reads "${type.name}" in chipless search, which cannot answer a bare token`);
        }
    }

    // A sentinel names a stored number, so it can only stand in for a quantity.
    if (prop.sentinels !== undefined
        && !prop.types.some((type) => type.storage === "int" || type.storage === "float")) {
        problems.push(`${where} declares sentinels but no numeric notation to hold them`);
    }

    return problems;
}

/**
 * Validates the declarations and builds {@link HEADS}.
 *
 * Called at import time. Exported so a test can prove the checks fire rather than only that they pass: a guard nobody
 * has seen fail is not known to work.
 *
 * @throws If any declaration breaks its contract, naming every problem found.
 */
export function buildSchema(): void {
    const problems = schemaProblems();
    if (problems.length > 0) {
        throw new Error(`search schema is invalid:\n  ${problems.join("\n  ")}`);
    }

    HEADS.clear();
    for (const column of COLUMNS.values()) {
        if (column.head !== false) HEADS.set(column.key, {role: "column", column});
    }
    for (const kind of KINDS.values()) {
        if (kind.word !== undefined && kind.global === true) HEADS.set(kind.word, {role: "kind", kind});
        for (const [name, prop] of Object.entries(kind.props)) {
            if (prop.prefix !== undefined) HEADS.set(prop.prefix, {role: "prop", kind, name, prop});
        }
    }
}

/**
 * The kinds belonging to one column.
 *
 * @param column The column.
 * @returns Its kinds, in declaration order.
 */
export function kindsOf(column: Column): Kind[] {
    return [...KINDS.values()].filter((kind) => kind.column === column);
}

buildSchema();
