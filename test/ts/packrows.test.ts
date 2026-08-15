/**
 * @file Reading the pack's row tables, and putting them back into the arrays 1.0 was written against.
 *
 * The expansion is the half with teeth. Every reader in `data.ts` walks parallel arrays and trusts the positions to
 * line up, so a row that contributes to one array and not another would shift everything after it — silently, and
 * only for the spells past the gap. The tests below check the two ways that happens: a kind that does not declare the
 * property an array reads, and a kind whose property is named something else.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import type {RowTable} from "../../src/packrows";
import {expand, expandAll, indexRows, passengerRows, rowsAt, storedAt} from "../../src/packrows";

/**
 * A model column holding a missile, an attached model and a carried weapon.
 *
 * Spell 10 has the missile and the weapon; spell 20 has the attached model; spell 30 has nothing. The three kinds
 * number end to end, so the missile is ref 0, the attached model ref 1 and the weapon ref 2.
 */
const MODELS: RowTable = {
    kinds: ["missile", "attached", "equipped"],
    sizes: [1, 1, 1],
    values: {
        missile: {file: [700], from: [5], to: [9], motion: [3], target: [1]},
        attached: {file: [800], attach: [4], target: [0]},
        equipped: {slot: [-2], attach: [-1], target: [2]},
    },
    vocab: {
        missile: {file: "files", from: "attachments", to: "attachments", motion: "motions"},
        attached: {file: "files", attach: "attachments"},
        equipped: {slot: "slots", attach: "attachments"},
    },
    absent: {
        missile: {from: -1, to: -1},
        attached: {attach: -1},
        equipped: {attach: -1},
    },
    counts: [2, 1, 0],
    refs: [0, 2, 1],
};

const SPELLS = [10, 20, 30];

describe("indexing a row table", () => {
    it("prefix-sums the counts into offsets one longer than the spells", () => {
        const index = indexRows(MODELS);
        assert.deepEqual([...index.at], [0, 2, 3, 3]);
    });

    it("gives every spell exactly the rows its count promised", () => {
        const index = indexRows(MODELS);
        assert.deepEqual(rowsAt(index, 0).map((r) => r.kind), ["missile", "equipped"]);
        assert.deepEqual(rowsAt(index, 1).map((r) => r.kind), ["attached"]);
        assert.deepEqual(rowsAt(index, 2), []);
    });

    it("reads a stored value, and reads absence as absence", () => {
        const index = indexRows(MODELS);
        const [missile] = rowsAt(index, 0);
        assert.equal(storedAt(MODELS, missile, "from"), 5);
        // The attached model's target is 0, which is this property's absent value, not a mask of nobody.
        const [attached] = rowsAt(index, 1);
        assert.equal(storedAt(MODELS, attached, "target"), undefined);
        // A property the kind does not declare at all.
        assert.equal(storedAt(MODELS, attached, "motion"), undefined);
    });
});

describe("expanding rows back into the legacy columns", () => {
    const columns = expand(MODELS, SPELLS, {
        kinds: {missile: 1, attached: 0, equipped: 0},
        cats: true,
        columns: {
            fids: {from: ["file", "slot"], missing: 0},
            srcAttach: {from: ["from", "attach"], missing: -1},
            dstAttach: {from: ["to"], missing: -1},
            motions: {from: ["motion"], missing: 0},
            targets: {from: ["target"], missing: 0},
        },
    });

    it("keeps every array the same length, so positions line up", () => {
        const lengths = Object.values(columns).map((a) => a.length);
        assert.deepEqual(lengths, lengths.map(() => 3));
    });

    it("writes the legacy sentinel where the kind has no such property", () => {
        // Only the missile has a destination attachment; the other two must read -1, not 0.
        assert.deepEqual(columns.dstAttach, [9, -1, -1]);
        assert.deepEqual(columns.motions, [3, 0, 0]);
    });

    it("takes the first property the kind actually declares", () => {
        // srcAttach was a missile's `from` and everything else's `attach`; fids is a file or a weapon slot marker.
        assert.deepEqual(columns.srcAttach, [5, -1, 4]);
        assert.deepEqual(columns.fids, [700, -2, 800]);
    });

    it("names the category each row came from", () => {
        assert.deepEqual(columns.cats, [1, 0, 0]);
        assert.deepEqual(columns.spellIds, [10, 10, 20]);
    });

    it("drops the kinds the section never held", () => {
        const onlyMissiles = expand(MODELS, SPELLS, {
            kinds: {missile: 1}, columns: {fids: {from: ["file"], missing: 0}},
        });
        assert.deepEqual(onlyMissiles.spellIds, [10]);
        assert.deepEqual(onlyMissiles.fids, [700]);
    });
});

describe("the kit expansion", () => {
    /** One kit playing two animations, which is two rows carrying the same kit id. */
    const ANIMS: RowTable = {
        kinds: ["kit"],
        sizes: [2],
        values: {kit: {id: [55, 55], anim: [1, 2], target: [4, 4]}},
        vocab: {kit: {anim: "anims"}},
        absent: {kit: {anim: -1}},
        counts: [2],
        refs: [0, 1],
    };

    it("gives back the kit once, which is what the count always meant", () => {
        const kits = expand(ANIMS, [10], {
            kinds: {kit: 0}, unique: ["id"],
            columns: {id: {from: ["id"], missing: 0}, targets: {from: ["target"], missing: 0}},
        });
        assert.deepEqual(kits.spellIds, [10]);
        assert.deepEqual(kits.id, [55]);
        assert.deepEqual(kits.targets, [4]);
    });
});

describe("the columns a row carries for the bridge", () => {
    /**
     * A dissolve painting two textures, and a screen painting none.
     *
     * Both carry the id of the effect they are, which no property of either kind declares: the evaluator has no use
     * for it and the section they replaced was one row per effect rather than one per texture.
     */
    const FX: RowTable = {
        kinds: ["dissolve", "screen"],
        sizes: [2, 1],
        values: {
            dissolve: {attach: [-1, -1], texture: [70, 71], target: [1, 1]},
            screen: {texture: [0], target: [2]},
        },
        carried: {dissolve: {dissolve: [40, 40]}, screen: {screen: [90]}},
        vocab: {dissolve: {attach: "anchors", texture: "files"}, screen: {texture: "files"}},
        absent: {dissolve: {attach: -2}, screen: {}},
        counts: [3],
        refs: [0, 1, 2],
    };

    it("keeps a carried column off the evaluator's reading of the row", () => {
        const index = indexRows(FX);
        const [first] = rowsAt(index, 0);
        assert.equal(storedAt(FX, first, "dissolve"), undefined);
        assert.equal(storedAt(FX, first, "texture"), 70);
    });

    it("collapses the texture expansion back to one row per effect", () => {
        const {dissolves, screens} = expandAll(FX, [10], {
            dissolves: {
                kinds: {dissolve: 0}, unique: ["dissolve"],
                columns: {
                    dissolveIds: {from: ["dissolve"], missing: 0},
                    targets: {from: ["target"], missing: 0},
                },
            },
            screens: {
                kinds: {screen: 0}, unique: ["screen"],
                columns: {screenIds: {from: ["screen"], missing: 0}},
            },
        });
        assert.deepEqual(dissolves.spellIds, [10]);
        assert.deepEqual(dissolves.dissolveIds, [40]);
        assert.deepEqual(dissolves.targets, [1]);
        assert.deepEqual(screens.screenIds, [90]);
    });

    it("builds every section from one walk, and each holds only its own kinds", () => {
        const both = expandAll(FX, [10], {
            dissolves: {kinds: {dissolve: 0}, columns: {}},
            screens: {kinds: {screen: 0}, columns: {}},
        });
        // Without `unique`, the dissolve's two textures are two rows again — the expansion is not lost, only folded
        // where a caller asks for the effect rather than the painting.
        assert.deepEqual(both.dissolves.spellIds, [10, 10]);
        assert.deepEqual(both.screens.spellIds, [10]);
    });

    it("starts each spell's uniqueness afresh, so two spells sharing an effect both keep it", () => {
        const shared: RowTable = {...FX, counts: [1, 1], refs: [0, 0]};
        const {dissolves} = expandAll(shared, [10, 20], {
            dissolves: {
                kinds: {dissolve: 0}, unique: ["dissolve"],
                columns: {dissolveIds: {from: ["dissolve"], missing: 0}},
            },
        });
        assert.deepEqual(dissolves.spellIds, [10, 20]);
        assert.deepEqual(dissolves.dissolveIds, [40, 40]);
    });
});

describe("the rider's roles", () => {
    /** One row per role, each setting exactly one of the three properties. */
    const RIDES: RowTable = {
        kinds: ["passenger"],
        sizes: [2],
        values: {passenger: {enter: [12, -1], sit: [-1, 13], exit: [-1, -1]}},
        vocab: {passenger: {enter: "anims", sit: "anims", exit: "anims"}},
        absent: {passenger: {enter: -1, sit: -1, exit: -1}},
        counts: [2],
        refs: [0, 1],
    };

    it("recovers the role from which property is set", () => {
        const rows = passengerRows(RIDES, [10], ["enter", "sit", "exit"]);
        assert.deepEqual(rows.spellIds, [10, 10]);
        assert.deepEqual(rows.animIds, [12, 13]);
        assert.deepEqual(rows.roles, [0, 1]);
    });
});
