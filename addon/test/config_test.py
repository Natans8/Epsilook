"""The settings layer: what a setting reads as, and what a store may say.

The panel is frames and is not tested here; what is tested is every function
that turns a stored value into the one a reader sees, run bare.
"""

from __future__ import annotations

from typing import cast

from support import LuaRuntime, LuaTable, as_list, lua_function, lua_table


def get(engine: LuaRuntime, key: bytes) -> object:
    return lua_function(engine, b"Epsilook.Config.Get")(key)


def load(engine: LuaRuntime, store: object) -> LuaTable:
    return cast(LuaTable, lua_function(engine, b"Epsilook.Config.Load")(store))


def test_a_setting_reads_as_its_default_until_it_is_chosen(engine: LuaRuntime) -> None:
    load(engine, None)
    assert get(engine, b"page") == 20
    assert get(engine, b"frame") == 0
    # A key nothing declares has no value rather than a made-up one.
    assert get(engine, b"nosuch") is None


def test_every_setting_is_declared_with_what_a_panel_needs(engine: LuaRuntime) -> None:
    """The panel draws itself from the declarations, so each carries its words."""
    keys = []
    for row in as_list(lua_table(engine, b"Epsilook.Config.SETTINGS")):
        setting = cast(dict[str, object], row)
        keys.append(setting["key"])
        assert setting["label"] and setting["hint"] and setting["kind"]
        assert setting["default"] is not None
    assert keys == ["page", "frame"]


def test_a_number_is_stepped_and_bounded(engine: LuaRuntime) -> None:
    load(engine, None)
    set_ = lua_function(engine, b"Epsilook.Config.Set")
    # 22 lies between two steps of five and is taken to the nearer.
    assert set_(b"page", 22) == 20
    assert set_(b"page", 23) == 25
    assert get(engine, b"page") == 25
    # Outside the declared bounds a value is refused, not clamped, so a store
    # written by hand says so instead of silently becoming something else.
    assert set_(b"page", 1) is None
    assert set_(b"page", 500) is None
    assert get(engine, b"page") == 25
    # Nil puts a setting back to its default.
    assert set_(b"page", None) == 20
    load(engine, None)


def test_a_store_keeps_only_what_the_declarations_still_admit(engine: LuaRuntime) -> None:
    """A value the declarations no longer allow is left behind rather than read."""
    engine.execute(b"STORE = { page = 500, frame = 3, gone = 7 }")
    store = load(engine, lua_table(engine, b"STORE"))
    assert get(engine, b"page") == 20, "an out-of-bounds stored value falls back to the default"
    assert get(engine, b"frame") == 3, "a value the declarations admit is kept"
    # The store is rewritten to exactly what is read, so the refused value goes.
    assert store[b"page"] is None
    assert store[b"frame"] == 3
    load(engine, None)


def test_the_page_size_the_shell_prints_is_the_setting(engine: LuaRuntime) -> None:
    load(engine, None)
    page = lua_function(engine, b"Epsilook.Shell.Page")
    assert page() == 20
    lua_function(engine, b"Epsilook.Config.Set")(b"page", 40)
    assert page() == 40
    load(engine, None)
    assert page() == 20
