/* THE SCHEMA — the kind catalogue and the gate that keeps two declarations
 * from claiming one word.
 *
 * ⭐ G1 IS THE ONLY ONE OF L5.1's FOUR GATES A SCRIPT CAN DECIDE, and it is
 * also the one 1.0 already broke: `attach` is registered BOTH as a model
 * category word and as the attachment keyword, so inside one column
 * `model:attach` is 16 and `model:{attach:chest}` is 51,581. Nothing warned,
 * because nothing could. The point of this file is that it now can.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {COLUMNS} from "../../src/search/columns";
import {KINDS, operatorsOf} from "../../src/search/kinds";
import {defineKind} from "../../src/search/kinds";
import {buildSchema, HEADS, kindsOf, schemaProblems} from "../../src/search/schema";
import {TYPES} from "../../src/search/value-types";
import {id, text} from "../../src/search/value-types";
import {modelColumn} from "../../src/search/columns";

describe("the shipped schema", () => {
    it("has no problems at all", () => {
        assert.deepEqual(schemaProblems(), []);
    });

    it("declares the seven columns, with `all` gone", () => {
        // `all` was never a column — it is chipless search, which L7 makes a
        // DECLARED union of the axes that opt in rather than a pseudo-field
        // holding seven hand-written calls (SEARCH.md §8.4).
        assert.deepEqual([...COLUMNS.keys()],
            ["text", "id", "model", "sound", "anim", "fx", "mech"]);
    });

    it("names every kind `column.word`, so an id cannot drift from its word", () => {
        for (const kind of KINDS.values()) {
            assert.equal(kind.id, `${kind.column.key}.${kind.word ?? kind.column.key}`);
        }
    });

    it("resolves every kind word and every column that offers a head", () => {
        const words = [...KINDS.values()].filter((k) => k.word !== undefined).length;
        const heads = [...COLUMNS.values()].filter((c) => c.head !== false).length;
        assert.equal(HEADS.size, heads + words);
        for (const column of COLUMNS.values()) {
            if (column.head !== false) assert.equal(HEADS.get(column.key)?.role, "column");
        }
    });

    it("renames the model category word to `attached`, closing the live G1 defect", () => {
        // TYPES §8.6 (3). `attached` already exists in 1.0 as its twin and is
        // the better noun, so nothing is invented — the collision simply goes.
        assert.ok(HEADS.has("attached"));
        assert.equal(HEADS.has("attach"), false,
            "`attach` must stay free for the attachment UNION axis (PHASE 5)");
    });

    it("lets the text column decline a head so its kinds own the obvious words", () => {
        // Every spell has a name, so a head over the whole column would select
        // everything. The word is better spent on the kind a reader means.
        assert.equal(HEADS.has("text"), false);
        assert.equal(HEADS.get("name")?.role, "kind");
        assert.deepEqual(kindsOf(COLUMNS.get("text")!).map((k) => k.word),
            ["name", "desc", "icon"]);
    });

    it("leaves a column's same-named kind word-less, for the same reason", () => {
        // `id:133` and `sound:cast` are COLUMN heads; a kind called `id` or
        // `sound` would be the same collision one column over. Reachable,
        // unambiguous, unspelled — and the sound one was caught by the guard
        // rather than by review, which is the point of having it.
        for (const [kind, column] of [["id.id", "id"], ["sound.sound", "sound"]] as const) {
            assert.equal(KINDS.get(kind)?.word, undefined);
            assert.equal(HEADS.get(column)?.role, "column");
        }
    });

    it("puts seat, invis, detect and speed in mech, where the shipped app has them", () => {
        // TYPES §8.4 lists all four under `fx` and omits `keybind` entirely.
        // 1.0's registry states the rule out loud — fx is what the spell LOOKS
        // like, mech is what it DOES — and a vehicle seat renders nothing.
        for (const word of ["seat", "invis", "detect", "speed", "keybind"]) {
            const head = HEADS.get(word);
            assert.equal(head?.role, "kind", `${word} is not a kind`);
            assert.equal(head!.role === "kind" && head.kind.column.key, "mech", word);
        }
    });

    it("splits `invis` into two kinds, because it carried two QUANTITIES", () => {
        // TYPES §8.6 (1). One word held a channel id AND a detector count,
        // told apart by whether an operator was typed (`operatorOnly`). The
        // discriminator is decidable: `invis:13` and `invis:>0` name unrelated
        // populations, where two NOTATIONS would name the same row.
        assert.ok(KINDS.has("mech.invis"));
        assert.ok(KINDS.has("mech.detect"));
        assert.deepEqual(Object.keys(KINDS.get("mech.invis")!.props), ["channel"]);
    });

    it("names both ends of a beam apart, which is the 67% finding", () => {
        // 2,014 of 2,997 BeamEffect rows have a different source and
        // destination attachment, so a unioned `attach` cannot say which end.
        assert.deepEqual(Object.keys(KINDS.get("fx.chain")!.props),
            ["texture", "from", "to", "colour", "target"]);
        assert.deepEqual(Object.keys(KINDS.get("model.missile")!.props),
            ["file", "from", "to", "motion", "target"]);
    });

    it("gives every kind a hint and every property a declared type", () => {
        for (const kind of KINDS.values()) {
            assert.ok(kind.hint.length > 0, `${kind.id} has no hint`);
            for (const [name, prop] of Object.entries(kind.props)) {
                assert.ok(prop.types.length > 0, `${kind.id}.${name} has no type`);
                for (const type of prop.types) {
                    assert.equal(TYPES.get(type.name), type, `${kind.id}.${name}`);
                }
            }
        }
    });

    it("declares a relevance tier for every axis chipless search reads", () => {
        // L7. 1.0 ranks plain search on the NAME alone, so a description-only
        // hit sits in the same bucket as an exact name match with nothing to
        // sink it — that is the defect the tiers exist to close.
        for (const kind of KINDS.values()) {
            for (const [name, prop] of Object.entries(kind.props)) {
                assert.equal(prop.plain === true, prop.tier !== undefined,
                    `${kind.id}.${name}: plain and tier must agree`);
            }
        }
    });

    it("keeps the mech column out of plain search", () => {
        // Its vocabulary is enum names — SPELL_EFFECT_SCHOOL_DAMAGE,
        // UNIT_TARGET_ENEMY — so free text like "damage" or "enemy" would drag
        // in most of the game. Reachable only through an explicit chip.
        for (const kind of kindsOf(COLUMNS.get("mech")!)) {
            for (const [name, prop] of Object.entries(kind.props)) {
                assert.notEqual(prop.plain, true, `${kind.id}.${name} joined plain search`);
            }
        }
    });
});

describe("operatorsOf — the multi-notation intersection", () => {
    it("offers only what EVERY notation accepts, never the union", () => {
        // TYPES §7 rule 2. `kit:>5` is a static error because `id` and `text`
        // both decline ordering — and offering it would mean the answer
        // depended on which notation the operand happened to look like.
        const kit = KINDS.get("sound.sound")!.props.kit;
        assert.deepEqual(kit.types.map((t) => t.name), ["id", "text"]);
        assert.deepEqual(operatorsOf(kit).toSorted(), ["exact", "present"]);
    });

    it("leaves a single-type property with everything that type accepts", () => {
        assert.deepEqual(operatorsOf({types: [text]}).toSorted(),
            ["contains", "exact", "glob", "present"]);
        assert.deepEqual(operatorsOf({types: [id]}).toSorted(), ["exact", "present"]);
    });
});

describe("G1 — the uniqueness gate", () => {
    it("FIRES when a kind claims a word another kind already has", () => {
        // A guard nobody has seen fail is not known to work. The registry is
        // module-level, so this test restores it — and each test FILE runs in
        // its own process, which is the second line of defence.
        const clash = defineKind({
            id: "model.chain", column: modelColumn, word: "chain",
            hint: "a deliberate collision, for the guard", props: {},
        });
        try {
            const problems = schemaProblems();
            assert.equal(problems.length, 1);
            assert.match(problems[0], /G1: "chain" is claimed by both kind fx\.chain and kind model\.chain/);
            assert.throws(() => buildSchema(), /search schema is invalid/);
        } finally {
            KINDS.delete(clash.id);
            buildSchema();
        }
        assert.deepEqual(schemaProblems(), []);
    });

    it("FIRES when a kind claims a COLUMN's key", () => {
        // Same namespace: both appear before the colon, so both are a head.
        const clash = defineKind({
            id: "model.sound", column: modelColumn, word: "sound",
            hint: "a deliberate collision, for the guard", props: {},
        });
        try {
            assert.match(schemaProblems()[0], /"sound" is claimed by both column sound/);
        } finally {
            KINDS.delete(clash.id);
            buildSchema();
        }
    });

    it("FIRES on a kind id that does not match its column and word", () => {
        assert.throws(
            () => defineKind({
                id: "wrong.name", column: modelColumn, word: "spurious", hint: "x", props: {},
            }),
            /should be named "model\.spurious"/);
    });
});
