"""The kernel and the public surface, against the built data.

The oracle at the end is opt-in: it runs the probe list through the web
engine's command line as well, which lives in the parent repository and needs
Node. Set EPSILOOK_ADDON_ORACLE=1 to run it; it is the proof that the two
engines answer one query language alike.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import cast

import pytest
from support import LuaFunction, LuaRuntime, LuaTable, as_dict, as_list, lua_function, lua_table, unwrap

REPO = Path(__file__).resolve().parents[2]

PROBES = [
    "fireball", "name:fireball", 'name:"fire ball"', "name:=Fireball", "desc:kneel", "icon:frost", "id:133",
    "id:133,134", "xpac:wotlk", "xpac:>legion", "model:missile", "model:fire", "model:*", "-model:*",
    "model:>4", "model:4-8", "model:file=fire", "missile:motion=arc", "missile:target=caster", "model:mount",
    "sound>2", "sound:fire", "anim:=0", "anim:kit", "fx:chain", "fx:glow", "scale:+50%", "scale:x1.5",
    "scale:10-90", "tint:red", "mech:debuff", "mech:triggers", "cast>2s", "cast:instant", "channel:unlimited",
    "spell:breaksmove", "spell:unbreakable", "fire -model:missile", "fire | frost", "name:fire model:missile",
    "kit:150", "sound:kit=150", "effect:heal", "aura:dummy", "location:*", "summon:*", "speed:>+50%",
    # Row scopes: one row satisfies a conjunction; a count term is lifted out; negation refines.
    "model:{fire missile}", "model:{fire -missile}", "model:{attach:chest fire}", "model:{missile}", "model:{}",
    "model:{count>5 fire}", "model:{count > 5}", "missile:{from:chest}", "model:{fire | frost}",
    "sound:{fire kit:150}", "spell:{name:fire desc:kneel}", "id:{133 134}", "xpac:{wotlk legion}",
    "mech:{triggers caster}", "fx:{glow red}", "model:{fire missile", "anim:{kit count:>2}",
    # Reach: the two sentinel words, the flags, a near edge, and a flag conjoined with a value.
    "range:40", "range:>100", "range:10-40", "range:self", "range:unlimited", "range:melee",
    "range:weapon", "range:{min>10}", "range:{melee unlimited}", "spell:tracking",
]
"""Queries across every column and most types, each answered by both engines."""


def method(api: LuaTable, name: bytes) -> LuaFunction:
    """One method of the API table, typed as a function."""
    return cast(LuaFunction, api[name])


def count(engine: LuaRuntime, query: str) -> int:
    return int(str(lua_function(engine, b"Epsilook.Search.Count")(query.encode("utf-8"))))


def first(engine: LuaRuntime, query: str, limit: int) -> list[int]:
    # language=Lua
    engine.execute(b"""
    function FIRST(q, n)
      local out = {}
      local step = Epsilook.Search.Find(q)
      for _ = 1, n do
        local at, id = step()
        if not at then break end
        out[#out + 1] = id
      end
      return out
    end
    """)
    found = unwrap(lua_function(engine, b"FIRST")(query.encode("utf-8"), limit))
    # An empty Lua table is neither list nor mapping; a query with no answer is the empty list.
    return [] if found == {} else [int(str(v)) for v in as_list(found)]


def test_the_iterator_resumes_where_it_stopped(engine: LuaRuntime) -> None:
    # language=Lua
    engine.execute(b"""
    function RESUME(q)
      local step = Epsilook.Search.Find(q)
      local a1, i1 = step()
      local a2, i2 = step()
      local again = Epsilook.Search.Find(q, a1 + 1)
      local b2, j2 = again()
      return a2 == b2 and i2 == j2
    end
    """)
    assert lua_function(engine, b"RESUME")(b"model:missile") is True


def test_matches_agrees_with_find(engine: LuaRuntime) -> None:
    matches = lua_function(engine, b"Epsilook.Search.Matches")
    ids = first(engine, "fx:chain", 5)
    assert ids
    for spell_id in ids:
        assert matches(b"fx:chain", spell_id) is True
    assert matches(b"fx:chain", 0) is False


def test_the_api_answers_for_one_spell(engine: LuaRuntime) -> None:
    api = lua_table(engine, b"Epsilook")
    spell = as_dict(method(api, b"GetSpellDataByID")(api, 133))
    assert spell["name"] == "Fireball" and spell["school"] == "Fire"
    assert isinstance(spell["icon"], int) and spell["icon"] > 0
    assert spell["expansion"] == "Classic"
    # A band rather than a distance, resolved: Fireball reaches forty yards
    # from anywhere, which is the commonest band in the game.
    assert spell["range"] == 40 and spell["rangeMin"] == 0
    assert spell["rangeMelee"] is False and spell["rangeWeapon"] is False
    # Slam carries the combat band, whose stored five yards is a placeholder
    # the client replaces with the two bodies' own reach.
    slam = as_dict(method(api, b"GetSpellDataByID")(api, 1464))
    assert slam["rangeMelee"] is True and slam["range"] == 5
    # Charge is the near-edge shape: a target can stand too close for it.
    charge = as_dict(method(api, b"GetSpellDataByID")(api, 100))
    assert (charge["rangeMin"], charge["range"]) == (8, 25)
    # Reaching no further than the caster ships as no band at all.
    assert as_dict(method(api, b"GetSpellDataByID")(api, 6603))["range"] == 0
    counts = as_dict(method(api, b"GetPartCounts")(api, 133))
    models = counts["model"]
    assert isinstance(models, int) and models >= 1
    part = as_dict(method(api, b"GetPartDataByIndex")(api, 133, b"model", 1))
    assert part["axis"] == "model" and part["kind"] == "missile"
    values = as_dict(part["values"])
    assert str(values["file"]).lower().endswith(".m2")
    assert method(api, b"GetPartDataByIndex")(api, 133, b"model", models + 1) is None
    assert method(api, b"GetSpellDataByID")(api, 0) is None


def test_the_api_resolves_the_ids_an_action_needs(engine: LuaRuntime) -> None:
    api = lua_table(engine, b"Epsilook")
    read_all = lua_function(engine, b"Epsilook.Data.ReadAll")
    fids = as_list(read_all(b"model", b"files", b"fids"))
    assert fids
    assert method(api, b"GetSpawnIDByFile")(api, fids[0]) is not None
    # An animation with an emote, found off the column rather than assumed: the
    # emote map is the first payload that does not describe the build.
    emotes = [int(str(emote)) for emote in as_list(read_all(b"anim", b"animEmoteOneshots", b"emotes"))]
    anim = next(i for i, emote in enumerate(emotes) if emote)
    oneshot = cast(tuple[int, int], method(api, b"GetEmotesByAnim")(api, anim))[0]
    assert oneshot == emotes[anim] and oneshot > 0


def test_the_self_test_passes(engine: LuaRuntime) -> None:
    api = lua_table(engine, b"Epsilook")
    assert method(api, b"SelfTest")(api) is True


@pytest.mark.skipif(not os.environ.get("EPSILOOK_ADDON_ORACLE"),
                    reason="set EPSILOOK_ADDON_ORACLE=1; runs the probe list through Node as well")
def test_both_engines_answer_every_probe_alike(engine: LuaRuntime) -> None:
    """Counts and the first fifty ids, both, because two engines can agree on a
    count while disagreeing on which spells make it up."""
    subprocess.run(["node", "tools/build.mjs", "--cli"], cwd=REPO, check=True)
    pack = str(unwrap(engine.eval(b"Epsilook.index.pack")))
    disagreements = []
    for probe in PROBES:
        # The query comes after the option terminator: a probe may begin with a minus.
        printed = subprocess.run(["node", "tools/query.mjs", f"--version={pack}", "--json", "--limit=50", "--", probe],
                                 cwd=REPO, check=True, capture_output=True, text=True, encoding="utf-8")
        web = json.loads(printed.stdout)
        web_count, web_ids = int(web["count"]), [int(v) for v in web["ids"]]
        our_count, our_ids = count(engine, probe), first(engine, probe, 50)
        if our_count != web_count or our_ids != web_ids:
            disagreements.append(f"{probe!r}: lua {our_count} {our_ids[:5]} / web {web_count} {web_ids[:5]}")
    assert not disagreements, "\n".join(disagreements)


def test_a_sort_orders_the_answer_over_a_named_door(engine: LuaRuntime) -> None:
    """A vocabulary-backed door keys by the resolved name, and a row whose
    stored number nothing names has no name to be ordered by. Keeping the raw
    number there would put a string and a number in one key, and the first
    comparison between two spells would raise instead of ordering them.

    Not every door below is vocabulary-backed; they are here because each must
    answer at all, whichever way its key is read.
    """
    # Each door must ANSWER: before the fix a door whose vocabulary named only
    # some of its rows raised on the first comparison instead of ordering.
    # Every word here is a real head -- neither kit has one, by the rule that
    # `kit:` means two different things and so gets no global door, so a sound
    # kit is reached as `sound:{kit:...}` and can be sorted on by neither name.
    for door in ("morph", "missile", "summon", "mount"):
        assert first(engine, f"{door}:* sort:{door}", 20), door
        assert first(engine, f"{door}:* sort:-{door}", 20), door
    # And a door that does order must order both ways.
    up = first(engine, "morph:* sort:morph", 20)
    assert up != first(engine, "morph:* sort:-morph", 20)
    # The id door is a plain number and must come back in order.
    by_id = first(engine, "morph:* sort:id", 30)
    assert by_id == sorted(by_id)
    # Descending starts from the other end of the answer, not from this page.
    down_id = first(engine, "morph:* sort:-id", 30)
    assert down_id == sorted(down_id, reverse=True)
    assert down_id[0] > by_id[-1]
