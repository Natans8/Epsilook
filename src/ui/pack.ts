/**
 * @file Fetching a shipped pack in the browser: the fetch counterpart of `tools/packfile.ts`.
 *
 * A pack is a module set: `data/<id>/manifest.json` names content-addressed module files, and reassembling them into
 * one flat pack object is the same walk the Node reader does. The transport differs (fetch and DecompressionStream
 * against readFileSync and gunzipSync), the logic does not — and the logic lives in {@link mergeSections}, a pure
 * function the test suite pins with fixtures.
 *
 * What a URL actually served is not a fact the type system knows, so every decode lands as `unknown` and passes a
 * guard before anything reads it. A malformed manifest then names itself where it was fetched, rather than
 * surfacing much later as a section that is quietly missing.
 */

/** Where the site's files are served from — the packs, and the art an offer may draw beside a word. */
export const BASE = "/site/";
import type {PackDomain, VersionEntry} from "../data";
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

/**
 * Whether a decoded value is a keyed object.
 *
 * Two duties, one predicate: it is what a fetched manifest or module payload must decode to before anything reads
 * it, and it is the shape test that tells a section two modules each hold half of (a column dict) from one that
 * lives in a single module.
 *
 * @param value Any decoded JSON value.
 * @returns Whether it is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a decoded value names a module file.
 *
 * @param value Any decoded JSON value.
 * @returns Whether it carries the `file` a module fetch is addressed by.
 */
function isManifestModule(value: unknown): value is ManifestModule {
    return isRecord(value) && typeof value.file === "string";
}

/**
 * Whether a decoded value is a set of module entries — the shape `modules` takes, and each locale under it.
 *
 * @param value Any decoded JSON value.
 * @returns Whether every entry names a module file.
 */
function isModuleSet(value: unknown): value is Record<string, ManifestModule> {
    return isRecord(value) && Object.values(value).every(isManifestModule);
}

/**
 * Whether a decoded value is a pack manifest, checked down to the module entries the fetch walks.
 *
 * @param value Any decoded JSON value.
 * @returns Whether it carries the pack id, the meta, the modules and the locales.
 */
function isManifest(value: unknown): value is PackManifest {
    return isRecord(value)
        && typeof value.pack === "string"
        && isRecord(value.meta)
        && isModuleSet(value.modules)
        && isRecord(value.locales)
        && Object.values(value.locales).every(isModuleSet);
}

/**
 * Whether a decoded value is one roster entry, checked on the three strings the roster is read by.
 *
 * `hash`, `hidden` and `default` are left unchecked: each is optional in the shipped file, and a pack declaring
 * none of them is still loadable.
 *
 * @param value Any decoded JSON value.
 * @returns Whether it carries the id, the label and the file.
 */
function isVersionEntry(value: unknown): value is VersionEntry {
    return isRecord(value)
        && typeof value.id === "string"
        && typeof value.label === "string"
        && typeof value.file === "string";
}

/** The quantities every measured domain carries — a numeric control reads each of them as a number. */
const DOMAIN_QUANTITIES: readonly (keyof PackDomain)[] = [
    "n", "min", "max", "distinct", "mean", "median", "p1", "p99", "step", "mode", "modeShare", "sentinels",
];

/**
 * Whether a decoded value is one axis's measured domain.
 *
 * A pack that carries `unit` alongside these says more than the type does, which is why extra keys pass: the
 * check is that everything a control reads is there and is what it claims to be.
 *
 * @param value Any decoded JSON value.
 * @returns Whether it carries every quantity, both flags and a known control kind.
 */
function isPackDomain(value: unknown): value is PackDomain {
    if (!isRecord(value)) return false;
    if (!DOMAIN_QUANTITIES.every((key) => typeof value[key] === "number")) return false;
    if (typeof value.clipped !== "boolean" || typeof value.signed !== "boolean") return false;
    if (value.ui !== "picker" && value.ui !== "range") return false;
    const {values} = value;
    return values === undefined
        || (Array.isArray(values) && values.every((option: unknown) => typeof option === "number"));
}

/**
 * The per-axis domains the build measured, read from the manifest that carries them.
 *
 * Measured per pack by the build and never re-derived here: working a domain out app-side means sorting every
 * stored value of every axis on load. A pack older than format 46 ships none, which is why absence is a state
 * rather than a fault.
 *
 * @param meta The manifest's own `meta`.
 * @returns The domains by axis, or nothing where the pack ships none.
 * @throws If an axis ships a domain that is not one — a control fed a malformed domain draws a wrong scale
 *   silently, where a refusal names the axis.
 */
function readDomains(meta: Record<string, unknown>): Record<string, PackDomain> | undefined {
    const domains: unknown = meta.domains;
    if (!isRecord(domains)) return undefined;
    const measured: Record<string, PackDomain> = {};
    for (const [axis, domain] of Object.entries(domains)) {
        if (!isPackDomain(domain)) throw new Error(`domain for "${axis}" is malformed`);
        measured[axis] = domain;
    }
    return measured;
}

/**
 * Reassembles module payloads into one flat pack, exactly as the Node reader does.
 *
 * A section can be SPLIT across modules: `spells` keeps its ids in `core` while its names ride in the locale
 * module, so two column dicts merge per COLUMN. A section that is a bare array or an id-keyed table lives in
 * exactly one module and the later payload replaces the earlier wholesale.
 *
 * @param meta The manifest's own `meta`, the one per-pack value no module carries.
 * @param payloads Each module's decoded JSON, core modules first, the locale's after.
 * @returns The flat pack object.
 */
export function mergeSections(
    meta: Record<string, unknown>, payloads: readonly Record<string, unknown>[],
): Record<string, unknown> {
    const pack: Record<string, unknown> = {meta};
    for (const payload of payloads) {
        for (const [section, held] of Object.entries(payload)) {
            const existing = pack[section];
            pack[section] = isRecord(existing) && isRecord(held) ? {...existing, ...held} : held;
        }
    }
    return pack;
}

/**
 * Picks one roster entry by a version prefix or a label fragment, or the default pack.
 *
 * @param versions The roster.
 * @param want A prefix such as `9.2.7`, a label fragment, or nothing for the default pack.
 * @returns The entry.
 * @throws If nothing matches — a typo'd version silently falling back to the default would misreport every count.
 */
export function pickEntry(versions: readonly VersionEntry[], want?: string | null): VersionEntry {
    const entry = want
        ? versions.find((v) => v.id.startsWith(want) || v.label.includes(want))
        : versions.find((v) => v.default) ?? versions[0];
    if (!entry) throw new Error(`no pack matches "${want ?? ""}"`);
    return entry;
}

/** Fetches a URL or throws with the status in the message — a silent 404 would read as an empty pack. */
async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
    return response;
}

/** Fetches and decodes one plain JSON file, bypassing stale caches — these files change under one name. */
async function fetchJson(url: string): Promise<unknown> {
    const decoded: unknown = await (await fetchOk(url, {cache: "no-cache"})).json();
    return decoded;
}

/** Fetches one gzipped JSON module. Content-addressed, so the browser cache may keep it forever. */
async function fetchGzJson(url: string): Promise<Record<string, unknown>> {
    const response = await fetchOk(url);
    if (response.body === null) throw new Error(`${url}: empty response body`);
    const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
    const decoded: unknown = await new Response(stream).json();
    if (!isRecord(decoded)) throw new Error(`${url}: not a module payload`);
    return decoded;
}

/**
 * Every version the site ships, newest roster order.
 *
 * @param base The URL prefix the site's files live under, ending in a slash.
 * @returns The roster.
 * @throws If the file does not decode to a roster — every pack the app can name is one of these entries.
 */
export async function fetchVersions(base: string): Promise<VersionEntry[]> {
    const url = `${base}data/versions.json`;
    const decoded = await fetchJson(url);
    if (!Array.isArray(decoded)) throw new Error(`${url}: not a version roster`);
    const entries: unknown[] = decoded;
    if (!entries.every(isVersionEntry)) throw new Error(`${url}: not a version roster`);
    return entries;
}

/** What one pack fetch hands back: the typed view, the languages the manifest offered, and its measured domains. */
export interface FetchedPack {
    readonly loaded: LoadedPack;
    readonly locales: readonly string[];
    /** Absent on a pack older than format 46, which measured none. */
    readonly domains: Record<string, PackDomain> | undefined;
}

/**
 * Fetches one version's pack, reassembled from its modules by {@link mergeSections}.
 *
 * A language the pack does not ship falls back to the manifest's first locale, which the build writes first
 * because every pack ships it.
 *
 * @param base The URL prefix the site's files live under, ending in a slash.
 * @param entry The roster entry to fetch.
 * @param locale Which language's names and prose to read, or nothing for the pack's first.
 * @param onProgress Called after each module lands, with how many of how many.
 * @returns The loaded pack, the languages it ships and the domains it measured.
 * @throws If the manifest does not decode to a manifest, or a module does not decode to a payload.
 */
export async function fetchPack(
    base: string, entry: VersionEntry, locale?: string,
    onProgress?: (done: number, total: number) => void,
): Promise<FetchedPack> {
    const url = base + entry.file;
    const decoded = await fetchJson(url);
    if (!isManifest(decoded)) throw new Error(`${url}: not a pack manifest`);
    const manifest: PackManifest = decoded;
    const shipped = Object.keys(manifest.locales);
    const spoken = locale !== undefined && shipped.includes(locale) ? locale : shipped[0];
    const modules = [...Object.values(manifest.modules), ...Object.values(manifest.locales[spoken] ?? {})];

    let done = 0;
    const payloads = await Promise.all(modules.map(async (module) => {
        const payload = await fetchGzJson(base + module.file);
        done += 1;
        onProgress?.(done, modules.length);
        return payload;
    }));

    const pack: RowPack = mergeSections(manifest.meta, payloads);
    return {loaded: fromPack(pack, entry, spoken), locales: shipped, domains: readDomains(manifest.meta)};
}
