/* The canonical battery — a DIFF instrument, not a pass gate.
 *
 *   npm run battery                     the default pack, every probe
 *   npm run battery -- --packs=9.2.7    another pack (prefix match)
 *   npm run battery -- --locale=ruRU    load the pack in another language it ships
 *   npm run battery -- --seedcheck      re-run 2.0 with candidates() disabled and flag any answer that moves
 *   npm run battery -- --json           machine-readable, for diffing two runs
 *
 * Each probe is a PAIR: the query in the retired 1.0 engine's language and its 2.0 translation, because the
 * languages differ by design — a 1.0 phrase like `model:"attach chest"` is a keyword-and-value, while a 2.0 quoted
 * value is a string. Where the translation cannot say the same thing, the note names the gap.
 *
 * The 1.0 column is a RECORDED count, never a live run: that engine cannot load a module-set pack, so what it last
 * measured is pinned on each probe. Probes added after its retirement carry none.
 *
 * Every count that moves must be EXPLAINED from the pack before it is accepted; an unexplained delta is the
 * failure. The notes carry the standing explanations.
 *
 * --seedcheck is the soundness half: a candidates() seed may only change the COST of a query, so the same query with
 * the seed disabled must return the identical set. A mismatch is a broken seed, and it prints loudly.
 */
import {parseArgs} from "node:util";

import type {Dataset} from "../src/search/index";
import {parse, run} from "../src/search/index";
import {loadPack, packDataset} from "./dataset";

/* STDOUT IS THE RESULT; everything else is stderr — the same rule as tools/query.ts. */
const out = (line: string): void => void process.stdout.write(line + "\n");
const toStderr = (...a: unknown[]): void => void process.stderr.write(a.map(String).join(" ") + "\n");
console.log = console.info = console.debug = toStderr;

interface Probe {
    /** The retired 1.0 engine's query, verbatim from the canonical battery. */
    v1: string;
    /** Its 2.0 translation. */
    v2: string;
    /** What the retired engine last measured for {@link v1}, absent where it was never recorded. */
    was?: number;
    /** The standing explanation for an expected delta, or "" where the counts should agree. */
    note: string;
}

/* Every `was` was measured on ONE pack in ONE language; against any other load the recorded column would read as a
 * wall of unexplained deltas, so the comparison only renders on the load it belongs to. */
const RECORDED_PACK = "9.2.7.45745";
const RECORDED_LOCALE = "enUS";

const PROBES: Probe[] = [
    {v1: "fireball", v2: "fireball", was: 4864, note: "plain search; 2.0 reads more corpora (anim names, fx textures)"},
    {v1: "fire|frost", v2: "fire|frost", was: 38517, note: "same, with alternation"},
    {
        v1: "model:missile", v2: "model:missile", was: 26041,
        note: "1.0's category word also substring-matches model file paths; the 2.0 kind word selects rows of the kind",
    },
    {v1: "fx:chain", v2: "fx:chain", was: 9014, note: "1.0's category word also substring-matches chain texture names"},
    {
        v1: "fx:summon",
        v2: "fx:summon",
        was: 19485,
        note: "1.0's corpus also carries the raw creature ids; 2.0 reads them as an id notation"
    },
    {v1: "fx:tint", v2: "fx:tint", was: 6722, note: "1.0's category word also substring-matches its corpus"},
    {
        v1: "mech:speed",
        v2: "mech:speed",
        was: 6047,
        note: "1.0 also corpus-matches the WORD speed in linked names/areas"
    },
    {
        v1: "mech:seat",
        v2: "mech:vehicle",
        was: 358,
        note: "the 2.0 word is vehicle; 1.0 seat also corpus-matches link/area names"
    },
    {v1: "anim:replace", v2: "anim:replace", was: 1100, note: ""},
    {v1: "mech:location", v2: "mech:location", was: 12423, note: "1.0 also matches Location in linked spell names"},
    {
        v1: "mech:triggers",
        v2: "mech:triggers",
        was: 49216,
        note: "1.0's extras are corpus hits on spells named after triggers"
    },
    {
        v1: "mech:origin",
        v2: "mech:origin",
        was: 47226,
        note: "1.0 also corpus-matches the word in linked spell and area names"
    },
    {v1: 'mech:"triggers fireball"', v2: "triggers:fireball", was: 26, note: ""},
    {
        v1: 'mech:"triggers periodically"', v2: "triggers:periodically", was: 11739,
        note: "the link word is a property now; 1.0 also corpus-matches the word in linked spell NAMES",
    },
    // The row properties of the five pooled columns, each on a row the pack already shipped: without a probe here
    // they are declared and unmeasured, which is how an axis quietly stops answering.
    {v1: 'fx:"summon pet"', v2: "fx:{summon control:pet}", was: 258, note: "the summon control word is a property now"},
    {
        v1: 'model:"item pauldrons"', v2: "model:{item name:pauldrons}", was: 22,
        note: "an item row carries its name now; 1.0 also matches the word in the model PATH"
    },
    {
        v1: 'fx:"shadowy black"', v2: "fx:{shadowy colour:black}", was: 0,
        note: "1.0 matches the HUE word in its corpus; 2.0 reads the packed colour, so nearness decides"
    },
    {
        v1: 'anim:"passenger"', v2: "anim:{passenger sit:*}", was: 242,
        note: "a rider animation carries its role now, so the seated ones are selectable apart"
    },
    {
        v1: 'mech:"seat"', v2: "vehicle:{attach:*}", was: 232,
        note: "the seat anchor resolves through the single-column vocabulary shape; 1.0 seat is a category word"
    },
    {v1: 'fx:"scale 50"', v2: "scale:+50", was: 352, note: "quote law: a quantity; +50 is the stored change"},
    {
        v1: 'fx:"scale =50"',
        v2: "scale:+50",
        was: 349,
        note: "bare number means = on a quantity, so both forms land here"
    },
    {v1: 'mech:"seat >2"', v2: "vehicle:{seats:>2}", was: 36, note: ""},
    {v1: 'mech:"speed 70"', v2: "speed:{amount:+70}", was: 76, note: "1.0 substring-matches 70 inside +70%/-70%/170%"},
    {v1: 'mech:"speed run 70"', v2: "speed:{amount:+70 mode:run}", was: 39, note: ""},
    {v1: 'mech:"invis 13"', v2: "mech:{invis channel:13}", was: 16, note: "1.0's extra hits are linked-name matches"},
    {
        v1: 'model:"motion parabola"', v2: "model:{motion:parabola}", was: 7796,
        note: "1.0 phrase = keyword+value; 2.0 names the property",
    },
    // Quotes are STRICT now, and 1.0's quoted keyword values were squashed — so the probes that carried a 1.0
    // quoted value forward re-base onto the squashed bare spelling, which is the reading 1.0 actually measured.
    // The vocabulary spells these CamelCase (HandRight, ForwardSpin), so the quoted forms rightly answer nought.
    {v1: 'model:(motion "forward spin")', v2: "model:{motion:forwardspin}", was: 924, note: ""},
    {
        v1: 'model:"attach chest"', v2: "model:{attach:chest}|model:{from:chest}|model:{to:chest}", was: 51581,
        note: "1.0 attach unions both ends of every row; 2.0 spells that out per property",
    },
    {
        v1: 'model:(attach "right hand")',
        v2: "model:{attach:righthand}|model:{from:righthand}|model:{to:righthand}",
        was: 39612,
        note: "",
    },
    {
        v1: 'model:"attach right hand"',
        v2: "model:{attach:righthand}|model:{from:righthand}|model:{to:righthand}",
        was: 26038,
        note: "1.0 reads the whole phrase as one keyword value; same 2.0 form as the group spelling",
    },
    {
        v1: 'model:"attach hand|chest"',
        v2: "model:{attach:(hand|chest)}|model:{from:(hand|chest)}|model:{to:(hand|chest)}",
        was: 78279,
        note: "",
    },
    {v1: 'anim:"boneset Head"', v2: "anim:{boneset:head}", was: 538, note: ""},
    {v1: "model:>4", v2: "model:>4", was: 16415, note: "the count desugar carries over"},
    {v1: "sound:>2", v2: "sound:>2", was: 75887, note: ""},
    {
        v1: "anim:=0",
        v2: "anim:=0",
        was: 173394,
        note: "2.0 splits kit rows per boneset, so nonzero counts differ — zero cannot"
    },
    {
        v1: "anim:stance", v2: "anim:stance", was: 0,
        note: "retired 1.0 word; in 2.0 it is ordinary content over animation names",
    },
    // The eight attribute-flag baselines. 1.0 spells them as category words; 2.0 gives each its subject's home.
    {v1: "anim:pose", v2: "anim:pose", was: 786, note: "flag became a kind"},
    {
        v1: "mech:instant",
        v2: "cast:instant",
        was: 216382,
        note: "delivery lives on the spell column now; instant is cast:0"
    },
    {v1: "mech:casttime", v2: "cast:>0", was: 48873, note: "a bar of any length"},
    {v1: "mech:channeled", v2: "channel:*", was: 14231, note: "a channel of any length, unlimited included"},
    {v1: "mech:unbreakable", v2: "spell:unbreakable", was: 595, note: "flag word on the delivery row"},
    {v1: "mech:unhindered", v2: "spell:unhindered", was: 868, note: "flag word on the delivery row"},
    {v1: "mech:debuff", v2: "mech:debuff", was: 17219, note: "flag became a kind"},
    {v1: "fx:tracking", v2: "fx:tracking", was: 2720, note: "flag became a kind"},
];

const {values} = parseArgs({
    options: {
        packs: {type: "string", default: ""},
        locale: {type: "string", default: ""},
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
  npm run battery -- --locale=ruRU    load the pack in another language it ships
  npm run battery -- --seedcheck      prove candidates() changes cost, never answers
  npm run battery -- --json           machine-readable
`.trim());
    process.exit(0);
}

const loaded = loadPack(values.packs || undefined, values.locale || undefined);
toStderr(`battery on ${loaded.entry.label || loaded.entry.id} (${loaded.locale})`
    + ` — ${loaded.spells.ids.length.toLocaleString("en-US")} spells`);

const t0 = performance.now();
const dataset = packDataset(loaded);
const bare: Dataset = {spells: dataset.spells, source: (column) => dataset.source(column)};
toStderr(`dataset ready in ${(performance.now() - t0).toFixed(0)} ms`);

const n = (x: number): string => x.toLocaleString("en-US");

interface Result extends Probe {
    c2: number;
    errors: string[];
    seedBroken?: boolean;
}

const results: Result[] = [];
for (const probe of PROBES) {
    const parsed = parse(probe.v2);
    const errors = parsed.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    const t = performance.now();
    const set2 = run(parsed, dataset);
    const ms = performance.now() - t;
    const result: Result = {...probe, c2: set2.size, errors};
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

const comparable = loaded.entry.id === RECORDED_PACK && loaded.locale === RECORDED_LOCALE;
out("");
if (!comparable) {
    out(`  recorded counts belong to ${RECORDED_PACK} (${RECORDED_LOCALE}); this load differs, so no delta renders`);
}
out(`  ${"1.0 query".padEnd(30)} ${"recorded".padStart(8)}   ${"2.0 query".padEnd(58)} ${"rows".padStart(8)}`
    + ` ${"delta".padStart(8)}`);
out("  " + "─".repeat(118));
for (const r of results) {
    const delta = comparable && r.was !== undefined ? r.c2 - r.was : undefined;
    const flag = r.errors.length ? "  ⛔ " + r.errors[0]
        : r.seedBroken ? "  ⛔ seed changed the answer" : "";
    out(`  ${r.v1.padEnd(30)} ${(r.was === undefined ? "—" : n(r.was)).padStart(8)}`
        + `   ${r.v2.padEnd(58)} ${n(r.c2).padStart(8)}`
        + ` ${(delta === undefined ? "—" : delta === 0 ? "=" : (delta > 0 ? "+" : "") + n(delta)).padStart(8)}${flag}`);
    if (r.note && delta !== undefined && delta !== 0) out(`  ${"".padEnd(30)}            ${r.note}`);
}
const broken = results.filter((r) => r.seedBroken).length;
if (values.seedcheck) {
    out("");
    out(broken === 0
        ? `  seedcheck: every answer identical with candidates() disabled — the seed changes cost, never answers`
        : `  ⛔ seedcheck: ${broken} probe(s) returned a DIFFERENT set with candidates() disabled`);
}
out("");
