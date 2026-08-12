/* The search 2.0 parser from the command line — query text in, the parse as JSON out.
 *
 *   npm run parse -- 'model:{fire -missile} scale:>50'
 *   npm run parse -- --typing 'model:{fire'
 *   npm run parse -- --compact 'name:/^fire/' | jq '.diagnostics'
 *
 * Prints exactly what `parse()` returns: the clauses, the evaluable groups and every diagnostic, as one JSON
 * document on stdout. Nothing is evaluated — no pack is loaded — so this answers what the query means;
 * what it would match needs the engine. `--typing` reads the text as a keystroke state rather than final input, and
 * `--compact` collapses schema declarations to their ids so the tree reads at a glance.
 */
import {parse} from "../src/search/index";

// A query may itself start with a dash — negation is language syntax — so flags stop at the first
// non-flag argument and everything after is the query, the way grep and git treat their operands.
const args = process.argv.slice(2);
const flagCount = args.findIndex((arg) => arg !== "--typing" && arg !== "--compact");
const flags = args.slice(0, flagCount < 0 ? args.length : flagCount);
const positionals = args.slice(flags.length).filter((arg, i) => !(i === 0 && arg === "--"));
const values = {typing: flags.includes("--typing"), compact: flags.includes("--compact")};

if (positionals.length === 0) {
    console.error("usage: npm run parse -- [--typing] [--compact] '<query>'");
    process.exit(2);
}

/**
 * Collapses schema declarations to their ids, and spans to `start-end`, for a tree meant to be read.
 *
 * @param key The property being serialised.
 * @param value Its value.
 * @returns The replacement.
 */
function compact(key: string, value: unknown): unknown {
    if (key === "span") {
        const span = value as { start: number; end: number };
        return `${span.start}-${span.end}`;
    }
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (typeof record.id === "string" && record.column !== undefined) return `kind:${record.id}`;
        if (typeof record.key === "string" && typeof record.label === "string") return `column:${record.key}`;
        const kind = record.kind as { id?: unknown } | undefined;
        if (typeof record.prop === "string" && typeof kind?.id === "string") {
            return `${kind.id}.${record.prop}`;
        }
    }
    return value;
}

const parsed = parse(positionals.join(" "), {mode: values.typing ? "typing" : "final"});
console.log(JSON.stringify(parsed, values.compact ? compact : undefined, 2));
