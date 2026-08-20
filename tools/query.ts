/* Epsilook from the command line — the search 2.0 engine, headless.
 *
 *   npm run query -- 'model:fir'
 *   npm run query -- 'model:{fire -missile}' --limit=20
 *   npm run query -- 'scale:>=x5' --version=9.2.7 --json
 *   npm run query -- 'model:missile' --locale=ruRU
 *
 * THE POINT OF THIS FILE IS HOW LITTLE OF IT THERE IS. It reimplements no
 * matching, no parsing and no indexing: `parse()` is the declarative core,
 * `run()` is the kernel, and the Dataset is the same pack-backed one the
 * battery and the bench use. If a query answers differently here and in the
 * app, that is a bug, not a second implementation drifting.
 */
import {parseArgs} from "node:util";

import {order, parse, run} from "../src/search/index";
import {loadPack, packDataset} from "./dataset";

/* Stdout is the result; everything else is stderr, so `--json | jq` can never
 * be corrupted by a diagnostic the engine narrates. */
const out = (line: string): void => void process.stdout.write(line + "\n");
const toStderr = (...args: unknown[]): void =>
    void process.stderr.write(args.map(String).join(" ") + "\n");
console.log = console.info = console.debug = toStderr;

const {values, positionals} = parseArgs({
    options: {
        version: {type: "string", default: ""},
        locale: {type: "string", default: ""},
        limit: {type: "string", default: "10"},
        json: {type: "boolean", default: false},
        help: {type: "boolean", default: false, short: "h"},
    },
    allowPositionals: true,
});

if (values.help || positionals.length === 0) {
    out("usage: npm run query -- '<query>' [--version=9.2.7] [--locale=ruRU] [--limit=10] [--json]");
    process.exit(values.help ? 0 : 2);
}

const query = positionals.join(" ");
const loaded = loadPack(values.version || undefined, values.locale || undefined);
const dataset = packDataset(loaded);

const parsed = parse(query, {mode: "final"});
for (const d of parsed.diagnostics) toStderr("diagnostic:", JSON.stringify(d));

// The kernel answers in spell INDEXES, dense from zero; the ids are the pack's. An unordered answer prints
// in id order as ever; a sort directive orders it, and the query's own `first` trims BEFORE the CLI's --limit.
const found = run(parsed, dataset);
const spells = parsed.sorts.length > 0 ? order(found, parsed.sorts, dataset)
    : [...found].toSorted((a, b) => loaded.spells.ids[a] - loaded.spells.ids[b]);
const listed = parsed.limit === null ? spells : spells.slice(0, parsed.limit.value);
const ids = listed.map((at) => loaded.spells.ids[at]);
const limit = Math.max(0, Number(values.limit) || 0);
const nameOf = (id: number): string => {
    const pos = loaded.index.get(id);
    return pos === undefined ? "" : loaded.spells.names[pos];
};

if (values.json) {
    out(JSON.stringify({
        query,
        version: loaded.entry.id,
        locale: loaded.locale,
        count: found.size,
        ids: ids.slice(0, limit),
    }));
} else {
    toStderr(`${loaded.entry.id} (${loaded.locale})`);
    out(String(found.size));
    for (const id of ids.slice(0, limit)) out(`${id}\t${nameOf(id)}`);
}
