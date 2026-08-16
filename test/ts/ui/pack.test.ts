/**
 * The browser pack reassembly: the merge must behave exactly as the Node reader's, because the two read one
 * artifact. Column dicts merge per column, everything else replaces wholesale, and the roster picker refuses a
 * version nothing matches.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {VersionEntry} from "../../../src/data";
import {mergeSections, pickEntry} from "../../../src/ui/pack";

test("two column dicts merge per column — the core half keeps its ids while the locale half brings names", () => {
    const pack = mergeSections({format: 54}, [
        {spells: {ids: [1, 2], icons: [0, 0]}},
        {spells: {names: ["Fireball", "Frostbolt"]}},
    ]);
    assert.deepEqual(pack.spells, {ids: [1, 2], icons: [0, 0], names: ["Fireball", "Frostbolt"]});
    assert.deepEqual(pack.meta, {format: 54});
});

test("a later column dict overrides the earlier's columns of the same name", () => {
    const pack = mergeSections({}, [
        {spells: {names: ["base"]}},
        {spells: {names: ["localized"]}},
    ]);
    assert.deepEqual(pack.spells, {names: ["localized"]});
});

test("a bare array replaces wholesale — arrays are never merged element-wise", () => {
    const pack = mergeSections({}, [
        {iconNames: ["a", "b"]},
        {iconNames: ["c"]},
    ]);
    assert.deepEqual(pack.iconNames, ["c"]);
});

test("an array meeting a dict replaces too — the merge only runs where both sides are column dicts", () => {
    const pack = mergeSections({}, [
        {section: {cols: [1]}},
        {section: [9]},
    ]);
    assert.deepEqual(pack.section, [9]);
});

const roster: VersionEntry[] = [
    {id: "12.1.0.69273", label: "Midnight", file: "data/12.1.0.69273/manifest.json"},
    {id: "9.2.7-epsilon.45745", label: "Epsilon 9.2.7", file: "data/9.2.7-epsilon.45745/manifest.json",
        default: true},
    {id: "9.2.7.45745", label: "Shadowlands", file: "data/9.2.7.45745/manifest.json"},
];

test("no version asked for picks the default entry", () => {
    assert.equal(pickEntry(roster).id, "9.2.7-epsilon.45745");
});

test("a version prefix picks the first matching entry in roster order", () => {
    assert.equal(pickEntry(roster, "12.1").id, "12.1.0.69273");
});

test("a label fragment reaches an entry its id would not", () => {
    assert.equal(pickEntry(roster, "Shadowlands").id, "9.2.7.45745");
});

test("a version nothing matches throws rather than silently serving the default", () => {
    assert.throws(() => pickEntry(roster, "3.3.5"), /no pack matches/);
});
