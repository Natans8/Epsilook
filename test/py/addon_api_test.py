"""The addon's surface, driven through the interpreter the client runs.

`addon_test.py` proves the emitter and the reader agree about bytes. This
proves the two layers above them agree about SPELLS: that a part comes back as
the kind the pack says it is, carrying the values that pack stores, and
carrying the ids the actions of its axis take.

Every test here runs the real Lua files. Nothing is reimplemented in Python and
handed to a stand-in, because the thing being checked is what the client will
execute -- a Python transcription of `Data.lua` could pass while the file the
game loads did not.

The payloads are built by the real emitter from small hand-written sections, so
a test states what a build ships rather than how a chunk is laid out. The one
opt-in test at the end walks a real pack instead and oracles it against the
build's own account of the same rows.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest
from pack.emit.addon import AXES, Variation, chunks
from pack.model import SECTIONS
from pack.model.sections.rows import ROW_COLUMNS
from support import unwrap

lua51 = pytest.importorskip("lupa.lua51")

ROOT = Path(__file__).resolve().parents[2]
ADDON = ROOT / "addon" / "Epsilook"
FILES = ("Reader.lua", "Data.lua", "Client.lua", "API.lua")
DECLARED = {section.name: section for section in SECTIONS}

SAMPLED = 40
"""How many spells the oracle walks per axis.

Every spell would read a million rows back through Lua for an answer the first
few hundred already give: what is being checked is one arithmetic and one
lookup, not a property of any particular spell.
"""


def none(_value: Any) -> None:
    """What a property with no vocabulary resolves to, which is nothing."""
    return None


def mapped(value: Any) -> Any:
    """One unwrapped table read as a mapping, whether or not it holds anything.

    Lua has one value for an empty list and an empty mapping, so the empty half
    of a record comes back as a list. Which was meant is the reader's to say,
    and a part's halves are mappings -- a kind carrying no property at all is
    an ordinary case, not a shape change.
    """
    return value or {}


def load(produced: Mapping[str, Any], variation: Variation = Variation.FULL) -> Any:
    """A Lua state holding the addon and a payload built from these sections.

    Args:
        produced: each section's payload, by section name, in the shape the
            browser's modules carry.
        variation: whether a column a client route supplies is left out.

    Returns:
        A Lua runtime with `Epsilook` loaded and the payload in place.
    """
    built = chunks(SECTIONS, produced, pack="test", version="9.2.7.1",
                   built="2026-01-01", variation=variation)
    # Strings cross as bytes rather than as text: the blob is addressed by byte
    # offset, so a runtime that decoded it on the way out would be answering
    # about a different string than the one the offsets describe.
    runtime = lua51.LuaRuntime(encoding=None)
    for name in FILES:
        runtime.execute((ADDON / name).read_bytes())
    for name, source in built.files.items():
        if name.endswith(".lua"):
            runtime.execute(source)
    return runtime


def api(runtime: Any) -> Any:
    """The one global the addon owns."""
    return runtime.globals()[b"Epsilook"]


def part(runtime: Any, spell: int, axis: str, index: int) -> Any:
    """One part of one spell, as Python values."""
    held = api(runtime)
    found = held.GetPartDataByIndex(held, spell, axis.encode("ascii"), index)
    return unwrap(found) if found is not None else None


def complete(section: str, columns: Mapping[str, Any]) -> Mapping[str, Any]:
    """A hand-written payload, checked against what that section declares.

    The emitter builds its header from what it is handed, so a column the
    registry declares and a payload here omits is not emitted and no test
    notices: they all go on passing against a shape the build stopped
    producing. That is how a ninth row column would arrive, since an eighth
    already did.
    """
    declared = set(DECLARED[section].columns)
    assert set(columns) == declared, (
        f"{section} ships {sorted(declared)}, this payload has "
        f"{sorted(columns)}")
    return columns


def spells(ids: Sequence[int]) -> Mapping[str, Any]:
    """The spell section, holding nothing but what a lookup by id needs."""
    return complete("spells", {
        "ids": list(ids), "names": [f"Spell {at}" for at in ids],
        "subtexts": [""] * len(ids), "altNames": [""] * len(ids),
        "icons": [0] * len(ids), "schools": [4] * len(ids),
        "eras": [0] * len(ids)})


def rows(section: str, kinds: Sequence[str], sizes: Sequence[int],
         values: Mapping[str, Any], counts: Sequence[int], refs: Sequence[int],
         *, vocab: Mapping[str, Any] | None = None,
         absent: Mapping[str, Any] | None = None) -> Mapping[str, Any]:
    """One row family, in the shape `produce` builds and the emitter writes."""
    return complete(section, {
        "kinds": list(kinds), "sizes": list(sizes), "values": dict(values),
        "carried": {}, "vocab": dict(vocab or {}),
        "absent": dict(absent or {}), "counts": list(counts),
        "refs": list(refs)})


def test_the_row_payload_states_every_column_the_build_ships() -> None:
    """The reconciliation above is worth nothing if it names the wrong list."""
    assert set(ROW_COLUMNS) == set(DECLARED["modelRows"].columns)


MODELS = {
    "spells": spells([10, 20, 30, 40]),
    "rowVocabs": {"files": {"in": "files", "keys": "fids", "values": "paths"},
                  "attachments": {"in": "attachmentNames"}},
    "files": {"fids": [700, 800, 900], "paths": ["one.m2", "two.m2", "three.m2"],
              "gobs": [-11, 0, -33]},
    "attachmentNames": {"0": "MountMain", "5": "SpellLeftHand"},
    # Two kinds, four pooled rows between them, and every one of them reached
    # by some spell: the second has one of each kind, which is where a reader
    # that gets the pool base wrong by one gives the wrong kind. The last spell
    # has none, which is what most spells look like on most axes.
    "modelRows": rows(
        "modelRows",
        kinds=["missile", "attached"],
        sizes=[2, 2],
        values={"missile": {"file": [700, 900], "from": [0, 5], "target": [1, 2]},
                "attached": {"file": [800, 900], "attach": [-1, 5],
                             "target": [1, 0]}},
        vocab={"missile": {"file": "files", "from": "attachments"},
               "attached": {"file": "files", "attach": "attachments"}},
        absent={"missile": {"from": -1}, "attached": {"attach": -1}},
        counts=[1, 2, 1, 0],
        refs=[0, 1, 2, 3],
    ),
}
"""A build with two model kinds, enough to state every rule about a part."""


def test_a_part_comes_back_as_the_kind_the_pack_says() -> None:
    """The reference names both the pool and the row within it."""
    runtime = load(MODELS)
    assert part(runtime, 10, "model", 1)["kind"] == "missile"
    assert part(runtime, 20, "model", 1)["kind"] == "missile"
    # Reference 2 is the first row of the second pool, which is the arithmetic
    # a reader gets wrong by one in either direction.
    assert part(runtime, 20, "model", 2)["kind"] == "attached"


def test_a_part_carries_what_the_pack_stores() -> None:
    """`values` is the stored numbers, which is what an action takes."""
    assert part(load(MODELS), 10, "model", 1)["values"] == {
        "file": 700, "from": 0, "target": 1}


def test_a_vocabulary_names_the_numbers_it_can() -> None:
    """`named` answers for the properties a vocabulary covers and no others.

    `target` is a mask with no vocabulary, so it appears in one half and not
    the other. Reading either half alone is what a caller does.
    """
    assert part(load(MODELS), 10, "model", 1)["named"] == {
        "file": "one.m2", "from": "MountMain"}


def test_the_absence_sentinel_is_the_kind_s_own() -> None:
    """A stored nought is a value where the kind says absence is something else.

    The failure this prevents is silent and was measured on a real build: a
    link word is an index into a pool, so its first entry is a word rather than
    the lack of one, and reading nought as absence loses it on thousands of
    spells. Here `from` declares minus one, so its nought is `MountMain`, while
    `attach` on the same build stores minus one and is left out.
    """
    missile = part(load(MODELS), 10, "model", 1)
    assert missile["values"]["from"] == 0
    assert missile["named"]["from"] == "MountMain"
    attached = part(load(MODELS), 20, "model", 2)
    assert "attach" not in attached["values"]
    assert "attach" not in attached["named"]


def test_a_property_whose_value_is_nought_and_undeclared_is_left_out() -> None:
    """With nothing declared, nought is what absence is spelled as."""
    assert part(load(MODELS), 30, "model", 1)["values"] == {"file": 900, "attach": 5}


def test_a_spell_with_no_parts_has_none() -> None:
    """A count of nought answers before any pool is touched."""
    runtime = load(MODELS)
    assert api(runtime).GetNumParts(api(runtime), 40, b"model") == 0
    assert part(runtime, 40, "model", 1) is None


def test_an_index_outside_the_spell_s_parts_answers_nothing() -> None:
    """Rather than the next spell's part, which is what lies there."""
    runtime = load(MODELS)
    assert part(runtime, 10, "model", 2) is None
    assert part(runtime, 10, "model", 0) is None


def test_an_unknown_spell_answers_nothing() -> None:
    """An id between two the build has is not a row between them."""
    assert part(load(MODELS), 15, "model", 1) is None


def test_walking_a_spell_s_parts_gives_them_in_order() -> None:
    """The iterator answers what the by-index call does, in the same order.

    It resolves where a spell's rows begin once for the whole walk rather than
    per part, so this is also what says the two doors agree.
    """
    held = api(load(MODELS))
    walk = held.IterateParts(held, 20, b"model")
    seen = []
    while True:
        found = walk()
        if found is None:
            break
        index, one = found
        seen.append((index, unwrap(one)["kind"]))
    assert seen == [(1, "missile"), (2, "attached")]


def test_a_reused_record_keeps_nothing_from_the_last_part() -> None:
    """The tables inside a filled record are emptied, not merged into.

    A caller reusing one record across a walk would otherwise see the previous
    part's properties on a row that has none, which reads exactly like data.
    """
    held = api(load(MODELS))
    first = held.GetPartDataByIndex(held, 20, b"model", 1)
    assert unwrap(first)["values"] == {"file": 900, "from": 5, "target": 2}
    again = held.GetPartDataByIndex(held, 20, b"model", 2, first)
    assert unwrap(again)["values"] == {"file": 800, "target": 1}
    assert unwrap(again)["named"] == {"file": "two.m2"}


def test_a_model_supplies_the_id_that_spawns_it() -> None:
    """The gob id, sign included, for the file the row names.

    The sign is what the command reads to tell a spawnable template from a
    display, so it is carried through rather than tidied away.
    """
    assert part(load(MODELS), 10, "model", 1)["ids"] == {"gob": -11}


def test_a_file_with_no_gob_supplies_nothing_to_spawn() -> None:
    """Nought is how the build spells "this file places nothing"."""
    assert not part(load(MODELS), 20, "model", 2)["ids"]


def test_an_action_is_offered_only_where_its_id_is_there() -> None:
    """Which is the whole of what pairs an action with a part."""
    held = api(load(MODELS))
    spawnable = held.GetPartDataByIndex(held, 10, b"model", 1)
    offered = unwrap(held.GetPartActions(held, spawnable))
    assert [one["key"] for one in offered] == ["spawn"]
    bare = held.GetPartDataByIndex(held, 20, b"model", 2)
    assert not unwrap(held.GetPartActions(held, bare))


def test_a_lean_build_can_still_find_a_spell_and_read_its_parts() -> None:
    """What the client answers is clipped; what addresses the payload is not.

    Every column of every section is read at the row a spell sits at, and the
    spell ids are what turn an id into that row. A client route answers about
    one spell it is handed and cannot say which row that spell is at, so
    clipping the ids would not degrade the lean build -- it would leave nothing
    able to find anything in it, on the smaller of the two shipped variations.
    """
    runtime = load(MODELS, Variation.LEAN)
    held = api(runtime)
    assert held.GetNumSpells(held) == 4
    assert held.GetSpellIndexByID(held, 20) == 1
    assert part(runtime, 20, "model", 2)["kind"] == "attached"


def test_a_lean_build_leaves_the_spawn_id_to_the_client() -> None:
    """`files.gobs` is supplied, so no model part offers a spawn without it.

    Pinned rather than left to be discovered in game: the seam that would
    close it is named on `Data.GetSupplier` and nothing composes it yet, and
    an action quietly missing on one variation is not something an interface
    can see for itself.
    """
    held = api(load(MODELS, Variation.LEAN))
    spawnable = held.GetPartDataByIndex(held, 10, b"model", 1)
    assert not unwrap(spawnable)["ids"]
    assert not unwrap(held.GetPartActions(held, spawnable))


TEXTS = {
    "spells": spells([10, 20]),
    "rowVocabs": {},
    # Every one of these columns repeats across spells -- a redirect cooks to
    # the same prose as its target -- so the pack pools the distinct strings
    # and ships a number per spell. The empty string is pooled like any other,
    # which is what makes "this spell has no aura line" an ordinary row.
    "spellText": {
        "descriptions": {"text": ["", "Throws a fiery ball."], "of": [1, 0]},
        "auras": {"text": ["", "Attack power increased."], "of": [0, 1]},
        "encounters": {"text": [""], "of": [0, 0]},
    },
}
"""A build carrying prose, in the pooled shape the pack actually ships."""


def test_a_spell_s_prose_is_read_through_the_pool() -> None:
    """A deduped column is a number per row and the strings once."""
    held = api(load(TEXTS))
    assert unwrap(held.GetSpellTextDataByID(held, 10)) == {
        "description": "Throws a fiery ball.", "aura": "", "encounter": ""}
    assert unwrap(held.GetSpellTextDataByID(held, 20)) == {
        "description": "", "aura": "Attack power increased.", "encounter": ""}


def test_a_spell_the_build_does_not_carry_has_no_prose() -> None:
    """Nothing to read at, rather than the row nought would give."""
    held = api(load(TEXTS))
    assert held.GetSpellTextDataByID(held, 15) is None


def test_a_clipped_description_is_asked_of_the_client() -> None:
    """The lean variation leaves the description out and the game answers.

    This is the seam actually composed rather than merely named: nothing above
    `Data` learns which of the two answered, and the client's is the better one
    because it resolves at the player's own level rather than at the
    expansion's cap.
    """
    runtime = load(TEXTS, Variation.LEAN)
    # Straight onto the interpreter's globals, which is where the game puts its
    # own API and therefore the only place the seam looks.
    runtime.globals()[b"GetSpellDescription"] = lambda _id: b"as the client tells it"
    held = api(runtime)
    assert unwrap(held.GetSpellTextDataByID(held, 10)) == {
        "description": "as the client tells it",
        # Clipped columns the client cannot answer would be worse than absent
        # if the description's route answered for them too, which is why the
        # supply is keyed per column and these two still ship.
        "aura": "", "encounter": ""}


def test_a_clipped_description_with_no_client_is_empty() -> None:
    """An unanswerable column is empty rather than an error or a nil field."""
    held = api(load(TEXTS, Variation.LEAN))
    assert unwrap(held.GetSpellTextDataByID(held, 10))["description"] == ""


ANIMS = {
    "spells": spells([10]),
    "rowVocabs": {"anims": {"in": "animNames"}},
    "animNames": ["Stand", "SpellCastDirected"],
    "animEmoteOneshots": [2000, 0],
    "animEmoteLoops": [4000, 4001],
    "animRows": rows(
        "animRows",
        kinds=["kit", "replace"],
        sizes=[1, 1],
        values={"kit": {"id": [13464], "anim": [0]},
                "replace": {"from": [0], "to": [1]}},
        vocab={"kit": {"anim": "anims"},
               "replace": {"from": "anims", "to": "anims"}},
        absent={"kit": {"anim": -1}, "replace": {"from": -1, "to": -1}},
        counts=[2],
        refs=[0, 1],
    ),
}
"""A build whose first animation has both emotes and whose second has one."""


def test_an_animation_supplies_both_emotes_where_the_build_has_both() -> None:
    """One plays the animation, the other sets the pose, and they differ.

    An interface handing one id to both commands would be right about half the
    time, which is why they are separate needs rather than one.
    """
    assert part(load(ANIMS), 10, "anim", 1)["ids"] == {
        "animkit": 13464, "emoteOneshot": 2000, "emoteLoop": 4000}


def test_a_row_naming_no_single_animation_supplies_no_emote() -> None:
    """A replacement names two animations and no one of them to play."""
    assert not part(load(ANIMS), 10, "anim", 2)["ids"]


def test_a_kind_declines_an_action_by_supplying_nothing() -> None:
    """So a kind needs no entry anywhere to be left out of one."""
    held = api(load(ANIMS))
    replace = held.GetPartDataByIndex(held, 10, b"anim", 2)
    offered = unwrap(held.GetPartActions(held, replace))
    # The two resets need no id at all, so they stand whatever the row is.
    assert [one["key"] for one in offered] == ["resetAnim", "resetStand"]


def test_every_action_names_an_id_some_part_of_its_axis_supplies() -> None:
    """The two declarations are one, read from either end.

    An action naming an id nothing produces could never be offered, and the way
    that happened once was a rename on one side: the model spawn asked for a
    display while what the command takes is a gob.
    """
    held = api(load(MODELS))
    # Every axis the emitter knows of, not only the ones this small build
    # ships, since an action is declared per axis and not per pack.
    for axis in AXES:
        supplies = unwrap(held.GetSupplies(held, axis.encode("ascii")))
        for action in unwrap(held.GetActions(held, axis.encode("ascii"))):
            if action["needs"] == "":
                continue
            assert action["needs"] in supplies, (
                f"{axis} action {action['key']} needs {action['needs']}, "
                f"which no part of that axis produces")


def test_every_action_that_reverts_names_one_that_exists() -> None:
    """A revert is a key of the same axis, so a rename cannot orphan it."""
    held = api(load(MODELS))
    for axis in AXES:
        offered = unwrap(held.GetActions(held, axis.encode("ascii")))
        keys = {action["key"] for action in offered}
        for action in offered:
            assert action["revert"] in ("", *keys), (
                f"{axis} action {action['key']} reverts with "
                f"{action['revert']}, which that axis does not offer")


def test_an_axis_the_build_does_not_ship_answers_nothing() -> None:
    """Four of the Classic packs carry whole sections that later ones do."""
    runtime = load(MODELS)
    assert api(runtime).GetNumParts(api(runtime), 10, b"fx") == 0
    assert part(runtime, 10, "fx", 1) is None


def test_the_part_axes_are_the_ones_carrying_rows() -> None:
    """Read off the payload, so a build shipping fewer offers fewer."""
    held = api(load(MODELS))
    assert unwrap(held.GetPartAxes(held)) == ["model"]


def test_a_sparse_vocabulary_reads_as_the_numbers_it_is_keyed_by() -> None:
    """The pack ships a sparse one as a mapping whose keys are text.

    Read as though they were the numbers they spell, every attachment on every
    model comes back unnamed, which looks like a build that shipped no names.
    """
    runtime = load(MODELS)
    look = runtime.eval(b"Epsilook.Data.GetVocabulary")(b"attachments")
    assert look(0) == b"MountMain"
    assert look(5) == b"SpellLeftHand"
    assert look(1) is None


def test_a_key_column_that_does_not_ascend_is_still_searched() -> None:
    """A paired lookup halves the column, so an unsorted tail needs the walk.

    One column in the whole build is like this: the equipped-weapon slots are
    appended to the file ids and they are negative, so the last rows descend.
    Halving alone steps over a key that is really there, and the answer looks
    exactly like a file the build does not carry.
    """
    held = dict(MODELS)
    held["files"] = {"fids": [700, 800, 900, -1], "gobs": [-11, 0, -33, -44],
                     "paths": ["one.m2", "two.m2", "three.m2", "equipped"]}
    look = load(held).eval(b"Epsilook.Data.GetPaired")(b"files", b"fids", b"paths")
    assert look(900) == b"three.m2"
    assert look(-1) == b"equipped"
    assert look(1234) is None


FRACTIONS = {
    "spells": spells([10]),
    "rowVocabs": {},
    "fxRows": rows(
        "fxRows",
        kinds=["scale"],
        sizes=[2],
        values={"scale": {"amount": [49.5, -50.0], "target": [1, 1]}},
        counts=[2],
        refs=[0, 1],
    ),
}
"""A build whose one kind carries a property that is not a whole number."""


def test_a_property_that_is_not_a_whole_number_comes_back_as_one() -> None:
    """A fractional value anywhere in a column ships the whole column as one.

    Two properties across the whole pack are like this, and reading either as
    though it were whole raises rather than answering wrongly -- which is how
    this was found, and why the cheap tier now carries a case for it.
    """
    runtime = load(FRACTIONS)
    assert part(runtime, 10, "fx", 1)["values"]["amount"] == pytest.approx(49.5)
    # Negative values are real on this property: a scale that shrinks.
    assert part(runtime, 10, "fx", 2)["values"]["amount"] == pytest.approx(-50.0)


def resolver(sections: Mapping[str, Any], where: Mapping[str, str]) -> Any:
    """What one vocabulary answers, read straight out of the loaded pack.

    The second implementation the oracle needs. It is the three shapes stated
    once more in Python, deliberately: a vocabulary that reads correctly here
    and not through Lua is exactly the disagreement worth catching, and the two
    accounts were written from the pack rather than from each other.
    """
    held = sections.get(where["in"])
    if held is None:
        return none
    if "keys" in where and "values" in where:
        return dict(zip(held[where["keys"]], held[where["values"]])).get
    column = held[where["values"]] if "values" in where else held
    if isinstance(column, dict):
        # A sparse vocabulary ships as a mapping whose keys are the numbers
        # written out, which is what JSON can carry and a list cannot.
        return lambda value: column.get(str(value))
    return lambda value: column[value] if 0 <= value < len(column) else None


def derived(values: Mapping[str, Any], kind: str, axis: str,
            gobs: Mapping[int, int], emotes: Mapping[str, Sequence[int]]
            ) -> Mapping[str, int]:
    """Which ids a row hands an action, worked out from the pack directly.

    The second account of `SUPPLIES`. Two of the five are the row's own value
    and cannot disagree with themselves; the other three are lookups, and a
    lookup is where a wrong id comes back looking exactly like a right one.
    Nought is no id everywhere it appears, which is the rule under test as much
    as the lookups are.
    """
    out: dict[str, int] = {}
    if axis == "sound":
        for name in ("file", "kit"):
            if values.get(name):
                out[name] = values[name]
    elif axis == "model":
        found = gobs.get(values.get("file", 0), 0)
        if found:
            out["gob"] = found
    elif axis == "anim":
        if kind == "kit" and values.get("id"):
            out["animkit"] = values["id"]
        anim = values.get("anim")
        if anim is not None:
            for name, column in emotes.items():
                if 0 <= anim < len(column) and column[anim]:
                    out[name] = column[anim]
    return out


@pytest.mark.skipif(not os.environ.get("EPSILOOK_ADDON_ORACLE"),
                    reason="set EPSILOOK_ADDON_ORACLE=1; needs a built pack "
                           "and reads it back through Lua")
def test_a_real_pack_s_parts_agree_with_the_build_s_own_account() -> None:
    """Every part of a sampled spell, against the walk that produced the rows.

    Two implementations of one answer: the build's `walk` reads the row table
    it just assembled, and the addon reads the same table out of a blob through
    the pool arithmetic. They can only agree if the emitting, the reference
    numbering, the vocabularies and the absence rule all match.
    """
    import packfile
    from pack.model.sections.rows import walk

    pack_dir = packfile.SITE / "data" / "9.2.7-epsilon.45745"
    if not (pack_dir / "manifest.json").exists():
        pytest.skip(f"{pack_dir.name} is not built")
    sections = packfile.load(pack_dir)
    meta = sections.pop("meta", {})
    runtime = load(sections)
    held = api(runtime)

    ids = sections["spells"]["ids"]
    assert str(meta.get("version"))
    vocabularies = {name: resolver(sections, where)
                    for name, where in sections["rowVocabs"].items()}
    # The three ids that are DERIVED rather than a property read straight off
    # the row, stated here a second way. A passthrough cannot disagree with
    # itself; a lookup can, and these are the ones an action would act on.
    gobs = dict(zip(sections["files"]["fids"], sections["files"]["gobs"]))
    emotes = {"emoteOneshot": sections["animEmoteOneshots"],
              "emoteLoop": sections["animEmoteLoops"]}

    checked = 0
    for axis in unwrap(held.GetPartAxes(held)):
        table = sections[f"{axis}Rows"]
        absent = table["absent"]
        counts = table["counts"]
        # An even stride alone would sample almost nothing but spells with no
        # parts at all, since most spells have none on any one axis. The
        # busiest spells are added so the walk covers a real spread of kinds,
        # and the stride is kept because a spell with nothing is a case too.
        busiest = sorted(range(len(counts)), key=lambda at: -counts[at])[:SAMPLED]
        wanted = set(busiest) | set(range(0, len(ids),
                                          max(1, len(ids) // SAMPLED)))
        # Float, because two properties across the build carry a
        # fraction and ship their whole column as one.
        expected: dict[int, list[tuple[str, dict[str, float]]]] = {}
        for spell, kind, values in walk(table):
            if spell not in wanted:
                continue
            declared = table["values"].get(kind, {})
            expected.setdefault(spell, []).append((kind, {
                name: value for name, value in values.items()
                if name in declared and value != absent.get(kind, {}).get(name, 0)}))
        for spell in sorted(wanted):
            want = expected.get(spell, [])
            assert held.GetNumParts(held, ids[spell],
                                    axis.encode("ascii")) == len(want)
            for at, (kind, values) in enumerate(want, start=1):
                got = part(runtime, ids[spell], axis, at)
                where = f"{axis}[{at}] of spell {ids[spell]}, a {kind}"
                assert got["kind"] == kind, where
                assert mapped(got["values"]) == values, where
                keyed = table["vocab"].get(kind, {})
                names = {}
                for name, value in values.items():
                    found = vocabularies.get(keyed.get(name, ""), none)(value)
                    if found is not None:
                        names[name] = found
                assert mapped(got["named"]) == names, where
                assert mapped(got["ids"]) == derived(values, kind, axis, gobs,
                                                     emotes), where
                checked += 1
        assert checked > 0, f"the {axis} sample held no parts at all"
