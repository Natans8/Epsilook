/**
 * @file The search worker: the pack, the dataset and every kernel run live here, off the main thread.
 *
 * Typing must never wait on a count. The page keeps only what rendering needs — the parse is cheap and runs on the
 * main thread — while the megabytes and the row walks stay behind this message boundary. One worker per page; the
 * pack is fetched exactly once.
 */
import type {PackDomain, VersionEntry} from "../data";
import type {Dataset} from "../search/index";
import {parse, run} from "../search/index";
import {packDataset} from "../dataset";
import {fetchPack, fetchVersions, pickEntry} from "./pack";

/** What the page sends the worker. */
export type WorkerAsk =
    | { readonly is: "load"; readonly base: string; readonly version: string | null; readonly locale: string | null }
    | { readonly is: "query"; readonly seq: number; readonly text: string; readonly mode: "typing" | "final" };

/** What the worker sends back. */
export type WorkerSay =
    | { readonly is: "progress"; readonly pack: string; readonly done: number; readonly total: number }
    | { readonly is: "ready"; readonly version: VersionEntry; readonly locale: string;
        readonly locales: readonly string[]; readonly versions: readonly VersionEntry[];
        readonly domains: Record<string, PackDomain> | undefined; readonly spells: number }
    | { readonly is: "result"; readonly seq: number; readonly count: number; readonly ms: number }
    | { readonly is: "failed"; readonly error: string };

// The worker global scope, addressed explicitly: this module also compiles under the Node target (its message
// types are imported by the page and the tests), where neither DOM nor worker globals exist.
const scope = globalThis as unknown as {
    postMessage(message: WorkerSay): void;
    addEventListener(type: "message", listener: (event: { data: WorkerAsk }) => void): void;
};

const say = (message: WorkerSay): void => { scope.postMessage(message); };

let dataset: Dataset | null = null;

async function load(ask: Extract<WorkerAsk, { is: "load" }>): Promise<void> {
    const versions = await fetchVersions(ask.base);
    const entry = pickEntry(versions, ask.version);
    say({is: "progress", pack: entry.id, done: 0, total: 1});
    const {loaded, locales} = await fetchPack(ask.base, entry, ask.locale ?? undefined, (done, total) => {
        say({is: "progress", pack: entry.id, done, total});
    });
    dataset = packDataset(loaded);
    const meta = (loaded.pack as unknown as { meta?: { domains?: Record<string, PackDomain> } }).meta;
    say({
        is: "ready", version: entry, locale: loaded.locale, locales, versions,
        domains: meta?.domains, spells: loaded.spells.ids.length,
    });
}

scope.addEventListener("message", (event) => {
    const ask = event.data;
    if (ask.is === "load") {
        load(ask).catch((error: unknown) => { say({is: "failed", error: String(error)}); });
        return;
    }
    if (dataset === null) return;
    const t0 = performance.now();
    const found = run(parse(ask.text, {mode: ask.mode}), dataset);
    say({is: "result", seq: ask.seq, count: found.size, ms: Math.round(performance.now() - t0)});
});
