/**
 * @file The synthetic world the search tests run against, small enough to verify by hand.
 *
 * The world is built so each algebraic identity has a spell that separates the two sides — a fire model that is
 * not a missile, a kit named by digits, a flag word shared by two spells — because an identity that no fixture can
 * break is not being tested. The kernel proves its walk here and the simplifier proves its rewrites answer-equal
 * here, against the same spells, so a rule the kernel would expose cannot hide from the simplifier's fixtures.
 */
import {strict as assert} from "node:assert";

import {run} from "../../../src/search/evaluate/kernel";
import {
    attached, chain, delivery, description, effect, expansion, missile, name as nameKind, scale,
    sound as soundKind, spellId, tint,
} from "../../../src/search/schema/catalogue";
import type {Kind} from "../../../src/search/schema/kinds";
import {parse} from "../../../src/search/language/parse";
import type {Parsed} from "../../../src/search/language/ast";
import type {Dataset, Row, RowSource, Stored} from "../../../src/search/evaluate/rows";
import {setOrdinalLadder} from "../../../src/search/vocabulary/value-types";

setOrdinalLadder(["classic", "tbc", "wotlk", "cata", "legion", "bfa"]
    .map((word) => ({word, reads: []})));

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
            target: 2,
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

/** The world as the kernel reads it. */
export const DATA: Dataset = {
    spells: WORLD.length,
    source: (column): RowSource => ({rows: (spell) => columnRows(WORLD[spell], column.key)}),
};

/** Every spell index, for complements and whole-world assertions. */
export const EVERY: readonly number[] = WORLD.map((_, index) => index);

/** The spells NOT in the given set. */
export const complement = (spells: readonly number[]): number[] =>
    EVERY.filter((index) => !spells.includes(index));

/**
 * Parses a fixture query, asserting it parses cleanly — a broken fixture should fail its test loudly rather than
 * quietly select nothing.
 */
export function parsed(query: string): Parsed {
    const result = parse(query);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(errors, [], `query "${query}" should parse cleanly`);
    return result;
}

/** The spells a parse selects, sorted. */
export const answers = (p: Parsed, data: Dataset = DATA): number[] =>
    [...run(p, data)].toSorted((a, b) => a - b);
