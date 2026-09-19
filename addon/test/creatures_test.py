"""What the server bills a creature as, read through the interpreter the client runs.

A morph and a summon both store a creature id, and the type, the rank and the
faction are what a reader wants beside the name. These run against the built
data, because what is worth proving is that the Lua reads what the Python
emitted.
"""

from __future__ import annotations

from typing import cast

from support import LuaRuntime, unwrap

Record = dict[str, object]


def record(engine: LuaRuntime, code: bytes) -> Record:
    """One Lua table as the mapping it stands for."""
    return cast(Record, unwrap(engine.execute(code)))


def test_a_creature_reads_down_to_what_it_is(engine: LuaRuntime) -> None:
    """The warlock's Imp, which a summon spell reaches: a demon of no special
    billing, belonging to a faction the pack already names."""
    # language=Lua
    kind = record(engine, b"return Epsilook:GetCreatureKind(416)")
    assert cast(Record, kind["type"])["text"] == "Demon"
    assert cast(Record, kind["rank"])["text"] == "Normal"
    assert cast(Record, kind["faction"])["id"] == 90


def test_a_creature_the_pack_does_not_carry_answers_nothing(engine: LuaRuntime) -> None:
    # language=Lua
    assert engine.execute(b"return Epsilook:GetCreatureKind(999999999)") is None
