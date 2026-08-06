#!/usr/bin/env python3
"""Build Arcanum (SpellCreator) ArcSpells and emit the addon's own import string.

Arcanum is the Epsilon addon downstream of Epsilook: you find a spell id here, you paste it into an ArcSpell action
row there. This module mirrors Arcanum's data structures well enough to author a spell OUTSIDE the game and hand the
user one string -- which is the cheap way to test a batch of spell ids, commands or macros in one go instead of typing
rows by hand.

That string has two doors, and for a throwaway test sheet the second is the better one (both verified in game,
2026-08-06)::

    Import box                      saves to the personal vault; a duplicate commID prompts to overwrite
    /run ARC.CASTIMPORT("<str>")    casts immediately and NEVER saves -- nothing to clean up between sheets

``ARC`` is a plain global (Constants.lua), so both ``ARC.CASTIMPORT`` and ``ARC.ImportSpell`` (the Import button's own
function) are reachable from chat. Use a DOT on ``ImportSpell``: it is assigned raw rather than through
``wrapToEvalFinalVal``, so ``ARC:ImportSpell(x)`` passes the ARC table as the string and dies. ``CASTIMPORT`` is
wrapped and takes either. The chat box is not length-capped on Epsilon (``UnlimitedChatMessage`` sets
``SetMaxLetters(0)``; a 391-character line was verified whole), so a full spell goes in the CHAT BOX -- saved macros
are still capped at 255 by Blizzard. No escaping is ever needed: the payload alphabet is ``a-zA-Z0-9()`` and commIDs
are ``[A-Za-z0-9_]+``, so neither can contain a quote or a backslash.

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

Three catalogues sit beside this file, all generated from the addon source by ``regen-catalog``:

===========================  =============================================================================
``arcanum_actions.json``     every action row type, its command, its typed inputs and whether it reverts
``arcanum_conditions.json``  every condition type, for the OR-of-ANDs gate on a spell or a single action
``arcanum_api.json``         the ``ARC`` runtime surface reachable from a Macro Script action
===========================  =============================================================================

**REGENERATE THEM AGAINST ``EpsilonRP/PublicAddOns``, NEVER AGAINST THE MINDSCAPE00 MIRROR.** Epsilon serves the
current addon from ``_retail_/Interface/AddOns/SpellCreator/``; the MindScape00 clone was last pushed in 2024 and is
**24 actions behind** (measured 2026-08-06 -- it lacks ``AnimKit``, ``Mount``/``Dismount``, ``PlayMusic``, the three
sound-STOP actions, ``SendSay``/``SendYell``/``SendEmote`` and more). Keep MindScape00 for its wiki prose only.

The addon is still ahead of us in places -- a real user export carried ``breakOnMove``, ``flags`` and ``castOnFail``
before any source we had declared them -- which is why ``ArcSpell.extra`` / ``ArcAction.extra`` exist and why nothing
here may enumerate-and-drop.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zlib
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CATALOG_PATH = Path(__file__).with_name("arcanum_actions.json")
CONDITIONS_PATH = Path(__file__).with_name("arcanum_conditions.json")
API_PATH = Path(__file__).with_name("arcanum_api.json")

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


# A conditions table is GROUPS of ROWS: Execute.lua's checkConditions ANDs the rows inside a group (a failed row
# breaks that group) and ORs the groups (the first group to pass returns true). Disjunctive normal form. Absent or
# empty passes. One row is {"Type": <catalogue key>, "Input": <comma-delimited string>, "IsNot": <bool>}.
ConditionRow = dict[str, Any]
ConditionGroup = list[ConditionRow]
ConditionTable = list[ConditionGroup]


def cond(type_: str, input_: str = "", is_not: bool = False) -> ConditionRow:
    """One condition row. ``Input`` runs through input substitution before the check is evaluated."""
    row: ConditionRow = {"Type": type_}
    if input_:
        row["Input"] = input_
    if is_not:
        row["IsNot"] = True
    return row


def all_of(*rows: ConditionRow) -> ConditionTable:
    """Every row must pass -- one group. ``all_of(cond("hasAura", "1234"), cond("isOutdoors"))``."""
    return [list(rows)]


def any_of(*groups: ConditionGroup | ConditionRow) -> ConditionTable:
    """Any group may pass. A bare row is promoted to its own group, so ``any_of(cond(a), cond(b))`` is a plain OR."""
    return [g if isinstance(g, list) else [g] for g in groups]


@dataclass
class ArcAction:
    """One row of an ArcSpell. ``vars`` is the row's input box, verbatim."""

    actionType: str
    vars: str = ""
    delay: float = 0
    revertDelay: float | None = None
    selfOnly: bool = False
    # Gates THIS row. Checked when the row fires -- and again when its revert fires, with whatever the world looks
    # like by then, which is the trap: a condition that has since flipped silently cancels the rollback.
    conditions: ConditionTable | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_table(self) -> dict[str, Any]:
        # selfOnly is written even when False: the addon's own export does, so emitting it keeps a decoded spell
        # byte-identical in VALUE after a re-encode.
        table: dict[str, Any] = {
            "actionType": self.actionType,
            "delay": self.delay,
            "vars": self.vars,
            "selfOnly": self.selfOnly,
        }
        if self.revertDelay is not None:
            table["revertDelay"] = self.revertDelay
        if self.conditions is not None:
            table["conditions"] = self.conditions
        table.update(self.extra)
        return table

    @classmethod
    def from_table(cls, t: dict[str, Any]) -> ArcAction:
        known = {"actionType", "vars", "delay", "revertDelay", "selfOnly", "conditions"}
        return cls(
            actionType=t.get("actionType", ""),
            vars=t.get("vars", ""),
            delay=t.get("delay", 0),
            revertDelay=t.get("revertDelay"),
            selfOnly=bool(t.get("selfOnly", False)),
            conditions=t.get("conditions"),
            extra={k: v for k, v in t.items() if k not in known},
        )


@dataclass
class ArcSpell:
    """An ArcSpell. Only ``commID``, ``fullName`` and one action are required by the addon's importer.

    ``commID`` is what you type after ``/sf`` to cast it. ``castbar`` is 0 = none, 1 = cast (the default), 2 = channel.

    ``extra`` carries every field this model does not name, so a spell decoded from the game survives being re-encoded.
    That is not hypothetical: a real 2026-08-06 export carried ``breakOnMove`` and ``flags``, neither of which appears
    in the addon source this model was written from -- the user runs a NEWER Arcanum than the MindScape00 mirror.
    **Never enumerate-and-drop here; the addon is ahead of us and will stay ahead.**
    """

    commID: str
    fullName: str
    actions: list[ArcAction] = field(default_factory=list)
    # None means ABSENT, "" means present-and-empty. The addon writes empty strings explicitly and a truthiness test
    # silently drops them -- the third field-loss bug a real export caught, after `selfOnly: false` and the unknown
    # keys. **Test `is not None`, never truthiness, for anything that round-trips.**
    description: str | None = None
    author: str | None = None
    icon: int | None = None
    castbar: int | None = None
    cooldown: float | None = None
    # Gates the WHOLE spell: checked once before any row fires. A failing check runs `castOnFail` if one is set.
    conditions: ConditionTable | None = None
    # Cancel the spell the moment the caster moves, jumps or sits. Every pending revert fires immediately when it
    # cancels, so this is safe for a spell that changes state -- see stopRunningReverts in Execute.lua.
    breakOnMove: bool | None = None
    # commID of a spell to cast instead when `conditions` fail -- the graceful-refusal path.
    castOnFail: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_table(self) -> dict[str, Any]:
        table: dict[str, Any] = {
            "commID": self.commID,
            "fullName": self.fullName,
            "actions": [a.to_table() for a in self.actions],
        }
        for key, value in (("description", self.description), ("author", self.author), ("icon", self.icon),
                           ("castbar", self.castbar), ("cooldown", self.cooldown),
                           ("conditions", self.conditions), ("breakOnMove", self.breakOnMove),
                           ("castOnFail", self.castOnFail)):
            if value is not None:
                table[key] = value
        table.update(self.extra)
        return table

    @classmethod
    def from_table(cls, t: dict[str, Any]) -> ArcSpell:
        """Rebuild a spell from a decoded export, so decode -> edit -> re-encode is lossless."""
        known = {"commID", "fullName", "actions", "description", "author", "icon", "castbar", "cooldown",
                 "conditions", "breakOnMove", "castOnFail"}
        return cls(
            commID=t.get("commID", ""),
            fullName=t.get("fullName", ""),
            actions=[ArcAction.from_table(a) for a in t.get("actions", [])],
            description=t.get("description"),
            author=t.get("author"),
            icon=t.get("icon"),
            castbar=t.get("castbar"),
            cooldown=t.get("cooldown"),
            conditions=t.get("conditions"),
            breakOnMove=t.get("breakOnMove"),
            castOnFail=t.get("castOnFail"),
            extra={k: v for k, v in t.items() if k not in known},
        )


def encode_spell(spell: ArcSpell, validate: bool = True) -> str:
    """Return the export string: paste into Arcanum's Import box, or feed to ``/run ARC.CASTIMPORT("...")``.

    The ``commID:`` prefix is emitted because that is what the addon's own export button produces. CASTIMPORT does
    not require it (verified in game against a byte-identical unprefixed control, 2026-08-06); the Import box was
    never tested without it, so do not drop the prefix.
    """
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


# ---------------------------------------------------------------------------
# Categories -- HOW a spell gets triggered, which decides what it may politely do.
#
# The user's rule, 2026-08-06: *"regular spells for personal use shouldn't shit in the chat, this is the job of the
# roleplayer. Regular spells are visual aid."* The exception is a spell the PHASE author wrote to speak on its own
# behalf -- a spark prompt, a gossip reply, an item that talks. So "may it write to chat" is not a property of the
# action, it is a property of who triggered the spell, which is why this axis exists at all.
# ---------------------------------------------------------------------------

SPELL_CATEGORIES: dict[str, dict[str, Any]] = {
    "personal": {
        "trigger": "the player, from their vault, Quickcast book or a hotkey",
        "chat": False,
        "note": "A visual aid. The roleplayer writes their own emotes -- do not write them for them.",
    },
    "spark": {
        "trigger": "walking into a location prompt (Sparks)",
        "chat": True,
        "note": "Phase-authored and speaks for the phase, not the player. Runs for GUESTS, so it must not need "
                "member+ commands. Sparks pass inputs, so @input1@ is available.",
    },
    "item": {
        "trigger": "using an item carrying an ArcTag, or a linked ArcSpell",
        "chat": True,
        "note": "@itemID@ / @itemName@ / @itemLink@ / @itemIcon@ are substituted. Reaches anyone holding the item.",
    },
    "gossip": {
        "trigger": "an NPC gossip option",
        "chat": True,
        "note": "The NPC is speaking. Phase-authored; runs for guests.",
    },
    "chained": {
        "trigger": "another ArcSpell (an ArcSpell action, or ARC:CAST)",
        "chat": False,
        "note": "A component, not a performance. Its caller owns the narration and the cleanup.",
    },
    "scene": {
        "trigger": "an author or DM running a set piece",
        "chat": True,
        "note": "May take over camera, UI and music. Everything it takes over, it must give back.",
    },
}

# Actions that put words on someone's screen. `speech` minus the two debug printers, which are for US, plus the
# prompt family, which also interrupts.
_CHAT_ACTIONS = {"SendSay", "SendYell", "SendEmote", "RaidMsg", "BoxMsg", "TalkingHead"}
_DEBUG_PRINT_ACTIONS = {"PrintMsg", "ErrorMsg"}

# ---------------------------------------------------------------------------
# The destructive-revert class.
#
# These actions set persistent character state that THE PLAYER HAS ALREADY CUSTOMISED, and Arcanum's built-in revert
# is a hardcoded constant rather than a saved previous value. So the "rollback" does not undo the spell -- it
# overwrites the player's own setting with a server default, silently and permanently.
#
# The user, 2026-08-06: *"most players don't walk around with the default 1.0 scale, if you mess with it too much you
# might upset their character height."* That is `mod scale 1` reverting a 1.15-scale character to 1.0.
#
# Each entry names the route that gets the same look WITHOUT touching the player's setting.
# ---------------------------------------------------------------------------
_STOMPS_PLAYER_STATE = {
    "Scale": ("the character's own height (reverts to `mod scale 1`, not to what they were)",
              "a SCALE AURA instead -- `.aura <id>` multiplies on top of their scale and `.unaura` removes it "
              "cleanly. Epsilook's scale pill searches these by percentage (aura 61, ~71 distinct values)"),
    "Speed": ("their movement speed (reverts to `mod speed 1`)",
              "a speed AURA -- same argument, and Epsilook's speed pill indexes them"),
    "SpeedWalk": ("their walk speed (reverts to `mod speed walk 1`)", "a speed aura"),
    "SpeedFly": ("their fly speed (reverts to `mod speed fly 1`)", "a speed aura"),
    "SpeedSwim": ("their swim speed (reverts to `mod speed swim 1`)", "a speed aura"),
    "SpeedBackwalk": ("their backwalk speed (reverts to `mod speed backwalk 1`)", "a speed aura"),
    "Native": ("their NATIVE model -- and the revert is `demorph`, which removes ALL morphs including the native "
               "they set for their character",
               "a morph aura, or accept that this is a permanent change the player must undo themselves"),
    "Morph": ("nothing by itself, but its revert is `demorph`, which also strips any NATIVE the player had set",
              "a transform AURA, which removes cleanly and leaves their native alone"),
}


def lint_spell(spell: ArcSpell, category: str = "personal") -> list[str]:
    """Design review, not validity: things the addon accepts happily and a player would resent.

    ``validate_spell`` answers *would the addon reject this*. This answers *is this a well-made spell* -- state left
    behind, chat the roleplayer did not ask for, a revert that will be silently dropped, a race between rows sharing
    a delay. Returns human-readable warnings; empty means nothing to say.
    """
    warnings: list[str] = []
    catalog = load_catalog()
    meta = SPELL_CATEGORIES.get(category)
    if meta is None:
        return [f"unknown category {category!r} (one of: {', '.join(SPELL_CATEGORIES)})"]

    if not spell.icon:
        warnings.append("no icon -- it is the only thing identifying the spell in a Quickcast book or a Spark prompt")
    if not spell.description:
        warnings.append("no description -- this becomes the item tooltip's 'Use:' text if it is ever linked to one")

    for i, action in enumerate(spell.actions, start=1):
        entry = catalog.get(action.actionType, {})

        if not meta["chat"] and action.actionType in _CHAT_ACTIONS:
            warnings.append(
                f"action {i}: {action.actionType} writes to chat, but a '{category}' spell should not -- "
                "the roleplayer narrates. Move it to a spark/gossip/item spell, or drop it.")
        if action.actionType in _DEBUG_PRINT_ACTIONS:
            warnings.append(f"action {i}: {action.actionType} is a debug printer -- fine while testing, "
                            "noise in a spell you hand to someone else")

        # Execute.lua force-nulls revertDelay when the action declares no revert, so this is dropped in silence.
        if action.revertDelay and not entry.get("revertable", True):
            alt = entry.get("revertAlternative")
            warnings.append(f"action {i}: {action.actionType} has no revert, so revertDelay is silently DROPPED"
                            + (f" -- {alt.splitlines()[0]}" if alt else ""))

        # The worst class: a "rollback" that overwrites the player's own persistent setting with a server default.
        stomp = _STOMPS_PLAYER_STATE.get(action.actionType)
        if stomp:
            damage, instead = stomp
            if action.revertDelay is not None:
                warnings.append(f"action {i}: {action.actionType}'s revert RESETS TO A DEFAULT, so it clobbers "
                                f"{damage}. Use {instead}.")
            else:
                warnings.append(f"action {i}: {action.actionType} changes {damage} and you left it that way. "
                                f"Either that is the point, or use {instead}.")

        if entry.get("permission") in ("member", "officer"):
            warnings.append(f"action {i}: {action.actionType} runs '.{entry['command'].split()[0]}', which a phase "
                            f"GUEST cannot -- expect it to fail silently for most of your audience")

        # Comma-splitting is the single most surprising thing about the input box.
        if "," in action.vars and not entry.get("doNotDelimit") and entry.get("target") == "server":
            warnings.append(f"action {i}: '{action.vars}' contains a comma and {action.actionType} is comma-split, "
                            "so this runs once PER value -- intended?")

    # A row that stops the spell has to beat every row it is stopping. The wiki's own item-requirement recipe says
    # the same thing, and getting it wrong means the guard passes while the payload has already fired.
    stops = [a for a in spell.actions if a.actionType == "ArcStopThisSpell"]
    for stop in stops:
        racing = [a for a in spell.actions if a is not stop and a.delay <= stop.delay]
        if racing:
            warnings.append(
                f"ArcStopThisSpell fires at {stop.delay}s but {len(racing)} row(s) fire at or before it -- "
                "a stop only stops what has not run yet. Give every guarded row a later delay.")

    # State a spell turns on and never turns off. Not wrong -- a deliberate toggle is a real design -- but it is the
    # thing most often forgotten, so it is worth naming.
    if category in ("personal", "spark", "item", "gossip"):
        sticky = [(i, a) for i, a in enumerate(spell.actions, start=1)
                  if catalog.get(a.actionType, {}).get("family") in ("appearance", "ui", "camera")
                  and a.revertDelay is None and catalog.get(a.actionType, {}).get("revertable")]
        for i, action in sticky:
            warnings.append(f"action {i}: {action.actionType} changes state with no revertDelay -- it persists after "
                            "the spell ends. Intended as a toggle, or a missing rollback?")
    return warnings


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
        problems += _validate_conditions(action.conditions, f"action {i}")
    problems += _validate_conditions(spell.conditions, "spell")
    return problems


def _validate_conditions(table: ConditionTable | None, where: str) -> list[str]:
    """A conditions table is groups-of-rows. A bare row where a group belongs silently never matches."""
    if table is None:
        return []
    problems: list[str] = []
    catalog: dict[str, Any] = {}
    if CONDITIONS_PATH.exists():
        catalog = json.loads(CONDITIONS_PATH.read_text(encoding="utf-8"))["conditions"]
    if not isinstance(table, list):
        return [f"{where}: conditions must be a list of GROUPS, each a list of rows"]
    for g, group in enumerate(table, start=1):
        if not isinstance(group, list):
            problems.append(f"{where}: condition group {g} is not a list -- conditions are groups of rows "
                            "(OR of ANDs), so a single row still needs to be wrapped: [[{...}]]")
            continue
        for r, row in enumerate(group, start=1):
            if not isinstance(row, dict) or "Type" not in row:
                problems.append(f"{where}: condition {g}.{r} needs a 'Type'")
                continue
            if catalog and row["Type"] not in catalog:
                problems.append(f"{where}: condition {g}.{r} unknown Type {row['Type']!r} "
                                "(see: arcanum.py conditions)")
    return problems


# ---------------------------------------------------------------------------
# Spec <-> model.
# ---------------------------------------------------------------------------


def spell_from_spec(spec: dict[str, Any]) -> ArcSpell:
    actions = [ArcAction(**a) for a in spec.get("actions", [])]
    known = {f for f in ArcSpell.__dataclass_fields__ if f != "actions"}
    # `category` is ours, not the addon's: it drives lint_spell and is never encoded into the export.
    unknown = set(spec) - known - {"actions", "category"}
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


# Every action, grouped by what it is FOR. This replaced a flat core/non-core boolean, which was drawn up for
# testing what Epsilook shows and is the wrong cut for composing a spell: it hid the whole camera, speech and
# flow-control surface, which is most of what turns a list of effects into a scene.
#
# Anything not named here falls to "misc", and anything with a `dependency` is re-tagged "integration" during
# generation -- so a new action in a future addon version lands somewhere honest instead of being dropped.
ACTION_FAMILIES: dict[str, set[str]] = {
    # the two cast paths: server-side .cast, and the client path that runs the pre-check layer
    "casting": {"SpellCast", "SpellTrig", "secCast", "secCastID", "secStopCasting"},
    "auras": {"SpellAura", "RemoveAura", "RemoveAllAuras", "ToggleAura", "ToggleAuraSelf",
              "PhaseAura", "PhaseUnaura", "GroupAura", "GroupUnaura"},
    "animation": {"Anim", "ResetAnim", "AnimKit", "Standstate", "ResetStandstate", "ToggleSheath", "DefaultEmote"},
    "sound": {"PlayLocalSoundKit", "PlayLocalSoundFile", "PlayPhaseSound", "PlayMusic",
              "StopLocalSoundKit", "StopLocalSoundFile", "StopMusic"},
    "appearance": {"Morph", "Unmorph", "Native", "Scale", "Mount", "Dismount",
                   "Equip", "Unequip", "EquipSet", "MogitEquip"},
    "movement": {"Speed", "SpeedWalk", "SpeedFly", "SpeedSwim", "SpeedBackwalk",
                 "StartAutoRun", "StopAutoRun", "ToggleAutoRun", "ToggleRun",
                 "FollowUnit", "StopFollow", "MouselookModeStart"},
    "teleport": {"TeleCommand", "PhaseTeleCommand", "WorldportCommand",
                 "SaveARCLocation", "GotoARCLocation"},
    # what the scene SAYS -- the half of RP that is not a visual at all
    "speech": {"SendSay", "SendYell", "SendEmote", "PrintMsg", "ErrorMsg", "RaidMsg", "BoxMsg", "TalkingHead"},
    # framing: what the audience is looking at, and what is in the way
    "camera": {"ZoomCameraInBy", "ZoomCameraOutBy", "ZoomCameraInStart", "ZoomCameraOutStart", "ZoomCameraSet",
               "ZoomCameraSaveCurrent", "ZoomCameraLoadSaved",
               "RotateCameraLeftStart", "RotateCameraRightStart", "RotateCameraUpStart", "RotateCameraDownStart",
               "RotateCameraStop"},
    "ui": {"HideMostUI", "UnhideMostUI", "FadeInMainUI", "FadeOutMainUI",
           "HideNames", "ShowNames", "RestoreNames", "ToggleNames",
           "OpenWorldMap", "ToggleWorldMap", "UnitPowerBar", "UnitPowerBarValue", "ArcCastbar"},
    # branching, chaining and stopping -- what makes an ArcSpell a program rather than a list
    "flow": {"ArcStopThisSpell", "ArcSpell", "ArcSpellPhase", "ArcSpellCastImport", "ArcImport",
             "ArcSaveFromPhase", "ArcStopSpells", "ArcStopSpellByName", "ArcTrigCooldown"},
    # persistent values, which is how a spell becomes a two-way toggle
    "state": {"ARCSet", "ARCTog", "ARCPhaseSet", "ARCPhaseTog"},
    "prompts": {"BoxPromptCommand", "BoxPromptCommandChoice", "BoxPromptCommandNoInput",
                "BoxPromptScript", "BoxPromptScriptChoice", "BoxPromptScriptNoInput"},
    "items": {"AddItem", "AddRandomItem", "RemoveItem", "secUseItem", "OpenSendMail", "SendMail"},
    "targeting": {"secTarget", "secClearTarg", "secFocus", "secClearFocus", "secAssist",
                  "secTargLEnemy", "secTargLFriend", "secTargLTarg", "secTargNAny", "secTargNEnPlayer",
                  "secTargNEnemy", "secTargNFrPlayer", "secTargNFriend", "secTargNParty", "secTargNRaid"},
    "objects": {"SpawnBlueprint"},
    "cheats": {"CheatOn", "CheatOff"},
    # the escape hatches: anything the catalogue does not cover goes through one of these two
    "raw": {"Command", "MacroText"},
    "arcanum": {"ARCCopy", "QCBookAddSpell", "QCBookNewBook", "QCBookNewPage", "QCBookSetPosition",
                "QCBookStyle", "QCBookSwitchPage", "QCBookToggle"},
}

_FAMILY_BY_KEY = {key: family for family, keys in ACTION_FAMILIES.items() for key in keys}

# The families a composer reaches for constantly. `arcanum.py actions` shows these unless asked for more; it is a
# display default, not a judgement about the rest.
CORE_FAMILIES = {"casting", "auras", "animation", "sound", "appearance", "movement",
                 "teleport", "speech", "flow", "state", "raw"}


def _lua_string(text: str) -> str | None:
    m = re.match(r'\s*"((?:[^"\\]|\\.)*)"', text)
    return m.group(1).replace('\\"', '"').replace("\\n", "\n").replace("\\r", "\n") if m else None


# One literal in a Lua concatenation chain: a quoted string, a helper that wraps a quoted string (the addon uses
# these to colour a word in a tooltip -- the colour is noise here, the word is not), or a bare local we can resolve.
_CHUNK = re.compile(
    r"""\s*(?:
        "(?P<dq>(?:[^"\\]|\\.)*)"
      | '(?P<sq>(?:[^'\\]|\\.)*)'
      | (?:\w+\.)*gen(?:Contrast|Example|Tooltip)?Text\s*\(\s*(?:'[^']*'\s*,\s*)?["'](?P<help>[^"']*)["']\s*\)
      | (?P<ident>[A-Za-z_]\w*)
    )""",
    re.X,
)


def _lua_expr_string(text: str, consts: dict[str, str]) -> str | None:
    """Resolve a Lua expression that is literals joined by ``..`` into one string.

    The addon writes half its help text as ``"literal " .. Tooltip.genContrastText('.look spell') .. " more"``.
    Taking only the first chunk -- what this used to do -- truncated 83 descriptions mid-sentence, which is exactly
    the class of half-truth that gets acted on. Returns None if the expression starts with something unresolvable
    (a function call, a table index), so the caller can leave the field out rather than record a guess.
    """
    out: list[str] = []
    pos = 0
    while True:
        m = _CHUNK.match(text, pos)
        if not m:
            break
        if m.group("dq") is not None:
            out.append(m.group("dq"))
        elif m.group("sq") is not None:
            out.append(m.group("sq"))
        elif m.group("help") is not None:
            out.append(m.group("help"))
        else:
            ident = m.group("ident")
            if ident not in consts:
                break  # an unresolvable name: stop, but keep whatever we already have
            out.append(consts[ident])
        pos = m.end()
        cont = re.match(r"\s*\.\.", text[pos:])
        if not cont:
            break
        pos += cont.end()
    if not out:
        return None
    joined = "".join(out)
    return joined.replace('\\"', '"').replace("\\n", "\n").replace("\\r", "\n").replace("\\t", "\t")


# What a command root implies about who may run it. DERIVED FROM THE COMMAND WORD, NOT MEASURED IN GAME -- Arcanum
# itself carries no phase-permission field (all 28 `requirement`s in Data.lua are `C_Epsilon.RunPrivileged`, a
# CLIENT-side protected-function gate, not a phase tier). Treat "member" and "officer" as "expect this to fail for a
# guest and confirm before shipping a spell that relies on it", never as fact.
_PERMISSION_BY_ROOT = {
    "cast": "anyone", "aura": "anyone", "unaura": "anyone", "mod": "anyone", "morph": "anyone",
    "demorph": "anyone", "dismount": "anyone", "tele": "anyone", "worldport": "anyone", "cheat": "anyone",
    "group": "anyone",
    "phase": "member", "gob": "member", "additem": "member",
}


def regen_catalog(checkout: Path) -> dict[str, Any]:
    """Extract the action registry from a SpellCreator checkout (Actions/Data.lua)."""
    src = _read_addon_file(checkout, "Actions/Data.lua")
    consts = _top_level_consts(src)

    actions: dict[str, Any] = {}
    for m in re.finditer(r"\[ACTION_TYPE\.(\w+)]\s*=\s*(serverAction|scriptAction)\(\s*\"([^\"]*)\"\s*,\s*\{", src):
        key, kind, name = m.group(1), m.group(2), m.group(3)
        body = src[m.end(): _match_brace(src, m.end()) - 1]

        entry: dict[str, Any] = {"name": name, "target": "server" if kind == "serverAction" else "script"}
        for fieldname in ("command", "dataName", "example", "revert", "revertDesc", "revertAlternative",
                          "inputDescription", "description", "dependency", "disabledWarning"):
            fm = re.search(rf"^\s*{fieldname}\s*=", body, re.M)
            if not fm:
                continue
            value = _lua_expr_string(body[fm.end():], consts)
            if value is not None:
                entry[fieldname] = value

        # Flags that change what the row DOES, not just how it reads.
        for flag in ("selfAble", "doNotDelimit", "convertLinks", "softDependency", "doNotSanitizeNewLines"):
            if re.search(rf"\b{flag}\s*=\s*true", body):
                entry[flag] = True
        req = re.search(r"^\s*requirement\s*=", body, re.M)
        if req:
            entry["requirement"] = _lua_expr_string(body[req.end():], consts) or "function"

        # A revertDelay is FORCE-NULLED by Execute.lua when the action has no revert, so "can this roll itself back"
        # is a property worth stating outright rather than inferring from the presence of a string.
        entry["revertable"] = bool(re.search(r"^\s*revert\s*=", body, re.M))
        # A revert with no @N@ placeholder is a CONSTANT: it restores a server default, not the value the player
        # had before the spell ran. `mod scale 1` is the dangerous shape -- it does not undo the spell, it sets the
        # character to 1.0, and most players do not walk around at 1.0.
        if entry.get("revert") and "@N@" not in entry["revert"]:
            entry["revertResetsToDefault"] = True
        if entry.get("command"):
            entry["permission"] = _PERMISSION_BY_ROOT.get(entry["command"].split()[0], "unknown")
        # A dependency wins over the hand-written family: an action that needs Kinesis or TRP3 loaded is an
        # integration first and an animation second, because "is it even available" outranks what it does.
        entry["family"] = "integration" if entry.get("dependency") else _FAMILY_BY_KEY.get(key, "misc")
        actions[key] = entry

    return {
        "_comment": "Generated from EpsilonRP/PublicAddOns Actions/Data.lua by "
                    "`python tools/arcanum.py regen-catalog <checkout>`. Script actions take a Lua function as their "
                    "command, so only server actions carry a command string. `revertable` is whether the action "
                    "declares a revert at all -- Execute.lua force-nulls revertDelay when it does not, so a revert on "
                    "a non-revertable row is silently dropped. `doNotDelimit` means the input is NOT comma-split: "
                    "without it, `a,b` runs the action once per value. `permission` is DERIVED FROM THE COMMAND WORD "
                    "and is a prediction, not a measurement -- the addon carries no phase-permission field. `family` "
                    "groups actions by what they are FOR; anything needing another addon is tagged 'integration', "
                    "because whether it is available outranks what it does.",
        "actions": actions,
    }


def _match_brace(src: str, start: int) -> int:
    """Index just past the ``}`` closing the ``{`` that ``start`` sits inside."""
    depth, i = 1, start
    while depth and i < len(src):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
        i += 1
    return i


def _read_addon_file(checkout: Path, relative: str) -> str:
    """Read a file from a SpellCreator checkout, tolerating either nesting depth."""
    for candidate in (checkout / "SpellCreator" / relative, checkout / relative):
        if candidate.exists():
            return candidate.read_text(encoding="utf-8")
    raise SystemExit(
        f"{relative} not found under {checkout}.\n"
        "Point this at a SpellCreator checkout -- prefer EpsilonRP/PublicAddOns at "
        "_retail_/Interface/AddOns/SpellCreator/, which is the addon Epsilon actually serves."
    )


def _top_level_consts(src: str) -> dict[str, str]:
    """The file-local string constants the help text is concatenated from."""
    consts: dict[str, str] = {}
    for m in re.finditer(r'^local (\w+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$', src, re.M):
        consts[m.group(1)] = m.group(2).replace('\\"', '"').replace("\\n", "\n").replace("\\r", "\n")
    return consts


def regen_conditions(checkout: Path) -> dict[str, Any]:
    """Extract the condition registry from Actions/ConditionsData.lua.

    A spell and every individual action can carry ``conditions``: a list of GROUPS, each a list of ROWS. Execute.lua
    ANDs the rows within a group (a failed row breaks the group) and ORs the groups (a passed group returns true),
    so the table is disjunctive normal form. Each row is ``{Type = <key>, Input = <string>, IsNot = <bool?>}``.
    """
    src = _read_addon_file(checkout, "Actions/ConditionsData.lua")
    consts = _top_level_consts(src)

    conditions: dict[str, Any] = {}
    category = None
    # Categories and condition entries interleave in one literal table, so walk the source in order and let the most
    # recent catName own the keys that follow it.
    for m in re.finditer(r'catName\s*=\s*"([^"]+)"|^\s*key\s*=\s*"([^"]+)"', src, re.M):
        if m.group(1):
            category = m.group(1)
            continue
        key = m.group(2)
        body = src[m.end(): _match_brace(src, m.end()) - 1]
        entry: dict[str, Any] = {"category": category}
        for fieldname in ("name", "description", "inputDesc", "inputExample"):
            fm = re.search(rf"^\s*{fieldname}\s*=", body, re.M)
            if fm:
                value = _lua_expr_string(body[fm.end():], consts)
                if value is not None:
                    entry[fieldname] = value
        inputs_match = re.search(r"^\s*inputs\s*=\s*\{", body, re.M)
        if inputs_match:
            inputs_body = body[inputs_match.end(): _match_brace(body, inputs_match.end()) - 1]
            entry["inputs"] = [
                {"label": im.group(1), "type": im.group(2)}
                for im in re.finditer(r'input\(\s*"([^"]*)"\s*,\s*"([^"]*)"', inputs_body)
            ]
        conditions[key] = entry

    return {
        "_comment": "Generated from EpsilonRP/PublicAddOns Actions/ConditionsData.lua by "
                    "`python tools/arcanum.py regen-catalog <checkout>`. Conditions attach to a whole spell "
                    "(spell.conditions) or to one action (action.conditions), same shape either way: a list of "
                    "GROUPS, each a list of ROWS of {Type, Input, IsNot}. Execute.lua ANDs within a group and ORs "
                    "across groups -- disjunctive normal form. No conditions, or an empty list, passes. Input is a "
                    "comma-delimited string and runs through input substitution before evaluation.",
        "conditions": conditions,
    }


def regen_api(checkout: Path) -> dict[str, Any]:
    """Extract the ARC runtime surface from API.lua -- what a Macro Script action can call.

    Worth generating rather than reading the wiki: the wiki documents about ten of these and the file exposes far
    more, including the whole ``ARC.XAPI`` tree (sparks, UI messages, sounds, cooldowns, phase, items, time).
    """
    src = _read_addon_file(checkout, "API.lua")
    lines = src.splitlines()

    entries: dict[str, Any] = {}
    for i, line in enumerate(lines):
        entry: dict[str, Any]
        m = re.match(r"^(ARC[\w.]*(?:\.\w+)?)\s*=\s*(.+)$", line)
        if not m:
            m = re.match(r"^function (ARC[\w.]*):(\w+)\(", line)
            if not m:
                continue
            name, entry = f"{m.group(1)}:{m.group(2)}", {"kind": "method"}
        else:
            name, rhs = m.group(1), m.group(2)
            if rhs.startswith("{}"):
                continue  # namespace table, not a callable
            entry = {"kind": "wrapped" if "wrapToEvalFinalVal" in rhs else "raw"}
        # The addon documents these as `-- SYNTAX:` comments and luadoc `---@param` lines directly above.
        doc: list[str] = []
        params: list[str] = []
        for back in range(i - 1, max(-1, i - 12), -1):
            prev = lines[back].strip()
            if prev.startswith("-- SYNTAX:"):
                doc.insert(0, prev[len("-- SYNTAX:"):].strip())
            elif prev.startswith("---@param"):
                params.insert(0, prev[len("---@param"):].strip())
            elif prev.startswith("--") or prev == "":
                continue
            else:
                break
        if doc:
            entry["syntax"] = doc
        if params:
            entry["params"] = params
        entries[name] = entry

    return {
        "_comment": "Generated from EpsilonRP/PublicAddOns API.lua by "
                    "`python tools/arcanum.py regen-catalog <checkout>`. This is the ARC surface a Macro Script "
                    "action can call. `kind` is how the entry is assigned: 'wrapped' entries went through "
                    "wrapToEvalFinalVal and accept BOTH `ARC:X(a)` and `ARC.X(a)`; 'raw' entries accept ONLY the DOT "
                    "form, because a colon call passes the ARC table as the first argument. ARC.ImportSpell is the "
                    "raw case that has already bitten us.",
        "api": entries,
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

# A REAL export, produced by the user's live Arcanum on 2026-08-06 and handed over verbatim. It is the only fixture
# here that came from the addon the user actually runs, which is NEWER than the MindScape00 mirror this model was
# written from -- and it is the one that caught `breakOnMove` and `flags`, two fields no source we have declares.
# Its job is to fail if `extra` ever stops preserving what we do not know about.
REAL_EXPORT = (
    "sneeze_final:vc9ppnmmqua8plDInuCAsOmIOQcgWz468rVKEbSWXoYojsHH(zh7w(tKGIGz)E)ENmkWTi0mO1sQLrqs9e5ux4pSBJYq6d7ad"
    "ZVgEPM89vKdLjiqd9pBDFMgHkhtVuAEWoYyvWttp5rPi0Y22E)Ae8hvESjAIqNZ2O08maQUxzn(WXipErJKZJWvRwTmhbhpYU(1SMMcZFzsW1Z"
    "6MsJEkU2PUBN6cGqhR13gove2)EEShLPFzwCDs63iZ)pIIO4YO4zYDAirrHyz2SwZNiiK9heYsZ)fH8Fu4Mbh9HqEXzBhwrvBnHhsYePXV59SV"
    "2P6ICiSbURSCXIqm8T)"
)

# A second real export, richer: SPELL-level conditions, `castOnFail`, an explicitly EMPTY description, and a
# `secTarget` row whose vars carry embedded quotes. The empty description is the point -- it is what proved that
# testing truthiness rather than `is not None` silently drops a field the addon wrote on purpose.
REAL_EXPORT_2 = (
    "open_portal:Tk5tlUnmqu8Vl7LEPuSL9A7CSTHfYH6uq58unrrorGSKqsEl5I(Sx501oo7YUbkfbgZin)EV5pqoSdOheEUtAdsJgOaLJ(WE0b"
    "TzafhcNmoG2IbeDsGADMoPsSic303VznqnwH(xwJlGkG2nOuTyF6DBtHJmmYMUsYtY0siL5zvKIX81hKJA7tEPnF6dDJ2oeM15t(i7NVqy3zBc"
    "CaDJkSXNEQV1eGVbHlNlfWw9tOm9wUY4fZ2c53ie9z0LsNK300KpD7FPtTcL6RdoCS9OWZx6gEHQBRwDg2NKPLCLq(Qv15L3LWxYFnJIfUilRO"
    "O6FGr5iJLz990eb1hMal08tOoez9OuN(7qKTQOS(Jq(4DqQT8iZBXFNgTKYMv1KSf4kFnUQRv5dVzE(WNJSGBqCts3iUxW3HUJIWcnQU7ItvfP"
    "QEAzXEAZ60MY0uBoO)hI(9c3lBoPRRVA1lfzV55iRZ4ISI33GZDNz718)yVomFODk8OFeqaG)a"
)


def selftest() -> list[str]:
    """Return a list of failures; empty means the codec still agrees with the addon."""
    failures: list[str] = []

    real = decode_spell(REAL_EXPORT)
    if real.get("fullName") != "Nataari's Final Sneeze" or len(real.get("actions", [])) != 5:
        failures.append(f"real export decoded wrong: {real}")
    for unknown in ("breakOnMove", "flags", "profile"):
        if unknown not in real:
            failures.append(f"real export lost {unknown!r} on decode")
    if decode_spell(encode_spell(ArcSpell.from_table(real))) != real:
        failures.append("re-encoding a decoded real export is not lossless (check ArcSpell.extra)")

    real2 = decode_spell(REAL_EXPORT_2)
    if real2.get("description") != "":
        failures.append("real export 2 lost its explicitly-empty description on decode")
    if "conditions" not in real2 or "castOnFail" not in real2:
        failures.append("real export 2 lost its spell-level conditions or castOnFail")
    if decode_spell(encode_spell(ArcSpell.from_table(real2))) != real2:
        failures.append("re-encoding real export 2 is not lossless (empty string dropped by a truthiness test?)")

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

    p_lint = sub.add_parser("lint", help="design review: state left behind, unwanted chat, dropped reverts, races")
    p_lint.add_argument("spec", help="path to a JSON spec, or '-' for stdin")
    p_lint.add_argument("--category", choices=sorted(SPELL_CATEGORIES),
                        help="how the spell is triggered (default: the spec's own, else personal)")

    sub.add_parser("categories", help="how a spell gets triggered, and what that lets it politely do")

    p_actions = sub.add_parser("actions", help="list or search the action catalogue (core families by default)")
    p_actions.add_argument("query", nargs="?", default="")
    p_actions.add_argument("--all", action="store_true", help="include every family, integrations included")
    p_actions.add_argument("--family", help=f"one of: {', '.join(sorted(ACTION_FAMILIES))}, integration, misc")
    p_actions.add_argument("--server-only", action="store_true")
    p_actions.add_argument("--verbose", "-v", action="store_true")

    p_cond = sub.add_parser("conditions", help="list or search the condition catalogue")
    p_cond.add_argument("query", nargs="?", default="")
    p_cond.add_argument("--verbose", "-v", action="store_true")

    p_api = sub.add_parser("api", help="list or search the ARC runtime surface (for Macro Script actions)")
    p_api.add_argument("query", nargs="?", default="")
    p_api.add_argument("--verbose", "-v", action="store_true")

    p_round = sub.add_parser("roundtrip", help="encode a spec, decode it again, assert they match")
    p_round.add_argument("spec")

    p_regen = sub.add_parser("regen-catalog", help="rebuild arcanum_actions.json from a SpellCreator checkout")
    p_regen.add_argument("checkout",
                         help="path to a SpellCreator checkout - prefer EpsilonRP/PublicAddOns "
                              "(_retail_/Interface/AddOns/SpellCreator), which is the addon Epsilon actually serves")

    sub.add_parser("selftest", help="check the codec still agrees with the addon's own Lua libraries")

    args = parser.parse_args(argv)

    if args.cmd == "regen-catalog":
        checkout = Path(args.checkout)
        catalog = regen_catalog(checkout)
        CATALOG_PATH.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        families = Counter(e["family"] for e in catalog["actions"].values())
        print(f"wrote {CATALOG_PATH.name} ({len(catalog['actions'])} actions across {len(families)} families)")
        unclassified = families.get("misc", 0)
        if unclassified:
            print(f"  ⚠ {unclassified} landed in 'misc' -- the addon added actions ACTION_FAMILIES does not know: "
                  + ", ".join(k for k, e in catalog["actions"].items() if e["family"] == "misc"))

        conditions = regen_conditions(checkout)
        CONDITIONS_PATH.write_text(json.dumps(conditions, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {CONDITIONS_PATH.name} ({len(conditions['conditions'])} conditions)")

        api = regen_api(checkout)
        API_PATH.write_text(json.dumps(api, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {API_PATH.name} ({len(api['api'])} ARC entry points)")
        return 0

    if args.cmd == "build":
        spec = _read_spec(args.spec)
        spell = spell_from_spec(spec)
        out = encode_spell(spell, validate=not args.no_validate)
        if args.pretty:
            print(summarize(spell), file=sys.stderr)
        # Design warnings always go to stderr, so the export string on stdout stays pipeable either way. They are
        # advice, not errors -- a deliberate toggle legitimately trips the "changes state" warning.
        for warning in lint_spell(spell, spec.get("category", "personal")):
            print(f"lint: {warning}", file=sys.stderr)
        print(out)
        return 0

    if args.cmd == "lint":
        spec = _read_spec(args.spec)
        spell = spell_from_spec(spec)
        category = args.category or spec.get("category", "personal")
        problems = validate_spell(spell)
        warnings = lint_spell(spell, category)
        for p in problems:
            print(f"INVALID  {p}")
        for w in warnings:
            print(f"warn     {w}")
        if not problems and not warnings:
            print(f"clean ({category}): {len(spell.actions)} actions, nothing to flag")
        return 1 if problems else 0

    if args.cmd == "categories":
        for name, meta in SPELL_CATEGORIES.items():
            print(f"{name:<10} triggered by {meta['trigger']}")
            print(f"{'':<10} chat: {'allowed -- it speaks for the phase' if meta['chat'] else 'NO -- visual aid only'}")
            print(f"{'':<10} {meta['note']}")
            print()
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
        shown = 0
        for key, entry in sorted(catalog.items(), key=lambda kv: (kv[1].get("family", "misc"), kv[0])):
            family = entry.get("family", "misc")
            if args.server_only and entry["target"] != "server":
                continue
            if args.family and family != args.family:
                continue
            if not args.all and not args.family and family not in CORE_FAMILIES:
                continue
            haystack = f"{key} {family} {entry.get('name', '')} {entry.get('command', '')} " \
                       f"{entry.get('description', '')}".lower()
            if query and query not in haystack:
                continue
            shown += 1
            cmd = f"  .{entry['command']}" if entry.get("command") else ""
            revert = "" if entry.get("revertable") else "  [no revert]"
            print(f"{family:<12} {key:<28} {entry.get('name', ''):<30}{cmd}{revert}")
            if args.verbose:
                if entry.get("dataName"):
                    print(f"    input: {entry['dataName']}"
                          + ("  (comma-split: one run per value)" if not entry.get("doNotDelimit") else ""))
                if entry.get("description"):
                    print(f"    {entry['description'].splitlines()[0]}")
                for extra in ("inputDescription", "example", "revertAlternative", "dependency"):
                    if entry.get(extra):
                        print(f"    {extra}: {entry[extra].splitlines()[0]}")
        if not shown:
            print("no actions matched -- try --all, or --family "
                  f"({', '.join(sorted(ACTION_FAMILIES))}, integration, misc)", file=sys.stderr)
        return 0

    if args.cmd == "conditions":
        if not CONDITIONS_PATH.exists():
            print("no conditions catalogue -- run: arcanum.py regen-catalog <checkout>", file=sys.stderr)
            return 1
        conditions = json.loads(CONDITIONS_PATH.read_text(encoding="utf-8"))["conditions"]
        query = args.query.lower()
        for key, entry in sorted(conditions.items(), key=lambda kv: (kv[1].get("category") or "", kv[0])):
            haystack = f"{key} {entry.get('category', '')} {entry.get('name', '')} " \
                       f"{entry.get('description', '')}".lower()
            if query and query not in haystack:
                continue
            inputs = ", ".join(f"{i['label']}:{i['type']}" for i in entry.get("inputs", []))
            print(f"{entry.get('category', ''):<22} {key:<26} {entry.get('name', '')}")
            if inputs:
                print(f"    inputs: {inputs}")
            if args.verbose and entry.get("description"):
                print(f"    {entry['description'].splitlines()[0]}")
            if args.verbose and entry.get("inputExample"):
                print(f"    e.g. {entry['inputExample'].splitlines()[0]}")
        return 0

    if args.cmd == "api":
        if not API_PATH.exists():
            print("no API catalogue -- run: arcanum.py regen-catalog <checkout>", file=sys.stderr)
            return 1
        api_catalog: dict[str, dict[str, Any]] = json.loads(API_PATH.read_text(encoding="utf-8"))["api"]
        query = args.query.lower()
        for name, entry in sorted(api_catalog.items()):
            if query and query not in f"{name} {' '.join(entry.get('syntax', []))}".lower():
                continue
            # A 'raw' entry must be called with a DOT: it was assigned without wrapToEvalFinalVal, so a colon call
            # passes the ARC table in as the first argument and dies. ARC.ImportSpell is the one that has bitten us.
            call = "ARC.X only" if entry["kind"] == "raw" else "ARC:X or ARC.X"
            print(f"{name:<34} [{call}]")
            for line in entry.get("syntax", []):
                print(f"    {line}")
            if args.verbose:
                for p in entry.get("params", []):
                    print(f"    @param {p}")
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
