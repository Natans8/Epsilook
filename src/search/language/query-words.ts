/**
 * @file Applying the reader's language to the query words.
 *
 * A language adds ways IN — extra spellings that resolve wherever a declared synonym does — and changes what no
 * surface writes: the canonical words stay English, so a shared query reads the same whatever language it was typed
 * in. The table applied here follows the string registry's language, one setting speaking both the chrome and the
 * syntax; the language of the loaded pack is a separate, independent choice.
 *
 * Applying runs at import time, exactly as the string registry's language selection does: registries resolve their
 * words when they load, so changing language is a reload.
 */
import {i18n} from "../../i18n";
import ruQuery from "../../locales/ru/query.json";
import {COLUMNS} from "../schema/columns";
import {KINDS} from "../schema/kinds";
import {buildSchema} from "../schema/schema";
import type {QueryWords} from "../vocabulary/locale-words";
import {setQueryWords} from "../vocabulary/locale-words";
import {notationProblems} from "../vocabulary/units";
import {TYPES} from "../vocabulary/value-types";

/** The query-word table of each language that has one. English needs none: its words are the canonical spellings. */
const TABLES: Readonly<Record<string, QueryWords>> = {ru: ruQuery};

/** The languages with a registered table, for the test that proves every shipped table validates. */
export const QUERY_WORD_LANGUAGES: readonly string[] = Object.keys(TABLES);

/** Whether the words in force are the empty table, so applying empty over empty can skip the rebuild. */
let appliedEmpty = true;

/**
 * Applies one language's query words and rebuilds the head index.
 *
 * A language with no table applies the empty one, which restores the declared words alone. A table passed
 * explicitly is applied in place of the registered one — the door a test proves the mechanism through.
 *
 * @param language The language code, as the string registry resolves it.
 * @param words The table to apply, defaulting to the language's registered one.
 * @throws If the table names a column, kind or property the schema does not declare — a misspelt key would
 *   otherwise be a word that silently never resolves — or if an added word collides with an existing one, through
 *   the same checks a declared synonym faces.
 */
export function applyQueryWords(language: string, words: QueryWords = TABLES[language] ?? {}): void {
    // Nothing to apply over nothing: at import time the schema was just built, and rebuilding it for the empty
    // English table would repeat the whole validation walk for an identical result.
    const empty = Object.keys(words).length === 0;
    if (empty && appliedEmpty) return;

    const problems: string[] = [];
    for (const key of Object.keys(words.columns ?? {})) {
        if (!COLUMNS.has(key)) problems.push(`column "${key}"`);
    }
    for (const id of Object.keys(words.kinds ?? {})) {
        if (!KINDS.has(id)) problems.push(`kind "${id}"`);
    }
    for (const ref of Object.keys(words.props ?? {})) {
        const split = ref.lastIndexOf(".");
        const kind = split < 0 ? undefined : KINDS.get(ref.slice(0, split));
        if (kind === undefined || !Object.hasOwn(kind.props, ref.slice(split + 1))) problems.push(`property "${ref}"`);
    }
    const symbols = new Set([...TYPES.values()].flatMap((type) =>
        type.notations?.map((notation) => notation.unit) ?? []));
    for (const symbol of Object.keys(words.units ?? {})) {
        if (!symbols.has(symbol)) problems.push(`unit "${symbol}"`);
    }
    if (problems.length > 0) {
        throw new Error(`query words for "${language}" name nothing declared: ${problems.join(", ")}`);
    }

    // The words face the same checks a declared spelling does: the schema's uniqueness walk, and the notation
    // ambiguity check the numeric types ran when they were built — re-run here because unit words enter the
    // notations after that. A failing table is backed out whole, so the words in force are always a set that passed.
    setQueryWords(words);
    try {
        const collisions = [...TYPES.values()].flatMap((type) =>
            type.notations === undefined ? [] : notationProblems(type.notations).map((p) => `type ${type.name} ${p}`));
        if (collisions.length > 0) throw new Error(`query words for "${language}": ${collisions.join("; ")}`);
        buildSchema();
        appliedEmpty = empty;
    } catch (error) {
        setQueryWords({});
        buildSchema();
        appliedEmpty = true;
        throw error;
    }
}

/* The reader's language, not the catalog's: `resolvedLanguage` names the catalog that answered, and a language whose
 * prose catalogs are still empty resolves to English while its query words may already exist. A regional code such
 * as ru-RU keys the same table its base language does. */
const spoken = (i18n.language ?? "en").split("-")[0];
try {
    applyQueryWords(spoken);
} catch (error) {
    // A shipped table failing validation must not take the reader's page down: the apply has already backed the
    // words out to English, so report the failure and run. The tests apply every registered table, so this path
    // is a shipped defect's last line, not its first.
    console.error(error);
}
