/* The translation template: what a language has to say, and how much of it is said.
 *
 *   npm run translate                        coverage for every language beside English
 *   npm run translate -- --lang=ru           one language
 *   npm run translate -- --lang=ru --write   create or update its skeleton files
 *   npm run translate -- --lang=ru --worksheet   the untranslated keys as TSV, for a spreadsheet
 *
 * A language has two things to translate and they are unrelated. The PROSE catalogs are what the app says to a
 * reader - diagnostics, tooltips, labels, the rule bible - and their keys are English's, so the skeleton is the
 * English key set with empty values. The QUERY WORDS are extra spellings a reader may TYPE, and their keys are the
 * schema's own declarations, so that skeleton is generated from the declarations rather than from a file.
 *
 * An empty value means "not translated yet" in both, and both fall back to English rather than showing a gap: a
 * prose key falls back per key, and an empty word list adds no spelling. So a half-finished language is a legal
 * state at every moment, which is what lets a translator stop anywhere. Deleting a key is identical in behaviour
 * to leaving it empty - a translator who will never translate a section may remove it.
 *
 * Writing preserves every value already there. The skeleton follows English's own key order, so the two files read
 * side by side.
 */
import {readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";
import {parseArgs} from "node:util";

import {COLUMNS, KINDS, TYPES} from "../src/search/index";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = resolve(ROOT, "src", "locales");
const SOURCE = "en";

/* STDOUT IS THE RESULT; everything else is stderr - the same rule as tools/query.ts. */
const out = (line: string): void => void process.stdout.write(line + "\n");
const toStderr = (...a: unknown[]): void => void process.stderr.write(a.map(String).join(" ") + "\n");
console.log = console.info = console.debug = toStderr;

/** A catalog as it lives on disk: nested objects with string leaves. */
type Catalog = {[key: string]: string | Catalog};

/** One key of a prose catalog, flattened to the dotted form `t` reads it by. */
interface Entry {
    readonly key: string;
    readonly source: string;
    readonly translated: string;
}

/** Reads one JSON file, or an empty object where it does not exist. */
function readJson(path: string): Catalog {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Catalog : {};
}

/** Writes one JSON file in the repository's own shape: two-space indent, trailing newline. */
function writeJson(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Every leaf of a catalog, in declaration order, as dotted keys. */
function flatten(node: Catalog, prefix = ""): Map<string, string> {
    const found = new Map<string, string>();
    for (const [name, value] of Object.entries(node)) {
        const key = prefix === "" ? name : `${prefix}.${name}`;
        if (typeof value === "string") found.set(key, value);
        else for (const [inner, text] of flatten(value, key)) found.set(inner, text);
    }
    return found;
}

/** Rebuilds a nested catalog from dotted keys, in the order given. */
function nest(entries: Iterable<readonly [string, string]>): Catalog {
    const root: Catalog = {};
    for (const [key, value] of entries) {
        const parts = key.split(".");
        let at = root;
        for (const part of parts.slice(0, -1)) {
            const held = at[part];
            at = typeof held === "object" ? held : (at[part] = {});
        }
        at[parts[parts.length - 1]] = value;
    }
    return root;
}

/** The namespaces English declares, which are the ones a language may translate. */
function namespaces(): string[] {
    return readdirSync(resolve(LOCALES, SOURCE))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .filter((name) => name !== "query");
}

/** One namespace's keys, with what the language has for each. */
function entriesOf(language: string, namespace: string): Entry[] {
    const source = flatten(readJson(resolve(LOCALES, SOURCE, `${namespace}.json`)));
    const held = flatten(readJson(resolve(LOCALES, language, `${namespace}.json`)));
    return [...source].map(([key, text]) => ({key, source: text, translated: held.get(key) ?? ""}));
}

/**
 * The query-word skeleton, read off the declarations rather than off a file.
 *
 * Every spelling a reader may type is a key here: the column heads, the words that name a kind inside its column,
 * the property names, and the symbols a quantity is written with. A symbol that is punctuation rather than a word
 * is included too - whether `%` has a spelling in another language is the translator's call, not this tool's.
 */
function queryWords(language: string): Record<string, Record<string, readonly string[]>> {
    const held = readJson(resolve(LOCALES, language, "query.json")) as unknown as
        Record<string, Record<string, readonly string[]>>;
    const carried = (section: string, key: string): readonly string[] => held[section]?.[key] ?? [];

    const columns: Record<string, readonly string[]> = {};
    for (const column of COLUMNS.values()) {
        if (column.head === false) continue;
        columns[column.key] = carried("columns", column.key);
    }

    const kinds: Record<string, readonly string[]> = {};
    const props: Record<string, readonly string[]> = {};
    for (const kind of [...KINDS.values()].toSorted((a, b) => a.id.localeCompare(b.id))) {
        if (kind.word !== undefined) kinds[kind.id] = carried("kinds", kind.id);
        for (const name of Object.keys(kind.props)) {
            props[`${kind.id}.${name}`] = carried("props", `${kind.id}.${name}`);
        }
    }

    const units: Record<string, readonly string[]> = {};
    for (const type of TYPES.values()) {
        for (const notation of type.notations ?? []) {
            if (notation.unit !== "") units[notation.unit] = carried("units", notation.unit);
        }
    }

    return {columns, kinds, props, units};
}

/** How many of a section's entries carry something. */
function done(values: Iterable<string | readonly string[]>): number {
    return [...values].filter((value) => value.length > 0).length;
}

const {values} = parseArgs({
    options: {
        lang: {type: "string", default: ""},
        write: {type: "boolean", default: false},
        worksheet: {type: "boolean", default: false},
        help: {type: "boolean", default: false, short: "h"},
    },
});

if (values.help) {
    out(`
The translation template - what a language has to say, and how much of it is said.

  npm run translate                            coverage for every language beside English
  npm run translate -- --lang=ru               one language
  npm run translate -- --lang=ru --write       create or update its skeleton files
  npm run translate -- --lang=ru --worksheet   the untranslated keys as TSV

An empty value means "not translated": prose falls back to English per key, and an
empty word list adds no spelling, so a half-finished language is legal at every moment.
`.trim());
    process.exit(0);
}

const languages = values.lang !== ""
    ? [values.lang]
    : readdirSync(LOCALES, {withFileTypes: true})
        .filter((entry) => entry.isDirectory() && entry.name !== SOURCE)
        .map((entry) => entry.name);

if (languages.length === 0) {
    toStderr(`no language beside ${SOURCE}; name one with --lang=<code> to start it`);
    process.exit(1);
}

for (const language of languages) {
    const directory = resolve(LOCALES, language);
    const fresh = !existsSync(directory);
    if (fresh && !values.write) {
        toStderr(`${language}: no src/locales/${language}/ yet - run with --write to create it`);
        continue;
    }
    if (values.write) mkdirSync(directory, {recursive: true});

    if (values.worksheet) {
        /* One row per untranslated key: the key, what English says, and a column for the translation. Tab-separated
         * because that is what a spreadsheet pastes into cleanly, and the translation column is deliberately empty. */
        for (const namespace of namespaces()) {
            for (const entry of entriesOf(language, namespace)) {
                if (entry.translated === "") out(`${namespace}:${entry.key}\t${entry.source}\t`);
            }
        }
        continue;
    }

    out(`\n  ${language}   src/locales/${language}/`);
    let missing = 0;
    for (const namespace of namespaces()) {
        const entries = entriesOf(language, namespace);
        const carried = entries.filter((entry) => entry.translated !== "").length;
        missing += entries.length - carried;
        out(`    ${namespace.padEnd(14)} ${String(carried).padStart(4)} / ${String(entries.length).padEnd(4)} translated`);
        if (values.write) {
            writeJson(resolve(directory, `${namespace}.json`),
                nest(entries.map((entry) => [entry.key, entry.translated] as const)));
        }
    }

    const words = queryWords(language);
    const total = Object.values(words).reduce((sum, section) => sum + Object.keys(section).length, 0);
    const filled = Object.values(words).reduce((sum, section) => sum + done(Object.values(section)), 0);
    out(`    ${"query".padEnd(14)} ${String(filled).padStart(4)} / ${String(total).padEnd(4)} words`
        + `   (${Object.entries(words).map(([name, section]) =>
            `${name} ${done(Object.values(section))}/${Object.keys(section).length}`).join(", ")})`);
    if (values.write) writeJson(resolve(directory, "query.json"), words);

    if (values.write) {
        out(`    written; ${missing + total - filled} entries still empty`);
        if (fresh) {
            out(`    ⚠ a new language must also be registered, or nothing loads it:`);
            out(`        src/i18n/resources.ts   import its four catalogs and add them to \`resources\``);
            out(`        src/search/language/query-words.ts   import its query.json and add it to \`TABLES\``);
        }
    }
}
out("");
