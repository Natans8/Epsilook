/**
 * @file Assembling the declarations into a schema, and refusing to run on a broken one.
 *
 * The columns, kinds and types are declared in their own files. Here they become a schema: one index the parser looks
 * a query word up in, and the checks that hold the declarations to their contract.
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
 * What a word before a colon resolves to.
 *
 * A column key and a kind word are told apart by which declaration claimed the word, not by anything in the text.
 *
 * TODO: add the property prefix, the global door for a property shared by several kinds, once a union axis exists to
 * be reached through it.
 */
export type Head =
    | { readonly role: "column"; readonly column: Column }
    | { readonly role: "kind"; readonly kind: Kind };

/**
 * Every word that may appear before a colon, resolved.
 *
 * Column keys and kind words share this namespace because they share a position in the query text.
 */
export const HEADS = new Map<string, Head>();

/**
 * Checks every declaration against its contract.
 *
 * @returns One line per problem, in declaration order, or an empty array when the schema is sound.
 */
export function schemaProblems(): string[] {
    const problems: string[] = [];
    const claimed = new Map<string, string>();

    const claim = (word: string, by: string): void => {
        const holder = claimed.get(word);
        if (holder !== undefined) {
            problems.push(`G1: "${word}" is claimed by both ${holder} and ${by}`);
            return;
        }
        claimed.set(word, by);
    };

    for (const column of COLUMNS.values()) {
        if (column.head !== false) claim(column.key, `column ${column.key}`);
    }

    for (const kind of KINDS.values()) {
        if (COLUMNS.get(kind.column.key) !== kind.column) {
            problems.push(`kind ${kind.id} names an unregistered column "${kind.column.key}"`);
        }
        if (kind.word !== undefined) claim(kind.word, `kind ${kind.id}`);

        for (const [name, prop] of Object.entries(kind.props)) {
            problems.push(...propProblems(`${kind.id}.${name}`, prop));
        }
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

    // Chipless search is a ranked union. A contributing property with no tier ranks alongside every other, which puts
    // a description hit level with an exact name match and nothing to separate them.
    if (prop.plain && prop.tier === undefined) {
        problems.push(`${where} is plain but declares no relevance tier`);
    }
    if (!prop.plain && prop.tier !== undefined) {
        problems.push(`${where} declares a relevance tier but is not plain`);
    }

    // A plain term arrives as a bare token, so at least one notation must be able to answer one: `contains` for
    // anything textual, `exact` for an id, which is how a lone number reaches an exact spell lookup without the engine
    // special-casing it. A property that can only answer presence would join the union and silently match nothing.
    if (prop.plain && !prop.types.some((type) =>
        type.accepts.some((op) => op.name === "contains" || op.name === "exact"))) {
        problems.push(`${where} is plain but no declared type can answer a bare token`);
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
        if (kind.word !== undefined) HEADS.set(kind.word, {role: "kind", kind});
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
