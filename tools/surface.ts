/**
 * @file Prints the query surface: every question the declarations currently allow a reader to ask.
 *
 *     npm run surface                 every column
 *     npm run surface -- fx mech      named columns only
 *     npm run surface -- --words      just the vocabulary, one word per line
 *
 * The declarations are data, so the language they describe can be read off them before a parser or an evaluator
 * exists. That makes this a design instrument rather than a report: adding a property or widening a type's accepted
 * operators changes what this prints, and a query that looks wrong here is wrong in the design rather than in code
 * nobody has written yet.
 *
 * Operators appear with the spelling a reader types, taken from the registry, so a change of symbol reaches this
 * output without an edit here.
 */
import {COLUMNS} from "../src/search/columns";
import type {Kind, Prop} from "../src/search/kinds";
import {hintOf, KINDS, operatorsOf} from "../src/search/kinds";
import type {Operator} from "../src/search/operators";
import {CLAUSE_OPERATORS, OPERATORS} from "../src/search/operators";
import {kindsOf} from "../src/search/schema";

/**
 * Two example operands per type, so a printed query reads as one a person would write.
 *
 * Two rather than one because alternation and ranges take a pair, and repeating a single sample would print
 * `(fireball|fireball)`, which reads as a mistake rather than as an example.
 */
const SAMPLE: Readonly<Record<string, readonly [string, string]>> = {
    text: ["fireball", "frostbolt"],
    path: ["fire_missile", "frost_missile"],
    enum: ["chest", "head"],
    ordinal: ["legion", "shadowlands"],
    id: ["133", "116"],
    count: ["4", "8"],
    seconds: ["1.5", "3"],
    percent: ["30", "70"],
    percentChange: ["+50", "-30"],
    proportion: ["150", "70"],
    multiplier: ["x2", "x0.5"],
    length: ["40", "100"],
    angle: ["27", "60"],
    colour: ["#ff00aa", "#00aaff"],
    bitmask: ["caster", "target"],
    offset: ["z=3", "x=1"],
    flag: ["", ""],
};

/**
 * Writes one operand as the operator spells it.
 *
 * @param op The operator.
 * @param samples Two sample operands of the property's first type.
 * @returns The operand as it would be typed, or `null` when the operator has no written form of its own.
 */
function spell(op: Operator, samples: readonly [string, string]): string | null {
    const [one, other] = samples;
    switch (op.form) {
        case "prefix":
            return `${op.symbol}${one}`;
        case "infix":
            return op.name === "range" ? `${one}-${other}` : `(${one}|${other})`;
        case "whole":
            return op.symbol;
        case "embedded":
            return `${one}*`;
        case "bare":
            return one;
        default:
            return null;
    }
}

/**
 * Every query a property allows, as text.
 *
 * @param head The word that reaches the property's kind.
 * @param name The property name.
 * @param prop The property.
 * @returns One line per accepted operator.
 */
function queriesFor(head: string, name: string, prop: Prop): string[] {
    const sample = SAMPLE[prop.types[0].name] ?? ["value", "other"];
    const lines: string[] = [];
    for (const opName of operatorsOf(prop)) {
        const op = OPERATORS.get(opName);
        if (!op) continue;
        const written = spell(op, sample);
        if (written === null) continue;
        lines.push(`${head}:{${name}:${written}}`.padEnd(42) + op.hint);
    }
    return lines;
}

/**
 * Prints one kind: its word, its hint, and every query its properties allow.
 *
 * @param kind The kind.
 */
function showKind(kind: Kind): void {
    const head = kind.word ?? kind.column.key;
    const props = Object.entries(kind.props);
    console.log(`\n  ${head}   ${kind.hint}`);
    if (props.length === 0) {
        console.log(`    ${head}`.padEnd(44) + "present or absent; it carries no value");
        return;
    }
    for (const [name, prop] of props) {
        console.log(`    ${name} — ${hintOf(prop)}`);
        const types = prop.types.map((t) => t.name).join(" or ");
        const plain = prop.plain ? `, read by plain search at tier ${String(prop.tier)}` : "";
        console.log(`      ${types}${plain}`);
        for (const line of queriesFor(head, name, prop)) console.log(`      ${line}`);
    }
}

function main(): void {
    const args = process.argv.slice(2);
    const wordsOnly = args.includes("--words");
    const wanted = args.filter((a) => !a.startsWith("--"));

    if (wordsOnly) {
        for (const kind of KINDS.values()) {
            const head = kind.word ?? kind.column.key;
            for (const name of Object.keys(kind.props)) console.log(`${head}:{${name}:}`);
            if (Object.keys(kind.props).length === 0) console.log(head);
        }
        return;
    }

    console.log("CLAUSE OPERATORS — the same whatever a clause asks about, tightest binding first\n");
    for (const op of CLAUSE_OPERATORS) {
        console.log(`  ${(op.symbol ?? "(juxtaposition)").padEnd(18)}${op.name.padEnd(10)}${op.hint}`);
    }

    for (const column of COLUMNS.values()) {
        if (wanted.length > 0 && !wanted.includes(column.key)) continue;
        const kinds = kindsOf(column);
        console.log(`\n\n${"=".repeat(78)}\n${column.label.toUpperCase()}  (${column.key})  —  ${column.hint}`);
        console.log(`${kinds.length} kind(s)${column.head === false ? ", reached only through its kinds" : ""}`);
        for (const kind of kinds) showKind(kind);
    }
}

main();
