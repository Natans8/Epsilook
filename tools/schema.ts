/**
 * @file Prints the query language's declarations as JSON, for an engine written in another language.
 *
 *     npm run schema                  the whole schema, to stdout
 *
 * The catalogue, the value types with their notations, the operators, the target roles and the grammar's own
 * characters are data already; this reads them through the engine's own door and writes them out with nothing derived
 * or re-spelled. A second engine built on this output parses the same words and compares the same stored numbers, and
 * a declaration added on the web reaches it without an edit anywhere — which is what makes the addon's data a
 * transform of the app rather than a second account of it.
 *
 * Only what a reader consumes is exported: an optional field a declaration leaves unset is omitted rather than
 * written as null, and a field only the web's own surfaces read (relevance tiers, the `single` fact the simplifier
 * reasons with, the qualifier warning, kind groups, operator precedence) stays out. Exporting a field nothing
 * consumes is a promise nobody made.
 */
import type {Notation, Operator} from "../src/search/index";
import {
    COLOUR_NAMES, COLOUR_TOLERANCE, COLUMNS, doorOf, GRAMMAR, hintOf, KINDS, OPERATORS, ROLES, TYPES, wordOf,
} from "../src/search/index";

/** The shape of this output. A reader refuses another rather than misreading it. */
const SCHEMA_FORMAT = 1;

/** A record with its undefined and null fields left out, so an absent declaration is an absent key. */
function trimmed<T extends Record<string, unknown>>(record: T): Partial<T> {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null)) as
        Partial<T>;
}

/** One notation, with its defaults made explicit so a reader has no defaults of its own to get wrong. */
function notation(note: Notation): Record<string, unknown> {
    return {
        unit: note.unit,
        aliases: note.aliases ?? [],
        position: note.position ?? "after",
        factor: note.factor,
        offset: note.offset ?? 0,
        sign: note.sign ?? "optional",
        bare: note.bare ?? "any",
    };
}

function operator(op: Operator): Record<string, unknown> {
    return trimmed({
        name: op.name,
        symbol: op.symbol,
        aliases: op.aliases ?? [],
        form: op.form,
        level: op.level,
        hint: op.hint,
    });
}

function main(): void {
    const columns = [...COLUMNS.values()].map((column) => ({
        key: column.key,
        label: column.label,
        hint: column.hint,
        head: column.head ?? true,
        synonyms: column.synonyms ?? [],
    }));

    const kinds = [...KINDS.values()].map((kind) => trimmed({
        id: kind.id,
        column: kind.column.key,
        word: wordOf(kind),
        // Whether the word is a kind's own, as opposed to the column key standing in for a wordless kind. A reader
        // resolves `model:mount` through kinds with a word and reaches a wordless kind through its column alone.
        worded: kind.word !== undefined,
        full: kind.full,
        synonyms: kind.synonyms ?? [],
        global: kind.global ?? false,
        hint: kind.hint,
        props: Object.entries(kind.props).map(([name, prop]) => trimmed({
            name,
            types: prop.types.map((type) => type.name),
            plain: (prop.plain ?? []).map((type) => type.name),
            door: prop.prefix === undefined ? undefined : doorOf(name, prop),
            full: prop.full,
            synonyms: prop.synonyms ?? [],
            // As pairs rather than a record: a record keyed by a number is a record keyed by its decimal spelling once
            // serialised, and a reader would have to know to convert the key back.
            sentinels: Object.entries(prop.sentinels ?? {}).map(([value, word]) => ({value: Number(value), word})),
            hint: hintOf(prop),
        })),
    }));

    // A flag has no storage: the field is left out, as every unset field is.
    const types = Object.fromEntries([...TYPES.values()].map((type) => [type.name, trimmed({
        storage: type.storage,
        accepts: type.accepts.map((op) => op.name),
        quantity: type.quantity ?? false,
        notations: (type.notations ?? []).map(notation),
        hint: type.hint,
    })]));

    const out = {
        format: SCHEMA_FORMAT,
        grammar: GRAMMAR,
        columns,
        kinds,
        types,
        operators: [...OPERATORS.values()].map(operator),
        roles: ROLES,
        colourTolerance: COLOUR_TOLERANCE,
        colourNames: COLOUR_NAMES,
    };
    process.stdout.write(JSON.stringify(out, null, 1) + "\n");
}

main();
