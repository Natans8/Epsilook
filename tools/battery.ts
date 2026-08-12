/* The canonical battery, run through BOTH engines — a DIFF instrument, not a pass gate.
 *
 *   npm run battery                     the default pack, every probe
 *   npm run battery -- --packs=9.2.7    another pack (prefix match)
 *   npm run battery -- --seedcheck      re-run 2.0 with candidates() disabled and flag any answer that moves
 *   npm run battery -- --json           machine-readable, for diffing two runs
 *
 * Each probe is a PAIR: the 1.0 query from the canonical battery and its 2.0 translation, because the languages
 * differ by design — a 1.0 phrase like `model:"attach chest"` is a keyword-and-value, while a 2.0 quoted value is a
 * string. Where the translation cannot say the same thing, the note names the gap.
 *
 * Every count that moves must be EXPLAINED from the pack before it is accepted; an unexplained delta is the
 * failure. The notes carry the standing explanations.
 *
 * --seedcheck is the soundness half: a candidates() seed may only change the COST of a query, so the same query with
 * the seed disabled must return the identical set. A mismatch is a broken seed, and it prints loudly.
 */
import {parseArgs} from "node:util";

import {groupsOf, parseQueryParts} from "../src/query";
import {searchGroups} from "../src/search";
import "../src/pilltypes";     // side effect: registers every pill type
import {run} from "../src/search/kernel";
import {parse} from "../src/search/parse";
import type {Dataset} from "../src/search/rows";
import {loadPack, packDataset} from "./dataset";

/* STDOUT IS THE RESULT; everything else is stderr — the same rule as tools/query.ts. */
const out = (line: string): void => void process.stdout.write(line + "\n");
const toStderr = (...a: unknown[]): void => void process.stderr.write(a.map(String).join(" ") + "\n");
console.log = console.info = console.debug = toStderr;

interface Probe {
    /** The 1.0 query, verbatim from the canonical battery. */
    v1: string;
    /** Its 2.0 translation. */
    v2: string;
    /** The standing explanation for an expected delta, or "" where the counts should agree. */
    note: string;
}

const PROBES: Probe[] = [
    {v1: "fireball", v2: "fireball", note: "plain search; 2.0 reads more corpora (anim names, fx textures)"},
    {v1: "fire|frost", v2: "fire|frost", note: "same, with alternation"},
    {v1: "model:missile", v2: "model:missile", note: ""},
    {v1: "fx:chain", v2: "fx:chain", note: ""},
    {v1: "fx:summon", v2: "fx:summon", note: "1.0 corpus carries control words + creature ids; 2.0 name/id props"},
    {v1: "fx:tint", v2: "fx:tint", note: ""},
    {v1: "mech:speed", v2: "mech:speed", note: "1.0 also corpus-matches the WORD speed in linked names/areas"},
    {v1: "mech:seat", v2: "mech:seats", note: "the 2.0 word is seats; 1.0 seat also corpus-matches link/area names"},
    {v1: "anim:replace", v2: "anim:replace", note: ""},
    {v1: "mech:location", v2: "mech:location", note: "1.0 also matches Location in linked spell names"},
    {v1: "mech:triggers", v2: "mech:triggers", note: ""},
    {v1: "mech:origin", v2: "mech:origin", note: ""},
    {v1: 'mech:"triggers fireball"', v2: "triggers:fireball", note: ""},
    {
        v1: 'mech:"triggers periodically"', v2: "triggers:periodically",
        note: "GAP: the link words (periodically, on proc, ...) have no 2.0 property yet — matches names only",
    },
    {v1: 'fx:"scale 50"', v2: "scale:+50", note: "quote law: a quantity; +50 is the stored change"},
    {v1: 'fx:"scale =50"', v2: "scale:+50", note: "bare number means = on a quantity, so both forms land here"},
    {v1: 'mech:"seat >2"', v2: "seats:{count:>2}", note: ""},
    {v1: 'mech:"speed 70"', v2: "speed:{amount:+70}", note: "1.0 substring-matches 70 inside +70%/-70%/170%"},
    {v1: 'mech:"speed run 70"', v2: "speed:{amount:+70 mode:run}", note: ""},
    {v1: 'mech:"invis 13"', v2: "mech:{invis channel:13}", note: "1.0's extra hits are linked-name matches"},
    {
        v1: 'model:"motion parabola"', v2: "model:{motion:parabola}",
        note: "1.0 phrase = keyword+value; 2.0 names the property",
    },
    {v1: 'model:(motion "forward spin")', v2: 'model:{motion:"forward spin"}', note: ""},
    {
        v1: 'model:"attach chest"', v2: "model:{attach:chest}|model:{from:chest}|model:{to:chest}",
        note: "1.0 attach unions both ends of every row; 2.0 spells that out per property",
    },
    {
        v1: 'model:(attach "right hand")',
        v2: 'model:{attach:"right hand"}|model:{from:"right hand"}|model:{to:"right hand"}',
        note: "",
    },
    {
        v1: 'model:"attach right hand"',
        v2: 'model:{attach:"right hand"}|model:{from:"right hand"}|model:{to:"right hand"}',
        note: "1.0 reads the whole phrase as one keyword value; same 2.0 form as the group spelling",
    },
    {
        v1: 'model:"attach hand|chest"',
        v2: "model:{attach:(hand|chest)}|model:{from:(hand|chest)}|model:{to:(hand|chest)}",
        note: "",
    },
    {v1: 'anim:"boneset Head"', v2: "anim:{boneset:head}", note: ""},
    {v1: "model:>4", v2: "model:>4", note: "the count desugar carries over"},
    {v1: "sound:>2", v2: "sound:>2", note: ""},
    {v1: "anim:=0", v2: "anim:=0", note: "2.0 splits kit rows per boneset, so nonzero counts differ — zero cannot"},
    {
        v1: "anim:stance", v2: "anim:stance",
        note: "retired 1.0 word; in 2.0 it is ordinary content over animation names",
    },
    // The eight attribute-flag baselines. 1.0 spells them as category words; 2.0 gives each its subject's home.
    {v1: "anim:pose", v2: "anim:pose", note: "flag became a kind"},
    {v1: "mech:instant", v2: "cast:instant", note: "delivery lives on the spell column now; instant is cast:0"},
    {v1: "mech:casttime", v2: "cast:>0", note: "a bar of any length"},
    {v1: "mech:channeled", v2: "channel:*", note: "a channel of any length, unlimited included"},
    {v1: "mech:unbreakable", v2: "spell:unbreakable", note: "flag word on the delivery row"},
    {v1: "mech:unhindered", v2: "spell:unhindered", note: "flag word on the delivery row"},
    {v1: "mech:debuff", v2: "mech:debuff", note: "flag became a kind"},
    {v1: "fx:tracking", v2: "fx:tracking", note: "flag became a kind"},
];

const {values} = parseArgs({
    options: {
        packs: {type: "string", default: ""},
        seedcheck: {type: "boolean", default: false},
        json: {type: "boolean", default: false},
        help: {type: "boolean", default: false, short: "h"},
    },
});

if (values.help) {
    out(`
The canonical battery through both engines — a diff instrument, not a pass gate.

  npm run battery                     default pack
  npm run battery -- --packs=9.2.7    one pack (prefix match)
  npm run battery -- --seedcheck      prove candidates() changes cost, never answers
  npm run battery -- --json           machine-readable
`.trim());
    process.exit(0);
}

const {data, entry} = loadPack(values.packs || undefined);
toStderr(`battery on ${entry.label || entry.id} — ${data.ids.length.toLocaleString("en-US")} spells`);

const t0 = performance.now();
const dataset = packDataset(data);
const bare: Dataset = {spells: dataset.spells, source: (column) => dataset.source(column)};
toStderr(`dataset ready in ${(performance.now() - t0).toFixed(0)} ms`);

const n = (x: number): string => x.toLocaleString("en-US");

interface Result extends Probe {
    c1: number;
    c2: number;
    errors: string[];
    seedBroken?: boolean;
}

const results: Result[] = [];
for (const probe of PROBES) {
    const c1 = searchGroups(groupsOf(parseQueryParts(probe.v1)), data).spellIds.length;
    const parsed = parse(probe.v2);
    const errors = parsed.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    const t = performance.now();
    const set2 = run(parsed, dataset);
    const ms = performance.now() - t;
    const result: Result = {...probe, c1, c2: set2.size, errors};
    if (values.seedcheck) {
        const unseeded = run(parsed, bare);
        result.seedBroken = unseeded.size !== set2.size
            || [...unseeded].some((spell) => !set2.has(spell));
    }
    results.push(result);
    toStderr(`  ${probe.v2.padEnd(64)} ${ms.toFixed(0).padStart(6)} ms`
        + (result.seedBroken ? "   ⛔ SEED CHANGED THE ANSWER" : ""));
}

if (values.json) {
    out(JSON.stringify(results, null, 2));
    process.exit(0);
}

out("");
out(`  ${"1.0 query".padEnd(30)} ${"rows".padStart(8)}   ${"2.0 query".padEnd(58)} ${"rows".padStart(8)}`
    + ` ${"delta".padStart(8)}`);
out("  " + "─".repeat(118));
for (const r of results) {
    const delta = r.c2 - r.c1;
    const flag = r.errors.length ? "  ⛔ " + r.errors[0]
        : r.seedBroken ? "  ⛔ seed changed the answer" : "";
    out(`  ${r.v1.padEnd(30)} ${n(r.c1).padStart(8)}   ${r.v2.padEnd(58)} ${n(r.c2).padStart(8)}`
        + ` ${(delta === 0 ? "=" : (delta > 0 ? "+" : "") + n(delta)).padStart(8)}${flag}`);
    if (r.note && delta !== 0) out(`  ${"".padEnd(30)}            ${r.note}`);
}
const broken = results.filter((r) => r.seedBroken).length;
if (values.seedcheck) {
    out("");
    out(broken === 0
        ? `  seedcheck: every answer identical with candidates() disabled — the seed changes cost, never answers`
        : `  ⛔ seedcheck: ${broken} probe(s) returned a DIFFERENT set with candidates() disabled`);
}
out("");
