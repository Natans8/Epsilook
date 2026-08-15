/* Epsilook from the command line — a SECOND UI on the app's own engine.
 *
 *   npm run query -- 'fx:chain mech:channeled'
 *   npm run query -- 'model:"attach chest"' --limit=20
 *   npm run query -- 'model:missile' --json | jq '.count'
 *   npm run query -- --version=3.4.3 'fx:tint'
 *
 * THE POINT OF THIS FILE IS HOW LITTLE OF IT THERE IS. It reimplements no
 * matching, no parsing and no indexing: it imports the same data.ts, query.ts
 * and search.ts the browser does, and the whole engine call is three lines
 * (parseQueryParts -> groupsOf -> searchGroups). If a query answers differently
 * here and in the page, that is a bug, not a second implementation drifting —
 * there is only one implementation.
 *
 * It lives in tools/ rather than src/ because tools/build.mjs fails the site
 * build on any src/ file its import graph never reaches, and a second entry
 * point is exactly that. See "Running queries without a browser" in README.md.
 */
import {parseArgs} from "node:util";

import {buildIndexes} from "../src/data";
import type {SpellData, VersionEntry} from "../src/data";
import {pickVersion, readPack} from "./packfile";
import {groupsOf, parseQueryParts} from "../src/query";
import {searchGroups} from "../src/search";
import "../src/pilltypes";     // side effect: registers every pill type

/* STDOUT IS THE RESULT; EVERYTHING ELSE IS STDERR. buildIndexes reports its
 * timing with console.info, which is right in a browser and corrupts a pipe
 * here — `--json | jq` died on it. Rather than make the engine care which UI it
 * is under, the UI takes responsibility: every console channel the engine might
 * narrate through is redirected to stderr, and only `out` writes to stdout.
 *
 * All three, not just the one that bit: `info` was the actual culprit after
 * `log` had already been patched, and the next diagnostic added upstream should
 * not be able to break a pipe again. */
const out = (line: string): void => void process.stdout.write(line + "\n");
const toStderr = (...args: unknown[]): void =>
    void process.stderr.write(args.map(String).join(" ") + "\n");
console.log = console.info = console.debug = toStderr;

/** The pack, straight off disk. */
function loadPack(want?: string): { data: SpellData; entry: VersionEntry } {
    const entry = pickVersion(want);
    return {data: buildIndexes(readPack(entry)), entry};
}

const {values, positionals} = parseArgs({
    options: {
        limit: {type: "string", default: "20"},
        version: {type: "string"},
        json: {type: "boolean", default: false},
        count: {type: "boolean", default: false},
        help: {type: "boolean", default: false, short: "h"},
    },
    allowPositionals: true,
});

const query = positionals.join(" ").trim();
if (values.help || !query) {
    out(`
Epsilook — search the spell packs from a shell.

  npm run query -- '<query>' [--limit=N] [--version=<id>] [--json] [--count]

The query language is the app's own, so anything that works in the search bar
works here: field prefixes (model: fx: anim: sound: mech: id:), quoted phrases,
| alternation, -exclusion and numeric comparisons.

  npm run query -- 'fireball'
  npm run query -- 'model:"attach chest"' --limit=5
  npm run query -- 'fx:chain mech:channeled' --count
  npm run query -- 'model:missile' --json | jq '.spellIds | length'
  npm run query -- --version=3.4.3 'anim:replace'
`.trim());
    process.exit(values.help ? 0 : 1);
}

const t0 = performance.now();
const {data, entry} = loadPack(values.version);
const tLoad = performance.now() - t0;

const t1 = performance.now();
const {spellIds} = searchGroups(groupsOf(parseQueryParts(query)), data);
const tQuery = performance.now() - t1;

const limit = Number(values.limit);
const rows = spellIds.slice(0, Math.max(0, limit)).map((id) => {
    const i = data.spellIndex.get(id)!;
    return {id, name: data.names[i], subtext: data.subtexts[i] || undefined};
});

if (values.count) {
    out(String(spellIds.length));
} else if (values.json) {
    out(JSON.stringify({
        query, version: entry.id, count: spellIds.length, spellIds, shown: rows,
    }, null, 2));
} else {
    const label = entry.label || entry.id;
    out(`\n${query}  →  ${spellIds.length.toLocaleString()} spells   (${label})\n`);
    for (const r of rows) {
        out(`  ${String(r.id).padStart(7)}  ${r.name}${r.subtext ? `  (${r.subtext})` : ""}`);
    }
    if (spellIds.length > rows.length) {
        out(`  … and ${(spellIds.length - rows.length).toLocaleString()} more`);
    }
    out(`\n  ${tLoad.toFixed(0)} ms load · ${tQuery.toFixed(0)} ms query\n`);
}
