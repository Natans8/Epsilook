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

import {camo, chain, description, expansion} from "../../../../src/search/schema/catalogue";
import {COLUMNS, fxColumn, modelColumn} from "../../../../src/search/schema/columns";
import {defineKind, formatValue, hintOf, KINDS, operatorsOf, parseValue} from "../../../../src/search/schema/kinds";
import {buildSchema, HEADS, kindIn, kindsOf, propIn, schemaProblems} from "../../../../src/search/schema/schema";
import {flag, id, path, text, TYPES} from "../../../../src/search/vocabulary/value-types";

describe("the shipped schema", () => {
    it("has no problems at all", () => {
        assert.deepEqual(schemaProblems(), []);
    });

    it("declares seven columns and no pseudo-column for chipless search", () => {
        // Chipless search is a ranked union of the properties that opt in, derived from the declarations, so it is not
        // a column and has no rows of its own.
        assert.deepEqual([...COLUMNS.keys()],
            ["spell", "id", "model", "sound", "anim", "fx", "mech"]);
    });

    it("derives every kind id as `column.word`, so an id cannot exist apart from its word", () => {
        for (const kind of KINDS.values()) {
            assert.equal(kind.id, `${kind.column.key}.${kind.word ?? kind.column.key}`);
        }
    });

    it("resolves the columns, the global kind words, the property prefixes and their spellings, and nothing else", () => {
        // A top-level word is earned, so the head index holds exactly what the declarations grant: every other kind
        // word is reachable inside its own column and nowhere shorter. A full name or synonym occupies its word's
        // namespaces, so each one is a head exactly where its word is.
        const ways = (full: string | undefined, synonyms: readonly string[] | undefined): number =>
            (full === undefined ? 0 : 1) + (synonyms?.length ?? 0);
        const globalKinds = [...KINDS.values()].filter((k) => k.global === true);
        const globals = globalKinds.length
            + globalKinds.reduce((n, k) => n + ways(k.full, k.synonyms), 0);
        const prefixed = [...KINDS.values()]
            .flatMap((k) => Object.values(k.props))
            .filter((p) => p.prefix !== undefined);
        const prefixes = prefixed.length + prefixed.reduce((n, p) => n + ways(p.full, p.synonyms), 0);
        const headColumns = [...COLUMNS.values()].filter((c) => c.head !== false);
        const heads = headColumns.length + headColumns.reduce((n, c) => n + (c.synonyms?.length ?? 0), 0);
        assert.equal(HEADS.size, heads + globals + prefixes);
        for (const column of COLUMNS.values()) {
            if (column.head !== false) assert.equal(HEADS.get(column.key)?.role, "column");
        }
    });

    it("resolves a kind's full name inside its column, exactly where the word is", () => {
        // The scoped counterpart of the HEADS spelling test: `fx:camouflage` asks what `fx:camo` asks.
        assert.equal(kindIn(fxColumn, "camo"), camo);
        assert.equal(kindIn(fxColumn, "camouflage"), camo);
        assert.equal(kindIn(fxColumn, "no-such-kind"), undefined);
        // A wordless kind has no word for the other spellings to respell, so its column key never resolves as a
        // scoped word.
        assert.equal(kindIn(fxColumn, "fx"), undefined);
    });

    it("resolves a property synonym to the property's own name, which is what every compact surface carries", () => {
        assert.equal(propIn(chain, "colour"), "colour");
        assert.equal(propIn(chain, "color"), "colour");
        assert.equal(propIn(chain, "no-such-prop"), undefined);
    });

    it("resolves the declared full names and synonyms at the top level", () => {
        // Every spelling reads; one spelling writes per surface. Both ways in reach the one declaration.
        const kindAt = (word: string): unknown => {
            const head = HEADS.get(word);
            return head?.role === "kind" ? head.kind : undefined;
        };
        assert.equal(kindAt("desc"), description);
        assert.equal(kindAt("description"), description);
        assert.equal(kindAt("expansion"), expansion);
        assert.equal(HEADS.get("animation")?.role, "column");
        assert.equal(HEADS.get("mechanics")?.role, "column");
    });

    it("keeps most kind words off the top level, where the column is the noun", () => {
        // `model:mount` reads as a whole question; `mount:` alone does not say what a mount is being asked about.
        for (const word of ["mount", "trail", "equipped", "ground", "keybind", "invis"]) {
            assert.equal(HEADS.has(word), false, `${word} should not be a top-level head`);
        }
    });

    it("calls the stuck-on-a-body category `attach`, its point KEYED `where` and SPOKEN `point`", () => {
        // The kind is the verb a reader reaches for — a top-level door, earned — and the point property
        // stopped colliding with it by moving aside. Its KEY stays `where` — the pack's storage name, which
        // a spoken-word change never moves — and its WORD is `point`, one word for the point everywhere.
        assert.ok(KINDS.has("model.attach"));
        assert.equal(HEADS.get("attach")?.role, "kind");
        for (const kindId of ["model.attach", "model.display", "model.item", "model.equipped", "model.barrage"]) {
            const held = KINDS.get(kindId);
            assert.ok(held !== undefined, kindId);
            assert.ok("where" in held.props, `${kindId} keys its point "where"`);
            assert.equal(held.props.where?.word, "point", `${kindId} speaks its point as "point"`);
            assert.equal(propIn(held, "point"), "where");
            assert.equal(propIn(held, "where"), undefined, "the storage key is not a way in");
        }
    });

    it("gives the spell column a head, while its kinds keep the obvious words", () => {
        // `spell:*` is total — every spell has a name — so the head is answered when asked, never offered. The kinds'
        // words stay the doors a reader actually types.
        assert.equal(HEADS.get("spell")?.role, "column");
        assert.equal(HEADS.get("name")?.role, "kind");
        assert.deepEqual(kindsOf(COLUMNS.get("spell")!).map((k) => k.word),
            ["name", "desc", "icon", undefined, "range"]);
    });

    it("leaves a column's same-named kind word-less, for the same reason", () => {
        // `id:133` and `sound:cast` are column heads. A kind spelled `id` or `sound` would be the same collision one
        // level down: reachable and unambiguous, so it needs no word of its own. Delivery is wordless for the
        // adjacent reason: its doors and flag words carry every real question, and a word selecting "spells with a
        // delivery row" would select nearly everything.
        for (const [kind, column] of [["id.id", "id"], ["sound.sound", "sound"], ["spell.spell", "spell"]] as const) {
            assert.equal(KINDS.get(kind)?.word, undefined);
            assert.equal(HEADS.get(column)?.role, "column");
        }
    });

    it("puts vehicle, invis, detect, speed and keybind in mech rather than fx", () => {
        // A vehicle seat, an invisibility channel and a movement-speed change render nothing. The fx column is what a
        // spell looks like; mech is what it does.
        for (const word of ["vehicle", "invis", "detect", "speed", "keybind"]) {
            assert.equal(KINDS.get(`mech.${word}`)?.column.key, "mech", word);
        }
    });

    it("declares delivery as one spell-column kind, whose valueless pieces are flag properties", () => {
        // The pack ships delivery as one record per spell, and the pieces qualify each other: a channel's length,
        // whether moving breaks it, whether the caster can act during it. It lives in the spell column because the
        // app draws it under the spell's name, and there is no instant flag: `cast:instant` is the one spelling.
        for (const old of ["delivery", "casttime", "channeled", "instant", "unbreakable", "unhindered"]) {
            assert.equal(KINDS.has(`mech.${old}`), false, `${old} should be part of spell.spell`);
        }
        const props = KINDS.get("spell.spell")!.props;
        assert.deepEqual(Object.keys(props),
            ["cast", "channel", "breaksmove", "unbreakable", "unhindered", "tracking"]);
        for (const name of ["breaksmove", "unbreakable", "unhindered", "tracking"]) {
            assert.deepEqual(props[name].types, [flag], name);
        }
        assert.equal(HEADS.get("cast")?.role, "prop");
        assert.equal(HEADS.get("channel")?.role, "prop");
    });

    it("puts how far a spell reaches in the spell column, beside how it goes off", () => {
        // Range is one record per spell, exactly as delivery is, and it is drawn under the spell's name rather than
        // as a mechanic of its own. The distance is the subject, so the kind's word is the door to it.
        assert.equal(KINDS.has("mech.range"), false);
        const range = KINDS.get("spell.range")!;
        assert.equal(range.single, true);
        assert.deepEqual(Object.keys(range.props), ["yards", "min", "melee", "weapon"]);
        assert.deepEqual(range.props.yards.sentinels, {0: "self", 50_000: "unlimited"});
        for (const name of ["melee", "weapon"]) {
            assert.deepEqual(range.props[name].types, [flag], name);
        }
    });

    it("splits invisibility into two kinds, because one word carried two quantities", () => {
        // A channel id and a count of the spells hiding in it are unrelated populations, so no operand shape can
        // dispatch between them the way two notations of one subject do.
        assert.ok(KINDS.has("mech.invis"));
        assert.ok(KINDS.has("mech.detect"));
        assert.deepEqual(Object.keys(KINDS.get("mech.invis")!.props), ["channel", "target"]);
    });

    it("names both ends of a beam apart", () => {
        // Two thirds of beam rows have a different source and destination attachment, so a single unioned attachment
        // property cannot say which end a reader meant.
        assert.deepEqual(Object.keys(KINDS.get("fx.chain")!.props),
            ["texture", "from", "to", "colour", "target"]);
        assert.deepEqual(Object.keys(KINDS.get("model.missile")!.props),
            ["file", "from", "to", "motion", "projectiles", "target"]);
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
                assert.equal((prop.plain?.length ?? 0) > 0, prop.tier !== undefined,
                    `${kind.id}.${name}: plain and tier must agree`);
            }
        }
    });

    it("reads exactly one identity notation in chipless search: the spell's own id", () => {
        // A bare number there means the spell id and nothing else. The kit id, the icon fid and every other identity
        // stay reachable through their own axes.
        const identity = [...KINDS.values()].flatMap((kind) =>
            Object.entries(kind.props)
                .filter(([, prop]) => prop.plain?.some((type) =>
                    !type.accepts.some((op) => op.name === "contains")))
                .map(([name]) => `${kind.id}.${name}`));
        assert.deepEqual(identity, ["id.id.value"]);
    });

    it("reads only the name half of a named thing in chipless search", () => {
        const kit = KINDS.get("sound.sound")!.props.kit;
        assert.deepEqual(kit.plain, [text]);
        assert.equal(KINDS.get("spell.icon")!.props.fid.plain, undefined);
    });

    it("records which types no property uses yet", () => {
        // A type is vocabulary and promises a reader nothing until a property declares it, so an unattached one cannot
        // produce an axis that silently answers nothing. Listing them here makes adding a type without attaching it a
        // deliberate act rather than an accident.
        const used = new Set([...KINDS.values()]
            .flatMap((kind) => Object.values(kind.props))
            .flatMap((prop) => prop.types.map((type) => type.name)));
        assert.deepEqual([...TYPES.keys()].filter((name) => !used.has(name)).toSorted(),
            ["angle", "coordinate", "offset"]);
    });

    it("keeps the mech column out of plain search", () => {
        // Its vocabulary is enum names such as SCHOOL_DAMAGE and UNIT_TARGET_ENEMY, so free text like "damage" or
        // "enemy" would reach most of the game. It stays reachable only through an explicit chip.
        for (const kind of kindsOf(COLUMNS.get("mech")!)) {
            for (const [name, prop] of Object.entries(kind.props)) {
                assert.ok(!prop.plain?.length, `${kind.id}.${name} joined plain search`);
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
            ["anyOf", "contains", "exact", "glob", "present", "regex"]);
        assert.deepEqual(operatorsOf({types: [id]}).toSorted(), ["anyOf", "exact", "present"]);
    });
});

describe("parseValue and formatValue", () => {
    const delivery = () => KINDS.get("spell.spell")!;

    it("reads a sentinel word before any notation, so it cannot be misread as a quantity", () => {
        assert.deepEqual(parseValue(delivery().props.channel, "unlimited"),
            {type: TYPES.get("seconds"), value: -1});
        assert.deepEqual(parseValue(delivery().props.cast, "instant"),
            {type: TYPES.get("seconds"), value: 0});
        assert.deepEqual(parseValue(delivery().props.cast, "INSTANT"),
            {type: TYPES.get("seconds"), value: 0});
    });

    it("keeps each sentinel the vocabulary of its own axis", () => {
        // The two properties share the duration type, and neither word leaks across.
        assert.equal(parseValue(delivery().props.cast, "unlimited"), null);
        assert.equal(parseValue(delivery().props.channel, "instant"), null);
    });

    it("dispatches an operand to the first notation that accepts it", () => {
        const kit = KINDS.get("sound.sound")!.props.kit;
        assert.deepEqual(parseValue(kit, "85701"), {type: TYPES.get("id"), value: 85701});
        assert.deepEqual(parseValue(kit, "frostbolt"), {type: TYPES.get("text"), value: "frostbolt"});
        assert.equal(parseValue(delivery().props.cast, "frostbolt"), null);
    });

    it("prints a sentinel's word and a quantity's spelling", () => {
        assert.equal(formatValue(delivery().props.channel, -1), "unlimited");
        assert.equal(formatValue(delivery().props.channel, 1500), "1.5s");
        assert.equal(formatValue(delivery().props.cast, 0), "instant");
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

    it("fires when a global kind claims a word another global declaration has", () => {
        const problems = problemsWith({
            column: modelColumn, word: "chain", global: true,
            hint: "a deliberate collision, for the check", props: {},
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /G1: "chain" is claimed by both kind fx\.chain and kind model\.chain/);
        assert.deepEqual(schemaProblems(), []);
    });

    it("lets two columns reuse a word that stays inside them", () => {
        // The column has already been named by the time a scoped word is read, so `model:dissolve` and `fx:dissolve`
        // could only ever mean their own column's kind. Only the top-level namespace is shared.
        const problems = problemsWith({
            column: modelColumn, word: "dissolve",
            hint: "a deliberate reuse, for the check", props: {},
        });
        assert.deepEqual(problems, []);
    });

    it("fires when a scoped word shadows a top-level one", () => {
        // `chain` opens a tag at the top level, so a column-scoped kind of the same name would make one spelling ask
        // two different questions depending on where it sits.
        const problems = problemsWith({
            column: modelColumn, word: "chain",
            hint: "a deliberate shadow, for the check", props: {},
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /"chain" of kind model\.chain shadows the top-level word of kind fx\.chain/);
    });

    it("fires when a global kind claims a column's key", () => {
        // Both appear at the start of a clause, so both are a head and they share one namespace.
        const problems = problemsWith({
            column: modelColumn, word: "sound", global: true,
            hint: "a deliberate collision, for the check", props: {},
        });
        assert.match(problems[0], /"sound" is claimed by both column sound/);
    });

    it("fires when a property prefix claims a word another property holds", () => {
        const problems = problemsWith({
            column: modelColumn, word: "timed",
            hint: "a deliberate collision, for the check",
            props: {bar: {types: [text], prefix: "cast"}},
        });
        assert.match(problems[0], /"cast" is claimed by both property spell\.spell\.cast/);
    });

    it("fires on a global kind with no word to be global with", () => {
        const problems = problemsWith({
            column: modelColumn, global: true,
            hint: "a deliberately wordless global kind", props: {},
        });
        assert.match(problems[0], /is global but has no word/);
    });

    it("fires when chipless search reads a notation the property does not declare", () => {
        const problems = problemsWith({
            column: modelColumn, word: "leaky",
            hint: "a deliberately inconsistent property",
            props: {file: {types: [path], plain: [text], tier: 2}},
        });
        assert.match(problems[0], /reads "text" in chipless search but does not declare it/);
    });

    it("fires when a second identity notation joins chipless search", () => {
        // A bare number in chipless search means the spell's own id; a second identity door would give the same
        // digits a second answer.
        const problems = problemsWith({
            column: modelColumn, word: "numbered",
            hint: "a deliberate second identity door",
            props: {ref: {types: [id], plain: [id], tier: 1}},
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /more than one identity notation/);
        assert.match(problems[0], /model\.numbered\.ref/);
    });

    it("resolves a synonym to the same declaration as its word, in any script", () => {
        // A synonym is a way in, never a second identity. The Cyrillic case pins the localisation route: a locale
        // vocabulary is more rows in the same lists, resolved through the same lookup.
        const aliased = defineKind({
            column: modelColumn, word: "projectile", global: true, synonyms: ["missiletest", "снаряд"],
            hint: "a deliberately respelled kind, for the check", props: {},
        });
        try {
            buildSchema();
            assert.equal(HEADS.get("projectile")?.role, "kind");
            for (const alias of ["missiletest", "снаряд"]) {
                const head = HEADS.get(alias);
                assert.equal(head?.role, "kind");
                assert.equal(head?.role === "kind" ? head.kind : undefined, aliased, alias);
            }
        } finally {
            KINDS.delete(aliased.id);
            buildSchema();
        }
    });

    it("fires when a synonym claims a word another declaration holds", () => {
        // A synonym occupies its word's namespaces, so it collides exactly as a word would.
        const problems = problemsWith({
            column: modelColumn, word: "fresh", global: true, synonyms: ["chain"],
            hint: "a deliberate synonym collision, for the check", props: {},
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /G1: "chain" is claimed by both kind fx\.chain and kind model\.fresh/);
    });

    it("fires when a scoped full name shadows a top-level word", () => {
        const problems = problemsWith({
            column: modelColumn, word: "fresh", full: "chain",
            hint: "a deliberate full-name shadow, for the check", props: {},
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /"chain" of kind model\.fresh shadows the top-level word of kind fx\.chain/);
    });

    it("fires when the fold rewrites a declared word whose folded form no alias catches", () => {
        // Input words arrive folded, and the fold rewrites regional spellings — a declared `armour` can never
        // arrive as itself. The guard is what keeps the British house spellings honest about needing their alias.
        const problems = problemsWith({
            column: modelColumn, word: "armour",
            hint: "a deliberately unreachable word, for the check", props: {},
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /"armour" of kind model\.armour is unreachable: input folds to "armor"/);
    });

    it("accepts the same word once its folded form is a synonym of the same declaration", () => {
        const problems = problemsWith({
            column: modelColumn, word: "armour", synonyms: ["armor"],
            hint: "the synonym that keeps the word reachable, for the check", props: {},
        });
        assert.deepEqual(problems, []);
    });

    it("fires on a spelling that repeats its own word, and on spellings with no word to respell", () => {
        assert.match(problemsWith({
            column: modelColumn, word: "fresh", synonyms: ["fresh"],
            hint: "a deliberately redundant synonym", props: {},
        })[0], /respells its own word "fresh"/);

        assert.match(problemsWith({
            column: modelColumn, word: "fresh", full: "fresh",
            hint: "a deliberately redundant full name", props: {},
        })[0], /respells its own word "fresh"/);

        assert.match(problemsWith({
            column: modelColumn, synonyms: ["orphaned"],
            hint: "deliberately wordless synonyms", props: {},
        })[0], /declares alternative spellings but no word for them to spell/);
    });

    it("fires when a property synonym collides inside its kind, and claims the top level only with a prefix", () => {
        const problems = problemsWith({
            column: modelColumn, word: "fresh",
            hint: "a deliberate in-kind synonym collision",
            props: {
                first: {types: [text]},
                second: {types: [text], synonyms: ["first"]},
            },
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /G1: "first" is claimed by both property model\.fresh\.first and property model\.fresh\.second/);
    });

    it("throws on a broken schema rather than building a partial one", () => {
        const clash = defineKind({
            column: modelColumn, word: "chain", global: true,
            hint: "a deliberate collision, for the check", props: {},
        });
        try {
            assert.throws(() => buildSchema(), /search schema is invalid/);
        } finally {
            KINDS.delete(clash.id);
            buildSchema();
        }
    });

    it("fires on notations that share no operator beyond presence", () => {
        // Both were declared to be matched and neither can be: a flag answers only whether a value exists, so pairing
        // it with a notation that matches text leaves a property nothing can ask about its value.
        const problems = problemsWith({
            column: modelColumn, word: "unusable",
            hint: "a deliberately unusable property",
            props: {both: {types: [flag, text]}},
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /model\.unusable\.both combines flag \+ text/);
    });

    it("allows a lone type that offers only presence, which is what a flag is", () => {
        const problems = problemsWith({
            column: modelColumn, word: "marker",
            hint: "a valueless property", props: {bit: {types: [flag]}},
        });
        assert.deepEqual(problems, []);
    });

    it("fires on a property with no type at all", () => {
        const problems = problemsWith({
            column: modelColumn, word: "typeless",
            hint: "a deliberately typeless property",
            props: {nothing: {types: []}},
        });
        assert.deepEqual(problems, ["model.typeless.nothing declares no type"]);
    });

    it("fires on a plain notation that cannot answer a bare token", () => {
        // A flag answers presence only, so joining the chipless union would put it there matching nothing.
        const problems = problemsWith({
            column: modelColumn, word: "unsearchable",
            hint: "a deliberately unsearchable property",
            props: {bit: {types: [flag], plain: [flag], tier: 0}},
        });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /reads "flag" in chipless search, which cannot answer a bare token/);
    });

    it("fires on sentinels with no numeric notation to hold them", () => {
        // A sentinel names a stored number, so a property of pure text has nowhere to store one.
        const problems = problemsWith({
            column: modelColumn, word: "worded",
            hint: "a deliberately misplaced sentinel",
            props: {label: {types: [text], sentinels: {0: "none"}}},
        });
        assert.match(problems[0], /declares sentinels but no numeric notation/);
    });

    it("fires when plain and tier disagree in either direction", () => {
        assert.match(problemsWith({
            column: modelColumn, word: "untiered",
            hint: "plain without a tier", props: {file: {types: [path], plain: [path]}},
        })[0], /is plain but declares no relevance tier/);

        assert.match(problemsWith({
            column: modelColumn, word: "stray",
            hint: "a tier without plain", props: {file: {types: [path], tier: 2}},
        })[0], /declares a relevance tier but is not plain/);
    });
});
