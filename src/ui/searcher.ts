/**
 * @file The page's handle on the search worker: load once, ask for counts, never block.
 *
 * Queries are sequenced; a result for anything but the newest ask is dropped, so a slow count can never overwrite
 * a fresh one. The worker owns the pack — the page holds only what {@link PackInfo} carries.
 */
import type {PackDomain, VersionEntry} from "../data";
import type {WorkerAsk, WorkerSay} from "./worker";

/** What the page knows about the loaded pack — everything rendering needs, nothing the worker keeps. */
export interface PackInfo {
    readonly version: VersionEntry;
    readonly locale: string;
    readonly locales: readonly string[];
    readonly versions: readonly VersionEntry[];
    readonly domains: Record<string, PackDomain> | undefined;
    readonly spells: number;
}

/** What a load reports as it progresses. */
export interface LoadHandlers {
    readonly progress: (pack: string, done: number, total: number) => void;
    readonly ready: (info: PackInfo) => void;
    readonly failed: (error: string) => void;
}

/** One page's search worker. */
export class Searcher {
    private readonly worker: Worker;
    private seq = 0;
    private onCount: ((seq: number, count: number, ms: number) => void) | null = null;

    constructor(url: string, handlers: LoadHandlers) {
        this.worker = new Worker(url);
        this.worker.addEventListener("message", (event: MessageEvent<WorkerSay>) => {
            const say = event.data;
            if (say.is === "progress") handlers.progress(say.pack, say.done, say.total);
            else if (say.is === "ready") {
                handlers.ready({
                    version: say.version, locale: say.locale, locales: say.locales,
                    versions: say.versions, domains: say.domains, spells: say.spells,
                });
            } else if (say.is === "failed") handlers.failed(say.error);
            else if (say.seq === this.seq) this.onCount?.(say.seq, say.count, say.ms);
        });
    }

    /** Starts the one pack load. */
    load(base: string, version: string | null, locale: string | null): void {
        this.send({is: "load", base, version, locale});
    }

    /** Asks for the count of one query; the sequence number identifies the answer. */
    query(text: string, mode: "typing" | "final"): number {
        this.seq += 1;
        this.send({is: "query", seq: this.seq, text, mode});
        return this.seq;
    }

    /** Registers the one count listener. */
    counts(listener: (seq: number, count: number, ms: number) => void): void {
        this.onCount = listener;
    }

    dispose(): void {
        this.worker.terminate();
    }

    private send(ask: WorkerAsk): void {
        this.worker.postMessage(ask);
    }
}
