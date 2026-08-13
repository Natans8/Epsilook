/* Query simplification from the command line — the explicit door the law requires.
 *
 *   npm run simplify -- 'model:fire model:fire | name:frost'
 *   npm run simplify -- --suggest 'model:{fire} cast:2s-2s'
 *   npm run simplify -- --rules
 *
 * The simplified query prints on stdout in its canonical spelling; the rules that fired and any findings print on
 * stderr, so the query pipes clean. `--suggest` runs each rule alone instead and prints one line per standalone
 * rewrite — what a surface would offer as individual suggestions. `--rules` prints the whole rule bible from the
 * registries: every rule with its tier, law and examples, then every boundary with what it keeps and why.
 */
import type {Rule} from "../src/search/index";
import {formatQuery, KEPT, parse, RULES, simplify, suggestions} from "../src/search/index";

// A query may itself start with a dash — negation is language syntax — so flags stop at the first
// non-flag argument and everything after is the query, the way grep and git treat their operands.
const args = process.argv.slice(2);
const flagCount = args.findIndex((arg) => arg !== "--rules" && arg !== "--suggest");
const flags = args.slice(0, flagCount < 0 ? args.length : flagCount);
const positionals = args.slice(flags.length).filter((arg, i) => !(i === 0 && arg === "--"));
const values = {rules: flags.includes("--rules"), suggest: flags.includes("--suggest")};

/** One rule's presentation line, shared by the bible and the fired-rules report. */
function ruleLine(rule: Rule): string {
    return `${rule.id.padEnd(4)} ${rule.name.padEnd(26)} ${rule.tier.padEnd(8)} ${rule.law}`;
}

/** Prints the whole rule bible from the registries: the rules with their examples, then the boundaries. */
function printRules(): void {
    const numbered = [...RULES].toSorted((a, b) =>
        Number.parseInt(a.id.slice(1), 10) - Number.parseInt(b.id.slice(1), 10) || a.id.localeCompare(b.id));
    console.log("THE RULES — what is cut\n");
    for (const rule of numbered) {
        console.log(`  ${ruleLine(rule)}`);
        for (const example of rule.examples) {
            console.log(`       ${example.from}  ->  ${example.to === "" ? "(the empty query)" : example.to}`);
        }
    }
    console.log("\nTHE BOUNDARIES — what is kept, and why\n");
    for (const boundary of KEPT) {
        console.log(`  ${boundary.id.padEnd(4)} ${boundary.name.padEnd(26)} keeps ${boundary.keeps}`);
        console.log(`       ${boundary.why}`);
    }
}

if (values.rules) {
    printRules();
    process.exit(0);
}

if (positionals.length === 0) {
    console.error("usage: npm run simplify -- [--suggest] '<query>'  |  npm run simplify -- --rules");
    process.exit(2);
}

const parsed = parse(positionals.join(" "));
const broken = parsed.diagnostics.filter((d) => d.severity === "error");
if (broken.length > 0) console.error(`${broken.length} error(s); simplifying what remains`);

const byId = new Map(RULES.map((rule) => [rule.id, rule]));

if (values.suggest) {
    const offers = suggestions(parsed);
    if (offers.length === 0) {
        console.error("no rule rewrites this query");
    }
    for (const offer of offers) {
        console.log(`${offer.rule.id.padEnd(4)} ${offer.rule.name.padEnd(26)} ${formatQuery(offer.parsed)}`);
        for (const note of offer.notes) console.error(`  ${note}`);
    }
    process.exit(0);
}

const result = simplify(parsed);
for (const id of result.applied) {
    const rule = byId.get(id);
    console.error(rule === undefined ? id : `${rule.id} ${rule.name}`);
}
for (const note of result.notes) console.error(note);
if (result.applied.length === 0) console.error("nothing to simplify");
console.log(formatQuery(result.parsed));
