/* Query equivalence from the command line — do two spellings ask the same question?
 *
 *   npm run equal -- 'model:fire -model:missile' '-model:missile model:fire'
 *   npm run equal -- 'model:(fire missile)' 'model:{fire missile}'
 *
 * Prints each query's canonical form and the verdict. Exit code 0 means equivalent, 1 different, 2 usage —
 * scriptable, like any comparison tool. Equivalence is up to everything the language says does not matter:
 * clause order, group order, and delimiter or notation spellings.
 */
import {equivalent, formatQuery, parse} from "../src/search/index";

// A query may itself start with a dash — negation is language syntax — so there are no flags here at all:
// both arguments are queries, whatever they start with, and a leading "--" separator is tolerated.
const positionals = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));

if (positionals.length !== 2) {
    console.error("usage: npm run equal -- '<query>' '<query>'");
    process.exit(2);
}

const [a, b] = positionals.map((query) => parse(query));
for (const [query, parsed] of [[positionals[0], a], [positionals[1], b]] as const) {
    const broken = parsed.diagnostics.filter((d) => d.severity === "error");
    console.error(`${JSON.stringify(query)} -> ${JSON.stringify(formatQuery(parsed))}`
        + (broken.length > 0 ? `  (${broken.length} error(s); comparing what remains)` : ""));
}

const same = equivalent(a, b);
console.log(same ? "equivalent" : "different");
process.exit(same ? 0 : 1);
