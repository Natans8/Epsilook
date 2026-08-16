/**
 * @file Reading a shipped pack off disk, for the tools that run outside a browser.
 *
 * A pack is a module set: `site/data/<id>/manifest.json` names the content-addressed files that make it up, and
 * `meta` rides on the manifest rather than in any module, because it is the only per-PACK value in an otherwise
 * per-BUILD artifact. Reassembling that into the one flat object {@link SpellPack} describes is the whole job here.
 *
 * It lives apart from the tools that use it because three of them were each doing it, which is three copies of one
 * rule and three chances to disagree — and they did the day the artifact became a module set and nothing noticed.
 *
 * The browser is deliberately NOT a caller. `data.ts` speaks fetch, a relative URL and DecompressionStream, which is
 * its transport rather than its logic; everything that turns bytes into something searchable is shared already. This
 * is the whole of the port: pick the bytes up differently, hand them to the same engine.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";
import {gunzipSync} from "node:zlib";

import type {SpellPack, VersionEntry} from "../src/data";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = resolve(ROOT, "site");

/** One entry of a pack's manifest: which file holds a module. */
interface ManifestModule {
    file: string;
}

/** What `site/data/<id>/manifest.json` carries. */
interface PackManifest {
    pack: string;
    meta: SpellPack["meta"];
    modules: Record<string, ManifestModule>;
    locales: Record<string, Record<string, ManifestModule>>;
    absentSections?: string[];
}

/**
 * The language a reader gets when it asks for none.
 *
 * Every pack ships it, which is what lets a caller fall back to it without checking. Declared again in
 * `tools/packfile.py` and `build/pack/derive/locales.py`; `check_locale_declaration` reconciles all three.
 */
export const DEFAULT_LOCALE = "enUS";

/** Every version the site ships, newest roster order. */
export function readVersions(): VersionEntry[] {
    return JSON.parse(readFileSync(resolve(SITE, "data", "versions.json"), "utf8")) as VersionEntry[];
}

/** One version's manifest, read off disk. */
function readManifest(entry: VersionEntry): PackManifest {
    return JSON.parse(readFileSync(resolve(SITE, entry.file), "utf8")) as PackManifest;
}

/**
 * The languages a pack ships, in manifest order.
 *
 * What a locale selector may offer for the pack: {@link readPack} serves any of these without falling back, and not
 * every pack ships every language — Epsilon publishes English alone.
 */
export function shippedLocales(entry: VersionEntry): string[] {
    return Object.keys(readManifest(entry).locales);
}

/**
 * The language a pack will actually serve for a request: the asked-for one where shipped, else the default.
 *
 * The lenient half of the policy split — a sweep that must not stop on one pack resolves through this and reports
 * what it got, while a tool measuring one pack refuses instead ({@link import("./dataset").loadPack}).
 */
export function servedLocale(entry: VersionEntry, want: string): string {
    return shippedLocales(entry).includes(want) ? want : DEFAULT_LOCALE;
}

/**
 * Picks one roster entry by a version prefix or a label fragment.
 *
 * @param want A prefix such as `9.2.7`, a label fragment, or nothing for the default pack.
 * @param versions The roster, defaulting to what the site ships.
 * @returns The entry.
 * @throws If nothing matches, naming what there is — a typo'd version is otherwise a silent fall back to the default.
 */
export function pickVersion(want?: string, versions: VersionEntry[] = readVersions()): VersionEntry {
    const entry = want
        ? versions.find((v) => v.id.startsWith(want) || v.label?.includes(want))
        : versions.find((v) => v.default) ?? versions[0];
    if (!entry) throw new Error(`no pack matches "${want}" — have: ${versions.map((v) => v.id).join(", ")}`);
    return entry;
}

/**
 * Reads one version's pack off disk, reassembled from its modules.
 *
 * A section can be SPLIT across modules rather than living in one: `spells` keeps its ids, icons and schools in
 * `core` while its names ride in the locale module, so the two copies are halves of one section and the merge is
 * per COLUMN. Replacing the section wholesale is the obvious wrong answer and it fails loudly on the first read —
 * `spells.ids` simply vanishes.
 *
 * A section that is a bare array or an id-keyed table lives in exactly one module, so it is taken as it comes.
 *
 * @param entry The roster entry to read.
 * @param locale Which language's names and prose to read; a pack that does not carry it falls back to the default.
 * @returns The pack as one object, the shape `buildIndexes` takes.
 */
export function readPack(entry: VersionEntry, locale: string = DEFAULT_LOCALE): SpellPack {
    const manifest = readManifest(entry);
    const spoken = manifest.locales[locale] ?? manifest.locales[DEFAULT_LOCALE] ?? {};
    const pack: Record<string, unknown> = {meta: manifest.meta};
    for (const module of [...Object.values(manifest.modules), ...Object.values(spoken)]) {
        const loaded = JSON.parse(
            gunzipSync(readFileSync(resolve(SITE, module.file))).toString("utf8")) as Record<string, unknown>;
        for (const [section, payload] of Object.entries(loaded)) {
            const held = pack[section];
            pack[section] = isColumns(held) && isColumns(payload)
                ? {...held, ...payload}
                : payload;
        }
    }
    return pack as unknown as SpellPack;
}

/** Whether a payload is a column dict, the one shape two modules can each hold half of. */
function isColumns(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
