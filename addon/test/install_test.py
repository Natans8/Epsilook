"""What the reader says when its data is missing, off, or from another download.

The two folders are installed by hand, and a player updating one and not the
other is the ordinary case rather than the rare one. So every way the pair can
disagree is named here, and a player is told which folder to fix.

The client's addon calls are stood in for, since this tree runs without a
client. A stand-in that encodes the assumption cannot test the assumption, so
these return exactly what the client's own addon list reads off them:
`name, title, notes, loadable, reason, security, newVersion`.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from typing import cast

from support import LuaRuntime, LuaTable, unwrap

READER = "Epsilook"
DATA = "Epsilook_Data"


@contextmanager
def client(
    runtime: LuaRuntime,
    *,
    installed: bool = True,
    loadable: bool = True,
    reason: str | None = "DEMAND_LOADED",
    fields: Mapping[str, Mapping[str, str]] | None = None,
) -> Iterator[None]:
    """Stand in for the client's two addon calls for as long as the block runs."""
    tocs = fields or {}
    lua_true = "true" if loadable else "false"
    lua_reason = "nil" if reason is None else f'"{reason}"'
    tables = ", ".join(
        f'["{addon}"] = {{ {", ".join(f"[{key!r}] = {value!r}" for key, value in values.items())} }}'
        for addon, values in tocs.items()
    )
    found = f'if name ~= "{DATA}" then return nil end' if installed else "do return nil end"
    # language=Lua
    runtime.execute(
        f"""
        local tocs = {{ {tables} }}
        _G.GetAddOnInfo = function(name)
            {found}
            return name, name, "", {lua_true}, {lua_reason}, "INSECURE", false
        end
        _G.GetAddOnMetadata = function(addon, field)
            return tocs[addon] and tocs[addon][field]
        end
        """.encode()
    )
    try:
        yield
    finally:
        # language=Lua
        runtime.execute(b"_G.GetAddOnInfo, _G.GetAddOnMetadata = nil, nil")


def problem(runtime: LuaRuntime) -> dict[str, object] | None:
    """The problem the data layer names, as a plain dict, or None."""
    found = runtime.execute(b"return Epsilook.Data.Problem()")
    if found is None:
        return None
    record = cast(LuaTable, found)
    return {cast(bytes, key).decode(): unwrap(record[key]) for key in record.keys()}


def said(runtime: LuaRuntime, found: dict[str, object] | None) -> str:
    """The line a player is shown for a problem."""
    if found is None:
        return ""
    fields = ", ".join(
        f"{key} = {value!r}" if isinstance(value, str) else f"{key} = {str(value).lower()}"
        for key, value in found.items()
    )
    # language=Lua
    lines = cast(LuaTable, runtime.execute(f"return Epsilook.Shell.ProblemLines({{ {fields} }})".encode()))
    return cast(bytes, lines[1]).decode()


def test_both_folders_from_one_download_raise_nothing(bare: LuaRuntime) -> None:
    fields = {DATA: {"X-Epsilook-Format": "2", "X-Epsilook-Release": "0.4"}, READER: {"Version": "0.4"}}
    with client(bare, fields=fields):
        assert problem(bare) is None


def test_a_build_for_development_is_not_called_mismatched(bare: LuaRuntime) -> None:
    """Only a packaged download writes its release into the data."""
    fields = {DATA: {"X-Epsilook-Format": "2"}, READER: {"Version": "0.4"}}
    with client(bare, fields=fields):
        assert problem(bare) is None


def test_missing_data_says_to_unzip_both_folders(bare: LuaRuntime) -> None:
    with client(bare, installed=False):
        found = problem(bare)
    assert found == {"code": "missing", "hard": True}
    assert "Unzip both folders" in said(bare, found)


def test_data_turned_off_says_where_to_turn_it_on(bare: LuaRuntime) -> None:
    with client(bare, loadable=False, reason="DISABLED"):
        found = problem(bare)
    assert found is not None and found["code"] == "disabled"
    assert "character select" in said(bare, found)


def test_another_refusal_is_given_in_the_clients_own_words(bare: LuaRuntime) -> None:
    """The client's addon list shows a reason as `ADDON_<code>`, and so does this."""
    # language=Lua
    bare.execute(b'_G.ADDON_CORRUPT = "Corrupt"')
    try:
        with client(bare, loadable=False, reason="CORRUPT"):
            found = problem(bare)
        assert found is not None and found["code"] == "unloadable"
        assert "could not load: Corrupt." in said(bare, found)
    finally:
        # language=Lua
        bare.execute(b"_G.ADDON_CORRUPT = nil")


def test_newer_data_says_to_update_the_reader(bare: LuaRuntime) -> None:
    """The player updated the data and not the addon."""
    with client(bare, fields={DATA: {"X-Epsilook-Format": "3"}}):
        found = problem(bare)
    assert found is not None and found["code"] == "layout" and found["hard"] is True
    assert "Update Epsilook from" in said(bare, found)


def test_older_data_says_to_update_the_data(bare: LuaRuntime) -> None:
    """The player updated the addon and not the data."""
    with client(bare, fields={DATA: {"X-Epsilook-Format": "1"}}):
        found = problem(bare)
    assert found is not None and found["code"] == "layout"
    assert "Update Epsilook_Data from" in said(bare, found)


def test_data_from_another_release_warns_and_does_not_stop(bare: LuaRuntime) -> None:
    """A different release in the same layout mostly reads; it is said, softly."""
    fields = {DATA: {"X-Epsilook-Format": "2", "X-Epsilook-Release": "0.3"}, READER: {"Version": "0.4"}}
    with client(bare, fields=fields):
        found = problem(bare)
    assert found == {"code": "release", "hard": False, "data": "0.3", "reader": "0.4"}
    line = said(bare, found)
    assert "Epsilook 0.4 is running with Epsilook_Data from 0.3" in line
    assert "|cffff2020" not in line, "a problem the addon works through is not drawn as an alarm"


def test_a_refused_load_names_its_problem(bare: LuaRuntime) -> None:
    """The loader hands the same record back, so the command can word it."""
    with client(bare, installed=False):
        # language=Lua
        ok, reason, found = cast(
            tuple[bool, bytes, LuaTable],
            bare.execute(b"return Epsilook.Data.Load()"),
        )
    assert ok is False
    assert b"not installed" in reason
    assert found[b"code"] == b"missing"


def test_a_fault_in_a_door_is_reported_once_and_goes_no_further(bare: LuaRuntime) -> None:
    """A hover handler that throws would otherwise throw on every mouse movement."""
    # language=Lua
    code = b"""
        local reports, stopped = 0, 0
        local real = _G.geterrorhandler
        _G.geterrorhandler = function()
            return function() reports = reports + 1 end
        end
        local door = Epsilook.Shell.Safely(function() error("a broken row") end, function()
            stopped = stopped + 1
        end)
        for _ = 1, 5 do
            door()
        end
        _G.geterrorhandler = real
        return reports, stopped
    """
    reports, stopped = cast(tuple[int, int], bare.execute(code))
    assert reports == 1, "reported once, not once per movement of the mouse"
    assert stopped == 5, "the caller's own clean-up runs every time"


def test_a_door_that_does_not_fault_passes_its_arguments_through(bare: LuaRuntime) -> None:
    # language=Lua
    code = b"""
        local seen
        Epsilook.Shell.Safely(function(a, b, c) seen = tostring(a) .. tostring(b) .. tostring(c) end)(1, nil, 3)
        return seen
    """
    assert unwrap(bare.execute(code)) == "1nil3", "a nil in the middle survives"


def test_a_property_with_no_vocabulary_asks_and_is_told_none(engine: LuaRuntime) -> None:
    """An absence is an answer. Asked through to the cache, nil raised on the key."""
    # language=Lua
    assert engine.execute(b"return Epsilook.Data.LocateVocab(nil)") is None


def test_waiting_for_items_calls_back_once_when_both_arrive(engine: LuaRuntime) -> None:
    """The items load and then the wait runs out regardless; both are being done.

    A caller answering both printed what it prints twice, and clicking an axis's
    count on a spell whose items the client had not cached printed the section
    twice over. The stand-ins below fire in the order the client fires them.
    """
    # language=Lua
    code = b"""
        local timers, loaders, calls = {}, {}, 0
        local realItem, realTimer = _G.Item, _G.C_Timer
        _G.Item = {
            CreateFromItemID = function(_, id)
                return {
                    IsItemEmpty = function() return false end,
                    IsItemDataCached = function() return false end,
                    ContinueOnItemLoad = function(_, done) loaders[#loaders + 1] = done end,
                }
            end,
        }
        _G.C_Timer = { After = function(_, done) timers[#timers + 1] = done end }
        -- A spell whose parts name an item, asked of the engine rather than
        -- walked for: a few hundred of a quarter of a million spells carry one.
        local spellID
        for _, id in Epsilook:FindSpells("model:item") do
            if id then
                spellID = id
                break
            end
        end
        Epsilook.Inspect.WhenItemsLoaded(spellID, function() calls = calls + 1 end)
        for _, done in ipairs(loaders) do done() end
        for _, done in ipairs(timers) do done() end
        _G.Item, _G.C_Timer = realItem, realTimer
        return spellID ~= nil, #loaders, #timers, calls
    """
    found, loaders, timers, calls = cast(tuple[bool, int, int, int], engine.execute(code))
    assert found, "a spell naming an item exists in the pack"
    assert loaders >= 1 and timers == 1, "both ways of being done were armed"
    assert calls == 1, "called back once, not once per way of being done"
