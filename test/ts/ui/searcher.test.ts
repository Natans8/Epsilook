/**
 * The count sequencing invariant: only the NEWEST ask's answer reaches the page. A slow count arriving after a
 * fresh one must be dropped, or the status line flickers backwards — the bug class this seam exists to make
 * testable without a browser.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {LoadHandlers, WorkerLike} from "../../../src/ui/searcher";
import {Searcher} from "../../../src/ui/searcher";
import type {WorkerAsk, WorkerSay} from "../../../src/ui/worker";

/** A worker the test drives by hand: every ask is recorded, every answer is injected. */
class FakeWorker implements WorkerLike {
    asks: WorkerAsk[] = [];
    terminated = false;
    private listener: ((event: { data: WorkerSay }) => void) | null = null;

    postMessage(message: unknown): void {
        this.asks.push(message as WorkerAsk);
    }

    addEventListener(_type: "message", listener: (event: { data: WorkerSay }) => void): void {
        this.listener = listener;
    }

    terminate(): void {
        this.terminated = true;
    }

    say(message: WorkerSay): void {
        this.listener?.({data: message});
    }
}

const silent: LoadHandlers = {
    progress: () => {
    }, ready: () => {
    }, failed: () => {
    }
};

test("one ask in flight: a burst of edits reaches the worker as the first ask plus only the newest follow-up", () => {
    const worker = new FakeWorker();
    const searcher = new Searcher(worker, silent);
    searcher.query("f", "final");
    searcher.query("fi", "final");
    searcher.query("fir", "final");
    searcher.query("fire", "final");
    // Nothing has answered yet, so exactly one ask is in flight; the middle edits were replaced unseen.
    assert.deepEqual(worker.asks.map((ask) => (ask.is === "query" ? ask.text : null)), ["f"]);

    worker.say({is: "result", seq: 1, count: 1, ms: 1});
    assert.deepEqual(worker.asks.map((ask) => (ask.is === "query" ? ask.text : null)), ["f", "fire"]);
});

test("an answer superseded by a waiting ask is dropped; the waiting ask's answer surfaces", () => {
    const worker = new FakeWorker();
    const searcher = new Searcher(worker, silent);
    const heard: number[] = [];
    searcher.counts((count) => heard.push(count));

    searcher.query("fire", "final");
    searcher.query("fireball", "final");
    // The first ask answers while "fireball" waits: stale by definition, dropped, and the wait is released.
    worker.say({is: "result", seq: 1, count: 999, ms: 5});
    worker.say({is: "result", seq: 2, count: 42, ms: 5});
    assert.deepEqual(heard, [42]);
});

test("a lone ask's answer surfaces immediately", () => {
    const worker = new FakeWorker();
    const searcher = new Searcher(worker, silent);
    const heard: number[] = [];
    searcher.counts((count) => heard.push(count));
    searcher.query("fire", "final");
    worker.say({is: "result", seq: 1, count: 7, ms: 2});
    assert.deepEqual(heard, [7]);
});

test("load handlers route progress, ready and failure", () => {
    const worker = new FakeWorker();
    const seen: string[] = [];
    const searcher = new Searcher(worker, {
        progress: (pack, done, total) => seen.push(`progress ${pack} ${String(done)}/${String(total)}`),
        ready: (info) => seen.push(`ready ${String(info.spells)}`),
        failed: (error) => seen.push(`failed ${error}`),
    });
    worker.say({is: "progress", pack: "9.2.7", done: 1, total: 4});
    worker.say({
        is: "ready", locale: "enUS", locales: ["enUS"], versions: [], domains: undefined, ladder: [], enums: {},
        spells: 7, version: {id: "9.2.7", label: "SL", file: "x"},
    });
    worker.say({is: "failed", error: "boom"});
    assert.deepEqual(seen, ["progress 9.2.7 1/4", "ready 7", "failed boom"]);
    assert.ok(searcher instanceof Searcher);
});

test("dispose terminates the worker", () => {
    const worker = new FakeWorker();
    const searcher = new Searcher(worker, silent);
    searcher.dispose();
    assert.equal(worker.terminated, true);
});
