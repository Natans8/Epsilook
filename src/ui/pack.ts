/**
 * @file Fetching a shipped pack in the browser: the fetch counterpart of `tools/packfile.ts`.
 *
 * A pack is a module set: `data/<id>/manifest.json` names content-addressed module files, and reassembling them into
 * one flat pack object is the same walk the Node reader does — fetch each module, gunzip it, merge column dicts per
 * column. The transport differs (fetch and DecompressionStream against readFileSync and gunzipSync), the logic does
 * not, and everything downstream of the assembled pack is `src/dataset.ts`, shared with the tools.
 */
import type {VersionEntry} from "../data";
import type {RowPack} from "../packrows";
import type {LoadedPack} from "../dataset";
import {fromPack} from "../dataset";

/** One entry of a pack's manifest: which file holds a module. */
interface ManifestModule {
    file: string;
}

/** What `data/<id>/manifest.json` carries. */
interface PackManifest {
    pack: string;
    meta: Record<string, unknown>;
    modules: Record<string, ManifestModule>;
    locales: Record<string, Record<string, ManifestModule>>;
}

/** Where the harness reaches the site's files from, ending in a slash. */
const asUrl = (base: string, path: string): string => base + path;

/** Fetches a URL or throws with the status in the message — a silent 404 would read as an empty pack. */
async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
    return response;
}

/** Fetches and parses one plain JSON file, bypassing stale caches — these files change under one name. */
async function fetchJson<T>(url: string): Promise<T> {
    return await (await fetchOk(url, {cache: "no-cache"})).json() as T;
}

/** Fetches one gzipped JSON module. Content-addressed, so the browser cache may keep it forever. */
async function fetchGzJson(url: string): Promise<Record<string, unknown>> {
    const response = await fetchOk(url);
    if (response.body === null) throw new Error(`${url}: empty response body`);
    const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).json() as Record<string, unknown>;
}

/** Every version the site ships, newest roster order. */
export async function fetchVersions(base: string): Promise<VersionEntry[]> {
    return fetchJson<VersionEntry[]>(asUrl(base, "data/versions.json"));
}

/**
 * Picks one roster entry by a version prefix or a label fragment, or the default pack.
 *
 * @param versions The roster.
 * @param want A prefix such as `9.2.7`, a label fragment, or nothing for the default pack.
 * @returns The entry.
 * @throws If nothing matches — a typo'd version silently falling back to the default would misreport every count.
 */
export function pickEntry(versions: VersionEntry[], want?: string | null): VersionEntry {
    const entry = want
        ? versions.find((v) => v.id.startsWith(want) || v.label.includes(want))
        : versions.find((v) => v.default) ?? versions[0];
    if (!entry) throw new Error(`no pack matches "${want ?? ""}"`);
    return entry;
}

/** Whether a payload is a column dict, the one shape two modules can each hold half of. */
function isColumns(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What one pack fetch hands back: the typed view plus the languages the manifest offered. */
export interface FetchedPack {
    readonly loaded: LoadedPack;
    readonly locales: readonly string[];
}

/**
 * Fetches one version's pack, reassembled from its modules.
 *
 * The merge is per COLUMN where two modules each hold half of a section — `spells` keeps its ids in `core` while its
 * names ride in the locale module — exactly as the Node reader merges. A language the pack does not ship falls back
 * to the manifest's first locale, which the build writes first because every pack ships it.
 *
 * @param base The URL prefix the site's files live under, ending in a slash.
 * @param entry The roster entry to fetch.
 * @param locale Which language's names and prose to read, or nothing for the pack's first.
 * @param onProgress Called after each module lands, with how many of how many.
 * @returns The loaded pack and the languages it ships.
 */
export async function fetchPack(
    base: string, entry: VersionEntry, locale?: string,
    onProgress?: (done: number, total: number) => void,
): Promise<FetchedPack> {
    const manifest = await fetchJson<PackManifest>(asUrl(base, entry.file));
    const shipped = Object.keys(manifest.locales);
    const spoken = locale !== undefined && shipped.includes(locale) ? locale : shipped[0];
    const modules = [...Object.values(manifest.modules), ...Object.values(manifest.locales[spoken] ?? {})];

    let done = 0;
    const loaded = await Promise.all(modules.map(async (module) => {
        const payload = await fetchGzJson(asUrl(base, module.file));
        done += 1;
        onProgress?.(done, modules.length);
        return payload;
    }));

    const pack: Record<string, unknown> = {meta: manifest.meta};
    for (const payload of loaded) {
        for (const [section, held] of Object.entries(payload)) {
            const existing = pack[section];
            pack[section] = isColumns(existing) && isColumns(held) ? {...existing, ...held} : held;
        }
    }
    return {loaded: fromPack(pack as unknown as RowPack, entry, spoken), locales: shipped};
}
