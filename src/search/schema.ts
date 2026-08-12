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
 * A word may carry alternative spellings, and reading and writing are declared apart because they are not
 * symmetric — exactly as a numeric type's notations are. Every spelling reads: the word, its full name where the
 * word is a shortcut (`desc` for `description`), and its synonyms (regional variants, plurals, localised words).
 * One spelling writes per surface: compact surfaces print the word, naming surfaces print the full name. Each
 * alternative spelling occupies the word's namespaces and resolves to the same declaration, so the checks treat
 * them identically: it can collide and shadow exactly as the word can.
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
import {fold} from "./text-normalization";
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

/** The alternative spellings a declaration reads besides its own word: its full name, then its synonyms. */
function alternates(full: string | undefined, synonyms: readonly string[] | undefined): string[] {
    return [...(full === undefined ? [] : [full]), ...(synonyms ?? [])];
}

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
        if (column.head === false) {
            if (column.synonyms !== undefined) {
                problems.push(`column ${column.key} declares synonyms but no head for them to reach`);
            }
            continue;
        }
        claim(topLevel, column.key, `column ${column.key}`);
        for (const synonym of column.synonyms ?? []) {
            if (synonym === column.key) {
                problems.push(`column ${column.key} lists its own key as a synonym`);
                continue;
            }
            claim(topLevel, synonym, `column ${column.key}`);
        }
    }

    // Chipless search answers a bare number as one identity, the spell's own id. A second plain notation that can
    // only match by equality would give the same digits a second meaning, so the check collects them all and allows
    // exactly one.
    const identityDoors: string[] = [];
    const propNamespaces: Map<string, string>[] = [];

    for (const kind of KINDS.values()) {
        if (COLUMNS.get(kind.column.key) !== kind.column) {
            problems.push(`kind ${kind.id} names an unregistered column "${kind.column.key}"`);
        }
        if (kind.word !== undefined) {
            claim(columnWords(kind.column.key), kind.word, `kind ${kind.id}`);
            if (kind.global === true) claim(topLevel, kind.word, `kind ${kind.id}`);
            for (const spelling of alternates(kind.full, kind.synonyms)) {
                if (spelling === kind.word) {
                    problems.push(`kind ${kind.id} respells its own word "${spelling}"`);
                    continue;
                }
                claim(columnWords(kind.column.key), spelling, `kind ${kind.id}`);
                if (kind.global === true) claim(topLevel, spelling, `kind ${kind.id}`);
            }
        } else {
            if (kind.global === true) problems.push(`kind ${kind.id} is global but has no word to be global with`);
            if (kind.full !== undefined || kind.synonyms !== undefined) {
                problems.push(`kind ${kind.id} declares alternative spellings but no word for them to spell`);
            }
        }

        const propWords = new Map<string, string>();
        propNamespaces.push(propWords);
        for (const [name, prop] of Object.entries(kind.props)) {
            const where = `${kind.id}.${name}`;
            claim(propWords, name, `property ${where}`);
            for (const spelling of alternates(prop.full, prop.synonyms)) {
                if (spelling === name) {
                    problems.push(`property ${where} respells its own name "${spelling}"`);
                    continue;
                }
                claim(propWords, spelling, `property ${where}`);
                if (prop.prefix !== undefined) claim(topLevel, spelling, `property ${where}`);
            }
            if (prop.prefix !== undefined) claim(topLevel, prop.prefix, `property ${where}`);
            const identity = prop.plain?.some((type) =>
                type.accepts.some((op) => op.name === "exact")
                && !type.accepts.some((op) => op.name === "contains"));
            if (identity === true) identityDoors.push(where);
            problems.push(...propProblems(where, prop));
        }
    }

    // Input words arrive folded, and the fold rewrites regional spellings — so a declared word the fold changes can
    // never arrive as itself. It stays reachable only when its folded form is claimed by the same declaration, which
    // is what a synonym is for.
    const reachable = (words: Map<string, string>): void => {
        for (const [word, by] of words) {
            const folded = fold(word);
            if (folded !== word && words.get(folded) !== by) {
                problems.push(`"${word}" of ${by} is unreachable: input folds to "${folded}" — declare that as a synonym`);
            }
        }
    };
    reachable(topLevel);
    for (const words of perColumn.values()) reachable(words);
    for (const words of propNamespaces) reachable(words);

    // A scoped word may repeat across columns, because the column has been named by the time one is read — but it
    // may not shadow a top-level word, or the same spelling would ask two different questions depending on where it
    // sits. Checked after every claim above, so declaration order cannot decide whether it fires.
    for (const kind of KINDS.values()) {
        if (kind.word === undefined || kind.global === true) continue;
        for (const word of [kind.word, ...alternates(kind.full, kind.synonyms)]) {
            const holder = topLevel.get(word);
            if (holder !== undefined && holder !== `kind ${kind.id}`) {
                problems.push(`"${word}" of kind ${kind.id} shadows the top-level word of ${holder}`);
            }
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
        if (column.head === false) continue;
        for (const word of [column.key, ...(column.synonyms ?? [])]) {
            HEADS.set(word, {role: "column", column});
        }
    }
    for (const kind of KINDS.values()) {
        if (kind.word !== undefined && kind.global === true) {
            for (const word of [kind.word, ...alternates(kind.full, kind.synonyms)]) {
                HEADS.set(word, {role: "kind", kind});
            }
        }
        for (const [name, prop] of Object.entries(kind.props)) {
            if (prop.prefix === undefined) continue;
            for (const word of [prop.prefix, ...alternates(prop.full, prop.synonyms)]) {
                HEADS.set(word, {role: "prop", kind, name, prop});
            }
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

/**
 * Resolves a word inside a column's scope to the kind it names, by its word, its full name or any synonym.
 *
 * The scoped counterpart of {@link HEADS}: the uniqueness checks guarantee at most one kind answers, and a wordless
 * kind is never a match, because it has no word for the other spellings to respell.
 *
 * @param column The column whose scope the word was read in.
 * @param word The word, already folded.
 * @returns The kind, or `undefined` when the column has none by that spelling.
 */
export function kindIn(column: Column, word: string): Kind | undefined {
    for (const kind of KINDS.values()) {
        if (kind.column !== column || kind.word === undefined) continue;
        if (kind.word === word || kind.full === word || (kind.synonyms?.includes(word) ?? false)) return kind;
    }
    return undefined;
}

/**
 * Resolves a word inside a kind's scope to the property it names, by its name, its full name or any synonym.
 *
 * @param kind The kind whose scope the word was read in.
 * @param word The word, already folded.
 * @returns The property's own name — what a reference and every compact surface carry — or `undefined`.
 */
export function propIn(kind: Kind, word: string): string | undefined {
    for (const [name, prop] of Object.entries(kind.props)) {
        if (name === word || prop.full === word || (prop.synonyms?.includes(word) ?? false)) return name;
    }
    return undefined;
}

buildSchema();
