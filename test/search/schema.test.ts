/**
 * @file The assembled schema: the kind catalogue, and the checks that hold declarations to their contract.
 *
 * The uniqueness check is the one with teeth. Two declarations claiming one word makes a query mean different things
 * depending on which was registered first, and the shipped engine has exactly that defect: `attach` is both a model
 * category word and an attachment keyword, so `model:attach` and `model:{attach:chest}` select unrelated populations.
 * The tests below prove the check catches it rather than only that the current declarations pass.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {COLUMNS, modelColumn} from "../../src/search/columns";
import {defineKind, hintOf, KINDS, operatorsOf} from "../../src/search/kinds";
import {buildSchema, HEADS, kindsOf, schemaProblems} from "../../src/search/schema";
import {flag, id, path, text, TYPES} from "../../src/search/value-types";

describe("the shipped schema", () => {
    it("has no problems at all", () => {
        assert.deepEqual(schemaProblems(), []);
    });

    it("declares seven columns and no pseudo-column for chipless search", () => {
        // Chipless search is a ranked union of the properties that opt in, derived from the declarations, so it is not
        // a column and has no rows of its own.
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

    it("calls the model category `attached`, leaving `attach` to the attachment property", () => {
        assert.ok(HEADS.has("attached"));
        assert.equal(HEADS.has("attach"), false,
            "`attach` must stay free for the attachment property to claim");
    });

    it("lets the text column decline a head so its kinds own the obvious words", () => {
        // Every spell has a name, so a head over the whole column would select everything. The word is better spent on
        // the kind a reader means.
        assert.equal(HEADS.has("text"), false);
        assert.equal(HEADS.get("name")?.role, "kind");
        assert.deepEqual(kindsOf(COLUMNS.get("text")!).map((k) => k.word),
            ["name", "desc", "icon"]);
    });

    it("leaves a column's same-named kind word-less, for the same reason", () => {
        // `id:133` and `sound:cast` are column heads. A kind spelled `id` or `sound` would be the same collision one
        // level down: reachable and unambiguous, so it needs no word of its own.
        for (const [kind, column] of [["id.id", "id"], ["sound.sound", "sound"]] as const) {
            assert.equal(KINDS.get(kind)?.word, undefined);
            assert.equal(HEADS.get(column)?.role, "column");
        }
    });

    it("puts seat, invis, detect, speed and keybind in mech rather than fx", () => {
        // A vehicle seat, an invisibility channel and a movement-speed change render nothing. The fx column is what a
        // spell looks like; mech is what it does.
        for (const word of ["seat", "invis", "detect", "speed", "keybind"]) {
            const head = HEADS.get(word);
            assert.equal(head?.role, "kind", `${word} is not a kind`);
            assert.equal(head!.role === "kind" && head.kind.column.key, "mech", word);
        }
    });

    it("splits invisibility into two kinds, because one word carried two quantities", () => {
        // A channel id and a count of the spells hiding in it are unrelated populations, so no operand shape can
        // dispatch between them the way two notations of one subject do.
        assert.ok(KINDS.has("mech.invis"));
        assert.ok(KINDS.has("mech.detect"));
        assert.deepEqual(Object.keys(KINDS.get("mech.invis")!.props), ["channel"]);
    });

    it("names both ends of a beam apart", () => {
        // Two thirds of beam rows have a different source and destination attachment, so a single unioned attachment
        // property cannot say which end a reader meant.
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

    it("gives every property a hint, its own or its first type's", () => {
        for (const kind of KINDS.values()) {
            for (const [name, prop] of Object.entries(kind.props)) {
                assert.ok(hintOf(prop).length > 0, `${kind.id}.${name} has no hint`);
            }
        }
    });

    it("declares a relevance tier for exactly the properties chipless search reads", () => {
        for (const kind of KINDS.values()) {
            for (const [name, prop] of Object.entries(kind.props)) {
                assert.equal(prop.plain === true, prop.tier !== undefined,
                    `${kind.id}.${name}: plain and tier must agree`);
            }
        }
    });

    it("records which types no property uses yet", () => {
        // A type is vocabulary and promises a reader nothing until a property declares it, so an unattached one cannot
        // produce an axis that silently answers nothing. Listing them here makes adding a type without attaching it a
        // deliberate act rather than an accident.
        const used = new Set([...KINDS.values()]
            .flatMap((kind) => Object.values(kind.props))
            .flatMap((prop) => prop.types.map((type) => type.name)));
        assert.deepEqual([...TYPES.keys()].filter((name) => !used.has(name)).toSorted(),
            ["angle", "flag", "offset"]);
    });

    it("keeps the mech column out of plain search", () => {
        // Its vocabulary is enum names such as SCHOOL_DAMAGE and UNIT_TARGET_ENEMY, so free text like "damage" or
        // "enemy" would reach most of the game. It stays reachable only through an explicit chip.
        for (const kind of kindsOf(COLUMNS.get("mech")!)) {
            for (const [name, prop] of Object.entries(kind.props)) {
                assert.notEqual(prop.plain, true, `${kind.id}.${name} joined plain search`);
            }
        }
    });
});

describe("operatorsOf", () => {
    it("offers only what every notation accepts, never the union", () => {
        // Offering an operator only one notation answers would make the result depend on what the operand happened to
        // look like.
        const kit = KINDS.get("sound.sound")!.props.kit;
        assert.deepEqual(kit.types.map((t) => t.name), ["id", "text"]);
        assert.deepEqual(operatorsOf(kit).toSorted(), ["anyOf", "exact", "present"]);
    });

    it("leaves a single-type property with everything that type accepts", () => {
        assert.deepEqual(operatorsOf({types: [text]}).toSorted(),
            ["anyOf", "contains", "exact", "glob", "present"]);
        assert.deepEqual(operatorsOf({types: [id]}).toSorted(), ["anyOf", "exact", "present"]);
    });
});

describe("hintOf", () => {
    it("prefers the property's own line", () => {
        assert.equal(hintOf({types: [text], hint: "the area it refuses to cast in"}),
            "the area it refuses to cast in");
    });

    it("falls back to the first type's line", () => {
        assert.equal(hintOf({types: [path]}), path.hint);
        assert.equal(hintOf({types: [id, text]}), id.hint);
    });
});

describe("the declaration checks", () => {
    /**
     * Registers a kind, runs the checks, and removes it again.
     *
     * The registry is module-level, so a check that fires has to be cleaned up or it fails every later assertion in
     * the file.
     *
     * @param kind A deliberately broken declaration.
     * @returns The problems reported for it.
     */
    function problemsWith(kind: Parameters<typeof defineKind>[0]): string[] {
        const registered = defineKind(kind);
        try {
            return schemaProblems();
        } finally {
            KINDS.delete(registered.id);
            buildSchema();
        }
    }

    it("fires when a kind claims a word another kind already has", () => {
        const problems = problemsWith({
            id: "model.chain", column: modelColumn, word: "chain",
            hint: "a deliberate collision, for the check", props: {},
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /G1: "chain" is claimed by both kind fx\.chain and kind model\.chain/);
        assert.deepEqual(schemaProblems(), []);
    });

    it("fires when a kind claims a column's key", () => {
        // Both appear before the colon, so both are a head and they share one namespace.
        const problems = problemsWith({
            id: "model.sound", column: modelColumn, word: "sound",
            hint: "a deliberate collision, for the check", props: {},
        });
        assert.match(problems[0], /"sound" is claimed by both column sound/);
    });

    it("throws on a broken schema rather than building a partial one", () => {
        const clash = defineKind({
            id: "model.chain", column: modelColumn, word: "chain",
            hint: "a deliberate collision, for the check", props: {},
        });
        try {
            assert.throws(() => buildSchema(), /search schema is invalid/);
        } finally {
            KINDS.delete(clash.id);
            buildSchema();
        }
    });

    it("fires on a kind id that does not match its column and word", () => {
        assert.throws(
            () => defineKind({
                id: "wrong.name", column: modelColumn, word: "spurious", hint: "x", props: {},
            }),
            /should be named "model\.spurious"/);
    });

    it("fires on notations that share no operator beyond presence", () => {
        // Both were declared to be matched and neither can be: a flag answers only whether a value exists, so pairing
        // it with a notation that matches text leaves a property nothing can ask about its value.
        const problems = problemsWith({
            id: "model.unusable", column: modelColumn, word: "unusable",
            hint: "a deliberately unusable property",
            props: {both: {types: [flag, text]}},
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /model\.unusable\.both combines flag \+ text/);
    });

    it("allows a lone type that offers only presence, which is what a flag is", () => {
        const problems = problemsWith({
            id: "model.marker", column: modelColumn, word: "marker",
            hint: "a valueless property", props: {bit: {types: [flag]}},
        });
        assert.deepEqual(problems, []);
    });

    it("fires on a property with no type at all", () => {
        const problems = problemsWith({
            id: "model.typeless", column: modelColumn, word: "typeless",
            hint: "a deliberately typeless property",
            props: {nothing: {types: []}},
        });
        assert.deepEqual(problems, ["model.typeless.nothing declares no type"]);
    });

    it("fires on a plain property that cannot answer a bare token", () => {
        // A flag answers presence only, so joining the chipless union would put it there matching nothing.
        const problems = problemsWith({
            id: "model.unsearchable", column: modelColumn, word: "unsearchable",
            hint: "a deliberately unsearchable property",
            props: {bit: {types: [flag], plain: true, tier: 0}},
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /is plain but no declared type can answer a bare token/);
    });

    it("fires when plain and tier disagree in either direction", () => {
        assert.match(problemsWith({
            id: "model.untiered", column: modelColumn, word: "untiered",
            hint: "plain without a tier", props: {file: {types: [path], plain: true}},
        })[0], /is plain but declares no relevance tier/);

        assert.match(problemsWith({
            id: "model.stray", column: modelColumn, word: "stray",
            hint: "a tier without plain", props: {file: {types: [path], tier: 2}},
        })[0], /declares a relevance tier but is not plain/);
    });
});
