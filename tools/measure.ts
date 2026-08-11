/* Measure every pack — the app's own numbers, reproducibly.
 *
 *   npm run measure                        every pack, every section
 *   npm run measure -- --packs=9.2.7       one pack
 *   npm run measure -- --only=bench        one section
 *   npm run measure -- --json > before.json
 *
 * THREE SECTIONS, AND TWO OF THEM MEASURE NOTHING — they READ what the build
 * already shipped:
 *
 *   rows      how many rows each search column yields, per pack. This is what
 *             any per-row walk costs, so it is the number to check before and
 *             after a change to how searching works. Summed from `meta.counts`
 *             through the declared column -> sections map below.
 *   domains   min / max / distinct / step / mode / robust bounds for every
 *             numeric axis, read from `meta.domains` (§3z). ⛔ MEASURED BY THE
 *             BUILD, NEVER HERE: value sets differ per game version, the build
 *             already holds them, and re-deriving them app-side would mean
 *             sorting ~276k values per axis on every page load.
 *   bench     p50 / p95 / max milliseconds per keystroke, per engine — the one
 *             thing that cannot be shipped, because it times running code.
 *
 * ⭐ SO ADDING A NUMBER IS A ONE-ROW EDIT IN THE RIGHT PLACE: a numeric axis is
 * one row in `numeric_domain`'s table in build_data.py, a column is one row in
 * COLUMNS here, and a search engine is one row in ENGINES here.
 *
 * It lives in tools/ rather than src/ for the reason tools/query.ts does:
 * everything under src/ must be reachable from src/main.ts, and a second entry
 * point is by definition not. The bench imports the shipped search.ts, so it
 * times the real engine rather than a copy of it.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";
import {gunzipSync} from "node:zlib";
import {parseArgs} from "node:util";

import {buildIndexes} from "../src/data";
import type {PackDomain, SpellData, SpellPack, VersionEntry} from "../src/data";
import {groupsOf, parseQueryParts} from "../src/query";
import {searchGroups} from "../src/search";
import "../src/pilltypes";     // side effect: registers every pill type

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* STDOUT IS THE RESULT; everything else is stderr — the same rule as
 * tools/query.ts, so `--json | jq` cannot be corrupted by the engine narrating
 * its index build. */
const out = (line: string): void => void process.stdout.write(line + "\n");
const toStderr = (...a: unknown[]): void =>
    void process.stderr.write(a.map(String).join(" ") + "\n");
console.log = console.info = console.debug = toStderr;

/* ═══════════════════════════════════════════ SECTION 1 — the columns ═══ */

/**
 * One SEARCH column, and the pack sections whose rows it walks.
 *
 * ⚠ THE MAPPING LIVES HERE AND NOT IN THE BUILD, deliberately: "which column
 * is this" is a search concept, and `build_data.py` has no business knowing
 * about search columns. The build ships section counts; this says how they
 * group.
 *
 * ⭐ ADDING A COLUMN IS ONE ROW.
 */
interface ColumnSpec {
    key: string;
    /** `meta.counts` keys, summed. */
    sections: string[];
    /** "" when the column needs no explanation. */
    note: string;
    /** Whether chipless search reads it (docs/SEARCH.md L7). */
    plain: boolean;
}

const COLUMNS: ColumnSpec[] = [
    {key: "model", sections: ["spellModels", "spellMounts"], note: "", plain: true},
    {key: "sound", sections: ["spellSounds"], note: "", plain: true},
    {
        key: "anim", plain: true, note: "kits + loose anims + replacements",
        sections: ["spellAnimKits", "spellVisualAnims", "spellReplaceAnims",
            "animKitAnimBoneset"],
    },
    {
        key: "fx", plain: true, note: "every visual pill type",
        sections: ["spellFx", "spellDissolves", "spellGlows", "spellShadowies",
            "spellGhostMats", "spellMorphs", "spellSummons", "spellObjects",
            "spellVehicles", "spellShapeshifts", "spellScreens", "spellScales",
            "spellSpeeds", "spellTints", "spellDesaturates", "spellTransparencies"],
    },
    {
        key: "mech", plain: false, note: "one row per SpellEffect — chip only, never plain",
        sections: ["spellMechanics"],
    },
    {
        key: "name", plain: true, note: "DEDUPED pools — one string serves many spells",
        sections: ["descriptionTexts", "icons"],
    },
];

/* ═══════════════════════════════════════════ SECTION 2 — the bench ═════ */

/**
 * A search engine, as far as this tool is concerned: text in, a count out.
 *
 * ⭐ THIS IS THE EXTENSION POINT FOR THE SEARCH 2.0 REWRITE. The new kernel
 * registers here beside the old one and the same keystrokes are timed through
 * both, which is what makes "is the new engine fast enough" a measurement
 * rather than an argument.
 *
 * ⛔ THERE IS NO PERFORMANCE BUDGET — the user's call, 2026-08-11: *"we don't
 * have a hard performance requirement."* So this prints a COMPARISON and never
 * a verdict. ENGINES[0] is the reference only because it is what ships today,
 * and the ratio is there for a human to read; a regression is a FINDING to
 * explain, exactly like a moved count in the canonical battery.
 *
 * (It also has to be relative to be worth anything: 1.0 measures 48 ms on an
 * idle machine and 75 ms while a pack is rebuilding, so no absolute number
 * survives contact with a dev box.)
 */
interface Engine {
    name: string;

    run(d: SpellData, query: string): number;
}

const ENGINES: Engine[] = [
    {
        name: "1.0 searchGroups",
        run: (d, q) => searchGroups(groupsOf(parseQueryParts(q)), d).spellIds.length,
    },
];

/* THE KEYSTROKES. Plain (chipless) search is the commonest path and a query is
 * typed one character at a time, so the honest unit is the keystroke rather
 * than the finished query.
 *
 * ⚠ AND THE SELECTIVE PREFIX IS THE EXPENSIVE ONE, not the wide one — measured
 * in the PHASE 1 spike and the opposite of what SEARCH.md §8.9.0 assumed. A
 * broad word matches on the first corpus and stops; a narrow one has to be
 * proved absent everywhere. So these words all END narrow. */
const WORDS = ["fireball", "arcane", "kneel", "blood pool"];

const keystrokes = (w: string): string[] => {
    const out: string[] = [];
    for (let k = 1; k <= w.length; k++) {
        const p = w.slice(0, k).trim();
        if (p) out.push(p);
    }
    return out;
};

interface Bench {
    engine: string;
    p50: number;
    p95: number;
    max: number;
    samples: number;
}

function bench(e: Engine, d: SpellData, reps: number): Bench {
    for (const w of WORDS) for (const k of keystrokes(w)) e.run(d, k);   // warm
    const s: number[] = [];
    for (let r = 0; r < reps; r++) {
        for (const w of WORDS) {
            for (const k of keystrokes(w)) {
                const t = performance.now();
                e.run(d, k);
                s.push(performance.now() - t);
            }
        }
    }
    s.sort((x, y) => x - y);
    const at = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
    return {engine: e.name, p50: at(0.5), p95: at(0.95), max: s[s.length - 1], samples: s.length};
}

/* ═══════════════════════════════════════════════════════════ driver ════ */

const {values} = parseArgs({
    options: {
        packs: {type: "string", default: "all"},
        only: {type: "string", default: "rows,domains,bench"},
        reps: {type: "string", default: "3"},
        json: {type: "boolean", default: false},
        help: {type: "boolean", default: false, short: "h"},
    },
    allowPositionals: true,
});

if (values.help) {
    out(`
Measure every pack — row counts, numeric domains, search latency.

  npm run measure                      every pack, every section
  npm run measure -- --packs=9.2.7     one pack (prefix match, comma-separated)
  npm run measure -- --only=bench      rows | domains | bench
  npm run measure -- --reps=10         more timing repetitions
  npm run measure -- --json            machine-readable, for diffing two runs

rows and domains are READ from the pack the build shipped; only bench runs
anything. Budget: p95 <= 50 ms per keystroke on the largest pack.
`.trim());
    process.exit(0);
}

const sections = new Set(values.only.split(",").map((s) => s.trim()));
const versions: VersionEntry[] = JSON.parse(
    readFileSync(resolve(ROOT, "site/data/versions.json"), "utf8"));
const wanted = values.packs === "all" ? versions
    : versions.filter((v) => values.packs.split(",").some((w) => v.id.startsWith(w.trim())));

if (!wanted.length) {
    toStderr(`no pack matches "${values.packs}" — have: ${versions.map((v) => v.id).join(", ")}`);
    process.exit(1);
}

const n = (x: number): string =>
    (Number.isInteger(x) ? x : Number(x.toFixed(2))).toLocaleString("en-US");
const report: Record<string, unknown>[] = [];

for (const entry of wanted) {
    const pack: SpellPack = JSON.parse(
        gunzipSync(readFileSync(resolve(ROOT, "site", entry.file))).toString("utf8"));
    const label = entry.label || entry.id;
    const counts = pack.meta.counts;
    const rec: Record<string, unknown> = {
        pack: entry.id, label, format: pack.meta.format, spells: counts.spells,
    };

    if (sections.has("rows")) {
        const cols: Record<string, number> = {};
        /* A SECTION NAME THAT IS NOT IN meta.counts WOULD SILENTLY CONTRIBUTE
         * ZERO, which is the one failure shape this whole tool exists to stop —
         * a number that looks measured and is not. A pack legitimately lacks
         * sections it predates, so this reports rather than throws. */
        const missing: string[] = [];
        for (const c of COLUMNS) {
            for (const s of c.sections) if (!(s in counts)) missing.push(`${c.key}.${s}`);
            cols[c.key] = c.sections.reduce((a, s) => a + (counts[s] || 0), 0);
        }
        rec.rows = cols;
        if (missing.length) rec.missingSections = missing;
    }

    if (sections.has("domains")) rec.domains = pack.meta.domains ?? null;

    /* ⚠ ONLY the bench needs the indexes built, and building them is the
     * expensive part — so `--only=rows,domains` stays instant across all
     * eleven packs. */
    if (sections.has("bench")) {
        const d = buildIndexes(pack);
        rec.bench = ENGINES.map((e) => bench(e, d, Number(values.reps)));
    }

    report.push(rec);
    if (values.json) continue;

    out(`\n${"═".repeat(96)}`);
    out(`  ${label}   ${n(counts.spells)} spells   pack format ${pack.meta.format}`);
    out("═".repeat(96));

    if (rec.rows) {
        out("\n  ROWS PER SEARCH COLUMN   (summed from meta.counts)");
        const cols = rec.rows as Record<string, number>;
        let plain = 0, all = 0;
        for (const c of COLUMNS) {
            all += cols[c.key];
            if (c.plain && c.key !== "name") plain += cols[c.key];
            out(`    ${c.key.padEnd(8)} ${n(cols[c.key]).padStart(11)} rows`
                + `${c.plain ? "" : "   not plain"}${c.note ? `   ${c.note}` : ""}`);
        }
        out(`    ${"".padEnd(8)} ${n(plain).padStart(11)} rows a PLAIN search must walk`);
        out(`    ${"".padEnd(8)} ${n(all).padStart(11)} rows in the schema`);
        const missing = rec.missingSections as string[] | undefined;
        if (missing) {
            out(`    ⚠ ${missing.length} declared section(s) absent from this pack's `
                + `meta.counts, counted as 0: ${missing.join(", ")}`);
        }
    }

    if (sections.has("domains")) {
        const doms = rec.domains as Record<string, PackDomain> | null;
        if (!doms) {
            out(`\n  NUMERIC DOMAINS   ⚠ absent — this pack predates format 46`);
        } else {
            out("\n  NUMERIC DOMAINS   (§3z, measured by the build — never declared)");
            out(`    ${"axis".padEnd(14)}${"n".padStart(9)}${"distinct".padStart(9)}`
                + `${"min".padStart(11)}${"max".padStart(12)}${"p1".padStart(9)}`
                + `${"p99".padStart(10)}${"step".padStart(7)}${"mode".padStart(9)}`
                + `${"share".padStart(7)}   affordance`);
            for (const [axis, v] of Object.entries(doms)) {
                out(`    ${axis.padEnd(14)}${n(v.n).padStart(9)}${n(v.distinct).padStart(9)}`
                    + `${n(v.min).padStart(11)}${n(v.max).padStart(12)}${n(v.p1).padStart(9)}`
                    + `${n(v.p99).padStart(10)}${n(v.step).padStart(7)}${n(v.mode).padStart(9)}`
                    + `${(v.modeShare * 100).toFixed(0).padStart(6)}%   ${v.ui}`
                    + (v.signed ? " signed" : "")
                    + (v.clipped ? " ⚠clipped" : "")
                    + (v.sentinels ? ` ${n(v.sentinels)} sentinels` : ""));
            }
        }
    }

    if (rec.bench) {
        const runs = rec.bench as Bench[];
        out(`\n  PLAIN-SEARCH LATENCY   ms per keystroke`
            + `   (compared with ${runs[0].engine}, same run — no pass mark)`);
        for (const b of runs) {
            out(`    ${b.engine.padEnd(24)} p50 ${b.p50.toFixed(1).padStart(7)} · `
                + `p95 ${b.p95.toFixed(1).padStart(7)} · max ${b.max.toFixed(1).padStart(7)}`
                + `   (${b.samples} keystrokes)`
                + (b === runs[0] ? "   reference"
                    : `   ${(b.p95 / runs[0].p95).toFixed(2)}x`));
        }
    }
}

if (values.json) out(JSON.stringify(report, null, 2));
else out("");
