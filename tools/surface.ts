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
 * Example queries are printed in the shortest spelling the grammar allows: a kind with one property binds its value
 * directly, a property with a door uses it, and only a property that needs naming appears in a scope. Operators
 * appear with the spelling a reader types, taken from the registry, so a change of symbol reaches this output without
 * an edit here.
 */
import type {Head, Kind, Operator, Prop} from "../src/search/index";
import {
    CLAUSE_OPERATORS, COLUMNS, HEADS, hintOf, isFlag, KINDS, kindsOf, operatorsOf, OPERATORS,
} from "../src/search/index";

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
    length: ["40", "100"],
    angle: ["27", "60"],
    colour: ["#ff00aa", "#00aaff"],
    bitmask: ["caster", "target"],
    offset: ["z=3", "x=1"],
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
        case "circumfix":
            return `${op.symbol}pattern${op.symbol}`;
        default:
            return null;
    }
}


/**
 * The shortest spelling that reaches one property, with a placeholder where the value goes.
 *
 * @param kind The property's kind.
 * @param name The property name.
 * @param prop The property.
 * @returns A template whose `¤` marks the value position, or the whole query for a flag.
 */
function template(kind: Kind, name: string, prop: Prop): string {
    // A flag's word is its own value: it reaches the property wherever the property is reached, which is the
    // kind's own door where the kind has one and the column's where it does not.
    if (isFlag(prop)) {
        const door = kind.global === true ? kind.word
            : kind.word === undefined ? kind.column.key : `${kind.column.key}:{${kind.word}`;
        return door === undefined ? `${kind.column.key}:${name}`
            : door.endsWith("{") ? `${door}${name}}` : `${door}:${name}`;
    }
    if (prop.prefix !== undefined) return `${prop.prefix}:¤`;

    const direct = kind.word === undefined ? kind.column.key : kind.global === true ? kind.word : null;
    if (direct !== null) {
        return Object.keys(kind.props).length === 1 ? `${direct}:¤` : `${direct}:{${name}:¤}`;
    }
    return `${kind.column.key}:{${kind.word} ${name}:¤}`;
}

/**
 * Every query a property allows, as text.
 *
 * @param kind The property's kind.
 * @param name The property name.
 * @param prop The property.
 * @returns One line per accepted operator.
 */
function queriesFor(kind: Kind, name: string, prop: Prop): string[] {
    if (isFlag(prop)) {
        return [template(kind, name, prop).padEnd(46) + "the word alone; present, excluded with -, or ignored"];
    }
    const shape = template(kind, name, prop);
    const sample = SAMPLE[prop.types[0].name] ?? ["value", "other"];
    const lines: string[] = [];
    for (const opName of operatorsOf(prop)) {
        const op = OPERATORS.get(opName);
        if (!op) continue;
        const written = spell(op, sample);
        if (written === null) continue;
        lines.push(shape.replace("¤", written).padEnd(46) + op.hint);
    }
    return lines;
}

/**
 * Prints one kind: its word, its hint, and every query its properties allow.
 *
 * @param kind The kind.
 */
function showKind(kind: Kind): void {
    const doors = [
        kind.word === undefined ? `${kind.column.key}:` : `${kind.column.key}:${kind.word}`,
        ...(kind.global === true ? [`${kind.word}:`] : []),
    ];
    console.log(`\n  ${(kind.word ?? kind.column.key).padEnd(14)}${kind.hint}`);
    console.log(`    reached as ${doors.join("  ·  ")}`);
    const props = Object.entries(kind.props);
    if (props.length === 0) {
        console.log("    the word alone; present, excluded with -, or ignored");
        return;
    }
    for (const [name, prop] of props) {
        console.log(`    ${name} — ${hintOf(prop)}`);
        const types = prop.types.map((t) => t.name).join(" or ");
        const words = Object.values(prop.sentinels ?? {});
        const sentinels = words.length > 0 ? `; also ${words.join(", ")}, by name` : "";
        const plain = prop.plain?.length
            ? `; plain search reads ${prop.plain.map((t) => t.name).join(", ")} at tier ${String(prop.tier)}`
            : "";
        console.log(`      ${types}${sentinels}${plain}`);
        for (const line of queriesFor(kind, name, prop)) console.log(`      ${line}`);
    }
}

/** The word a head writes on compact surfaces — every other spelling resolves here. */
function principalOf(head: Head): string {
    if (head.role === "column") return head.column.key;
    if (head.role === "kind") return head.kind.word ?? head.kind.column.key;
    return head.prop.prefix ?? head.name;
}

/** The unabbreviated name a head writes on naming surfaces, where its word is a shortcut. */
function fullOf(head: Head): string | undefined {
    if (head.role === "column") return undefined;
    return head.role === "kind" ? head.kind.full : head.prop.full;
}

/** Prints every top-level word, then the plain-search roster. */
function showRosters(): void {
    // The roster counts words, not spellings: a full name or synonym is a way in, not a new question, so each is
    // listed apart — full names as what naming surfaces write, synonyms as input-only.
    const isPrincipal = (word: string): boolean => {
        const head = HEADS.get(word);
        return head !== undefined && principalOf(head) === word;
    };
    const others = [...HEADS.keys()].filter((word) => !isPrincipal(word)).toSorted();
    const words = [...HEADS.keys()].filter(isPrincipal).toSorted();
    console.log(`\nTOP-LEVEL WORDS — every word that opens a tag (${String(words.length)})\n`);
    console.log(`  ${words.join("  ")}`);
    const spelt = (word: string): string => {
        const head = HEADS.get(word);
        return head === undefined ? word : `${word} → ${principalOf(head)}`;
    };
    const fulls: string[] = [];
    const synonyms: string[] = [];
    for (const word of others) {
        const head = HEADS.get(word);
        (head !== undefined && fullOf(head) === word ? fulls : synonyms).push(word);
    }
    if (fulls.length > 0) console.log(`\n  full names:    ${fulls.map(spelt).join("  ")}`);
    if (synonyms.length > 0) console.log(`  synonyms:      ${synonyms.map(spelt).join("  ")}`);

    console.log("\nPLAIN SEARCH — what a bare word reaches, best tier first\n");
    const rows: { tier: number; line: string }[] = [];
    for (const kind of KINDS.values()) {
        for (const [name, prop] of Object.entries(kind.props)) {
            if (!prop.plain?.length) continue;
            rows.push({
                tier: prop.tier ?? 0,
                line: `  tier ${String(prop.tier)}  ${`${kind.id}.${name}`.padEnd(28)}`
                    + prop.plain.map((t) => t.name).join(", "),
            });
        }
    }
    for (const row of rows.toSorted((a, b) => a.tier - b.tier)) console.log(row.line);
}

function main(): void {
    const args = process.argv.slice(2);
    const wordsOnly = args.includes("--words");
    const wanted = args.filter((a) => !a.startsWith("--"));

    if (wordsOnly) {
        for (const word of [...HEADS.keys()].toSorted()) console.log(word);
        return;
    }

    console.log("CLAUSE OPERATORS — the same whatever a clause asks about, tightest binding first\n");
    for (const op of CLAUSE_OPERATORS) {
        console.log(`  ${(op.symbol ?? "(juxtaposition)").padEnd(18)}${op.name.padEnd(10)}${op.hint}`);
    }
    if (wanted.length === 0) showRosters();

    for (const column of COLUMNS.values()) {
        if (wanted.length > 0 && !wanted.includes(column.key)) continue;
        const kinds = kindsOf(column);
        console.log(`\n\n${"=".repeat(78)}\n${column.label.toUpperCase()}  (${column.key})  —  ${column.hint}`);
        console.log(`${kinds.length} kind(s)${column.head === false ? ", reached only through its kinds" : ""}`);
        const groups = new Map<string | undefined, Kind[]>();
        for (const kind of kinds) {
            const list = groups.get(kind.group) ?? [];
            list.push(kind);
            groups.set(kind.group, list);
        }
        for (const [group, members] of groups) {
            if (group !== undefined) console.log(`\n  — ${group} —`);
            for (const kind of members) showKind(kind);
        }
    }
}

main();
