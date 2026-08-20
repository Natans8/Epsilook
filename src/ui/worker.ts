/**
 * @file The search worker: the pack, the dataset and every kernel run live here, off the main thread.
 *
 * Typing must never wait on a count. The page keeps only what rendering needs — the parse is cheap and runs on the
 * main thread — while the megabytes and the row walks stay behind this message boundary. One worker per page; the
 * pack is fetched exactly once.
 */
import type {PackDomain, VersionEntry} from "../data";
import type {Dataset, Rung} from "../search/index";
import {ordinalRungs, parse, run} from "../search/index";
import {enumWords, packDataset} from "../dataset";
import {fetchPack, fetchVersions, pickEntry} from "./pack";

/** What the page sends the worker. */
export type WorkerAsk =
    | { readonly is: "load"; readonly base: string; readonly version: string | null; readonly locale: string | null }
    | { readonly is: "query"; readonly seq: number; readonly text: string; readonly mode: "typing" | "final" };

/** What the worker sends back. */
export type WorkerSay =
    | { readonly is: "progress"; readonly pack: string; readonly done: number; readonly total: number }
    | {
    readonly is: "ready"; readonly version: VersionEntry; readonly locale: string;
    readonly locales: readonly string[]; readonly versions: readonly VersionEntry[];
    readonly domains: Record<string, PackDomain> | undefined; readonly spells: number;
    /**
     * The ordered vocabulary the ordinal type is read against, exactly as loading the pack set it here.
     *
     * The page parses and draws, so it needs the same ladder — without it a rung the worker matches would
     * be refused by the page's own parse, and the chip would squiggle a query that runs. It is also what the
     * surface offers an expansion from, which is why one array carries the name, the synonyms and the title.
     */
    readonly ladder: readonly Rung[];
    /**
     * The words each enumeration-typed property stores in this pack, keyed `<kind word>.<prop name>`.
     *
     * What the surface lists for a closed vocabulary. Read from the pack's own rows so that every offered
     * word answers something — a vocabulary word no row carries would be an offer that can only count nought.
     */
    readonly enums: Record<string, readonly string[]>;
}
    | { readonly is: "result"; readonly seq: number; readonly count: number; readonly ms: number }
    | { readonly is: "failed"; readonly error: string };

/** The global scope this module is loaded into, addressed by the two members it uses. */
interface WorkerScope {
    postMessage(message: WorkerSay): void;

    addEventListener(type: "message", listener: (event: { data: WorkerAsk }) => void): void;
}

/**
 * Whether the global scope offers the two entry points this module is written against.
 *
 * It proves the members, not the environment: a window carries both names too. What it rules out is the Node
 * target this file also type-checks under (its message types are imported by the page and the tests), where
 * neither DOM nor worker globals exist at all.
 *
 * @param value The global scope.
 * @returns Whether both entry points are there to call.
 */
function isWorkerScope(value: unknown): value is WorkerScope {
    return typeof value === "object" && value !== null
        && "postMessage" in value && typeof value.postMessage === "function"
        && "addEventListener" in value && typeof value.addEventListener === "function";
}

// Narrowed through a local rather than `globalThis` itself: under the Node target that reference carries no
// messaging members at all, and a predicate cannot widen what the lib declares.
const host: unknown = globalThis;
if (!isWorkerScope(host)) throw new Error("not a worker scope: no postMessage and addEventListener");
const scope: WorkerScope = host;

const say = (message: WorkerSay): void => {
    // A worker's postMessage takes a transfer list where a window's takes a target origin, so the argument the
    // rule asks for would be a TypeError rather than a fix. It reads the call, not the receiver, so it cannot
    // tell the two apart.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    scope.postMessage(message);
};

let dataset: Dataset | null = null;

async function load(ask: Extract<WorkerAsk, { is: "load" }>): Promise<void> {
    const versions = await fetchVersions(ask.base);
    const entry = pickEntry(versions, ask.version);
    say({is: "progress", pack: entry.id, done: 0, total: 1});
    const {loaded, locales, domains} = await fetchPack(ask.base, entry, ask.locale ?? undefined, (done, total) => {
        say({is: "progress", pack: entry.id, done, total});
    });
    dataset = packDataset(loaded);
    say({
        is: "ready", version: entry, locale: loaded.locale, locales, versions,
        domains, spells: loaded.spells.ids.length,
        // Read back rather than rebuilt: loading the pack is what sets the ladder, so asking for it here
        // cannot drift from the spellings the kernel matches against.
        ladder: ordinalRungs(),
        enums: enumWords(loaded),
    });
}

scope.addEventListener("message", (event) => {
    const ask = event.data;
    if (ask.is === "load") {
        load(ask).catch((error: unknown) => {
            say({is: "failed", error: String(error)});
        });
        return;
    }
    if (dataset === null) return;
    const t0 = performance.now();
    const found = run(parse(ask.text, {mode: ask.mode}), dataset);
    say({is: "result", seq: ask.seq, count: found.size, ms: Math.round(performance.now() - t0)});
});
