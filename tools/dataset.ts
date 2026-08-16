/**
 * @file The Node door onto the pack-backed dataset: pick a shipped pack off disk, hand it to the shared core.
 *
 * Everything that turns a loaded pack into a {@link import("../src/dataset").LoadedPack} and a dataset lives in
 * `src/dataset.ts`, where the browser can reach it too; what belongs here is only the part a browser cannot have —
 * reading the module set off the filesystem. The command line tools keep importing from this module either way.
 */
import type {RowPack} from "../src/packrows";
import type {LoadedPack} from "../src/dataset";
import {fromPack} from "../src/dataset";
import {DEFAULT_LOCALE, pickVersion, readPack, shippedLocales} from "./packfile";

export type {LoadedPack} from "../src/dataset";
export {fromPack, packDataset} from "../src/dataset";

/**
 * Loads one shipped pack in one language.
 *
 * The pack's names and prose come out in the loaded language, so the corpora the engine matches against do too —
 * choosing a language here is what makes a Russian query find spells. Asking for a language the pack does not ship
 * throws rather than falling back, for the reason {@link pickVersion} throws on a version: in a measuring tool a
 * silent fall back to English reads as "the Russian query works". The graceful fallback stays in {@link readPack},
 * where a surface that would rather degrade than refuse can have it.
 *
 * @param want A version prefix such as `9.2.7`, or nothing for the default pack.
 * @param locale A language the pack ships, or nothing for the default.
 * @returns The loaded pack and its typed view.
 * @throws If no pack matches, or the pack does not ship the asked-for language.
 */
export function loadPack(want?: string, locale?: string): LoadedPack {
    const entry = pickVersion(want);
    if (locale !== undefined) {
        const shipped = shippedLocales(entry);
        if (!shipped.includes(locale)) {
            throw new Error(`${entry.id} ships no "${locale}" — have: ${shipped.join(", ")}`);
        }
    }
    const spoken = locale ?? DEFAULT_LOCALE;
    return fromPack(readPack(entry, spoken) as unknown as RowPack, entry, spoken);
}
