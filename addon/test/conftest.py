"""Fixtures for the addon's tests: the addon loaded under the client's own Lua.

The addon is a sub-project. Its tests depend on nothing outside this directory
but `lupa` (which ships Lua 5.1, the interpreter the client runs) and the
addon's own files, so the whole of `addon/` can move to a repository of its own
without these having to change. The built data under `addon/build/` is
generated from the pack and is used where it exists; tests that need it skip
where it does not.

The addon's files are loaded in the order the toc lists them, read off the toc
itself, so a file added to the addon is added to the tests by the one edit that
ships it.
"""

import sys
from pathlib import Path
from typing import cast

import pytest

# The tree's own helpers are importable from its own directory, whatever
# repository the addon sits in: a test writes `from support import unwrap`.
sys.path.insert(0, str(Path(__file__).resolve().parent))

lua51 = pytest.importorskip("lupa.lua51")

# pylint: disable=wrong-import-position
from support import LuaRuntime  # noqa: E402  (the path above is what makes this importable)

ADDON = Path(__file__).resolve().parents[1]
CODE = ADDON / "Epsilook"
DATA = ADDON / "build" / "full" / "Epsilook_Data"
TOC = CODE / "Epsilook.toc"


def toc_files() -> list[Path]:
    """The Lua files the toc loads, in order.

    A toc names a file the client's way, with backslashes, so the separator is
    turned round before the path is built and the tree reads on any system.
    """
    out = []
    for line in TOC.read_text(encoding="utf-8").splitlines():
        name = line.strip()
        if name and not name.startswith("#"):
            out.append(CODE.joinpath(*name.replace("\\", "/").split("/")))
    return out


def data_files() -> list[Path]:
    """The data addon's Lua files, in the order its toc loads them."""
    toc = DATA / "Epsilook_Data.toc"
    out = []
    for line in toc.read_text(encoding="utf-8").splitlines():
        name = line.strip()
        if name and not name.startswith("#"):
            out.append(DATA / name)
    return out


def bare_runtime(before: bytes = b"") -> LuaRuntime:
    """A Lua state with the addon's files loaded and no data.

    Strings cross as bytes rather than as text: the payload is addressed by
    byte offset, so a runtime that decoded it on the way out would be answering
    about a different string than the one the offsets describe. Lua in `before`
    runs first, standing in for an addon the client loads before this one.
    """
    runtime = cast(LuaRuntime, lua51.LuaRuntime(encoding=None))
    runtime.execute(before)
    for path in toc_files():
        runtime.execute(path.read_bytes())
    return runtime


@pytest.fixture(name="bare", scope="session")
def bare_fixture() -> LuaRuntime:
    return bare_runtime()


#: Glimpse's door, standing in for that addon: it keeps what it is offered in `OFFERED`.
GLIMPSE = b"""
    OFFERED = {}
    Glimpse = { Provide = function(kind, provider) OFFERED[kind] = provider return true end }
"""


@pytest.fixture(name="beside_glimpse")
def beside_glimpse_fixture() -> LuaRuntime:
    """The addon without data, loaded after Glimpse as its toc's `OptionalDeps` loads it."""
    return bare_runtime(GLIMPSE)


@pytest.fixture(name="engine", scope="session")
def engine_fixture() -> LuaRuntime:
    """The addon with the built data mounted, or a skip where nothing is built."""
    if not (DATA / "Epsilook_Data.toc").exists():
        pytest.skip(f"{DATA} is not built; run tools/addon.py")
    runtime = bare_runtime()
    for path in data_files():
        runtime.execute(path.read_bytes())
    # language=Lua
    runtime.execute(b"assert(Epsilook:LoadData())")
    return runtime
