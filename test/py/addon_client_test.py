"""The addon's client seam, driven with a stand-in for the running game.

`Client.lua` is the one addon file allowed to reach the game, and everything
above it is written so that a column answered from a blob and one answered by
the client are indistinguishable. What that rests on is this file behaving the
same way whether a call is there or not: an absent route has to look like an
unanswerable column rather than raise, and a present one has to be detected by
being asked rather than by being looked for.

The game is stood in for by putting plain functions on the interpreter's own
globals table, which is exactly where the client puts its API, so nothing here
is a special path the real thing does not take.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from pack.emit.addon import SUPPLIED_BY

lua51 = pytest.importorskip("lupa.lua51")

ROOT = Path(__file__).resolve().parents[2]
CLIENT = ROOT / "addon" / "Epsilook" / "Client.lua"

UNWRITTEN = {"LibRPMedia"}
"""Routes the supply table names that this addon does not implement.

Named rather than left to be noticed: the column is simply unanswerable on a
lean build, which is a different thing from the route being forgotten. Each
entry is a claim waiting on what the library actually exposes.
"""


@pytest.fixture(name="lua")
def lua_fixture() -> Any:
    """A Lua state with `Client.lua` loaded and no game around it."""
    runtime = lua51.LuaRuntime(encoding=None)
    runtime.execute(CLIENT.read_bytes())
    return runtime


def seam(runtime: Any) -> Any:
    """The seam, as the addon's own global exposes it."""
    return runtime.globals()[b"Epsilook"][b"Client"]


def test_a_route_the_client_does_not_provide_is_not_there(lua: Any) -> None:
    """Asking is the detection, because a route is a composition of calls."""
    assert seam(lua).Has(b"GetSpellInfo") is False
    assert seam(lua).Get(b"GetSpellInfo", 133) is None


def test_a_route_this_addon_does_not_know_is_not_there(lua: Any) -> None:
    """A name nothing implements answers nothing rather than raising."""
    assert seam(lua).Has(b"NoSuchThing") is False
    assert seam(lua).Get(b"NoSuchThing", 133) is None


def test_a_route_the_client_provides_answers(lua: Any) -> None:
    """With the call in place, the seam hands its answer straight back."""
    lua.globals()[b"GetSpellInfo"] = lambda *_args: b"Fireball"
    assert seam(lua).Has(b"GetSpellInfo") is True
    assert seam(lua).Get(b"GetSpellInfo", 133) == b"Fireball"


def test_a_name_is_read_as_the_game_s_own(lua: Any) -> None:
    """The original-data flag is passed, or another addon's overrides win.

    A client on this server replaces the global and lets players rename their
    own auras. Reading without the flag turns those private strings into ours,
    and it contaminated a rename measurement before anybody noticed.
    """
    seen: list[Any] = []

    def spell_info(spell_id: Any, *rest: Any) -> bytes:
        seen.append((spell_id, rest))
        return b"Fireball"

    lua.globals()[b"GetSpellInfo"] = spell_info
    seam(lua).Get(b"GetSpellInfo", 133)
    assert seen, "the route did not reach the stand-in"
    spell_id, rest = seen[-1]
    assert spell_id == 133
    # Lua drops a nil argument in the middle, so what arrives is the id and the
    # flag. What matters is that the flag is true and is the last of them.
    assert rest[-1] is True


def test_a_route_that_raises_answers_nothing(lua: Any) -> None:
    """A client that errors is a column that cannot be answered, not a crash.

    Everything above this file treats an answerless route as an absent column,
    so an error escaping here would surface as a broken dossier rather than as
    a missing field.
    """

    def angry(*_args: Any) -> Any:
        raise RuntimeError("the client refused")

    lua.globals()[b"GetSpellTexture"] = angry
    assert seam(lua).Has(b"GetSpellTexture") is False
    assert seam(lua).Get(b"GetSpellTexture", 133) is None


def test_a_namespaced_route_needs_its_whole_path(lua: Any) -> None:
    """A table the client does not carry is absent, not an index error."""
    held = seam(lua)
    assert held.Has(b"C_Epsilon.GODI_Get") is False
    table = lua.eval(b"{}")
    table[b"GODI_Get"] = lambda index: 12345
    lua.globals()[b"C_Epsilon"] = table
    assert held.Has(b"C_Epsilon.GODI_Get") is True
    assert held.Get(b"C_Epsilon.GODI_Get", 7) == 12345


def test_every_route_is_one_the_supply_table_names(lua: Any) -> None:
    """A route nothing supplies through can never be reached.

    The two are one declaration read from either end: the emitter writes a
    route's name into `index.supplied`, and this file answers by that name. A
    route here that no column names is dead the moment it is written, and the
    way that happens is a column leaving the supply table while its route
    stays.
    """
    routes = set(SUPPLIED_BY.values())
    for name in seam(lua).ROUTES:
        assert name.decode("utf-8") in routes, (
            f"{name.decode('utf-8')} is a route no column is supplied by")


def test_every_supplied_route_is_written_or_declared_unwritten(lua: Any) -> None:
    """The other direction, which is a claim rather than dead code.

    A supplied column with no route here is answerable in principle and not in
    fact, which is honest only while it is said out loud.
    """
    written = {name.decode("utf-8") for name in seam(lua).ROUTES}
    for route in sorted(set(SUPPLIED_BY.values())):
        assert route in written or route in UNWRITTEN, (
            f"{route} supplies a column and nothing answers it; write the "
            f"route or name it in UNWRITTEN")
    assert UNWRITTEN <= set(SUPPLIED_BY.values()), (
        "UNWRITTEN names a route the supply table no longer asks for")
