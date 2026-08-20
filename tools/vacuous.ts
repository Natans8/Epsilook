/* The vacuous-ask sweep — every ask the offer surface can complete, judged against the loaded pack.
 *
 *   npm run vacuous
 *   npm run vacuous -- --version=9.2.7 --all
 *
 * The `name:count` class hunted mechanically: an offer that is grammatical but can only answer a constant is a
 * defect in the language, and one that answers nothing on the pack in front of it is at best a dead control. The
 * sweep drives the REAL surface — the doors an empty bar offers, then every word the surface completes behind
 * each door — commits each offer exactly as a click would, and counts the answer. Flagged: an offer whose commit
 * the parser refuses, one answering no spell, and one answering every spell. The judge is the pack, so verdicts
 * move with it; the sweep reports and nothing gates on it.
 */
import {parseArgs} from "node:util";

import {ordinalRungs, parse, run} from "../src/search/index";
import type {Dataset} from "../src/search/index";
import {enumWords} from "../src/dataset";
import {loadPack, packDataset} from "./dataset";
import {offersAt} from "../src/ui/bar/offers";
import {planAt, scopeGesture, slotStart, writeSlot} from "../src/ui/bar/plan";

const out = (line: string): void => void process.stdout.write(line + "\n");
const toStderr = (...args: unknown[]): void =>
    void process.stderr.write(args.map(String).join(" ") + "\n");
console.log = console.info = console.debug = toStderr;

const {values} = parseArgs({
    options: {
        version: {type: "string", default: ""},
        locale: {type: "string", default: ""},
        all: {type: "boolean", default: false},
        help: {type: "boolean", default: false, short: "h"},
    },
});

if (values.help) {
    out("usage: npm run vacuous -- [--version=9.2.7] [--locale=ruRU] [--all]");
    out("  flags every committed offer the pack answers with nothing or with everything; --all lists the rest too");
    process.exit(0);
}

const loaded = loadPack(values.version || undefined, values.locale || undefined);
const dataset: Dataset = packDataset(loaded);
const vocab = {rungs: ordinalRungs(), enums: enumWords(loaded)};

/** One judged ask: the door it came through, the query a click commits, and what the pack says back. */
interface Verdict {
    readonly door: string;
    readonly query: string;
    readonly kind: "refused" | "empty" | "all" | "ok";
    readonly count: number;
}

const total = dataset.spells;
const verdicts: Verdict[] = [];

/** Commits one offer the way a click would, and judges the query it writes. */
function judge(door: string, query: string): void {
    const parsed = parse(query, {mode: "final"});
    if (parsed.diagnostics.some((d) => d.severity === "error")) {
        verdicts.push({door, query, kind: "refused", count: -1});
        return;
    }
    const count = run(parsed, dataset).size;
    const kind = count === 0 ? "empty" : count === total ? "all" : "ok";
    verdicts.push({door, query, kind, count});
}

// The sweep is the surface's own enumeration: the empty bar names the doors, and each door — opened the way the
// input opens it, scope spawn included — names the words that complete a condition where they stand. A door
// offer takes a value of its own and is no ask by itself, so only the word offers commit.
const doors = offersAt(planAt("", 0), 0, [], vocab).groups.flatMap((group) =>
    group.id === "axes" ? group.offers : []);
for (const doorOffer of doors) {
    const base = doorOffer.insert;
    const spawned = scopeGesture(planAt("", 0), {text: base, caret: base.length});
    const plan = planAt(spawned.text, spawned.caret);
    const offers = offersAt(plan, spawned.caret - slotStart(plan), [], vocab);
    const words = offers.groups.flatMap((group) => (group.id === "words" ? group.offers : []));
    toStderr(`${doorOffer.word}: ${String(words.length)} word offers`);
    for (const word of words) {
        judge(doorOffer.word, writeSlot(plan, word.insert));
    }
}

const RANK: Record<Verdict["kind"], number> = {refused: 0, empty: 1, all: 2, ok: 3};
verdicts.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.door.localeCompare(b.door));
let flagged = 0;
for (const verdict of verdicts) {
    if (verdict.kind === "ok" && !values.all) continue;
    if (verdict.kind !== "ok") flagged++;
    const count = verdict.kind === "refused" ? "-" : String(verdict.count);
    out(`${verdict.kind}\t${count}\t${verdict.query}`);
}
toStderr(`${loaded.entry.id}: ${String(verdicts.length)} asks swept, ${String(flagged)} flagged, `
    + `${String(total)} spells`);
