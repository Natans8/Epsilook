"""Text folding, and the column scan that runs a folded operand over a payload."""

from __future__ import annotations

from typing import cast

from support import LuaRuntime, LuaTable, lua_function

DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"


def text_column(runtime: LuaRuntime, values: list[str]) -> tuple[bytes, LuaTable]:
    """A hand-spelled text column in the payload's layout: the texts joined with
    no separator, indexed by one more base-64 offset than there are texts.

    The emitter in the parent repository is the one that writes this layout for
    real, and its own tests read the result back through the addon's reader;
    this spells only the simplest shape, so a scan can be handed rows placed
    exactly where a test wants them.
    """
    encoded = [value.encode("utf-8") for value in values]
    offsets, at = [0], 0
    for cell in encoded:
        at += len(cell)
        offsets.append(at)
    width = 1
    while 64**width <= offsets[-1]:
        width += 1
    index = b"".join(
        "".join(DIGITS[(offset // 64**place) % 64] for place in range(width - 1, -1, -1)).encode("ascii")
        for offset in offsets
    )
    blob = b"".join(encoded) + index
    # Keys as bytes: the runtime passes strings through undecoded, so a text
    # key would reach Lua as a foreign object rather than as a string.
    index_node = runtime.table_from(
        {b"kind": b"int", b"at": 1 + offsets[-1], b"n": len(offsets), b"width": width, b"base": 0}
    )
    node = runtime.table_from({b"kind": b"text", b"at": 1, b"n": len(values), b"index": index_node})
    return blob, node


def scanned(runtime: LuaRuntime, values: list[str], op: str, written: str) -> list[int]:
    """The rows of a text column a scan lands in."""
    blob, node = text_column(runtime, values)
    hits = cast(
        LuaTable, lua_function(runtime, b"Epsilook.Match.ScanText")(blob, node, op.encode(), written.encode("utf-8"))
    )
    return sorted(int(str(k)) for k in hits.keys())


def test_fold_and_squash(bare: LuaRuntime) -> None:
    fold = lua_function(bare, b"Epsilook.Text.fold")
    squash = lua_function(bare, b"Epsilook.Text.squash")
    assert fold("Fire’Ball ".encode("utf-8")) == b"fire'ball "
    assert squash(b"Fire-Ball, Jr.") == b"fireballjr"
    assert squash(b"|cff71d5ff|Hspell:133|h[Fire]|h|r") == b"fire"
    assert squash(b"---") == b""


def test_contains_pattern_folds_case_and_punctuation(bare: LuaRuntime) -> None:
    contains_pattern = lua_function(bare, b"Epsilook.Text.containsPattern")
    find = lua_function(bare, b"string.find")
    pattern = contains_pattern(b"fire ball")
    assert pattern is not None
    assert find(b"Frost and FIRE-BALL", pattern) is not None
    assert find(b"Fireball", pattern) is not None
    assert find(b"fire bull", pattern) is None
    assert contains_pattern(b"...") is None


def test_scan_counts_a_row_once_and_never_across_a_boundary(bare: LuaRuntime) -> None:
    # "fi" ends one row and "re" begins the next: no separator is stored, so
    # the bytes read "fire" across the boundary and must not count.
    rows = ["Fire Ball", "fi", "re", "FIREfire", "", "a fire"]
    assert scanned(bare, rows, "contains", "fire") == [0, 3, 5]
    assert scanned(bare, rows, "exact", "fire ball") == [0]
    assert scanned(bare, rows, "exact", "fire") == []
    assert scanned(bare, ["Fire", "x"], "exact", "fire") == [0]


def test_scan_skips_nothing_after_a_straddle(bare: LuaRuntime) -> None:
    # The straddling match starts in the first row; the real hit in the second
    # row begins before that match ends and must still be found.
    assert scanned(bare, ["ab", "a abab"], "contains", "aba") == [1]
