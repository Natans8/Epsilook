#!/usr/bin/env python3
"""Build Arcanum (SpellCreator) ArcSpells and emit the addon's own import string.

Arcanum is the Epsilon addon downstream of Epsilook: you find a spell id here, you paste it into an ArcSpell action
row there. This module mirrors Arcanum's data structures well enough to author a spell OUTSIDE the game and hand the
user one string to paste into the addon's Import box -- which is the cheap way to test a batch of spell ids, commands
or macros in one go instead of typing rows by hand.

THE EXPORT FORMAT, read out of the addon source (SpellCreator/serializer.lua + UI/ImportExport.lua)::

    "<commID>:" .. LibDeflate:EncodeForPrint(LibDeflate:CompressDeflate(AceSerializer:Serialize(spell), {level = 9}))

All three stages are reimplemented below, because each is a plain documented format: AceSerializer is text with ``^``
markers, CompressDeflate is raw DEFLATE (no zlib header), and EncodeForPrint is 6-bit little-endian packing over a
64-character printable alphabet. Nothing here needs Lua, the addon, or the game.

The import side is deliberately tolerant -- ``getDataFromImportString`` splits on the first ``:`` and falls back to
treating the whole string as payload -- but we emit the ``commID:`` prefix anyway, because that is what the addon's
own export button produces.

Usage::

    python tools/arcanum.py build spec.json          # spec on disk, export string on stdout
    python tools/arcanum.py build -                  # spec on stdin
    python tools/arcanum.py build - --pretty         # ... plus a human-readable summary on stderr
    python tools/arcanum.py quick --id fxtest --name "FX Test" \
        -a SpellCast:118 -a "Command:mod scale 2@1.5"
    python tools/arcanum.py decode "<export string>"  # read a string the user exported back to us
    python tools/arcanum.py actions aura              # search the action catalogue
    python tools/arcanum.py roundtrip spec.json       # encode, decode, assert equal

As a module::

    from arcanum import ArcSpell, ArcAction, encode_spell, decode_spell

    spell = ArcSpell(commID="fxtest", fullName="FX Test", actions=[ArcAction("SpellCast", "118")])
    print(encode_spell(spell))

The action catalogue in ``arcanum_actions.json`` is generated from the addon source; regenerate it against a fresh
clone with ``--regen-catalog <path-to-SpellCreator-checkout>``.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CATALOG_PATH = Path(__file__).with_name("arcanum_actions.json")

# ---------------------------------------------------------------------------
# AceSerializer-3.0
#
# "^1" header, "^^" terminator, one marker per value. Mirrors SerializeValue/DeserializeValue in
# Libs/AceSerializer-3.0/AceSerializer-3.0.lua. We work in bytes throughout: WoW strings are UTF-8 byte strings and
# the escaping below is defined per byte.
# ---------------------------------------------------------------------------

# The gsub class is "[%c \94\126\127]" -- controls (0-31), space, "^", "~", DEL.
_NEEDS_ESCAPE = set(range(0, 33)) | {94, 126, 127}


def _escape_byte(n: int) -> bytes:
    # Order matters: 30 is checked before the <= 32 branch, which would otherwise emit "~^" and break the framing.
    if n == 30:
        return b"~z"
    if n <= 32:
        return b"~" + bytes([n + 64])
    if n == 94:
        return b"~}"
    if n == 126:
        return b"~|"
    if n == 127:
        return b"~{"
    raise AssertionError(f"byte {n} does not need escaping")


_UNESCAPE = {ord("z"): 30, ord("}"): 94, ord("|"): 126, ord("{"): 127}


def _escape_string(s: str) -> bytes:
    out = bytearray()
    for n in s.encode("utf-8"):
        out += _escape_byte(n) if n in _NEEDS_ESCAPE else bytes([n])
    return bytes(out)


def _unescape_string(raw: bytes) -> str:
    out = bytearray()
    i = 0
    while i < len(raw):
        b = raw[i]
        if b == 126:  # "~"
            nxt = raw[i + 1]
            out.append(_UNESCAPE.get(nxt, nxt - 64))
            i += 2
        else:
            out.append(b)
            i += 1
    return out.decode("utf-8", errors="replace")


def _format_number(v: int | float) -> bytes:
    """Render a number the way Lua 5.1's tostring() would, which is what AceSerializer transmits."""
    if isinstance(v, int):
        return str(v).encode()
    if v != v or v in (float("inf"), float("-inf")):
        raise ValueError(f"cannot serialize non-finite number {v!r}")
    if v.is_integer() and abs(v) < 1e15:
        return str(int(v)).encode()
    # Lua 5.1 formats with "%.14g"; if that round-trips exactly we can send it as-is, which is the common case.
    s = "%.14g" % v
    if float(s) == v:
        return s.encode()
    raise ValueError(f"number {v!r} is not exactly representable in AceSerializer's ^N form")


def _serialize_value(v: Any, out: bytearray) -> None:
    if v is None:
        out += b"^Z"
    elif isinstance(v, bool):  # before int -- bool is an int subclass in Python
        out += b"^B" if v else b"^b"
    elif isinstance(v, str):
        out += b"^S" + _escape_string(v)
    elif isinstance(v, (int, float)):
        out += b"^N" + _format_number(v)
    elif isinstance(v, dict):
        out += b"^T"
        for k, val in v.items():
            _serialize_value(k, out)
            _serialize_value(val, out)
        out += b"^t"
    elif isinstance(v, (list, tuple)):
        # Lua has no arrays -- a list is a table keyed 1..N.
        out += b"^T"
        for i, val in enumerate(v, start=1):
            _serialize_value(i, out)
            _serialize_value(val, out)
        out += b"^t"
    else:
        raise TypeError(f"cannot serialize {type(v).__name__}")


def ace_serialize(value: Any) -> bytes:
    out = bytearray(b"^1")
    _serialize_value(value, out)
    out += b"^^"
    return bytes(out)


class _AceReader:
    def __init__(self, raw: bytes) -> None:
        self.raw = raw
        self.i = 0

    def _read_marker(self) -> bytes:
        if self.raw[self.i: self.i + 1] != b"^":
            raise ValueError(f"expected a '^' marker at offset {self.i}")
        marker = self.raw[self.i: self.i + 2]
        self.i += 2
        return marker

    def _read_data(self) -> bytes:
        nxt = self.raw.find(b"^", self.i)
        if nxt < 0:
            raise ValueError("unterminated AceSerializer stream")
        data = self.raw[self.i: nxt]
        self.i = nxt
        return data

    def read_value(self) -> Any:
        marker = self._read_marker()
        if marker == b"^S":
            return _unescape_string(self._read_data())
        if marker == b"^N":
            text = self._read_data().decode()
            try:
                return int(text)
            except ValueError:
                return float(text)
        if marker == b"^F":
            mantissa = int(self._read_data().decode())
            if self._read_marker() != b"^f":
                raise ValueError("^F not followed by ^f")
            return mantissa * 2.0 ** int(self._read_data().decode())
        if marker == b"^B":
            return True
        if marker == b"^b":
            return False
        if marker == b"^Z":
            return None
        if marker == b"^T":
            table: dict[Any, Any] = {}
            while self.raw[self.i: self.i + 2] != b"^t":
                key = self.read_value()
                table[key] = self.read_value()
            self.i += 2
            return _maybe_list(table)
        raise ValueError(f"unknown AceSerializer marker {marker!r}")


def _maybe_list(table: dict[Any, Any]) -> Any:
    """Turn a table keyed exactly 1..N back into a Python list, which is how Arcanum stores its action rows."""
    if table and all(isinstance(k, int) for k in table) and sorted(table) == list(range(1, len(table) + 1)):
        return [table[i] for i in range(1, len(table) + 1)]
    return table


def ace_deserialize(raw: bytes) -> Any:
    if not raw.startswith(b"^1"):
        raise ValueError("not an AceSerializer v1 stream")
    reader = _AceReader(raw)
    reader.i = 2
    value = reader.read_value()
    if reader.raw[reader.i: reader.i + 2] != b"^^":
        raise ValueError("AceSerializer stream did not end with ^^")
    return value


# ---------------------------------------------------------------------------
# LibDeflate EncodeForPrint -- 6 bits per character, least-significant first.
# ---------------------------------------------------------------------------

_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()"
_DECODE = {c: i for i, c in enumerate(_ALPHABET)}


def encode_for_print(data: bytes) -> str:
    out: list[str] = []
    i = 0
    while i + 3 <= len(data):
        cache = data[i] + data[i + 1] * 256 + data[i + 2] * 65536
        out += [_ALPHABET[(cache >> shift) & 63] for shift in (0, 6, 12, 18)]
        i += 3
    cache, bits = 0, 0
    for b in data[i:]:
        cache |= b << bits
        bits += 8
    while bits > 0:
        out.append(_ALPHABET[cache & 63])
        cache >>= 6
        bits -= 6
    return "".join(out)


def decode_for_print(text: str) -> bytes:
    text = "".join(text.split())
    out = bytearray()
    i = 0
    while i + 4 <= len(text):
        cache = 0
        for j, ch in enumerate(text[i: i + 4]):
            cache |= _DECODE[ch] << (6 * j)
        out += bytes([cache & 255, (cache >> 8) & 255, (cache >> 16) & 255])
        i += 4
    cache, bits = 0, 0
    for ch in text[i:]:
        cache |= _DECODE[ch] << bits
        bits += 6
    while bits >= 8:
        out.append(cache & 255)
        cache >>= 8
        bits -= 8
    return bytes(out)


# ---------------------------------------------------------------------------
# The codec, end to end.
# ---------------------------------------------------------------------------


def compress_for_export(value: Any) -> str:
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)  # -15 = raw DEFLATE, no zlib header
    raw = compressor.compress(ace_serialize(value)) + compressor.flush()
    return encode_for_print(raw)


def decompress_for_import(text: str) -> Any:
    return ace_deserialize(zlib.decompress(decode_for_print(text), -15))


# ---------------------------------------------------------------------------
# The model -- mirrors Models/VaultSpell.lua and Models/VaultSpellAction.lua.
# ---------------------------------------------------------------------------


@dataclass
class ArcAction:
    """One row of an ArcSpell. ``vars`` is the row's input box, verbatim."""

    actionType: str
    vars: str = ""
    delay: float = 0
    revertDelay: float | None = None
    selfOnly: bool = False

    def to_table(self) -> dict[str, Any]:
        table: dict[str, Any] = {"actionType": self.actionType, "delay": self.delay, "vars": self.vars}
        if self.selfOnly:
            table["selfOnly"] = True
        if self.revertDelay is not None:
            table["revertDelay"] = self.revertDelay
        return table


@dataclass
class ArcSpell:
    """An ArcSpell. Only ``commID``, ``fullName`` and one action are required by the addon's importer.

    ``commID`` is what you type after ``/sf`` to cast it. ``castbar`` is 0 = none, 1 = cast (the default), 2 = channel.
    """

    commID: str
    fullName: str
    actions: list[ArcAction] = field(default_factory=list)
    description: str = ""
    author: str = ""
    icon: int | None = None
    castbar: int | None = None
    cooldown: float | None = None

    def to_table(self) -> dict[str, Any]:
        table: dict[str, Any] = {
            "commID": self.commID,
            "fullName": self.fullName,
            "actions": [a.to_table() for a in self.actions],
        }
        if self.description:
            table["description"] = self.description
        if self.author:
            table["author"] = self.author
        if self.icon is not None:
            table["icon"] = self.icon
        if self.castbar is not None:
            table["castbar"] = self.castbar
        if self.cooldown is not None:
            table["cooldown"] = self.cooldown
        return table


def encode_spell(spell: ArcSpell, validate: bool = True) -> str:
    """Return the string to paste into Arcanum's Import box."""
    if validate:
        problems = validate_spell(spell)
        if problems:
            raise ValueError("invalid ArcSpell:\n  " + "\n  ".join(problems))
    return f"{spell.commID}:{compress_for_export(spell.to_table())}"


def decode_spell(text: str) -> Any:
    """Decode an export string back to the raw table, so a spell exported from the game can be read here."""
    text = text.strip()
    head, sep, rest = text.partition(":")
    payload = rest if sep and rest else head
    return decompress_for_import(payload)


# ---------------------------------------------------------------------------
# Validation against the action catalogue.
# ---------------------------------------------------------------------------


def load_catalog() -> dict[str, dict[str, Any]]:
    if not CATALOG_PATH.exists():
        return {}
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))["actions"]


def validate_spell(spell: ArcSpell) -> list[str]:
    """Return a list of problems the addon would reject or silently mangle. Empty list means good."""
    problems: list[str] = []
    catalog = load_catalog()
    if not spell.commID:
        problems.append("commID is empty (the addon refuses a blank command)")
    elif not re.fullmatch(r"[A-Za-z0-9_]+", spell.commID):
        problems.append(f"commID {spell.commID!r} should be alphanumeric -- it is typed after /sf")
    if not spell.fullName:
        problems.append("fullName is empty (the addon refuses a blank name)")
    if not spell.actions:
        problems.append("no actions -- the addon only saves a spell with at least one")
    if spell.castbar is not None and spell.castbar not in (0, 1, 2):
        problems.append(f"castbar {spell.castbar!r} must be 0 (none), 1 (cast) or 2 (channel)")
    for i, action in enumerate(spell.actions, start=1):
        entry = catalog.get(action.actionType)
        if catalog and entry is None:
            problems.append(f"action {i}: unknown actionType {action.actionType!r} (see: arcanum.py actions)")
        if action.delay is None or action.delay < 0:
            problems.append(f"action {i}: delay must be >= 0 (the addon drops rows with a negative delay)")
        if entry and action.selfOnly and not entry.get("selfAble"):
            problems.append(f"action {i}: {action.actionType} does not support selfOnly")
        if entry and entry.get("dataName") and not action.vars:
            problems.append(f"action {i}: {action.actionType} expects input ({entry['dataName']})")
    return problems


# ---------------------------------------------------------------------------
# Spec <-> model.
# ---------------------------------------------------------------------------


def spell_from_spec(spec: dict[str, Any]) -> ArcSpell:
    actions = [ArcAction(**a) for a in spec.get("actions", [])]
    known = {f for f in ArcSpell.__dataclass_fields__ if f != "actions"}
    unknown = set(spec) - known - {"actions"}
    if unknown:
        raise ValueError(f"unknown spec field(s): {', '.join(sorted(unknown))}")
    return ArcSpell(actions=actions, **{k: v for k, v in spec.items() if k in known})


_SHORTHAND = re.compile(r"^(?P<type>\w+):(?P<vars>.*?)(?:@(?P<delay>[\d.]+))?(?:~(?P<revert>[\d.]+))?$", re.S)


def action_from_shorthand(text: str) -> ArcAction:
    """Parse ``Type:vars@delay~revertDelay`` -- delay and revertDelay optional. e.g. ``Command:mod scale 2@1.5``

    Convenience only: a trailing ``@<number>`` or ``~<number>`` is read as a delay, so use a JSON spec instead when
    the input itself ends that way (a macro line ending in an ``@`` target, say).
    """
    m = _SHORTHAND.match(text)
    if not m:
        raise ValueError(f"cannot parse action shorthand {text!r} (expected Type:vars[@delay][~revertDelay])")
    return ArcAction(
        actionType=m["type"],
        vars=m["vars"],
        delay=float(m["delay"]) if m["delay"] else 0,
        revertDelay=float(m["revert"]) if m["revert"] else None,
    )


def summarize(spell: ArcSpell) -> str:
    catalog = load_catalog()
    lines = [f"{spell.fullName}  (/sf {spell.commID})"]
    if spell.description:
        lines.append(f"  {spell.description}")
    for i, a in enumerate(spell.actions, start=1):
        entry = catalog.get(a.actionType, {})
        label = entry.get("name", a.actionType)
        bits = [f"{a.delay}s", label]
        if a.vars:
            bits.append(repr(a.vars))
        if a.selfOnly:
            bits.append("self only")
        if a.revertDelay is not None:
            bits.append(f"revert after {a.revertDelay}s")
        lines.append(f"  {i}. " + "  ".join(bits))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Catalogue generation from the addon source.
# ---------------------------------------------------------------------------


# The action families worth having at hand for testing what Epsilook shows: the two cast paths, auras, animations,
# sounds, the morph/scale/speed routes the app draws pills for, teleports, and the raw command/macro escape hatches.
# Everything else in the addon (Kinesis, TRP3, books, camera, mail, targeting minutiae) is still catalogued below --
# it is just not listed by default, because it has nothing to do with this app.
CORE_ACTIONS = {
    # casting -- server-side .cast, and the client-side path that runs the pre-check layer
    "SpellCast", "SpellTrig", "secCast", "secCastID", "secStopCasting",
    # auras
    "SpellAura", "RemoveAura", "RemoveAllAuras", "ToggleAura", "ToggleAuraSelf",
    "PhaseAura", "PhaseUnaura", "GroupAura", "GroupUnaura",
    # animations and poses
    "Anim", "ResetAnim", "Standstate", "ResetStandstate", "ToggleSheath", "DefaultEmote",
    # sound
    "PlayLocalSoundKit", "PlayLocalSoundFile", "PlayPhaseSound",
    # appearance and movement -- the routes Epsilook draws pills for
    "Morph", "Unmorph", "Native", "Scale",
    "Speed", "SpeedWalk", "SpeedFly", "SpeedSwim", "SpeedBackwalk",
    # raw escape hatches
    "Command", "MacroText",
    # teleports -- the area pill's own route
    "TeleCommand", "PhaseTeleCommand", "WorldportCommand",
    # targeting, so a two-path test can fix its target instead of guessing at a refusal
    "secTarget", "secClearTarg",
    # labelling a test sheet as it runs
    "PrintMsg", "ErrorMsg",
    "CheatOn", "CheatOff",
}


def _lua_string(text: str) -> str | None:
    m = re.match(r'\s*"((?:[^"\\]|\\.)*)"', text)
    return m.group(1).replace('\\"', '"').replace("\\n", "\n").replace("\\r", "\n") if m else None


def regen_catalog(checkout: Path) -> dict[str, Any]:
    """Extract the action registry from a SpellCreator checkout (Actions/Data.lua)."""
    data_lua = checkout / "SpellCreator" / "Actions" / "Data.lua"
    if not data_lua.exists():
        data_lua = checkout / "Actions" / "Data.lua"
    src = data_lua.read_text(encoding="utf-8")

    actions: dict[str, Any] = {}
    for m in re.finditer(r"\[ACTION_TYPE\.(\w+)]\s*=\s*(serverAction|scriptAction)\(\s*\"([^\"]*)\"\s*,\s*\{", src):
        key, kind, name = m.group(1), m.group(2), m.group(3)
        # Walk braces to find the end of this entry's table.
        depth, i = 1, m.end()
        while depth and i < len(src):
            if src[i] == "{":
                depth += 1
            elif src[i] == "}":
                depth -= 1
            i += 1
        body = src[m.end(): i - 1]

        entry: dict[str, Any] = {"name": name, "target": "server" if kind == "serverAction" else "script"}
        for fieldname in ("command", "dataName", "example", "revert", "revertDesc", "inputDescription", "description"):
            fm = re.search(rf"\b{fieldname}\s*=", body)
            if not fm:
                continue
            value = _lua_string(body[fm.end():])
            if value is not None:
                entry[fieldname] = value
        entry["selfAble"] = bool(re.search(r"\bselfAble\s*=\s*true", body))
        if key in CORE_ACTIONS:
            entry["core"] = True
        dep_match = re.search(r"\bdependency\s*=", body)
        if dep_match:
            dep = _lua_string(body[dep_match.end():])
            if dep:
                entry["dependency"] = dep
        actions[key] = entry

    return {
        "_comment": "Generated from MindScape00/SpellCreator Actions/Data.lua by tools/arcanum.py --regen-catalog. "
                    "Script actions take a Lua function as their command, so only server actions carry a command string. "
                    "Descriptions are best-effort: the addon builds some of them by concatenation and only the first "
                    "literal chunk is captured.",
        "actions": actions,
    }


# ---------------------------------------------------------------------------
# Self-test.
#
# GOLDEN_EXPORT was produced by Arcanum's OWN Lua libraries (unmodified AceSerializer-3.0 + LibDeflate, driven through
# lupa), so decoding it proves this file agrees with the addon rather than merely with itself. It exercises the parts
# that are easy to get wrong: the "^" and "~" escapes, a tab and a newline, a non-ASCII name, a float delay, a
# boolean, and a nested action row carrying revertDelay.
#
# Do NOT extend this into "encode(GOLDEN_SPELL) == GOLDEN_EXPORT". Lua randomises its string hash seed, so pairs()
# emits table keys in a different order every run and the compressed bytes differ each time. Only the decoded VALUE
# is stable, which is why the assertion runs in that direction.
# ---------------------------------------------------------------------------

GOLDEN_SPELL: dict[str, Any] = {
    "commID": "golden",
    "fullName": "Golden ^ Fixture ~ Üml",
    "description": "tab\there and newline\nend",
    "castbar": 2,
    "cooldown": 1.5,
    "actions": [
        {"actionType": "SpellCast", "vars": "118", "delay": 0},
        {"actionType": "SpellAura", "vars": "1784", "delay": 2.25, "revertDelay": 5, "selfOnly": True},
    ],
}

GOLDEN_EXPORT = (
    "golden:T9yqonmmqu0BufjIi6wGkqLfMftxpYtJNcrAItKTtlrIoNeUnCXysr0vS02)3)9nwH7qOLYL9ucD1ie4CBQBS0nerOq71TVZjw9um"
    "O(iFs6IS(chdg2WGegofrx1QMLJ99B3GWB2TSbtTlLKnbUlwcSqZO7M)Ez38iJamYI8OnaeosPmcvvRXYYumKeFKtLn)c2CnXDRVfHmlhEnk"
    "Z4d)tH3pLORgRxv3yvAgomjIJ6TupFzKQxpR(N6(OmT8h1pv)3F1lwu8Np"
)


def selftest() -> list[str]:
    """Return a list of failures; empty means the codec still agrees with the addon."""
    failures: list[str] = []

    decoded = decode_spell(GOLDEN_EXPORT)
    if decoded != GOLDEN_SPELL:
        failures.append(f"golden fixture (Lua-encoded) decoded wrong:\n    want {GOLDEN_SPELL}\n    got  {decoded}")

    # Our own encoder must survive a round trip through our own decoder for the same awkward content.
    spell = ArcSpell(
        commID="golden",
        fullName=GOLDEN_SPELL["fullName"],
        description=GOLDEN_SPELL["description"],
        castbar=2,
        cooldown=1.5,
        actions=[
            ArcAction("SpellCast", "118", delay=0),
            ArcAction("SpellAura", "1784", delay=2.25, revertDelay=5, selfOnly=True),
        ],
    )
    there_and_back = decode_spell(encode_spell(spell))
    if there_and_back != spell.to_table():
        failures.append(f"round trip changed the spell:\n    want {spell.to_table()}\n    got  {there_and_back}")

    # Every byte the escaper claims to handle must survive verbatim.
    torture = "".join(chr(n) for n in list(range(1, 128)))
    if ace_deserialize(ace_serialize(torture)) != torture:
        failures.append("byte-level escaping is not reversible over chr(1)..chr(127)")

    for value in (0, 1, -1, 0.5, 2.25, -3.75, 1e6, 0.001):
        if ace_deserialize(ace_serialize(value)) != value:
            failures.append(f"number {value!r} did not survive serialization")

    return failures


# ---------------------------------------------------------------------------
# CLI.
# ---------------------------------------------------------------------------


def _read_spec(path: str) -> dict[str, Any]:
    text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    return json.loads(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build Arcanum ArcSpells and emit the addon's import string.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_build = sub.add_parser("build", help="turn a JSON spec into an import string")
    p_build.add_argument("spec", help="path to a JSON spec, or '-' for stdin")
    p_build.add_argument("--pretty", action="store_true", help="also print a readable summary to stderr")
    p_build.add_argument("--no-validate", action="store_true")

    p_quick = sub.add_parser("quick", help="build from flags, no spec file")
    p_quick.add_argument("--id", required=True, help="commID -- what you type after /sf")
    p_quick.add_argument("--name", required=True)
    p_quick.add_argument("--description", default="")
    p_quick.add_argument("--castbar", type=int, choices=(0, 1, 2))
    p_quick.add_argument("-a", "--action", action="append", default=[], metavar="TYPE:VARS[@DELAY][~REVERT]")
    p_quick.add_argument("--pretty", action="store_true")

    p_decode = sub.add_parser("decode", help="decode an export string back to JSON")
    p_decode.add_argument("string", help="the export string, or '-' for stdin")

    p_actions = sub.add_parser("actions", help="list or search the action catalogue (core families by default)")
    p_actions.add_argument("query", nargs="?", default="")
    p_actions.add_argument("--all", action="store_true", help="include the addon's non-core families")
    p_actions.add_argument("--server-only", action="store_true")
    p_actions.add_argument("--verbose", "-v", action="store_true")

    p_round = sub.add_parser("roundtrip", help="encode a spec, decode it again, assert they match")
    p_round.add_argument("spec")

    p_regen = sub.add_parser("regen-catalog", help="rebuild arcanum_actions.json from a SpellCreator checkout")
    p_regen.add_argument("checkout", help="path to a MindScape00/SpellCreator clone")

    sub.add_parser("selftest", help="check the codec still agrees with the addon's own Lua libraries")

    args = parser.parse_args(argv)

    if args.cmd == "regen-catalog":
        catalog = regen_catalog(Path(args.checkout))
        CATALOG_PATH.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        core = sum(1 for e in catalog["actions"].values() if e.get("core"))
        print(f"wrote {CATALOG_PATH} ({len(catalog['actions'])} actions, {core} core)")
        return 0

    if args.cmd == "build":
        spell = spell_from_spec(_read_spec(args.spec))
        out = encode_spell(spell, validate=not args.no_validate)
        if args.pretty:
            print(summarize(spell), file=sys.stderr)
        print(out)
        return 0

    if args.cmd == "quick":
        spell = ArcSpell(
            commID=args.id,
            fullName=args.name,
            description=args.description,
            castbar=args.castbar,
            actions=[action_from_shorthand(a) for a in args.action],
        )
        if args.pretty:
            print(summarize(spell), file=sys.stderr)
        print(encode_spell(spell))
        return 0

    if args.cmd == "decode":
        text = sys.stdin.read() if args.string == "-" else args.string
        print(json.dumps(decode_spell(text), indent=2, ensure_ascii=False))
        return 0

    if args.cmd == "actions":
        catalog = load_catalog()
        query = args.query.lower()
        for key, entry in sorted(catalog.items()):
            if args.server_only and entry["target"] != "server":
                continue
            if not args.all and not entry.get("core"):
                continue
            haystack = f"{key} {entry.get('name', '')} {entry.get('command', '')} {entry.get('description', '')}".lower()
            if query and query not in haystack:
                continue
            cmd = f"  .{entry['command']}" if entry.get("command") else ""
            print(f"{key:<28} {entry.get('name', ''):<28}{cmd}")
            if args.verbose:
                if entry.get("dataName"):
                    print(f"    input: {entry['dataName']}")
                if entry.get("description"):
                    print(f"    {entry['description'].splitlines()[0]}")
        return 0

    if args.cmd == "selftest":
        failures = selftest()
        for f in failures:
            print(f"FAIL  {f}", file=sys.stderr)
        print("selftest failed" if failures else "selftest ok (codec matches the addon's Lua libraries)")
        return 1 if failures else 0

    if args.cmd == "roundtrip":
        spell = spell_from_spec(_read_spec(args.spec))
        encoded = encode_spell(spell)
        decoded = decode_spell(encoded)
        if decoded != spell.to_table():
            print("ROUND TRIP FAILED", file=sys.stderr)
            print(json.dumps({"sent": spell.to_table(), "got": decoded}, indent=2), file=sys.stderr)
            return 1
        print(f"round trip ok ({len(encoded)} chars)")
        return 0

    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, TypeError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2) from None
