/* Epsilook bundle build — the one esbuild invocation, so its flags exist in
 * exactly one place (check.py and pages.yml both run it through npm).
 *
 *   node tools/build.mjs             one production build into site/js/
 *   node tools/build.mjs --serve[=PORT]
 *                                    dev server on site/ (default 8378) —
 *                                    esbuild rebuilds on every request, so a
 *                                    reload is always the current source
 *   node tools/build.mjs --cli       the command-line entry points -> tools/*.mjs
 *   node tools/build.mjs --test      the test suite -> test/.bundle/ (npm test)
 *
 * The build also guards the module graph: every .ts under src/ must be
 * reachable from the entry, or the build fails naming the orphan. That is the
 * ESM successor to the old "every module in site/js is loaded by index.html"
 * check — a side-effect module (pilltypes.ts registering pill types) that
 * loses its import would otherwise vanish from the bundle silently.
 */
import * as esbuild from "esbuild";
import {readdirSync} from "node:fs";
import {relative, resolve, sep} from "node:path";
import {parseArgs} from "node:util";

const root = resolve(import.meta.dirname, "..");

/** @type {esbuild.BuildOptions} */
const options = {
    entryPoints: [resolve(root, "src/main.ts")],
    outfile: resolve(root, "site/js/app.js"),
    bundle: true,
    // an IIFE, not <script type="module">: the site must keep working when
    // site/index.html is opened straight from file:// (module scripts are
    // blocked by CORS there), and nothing needs code splitting
    format: "iife",
    target: "es2022",
    sourcemap: true,
    metafile: true,
    logLevel: "info",
    // vendored bufo.js carries a Node-only writeToFile method that requires
    // "fs" — never called in the browser, but esbuild resolves imports
    // statically, so tell it to leave that one alone
    external: ["fs"],
};

/* TREES THE BUNDLE IS NOT EXPECTED TO REACH, each with a reason and an end.
 *
 * The reachability guard below exists to catch a module that LOST its import —
 * pilltypes falling out of main.ts would silently empty the pill registry. It
 * is not meant to force half-built work into the shipping bundle.
 *
 *   src/search/   SEARCH 2.0, being written BESIDE the shipped engine (see
 *                 docs/PLAN-search2.md §8 — 1.0 is deleted in ONE commit at
 *                 PHASE 8, never edited in place). Nothing drives it yet, so
 *                 importing it would ship dead code AND put a module that
 *                 validates-and-throws at import time on the app's boot path,
 *                 where a schema collision is a white screen rather than a
 *                 failed check. `npx tsc` (both targets), `node --test` and
 *                 tools/check.py all cover it instead.
 *                 DELETE THIS ENTRY when PHASE 5 wires the engine into a
 *                 surface; from then on the guard should apply normally.
 *
 *   src/i18n/     The string registry. Its only importers today live in
 *                 src/search/, so it is unreached exactly as long as that tree
 *                 is. DELETE THIS ENTRY together with the one above.
 */
const UNREACHED = ["src/search/", "src/i18n/"];

/** Every non-declaration .ts under src/, relative to the repo root. */
function sourceFiles(dir = resolve(root, "src")) {
    const out = [];
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(path));
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
            out.push(relative(root, path).split(sep).join("/"));
    }
    return out;
}

/** Fail if a source file exists that the bundle never reached. */
function checkReachability(metafile) {
    const bundled = new Set(Object.keys(metafile.inputs));
    const orphans = sourceFiles().filter(
        (f) => !bundled.has(f) && !UNREACHED.some((prefix) => f.startsWith(prefix)));
    if (orphans.length) {
        console.error(
            `error: ${orphans.length} source file(s) not reachable from src/main.ts` +
            ` — add the import or delete the file:\n  ` + orphans.join("\n  "));
        process.exit(1);
    }
}

/* The command-line entry points — FURTHER entry points on the same engine,
 * bundled the same way. They live outside src/ on purpose: everything under
 * src/ must be reachable from src/main.ts (checkReachability above), and a
 * second entry point is by definition not. Not minified — these are read when
 * they throw.
 *
 * Adding one is a name in this list and an npm script beside `query`. */
const CLI_ENTRIES = ["query", "measure", "surface", "parse", "equal", "battery", "simplify"];

const cliOptions = CLI_ENTRIES.map((name) => ({
    entryPoints: [resolve(root, `tools/${name}.ts`)],
    outfile: resolve(root, `tools/${name}.mjs`),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "warning",
    external: ["fs"],
}));

/* THE TEST SUITE — bundled, for one blunt reason: Node's own TypeScript
 * support strips TYPES but does not resolve EXTENSIONLESS imports, and every
 * module in this repo writes `import {x} from "./y"`. Running `node --test`
 * straight at src/ would therefore mean putting `.ts` on every import in the
 * app, to make a test runner happy. Bundling costs one command and lets a test
 * import ANY module in the repo exactly as the app does — which is the whole
 * point of a suite meant to grow past search 2.0.
 *
 * One bundle per test file, structure preserved, so `node --test` still runs
 * each file in its own process: that isolation is load-bearing, because the
 * registries are module-level and a test that deliberately corrupts one must
 * not reach the others. Source maps, so a failure points at the .ts line.
 *
 * Output is gitignored build output, exactly like site/js. */
function testFiles(dir = resolve(root, "test")) {
    const out = [];
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== ".bundle") out.push(...testFiles(path));
        } else if (entry.name.endsWith(".test.ts")) out.push(path);
    }
    return out;
}

const testOptions = () => ({
    entryPoints: testFiles(),
    outdir: resolve(root, "test/.bundle"),
    outbase: resolve(root, "test"),
    outExtension: {".js": ".mjs"},
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    logLevel: "warning",
    external: ["fs"],
});

const {values} = parseArgs({
    options: {
        serve: {type: "string", default: undefined},
        cli: {type: "boolean", default: false},
        test: {type: "boolean", default: false},
    },
    // let --serve appear with no port
    tokens: false,
    allowNegative: false,
    args: process.argv.slice(2).map((a) => (a === "--serve" ? "--serve=8378" : a)),
});

if (values.test) {
    await esbuild.build(testOptions());
} else if (values.cli) {
    await Promise.all(cliOptions.map((o) => esbuild.build(o)));
} else if (values.serve !== undefined) {
    const port = Number(values.serve);
    const ctx = await esbuild.context(options);
    await ctx.serve({servedir: resolve(root, "site"), port, host: "127.0.0.1"});
    console.log(`serving site/ on http://127.0.0.1:${port} — rebuild on every request`);
} else {
    const result = await esbuild.build({...options, minify: true});
    checkReachability(result.metafile);
}
