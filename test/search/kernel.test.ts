/**
 * @file The kernel's algebra, proved against a synthetic dataset small enough to verify by hand.
 *
 * The fixtures run whole queries through `parse` and `run`, so every assertion exercises the same pipeline the
 * application will: text in, spell set out. The world below is built so each algebraic identity has a spell that
 * separates the two sides — a fire model that is not a missile, a kit named by digits, a flag word shared by two
 * spells — because an identity that no fixture can break is not being tested.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {run} from "../../src/search/kernel";
import {
    attached, chain, delivery, description, effect, expansion, missile, name as nameKind, scale,
    sound as soundKind, spellId, tint,
} from "../../src/search/kinds";
import type {Kind} from "../../src/search/kinds";
import {parse} from "../../src/search/parse";
import type {Ask, Parsed} from "../../src/search/parse";
import type {Dataset, Row, RowSource, Stored} from "../../src/search/rows";
import {setOrdinalLadder} from "../../src/search/value-types";

setOrdinalLadder(["classic", "tbc", "wotlk", "cata", "legion", "bfa"]);

const row = (kind: Kind, props: Record<string, Stored>): Row => ({kind, props});

/** One spell's rows, by column key. A column absent from a spell simply has no rows for it. */
interface Spec {
    readonly id: number;
    readonly name: string;
    readonly desc?: string;
    readonly xpac: string;
    readonly delivery?: Record<string, Stored>;
    readonly model?: readonly Row[];
    readonly sound?: readonly Row[];
    readonly fx?: readonly Row[];
    readonly mech?: readonly Row[];
}

const m = (file: string, from: string, to: string, motion: string): Row =>
    row(missile, {file, from, to, motion, target: 2});

/* Spell indexes are their positions here; the comments name what each one exists to separate. */
const WORLD: readonly Spec[] = [
    /* 0 */ {
        id: 100, name: "Fireball", xpac: "classic", delivery: {cast: 2500},
        model: [m("spell/fire/fireball_missile.m2", "right hand", "chest", "parabola")],
        sound: [row(soundKind, {file: "sound/spell/fireballcast.ogg", kit: {id: 150, text: "FireImpact"}, target: 1})],
        mech: [row(effect, {name: "SCHOOL_DAMAGE", target: 2})],
    },
    /* 1 */ {
        id: 101, name: "Frostbolt", xpac: "classic", delivery: {cast: 3000},
        model: [m("spell/frost/frostbolt.m2", "right hand", "chest", "parabola")],
    },
    /* 2 — a fire model that is NOT a missile, beside a missile that is not fire */ {
        id: 102, name: "Flame Shield", xpac: "tbc", delivery: {cast: 0},
        model: [
            row(attached, {file: "spell/fire/flameshield.m2", attach: "chest", target: 1}),
            m("spell/arcane/orb.m2", "head", "head", "forward spin"),
        ],
    },
    /* 3 — five model rows, an unbreakable channel, and "arcane" in the description */ {
        id: 103, name: "Arcane Torrent", desc: "Channels arcane power while kneeling.", xpac: "wotlk",
        delivery: {channel: 5000, unbreakable: 1},
        model: [1, 2, 3, 4, 5].map((i) => row(attached, {file: `spell/arcane/torrent${i}.m2`, attach: "head"})),
    },
    /* 4 */ {
        id: 104, name: "Ghost Wolf", xpac: "cata", delivery: {cast: 0},
        fx: [row(tint, {colour: 0xff0000, target: 1}), row(scale, {amount: 50, target: 1})],
    },
    /* 5 */ {id: 105, name: "Giant Growth", xpac: "legion", delivery: {channel: -1}, fx: [row(scale, {amount: 50})]},
    /* 6 — a kit NAMED by digits, for the quote law */ {
        id: 106, name: "Odd Chime", xpac: "bfa",
        sound: [row(soundKind, {file: "sound/odd.ogg", kit: {id: 9999, text: "150"}})],
    },
    /* 7 — no visuals at all; found by its description and its id */ {
        id: 133, name: "Pure Thought", desc: "A spell with no visuals, pure arcane thought.", xpac: "wotlk",
    },
    /* 8 */ {
        id: 108, name: "Lightning Link", xpac: "legion",
        fx: [row(chain, {
            texture: "spell/beam/lightning.m2",
            from: "right hand",
            to: "chest",
            colour: 0x0000ff,
            target: 2
        })],
        mech: [row(effect, {name: "JUMP_DEST", target: 16})],
    },
    /* 9 */ {
        id: 109, name: "Comet Break", xpac: "tbc", delivery: {channel: 4000, breaksmove: 1},
        model: [m("spell/fire/comet.m2", "chest", "feet", "follow ground")],
    },
    /* 10 */ {
        id: 110, name: "Arcane Missile", xpac: "cata",
        model: [m("spell/arcane/arcane_missile.m2", "right hand", "chest", "parabola")],
    },
    /* 11 */ {id: 111, name: "Silence", xpac: "classic"},
];

function spellRows(spec: Spec): readonly Row[] {
    const rows: Row[] = [row(nameKind, {text: spec.name})];
    if (spec.desc !== undefined) rows.push(row(description, {text: spec.desc}));
    if (spec.delivery !== undefined) rows.push(row(delivery, spec.delivery));
    return rows;
}

function columnRows(spec: Spec, key: string): readonly Row[] {
    switch (key) {
        case "spell":
            return spellRows(spec);
        case "id":
            return [row(spellId, {value: spec.id}), row(expansion, {rung: spec.xpac})];
        case "model":
            return spec.model ?? [];
        case "sound":
            return spec.sound ?? [];
        case "fx":
            return spec.fx ?? [];
        case "mech":
            return spec.mech ?? [];
        default:
            return [];
    }
}

function dataset(): Dataset {
    return {
        spells: WORLD.length,
        source: (column): RowSource => ({rows: (spell) => columnRows(WORLD[spell], column.key)}),
    };
}

const DATA = dataset();
const EVERY = WORLD.map((_, index) => index);

function parsed(query: string): Parsed {
    const result = parse(query);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(errors, [], `query "${query}" should parse cleanly`);
    return result;
}

const ids = (query: string, data: Dataset = DATA): number[] => [...run(parsed(query), data)].toSorted((a, b) => a - b);

const complement = (spells: readonly number[]): number[] => EVERY.filter((index) => !spells.includes(index));

describe("the walk", () => {
    it("answers a column content term over every row of the column", () => {
        assert.deepEqual(ids("model:fire"), [0, 2, 9]);
        assert.deepEqual(ids("model:arcane"), [2, 3, 10]);
    });

    it("answers a kind word as the rows of that kind", () => {
        assert.deepEqual(ids("model:missile"), [0, 1, 2, 9, 10]);
    });

    it("answers existence, and its negation as the complement", () => {
        assert.deepEqual(ids("model:*"), [0, 1, 2, 3, 9, 10]);
        assert.deepEqual(ids("-model:*"), complement([0, 1, 2, 3, 9, 10]));
    });

    it("dispatches a bare token after a kind across all its properties", () => {
        // "chest" lives in `from` on one spell and in `to` on three others; the precise forms tell them apart.
        assert.deepEqual(ids("missile:chest"), [0, 1, 9, 10]);
        assert.deepEqual(ids("missile:{from:chest}"), [9]);
        assert.deepEqual(ids("missile:{to:chest}"), [0, 1, 10]);
    });

    it("anchors a content match to the whole value", () => {
        assert.deepEqual(ids("model:{=parabola}"), [0, 1, 10]);
        assert.deepEqual(ids("model:{parab}"), [0, 1, 10]);
        assert.deepEqual(ids("model:{=parab}"), []);
    });

    it("matches a phrase with punctuation and spacing folded, like any other token", () => {
        assert.deepEqual(ids('model:"right hand"'), [0, 1, 10]);
    });
});

describe("the row scope", () => {
    it("binds its conjunction to one row, which the flat form cannot say", () => {
        // Flame Shield holds a fire attachment and an arcane missile: no single row is fire-without-missile
        // anywhere else, and the flat form excludes the spell for having any missile at all.
        assert.deepEqual(ids("model:{fire -missile}"), [2]);
        assert.deepEqual(ids("model:fire -model:missile"), []);
    });

    it("reads an empty scope as existence", () => {
        assert.deepEqual(ids("model:{}"), ids("model:*"));
    });

    it("collapses a one-term scope to the flat form", () => {
        assert.deepEqual(ids("model:{fire}"), ids("model:fire"));
    });

    it("counts the rows the scope's other terms leave", () => {
        assert.deepEqual(ids("model:>4"), [3]);
        assert.deepEqual(ids("model:{arcane count:>1}"), [3]);
        assert.deepEqual(ids("model:{arcane count:1}"), [2, 10]);
    });

    it("tests a target mask by role, inside the column that names the subject", () => {
        assert.deepEqual(ids("model:{target:caster}"), [2]);
        assert.deepEqual(ids("mech:{JUMP_DEST target:area}"), [8]);
    });
});

describe("the algebra", () => {
    it("returns the same set under any clause permutation", () => {
        const clauses = ["model:arcane", "-model:fire", "xpac:>tbc"];
        const expected = ids(clauses.join(" "));
        assert.deepEqual(expected, [3, 10]);
        for (const permuted of permutations(clauses)) {
            assert.deepEqual(ids(permuted.join(" ")), expected, permuted.join(" "));
        }
    });

    it("pushes negation through a conjunction, as De Morgan says", () => {
        assert.deepEqual(ids("-model:arcane | model:fire"), complement(ids("model:arcane -model:fire")));
    });

    it("reads alternatives as the union of their separate clauses", () => {
        assert.deepEqual(ids("model:(fire|arcane)"), ids("model:fire | model:arcane"));
    });

    it("starts an exclusion-only query from every spell", () => {
        assert.deepEqual(ids("-model:fire"), complement([0, 2, 9]));
    });

    it("answers an empty query with everything, because an empty conjunction is true", () => {
        assert.deepEqual(ids(""), EVERY);
        assert.deepEqual(ids("*"), EVERY);
    });
});

describe("properties and doors", () => {
    it("reaches a property door with its sentinel words", () => {
        assert.deepEqual(ids("cast:instant"), [2, 4]);
        assert.deepEqual(ids("channel:unlimited"), [5]);
        assert.deepEqual(ids("channel:>3"), [3, 9]);
    });

    it("matches a set flag by its word, as row content", () => {
        assert.deepEqual(ids("spell:unbreakable"), [3]);
        // A substring reaches both flag words, exactly as it reaches a category word or a file name.
        assert.deepEqual(ids("spell:break"), [3, 9]);
    });

    it("binds a flag and a duration to the one delivery row", () => {
        assert.deepEqual(ids("spell:{unbreakable channel:>3}"), [3]);
        assert.deepEqual(ids("spell:{breaksmove channel:>3}"), [9]);
    });

    it("keeps a bare number an id and a quoted number a name, on the same property", () => {
        assert.deepEqual(ids("sound:{kit:150}"), [0]);
        assert.deepEqual(ids('sound:{kit:"150"}'), [6]);
        assert.deepEqual(ids("sound:{kit:fireimpact}"), [0]);
    });

    it("compares an ordinal by its rung on the loaded ladder", () => {
        assert.deepEqual(ids("xpac:>wotlk"), [4, 5, 6, 8, 10]);
        assert.deepEqual(ids("xpac:classic"), [0, 1, 11]);
    });

    it("matches a colour name against nearby shades", () => {
        assert.deepEqual(ids("fx:{tint red}"), [4]);
    });
});

describe("plain search", () => {
    it("reads names, descriptions and asset paths, nothing else", () => {
        assert.deepEqual(ids("fire"), [0, 2, 9]);
        assert.deepEqual(ids("arcane"), [2, 3, 7, 10]);
    });

    it("reads a bare number as the spell's own id, and as text where text is plain", () => {
        assert.deepEqual(ids("133"), [7]);
        // The kit ID 150 is keyword-only: the digits reach the kit NAMED "150", never the kit numbered 150.
        assert.deepEqual(ids("150"), [6]);
    });
});

describe("candidates", () => {
    // A deliberately coarse seed: every spell with any row in the ask's column, and no seed at all for plain
    // search. Sound but lazy, which is the contract — the kernel must verify, so the answers cannot move.
    const seeded: Dataset = {
        ...DATA,
        candidates(ask: Ask): Iterable<number> | null {
            const column = ask.on === "column" ? ask.column
                : ask.on === "kind" ? ask.kind.column
                    : ask.on === "prop" ? ask.ref.kind.column : null;
            if (column === null) return null;
            return EVERY.filter((spell) => DATA.source(column)!.rows(spell).length > 0);
        },
    };

    it("changes the cost of a query and never its answer", () => {
        const queries = [
            "model:fire", "model:{fire -missile}", "-model:*", "model:>4", "missile:{from:chest}",
            "cast:instant", "spell:{unbreakable channel:>3}", "model:arcane -model:fire | xpac:>legion",
            "fire", "sound:{kit:150}",
        ];
        for (const query of queries) {
            assert.deepEqual(ids(query, seeded), ids(query), query);
        }
    });
});

function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
        permutations(items.toSpliced(index, 1)).map((rest) => {
            rest.unshift(item);
            return rest;
        }));
}
