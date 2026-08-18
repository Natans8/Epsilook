/**
 * @file The page's handle on the search worker: load once, ask for counts, never block.
 *
 * Queries are sequenced and only the newest ask's answer surfaces, so a slow count can never overwrite a fresh
 * one — the invariant the unit test pins. The worker arrives through the {@link WorkerLike} seam, which is what
 * makes that test possible without a browser.
 */
import type {PackDomain, VersionEntry} from "../data";
import type {WorkerAsk, WorkerSay} from "./worker";

/** The slice of the Worker interface this module touches, injectable for tests. */
export interface WorkerLike {
    postMessage(message: unknown): void;

    addEventListener(type: "message", listener: (event: { data: WorkerSay }) => void): void;

    terminate(): void;
}

/** What the page knows about the loaded pack — everything rendering needs, nothing the worker keeps. */
export interface PackInfo {
    readonly version: VersionEntry;
    readonly locale: string;
    readonly locales: readonly string[];
    readonly versions: readonly VersionEntry[];
    readonly domains: Record<string, PackDomain> | undefined;
    readonly spells: number;
    /** The ordered vocabulary the page reads a rung against, as the pack set it. */
    readonly ladder: readonly string[];
    /** The expansions as a reader spells them, lowest first. */
    readonly rungs: readonly string[];
}

/** What a load reports as it progresses. */
export interface LoadHandlers {
    readonly progress: (pack: string, done: number, total: number) => void;
    readonly ready: (info: PackInfo) => void;
    readonly failed: (error: string) => void;
}

/** One page's search worker. */
export class Searcher {
    private seq = 0;
    private inFlight = false;
    private pending: { text: string; mode: "typing" | "final" } | null = null;
    private onCount: ((count: number, ms: number) => void) | null = null;

    constructor(private readonly worker: WorkerLike, handlers: LoadHandlers) {
        worker.addEventListener("message", (event) => {
            const said = event.data;
            if (said.is === "progress") handlers.progress(said.pack, said.done, said.total);
            else if (said.is === "ready") {
                handlers.ready({
                    version: said.version, locale: said.locale, locales: said.locales,
                    versions: said.versions, domains: said.domains, spells: said.spells,
                    ladder: said.ladder, rungs: said.rungs,
                });
            } else if (said.is === "failed") handlers.failed(said.error);
            else {
                // An answer frees the pipeline. A newer ask waiting makes this answer stale by definition; with
                // none waiting, the newest sent ask's answer surfaces.
                this.inFlight = false;
                if (this.pending !== null) this.pump();
                else if (said.seq === this.seq) this.onCount?.(said.count, said.ms);
            }
        });
    }

    /** Starts the one pack load. */
    load(base: string, version: string | null, locale: string | null): void {
        this.send({is: "load", base, version, locale});
    }

    /**
     * Asks for the count of one query.
     *
     * At most ONE ask is ever in flight: a burst of edits keeps replacing the single pending ask, so the worker
     * never builds a backlog of counts nobody will see — a held undo would otherwise queue seconds of stale work.
     * Only the newest ask's answer reaches the listener.
     */
    query(text: string, mode: "typing" | "final"): void {
        this.pending = {text, mode};
        this.pump();
    }

    /** Sends the pending ask when the pipeline is free. */
    private pump(): void {
        if (this.inFlight || this.pending === null) return;
        const {text, mode} = this.pending;
        this.pending = null;
        this.inFlight = true;
        this.seq += 1;
        this.send({is: "query", seq: this.seq, text, mode});
    }

    /** Registers the one count listener. */
    counts(listener: (count: number, ms: number) => void): void {
        this.onCount = listener;
    }

    dispose(): void {
        this.worker.terminate();
    }

    private send(ask: WorkerAsk): void {
        this.worker.postMessage(ask);
    }
}
