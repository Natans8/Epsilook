/* SEARCH 2.0 — L3 schema. ASSEMBLY AND THE GATES.
 *
 * The columns and the kinds are declared in their own files; this is where the
 * declarations become a SCHEMA — one head index the parser can look a word up
 * in, and the checks that make sure two declarations never claim the same
 * word.
 *
 * ⭐ IT RUNS AT IMPORT TIME AND IT THROWS. Per this repo's own standing rule
 * that PROSE CANNOT FIRE: a uniqueness rule written in a document is a rule
 * that gets broken, and 1.0 broke this exact one — `attach` is registered both
 * as a model category word and as the attachment keyword, so `model:attach` is
 * 16 and `model:{attach:chest}` is 51,581. Nothing warned, because nothing
 * could. Here a collision cannot survive `import`: the app, the CLI, the
 * tests and `tools/check.py` all fail identically and immediately.
 */
import type {Column} from "./columns";
import {COLUMNS} from "./columns";
import type {Kind, Prop} from "./kinds";
import {KINDS} from "./kinds";
import {TYPES} from "./value-types";

/**
 * What a word before a colon resolves to.
 *
 * TWO ROLES, because SEARCH.md §2.4.1's `head := column | kind | axis` has
 * three and the third does not exist yet: a property is reachable inside its
 * kind's scope (`missile:{from:chest}`), and a property PREFIX — the global
 * door for a union axis such as `attach` over `from`/`to` — is PHASE 5.
 */
export type Head =
    | { readonly role: "column"; readonly column: Column }
    | { readonly role: "kind"; readonly kind: Kind };

/**
 * G1 — THE UNIQUENESS GATE, and the only one of L5.1's four a script can
 * decide.
 *
 * Every word that may appear before a colon, resolved. A column key and a kind
 * word share this namespace because they share the position in the text, and
 * two things reachable by one spelling is L12 (3) — a form that means two
 * things depending on hidden state.
 */
export const HEADS = new Map<string, Head>();

/** Everything wrong with the declarations, in declaration order. */
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

function propProblems(where: string, prop: Prop): string[] {
    const problems: string[] = [];

    if (prop.types.length === 0) {
        problems.push(`${where} declares no type`);
    }
    for (const type of prop.types) {
        if (TYPES.get(type.name) !== type) {
            problems.push(`${where} names an unregistered type "${type.name}"`);
        }
    }

    /* L7 — plain search is a DECLARED union, RANKED. A contributing axis with
     * no tier is exactly 1.0's defect: `FIELDS.all` reads seven corpora and
     * ranks on the name alone, so a description-only hit sits in the same
     * bucket as an exact name match with nothing to sink it. */
    if (prop.plain && prop.tier === undefined) {
        problems.push(`${where} is plain but declares no relevance tier`);
    }
    if (!prop.plain && prop.tier !== undefined) {
        problems.push(`${where} declares a relevance tier but is not plain`);
    }

    /* A PLAIN TERM IS A BARE TOKEN, so at least one of the property's types
     * must be able to answer one. `contains` for anything textual, `exact` for
     * an id — which is how a lone number in chipless search reaches the exact
     * spell-ID lookup without a special case in the engine. A property whose
     * only type is `flag` (presence alone) could never match a typed word, and
     * declaring it plain would put it in the union silently answering nothing. */
    if (prop.plain && !prop.types.some((type) =>
        type.accepts.some((op) => op.name === "contains" || op.name === "exact"))) {
        problems.push(`${where} is plain but no declared type can answer a bare token`);
    }

    return problems;
}

/**
 * Build `HEADS`, or throw naming everything wrong.
 *
 * Called at import time below. Exported so a test can prove the gate FIRES
 * rather than merely that it passes — a guard nobody has seen fail is not
 * known to work, which is how `check_layers` came to miss the side-effect
 * import shape for a year.
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

/** Every kind that belongs to one column, in declaration order. */
export function kindsOf(column: Column): Kind[] {
    return [...KINDS.values()].filter((kind) => kind.column === column);
}

buildSchema();
