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
    return [int(str(v)) for v in as_list(lua_function(engine, b"FIRST")(query.encode("utf-8"), limit))]


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
