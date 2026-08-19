"""Helpers the addon's tests share. Fixtures are in conftest.py; what a test
imports by name lives here, because importing out of a conftest is not a
thing pytest supports.

`lupa` ships no type stubs, so the runtime, its tables and its functions are
described here as protocols of exactly the calls the tests make. A test then
reads a Lua value through `lua_function` or `unwrap` and is typed from there.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol, cast

import pytest

lua51 = pytest.importorskip("lupa.lua51")


class LuaTable(Protocol):
    """A Lua table as the runtime proxies it."""

    def keys(self) -> Iterable[object]: ...

    def __getitem__(self, key: object) -> object: ...


class LuaFunction(Protocol):
    """A Lua function as the runtime proxies it; what it returns depends on the function."""

    def __call__(self, *args: object) -> object: ...


class LuaRuntime(Protocol):
    """The one Lua 5.1 state a test drives."""

    def execute(self, source: bytes) -> object: ...

    def eval(self, source: bytes) -> object: ...

    def table_from(self, mapping: dict[bytes, object]) -> LuaTable: ...

    def globals(self) -> LuaTable: ...


def lua_function(runtime: LuaRuntime, path: bytes) -> LuaFunction:
    """A Lua function by its path under the global, typed as one."""
    return cast(LuaFunction, runtime.eval(path))


def lua_table(runtime: LuaRuntime, path: bytes) -> LuaTable:
    """A Lua table by its path under the global, typed as one."""
    return cast(LuaTable, runtime.eval(path))


def is_table(value: object) -> bool:
    return bool(lua51.lua_type(value) == "table")


def unwrap(value: object) -> object:
    """A Lua value as the Python one it stands for.

    A table is a list where its keys are one to n and a mapping otherwise. A
    kind or property record is summarised by its identity, so a parse tree
    reads as data rather than as the whole schema.
    """
    if not is_table(value):
        return value.decode("utf-8") if isinstance(value, bytes) else value
    table = cast(LuaTable, value)
    keys = list(table.keys())
    numbered = [k for k in keys if isinstance(k, int)]
    if keys and len(numbered) == len(keys) and sorted(numbered) == list(range(1, len(keys) + 1)):
        return [unwrap(table[k]) for k in range(1, len(keys) + 1)]
    out: dict[str | int, object] = {}
    for key in keys:
        # A Lua table key is a string or a number here; anything else would be
        # a table or a function used as a key, which the addon never does.
        name: str | int = key.decode("utf-8") if isinstance(key, bytes) else cast(int, key)
        held = table[key]
        if name in ("kind", "prop") and is_table(held):
            record = cast(LuaTable, held)
            out[name] = unwrap(record[b"id"] if record[b"id"] is not None else record[b"name"])
        else:
            out[name] = unwrap(held)
    return out


def as_dict(value: object) -> dict[str | int, object]:
    """An unwrapped mapping, asserted to be one."""
    out = unwrap(value)
    assert isinstance(out, dict), out
    return out


def as_list(value: object) -> list[object]:
    """An unwrapped list, asserted to be one."""
    out = unwrap(value)
    assert isinstance(out, list), out
    return out
