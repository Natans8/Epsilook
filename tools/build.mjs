/* Epsilook bundle build — the one esbuild invocation, so its flags exist in
 * exactly one place (check.py and pages.yml both run it through npm).
 *
 *   node tools/build.mjs             one production build into site/js/
 *   node tools/build.mjs --serve[=PORT]
 *                                    dev server on site/ (default 8378) —
 *                                    esbuild rebuilds on every request, so a
 *                                    reload is always the current source
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
    const orphans = sourceFiles().filter((f) => !bundled.has(f));
    if (orphans.length) {
        console.error(
            `error: ${orphans.length} source file(s) not reachable from src/main.ts` +
            ` — add the import or delete the file:\n  ` + orphans.join("\n  "));
        process.exit(1);
    }
}

const {values} = parseArgs({
    options: {serve: {type: "string", default: undefined}},
    // let --serve appear with no port
    tokens: false,
    allowNegative: false,
    args: process.argv.slice(2).map((a) => (a === "--serve" ? "--serve=8378" : a)),
});

if (values.serve !== undefined) {
    const port = Number(values.serve);
    const ctx = await esbuild.context(options);
    await ctx.serve({servedir: resolve(root, "site"), port, host: "127.0.0.1"});
    console.log(`serving site/ on http://127.0.0.1:${port} — rebuild on every request`);
} else {
    const result = await esbuild.build({...options, minify: true});
    checkReachability(result.metafile);
}
