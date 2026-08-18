"""The addon's data files: what a pack becomes when Lua has to read it.

A peer of `module`, and the split between them is the medium rather than the
content. Both take the same encoded sections and decide only what shape the
bytes land in: the browser gets JSON in gzipped module files, and the addon
gets Lua source holding one long string per axis.

Three properties drive every choice here, and they are all the client's.

Nothing is decoded at load. The values in that string are groups of printable
digits rather than packed bytes, so a reader indexes them where they lie with
`string.byte` and arithmetic. Byte-packing would be denser, but a value would
then straddle the characters a text-safe encoding writes, and every read would
have to unpack a whole column before it could answer for one row.

Nothing is materialised. A column is a region of one string rather than a
table, so the collector marks a handful of values instead of one slot per row.
That is what keeps a payload of this size affordable at all.

Text is not encoded, because it is already printable. A name blob is written
as it stands and indexed by an offset column, which is what makes the largest
columns in the pack cost their own length and nothing more.

What ships is a variation. `SUPPLIED_BY` names the sections a running client
answers better than a payload can, and a lean build leaves those out for the
addon to ask the game for instead. Moving a section between the two is one row
there.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum

from ..encode import FEWEST_BYTES, layout_for
from ..model.section import Cardinality, Encoding, Layout, Section

ADDON_FORMAT = 1
"""The shape of the emitted header and blob.

Read by whatever loads these files, so a reader written against one layout
refuses a payload written in another rather than misreading it.
"""

DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
"""The sixty-four characters a number is spelled in.

Chosen for what they are not: none needs escaping inside a Lua long string,
none is a line ending, and none can begin one of that string's terminators.
Six bits a character is what makes a value occupy a whole number of them, so
reading one is a slice at a fixed stride rather than a bit offset.
"""

BASE = len(DIGITS)

AXES: Mapping[str, str] = {
    "model": ("modelRows morphs morphDisplays mounts shapeshifts "
              "shapeshiftDisplays summons summonControlNames objects files "
              "modelCatNames equippedSlots items itemIconNames "
              "itemQualityNames vehicles vehicleSeats"),
    "sound": "soundRows soundKitNames",
    "anim": ("animRows animNames animKitAnims animKitAnimBoneset bonesetNames "
             "animEmoteOneshots animEmoteLoops spellVehicleAnims "
             "spellVehicleAnimKits"),
    "fx": ("fxRows fxChains fxTextures dissolves dissolveTextures glows "
           "shadowies ghostMats tints screens screenTextures anchorNames "
           "attachmentNames missileMotions"),
    "mech": ("mechRows spellDelivery areas keybinds linkKindNames effectNames "
             "auraNames implicitTargetNames implicitTargetBits targetNames "
             "speedModeNames spellAttrs"),
    "spell": "spells expansions iconNames iconFids",
    "text": "spellText",
    "misc": "rowVocabs",
}
"""Which file each section lands in, keyed by the axis a query reaches it
through.

The browser groups sections by what a first paint needs, because it fetches
over a network. An addon has the whole payload on disk already and pays
instead for what it makes resident, so it groups by what one search touches:
a query naming no model never loads the model file.
"""

AXIS_OF: Mapping[str, str] = {name: axis
                              for axis, names in AXES.items()
                              for name in names.split()}
"""The axis one section belongs to, by section name."""

SUPPLIED_BY: Mapping[str, str] = {
    "spellText": "GetSpellDescription",
    "spells.names": "GetSpellInfo",
    "spells.ids": "C_Spell.DoesSpellExist",
    "spells.icons": "GetSpellTexture",
    "soundKitNames": "C_Epsilon.SoundKit_Get",
    "files.gobs": "C_Epsilon.GODI_Get",
    "morphDisplays": "C_Epsilon.GODI_Get",
    "iconNames": "LibRPMedia",
}
"""What a running client answers, and the call that answers it.

The third state a column can be in. Absence says the build never had the
data; this says the data exists and something already holds it that the
payload cannot improve on, so a lean variation leaves it out and the addon
asks the game.

Keyed by a column, because that is the grain the answer has. A client knows a
spell's name and its icon and says nothing about which expansion it came from,
so declaring the whole of `spells` supplied would drop four columns nothing
can replace. A bare section name is every column of it.

Clipping one more is one row here. Adding a row is a claim that something
outside the payload answers as well, and it is only worth making once the call
has been run against the client -- a column clipped on an untested claim is
one the addon silently cannot answer.
"""


class Variation(Enum):
    """Which columns a build of the addon data carries."""

    FULL = "full"
    """Everything the pack holds, whatever a client could also answer.

    What the query engine is tested against: a gap here would show up as an
    engine defect rather than as a column that was never shipped.
    """

    LEAN = "lean"
    """Only what no client route supplies."""


def supplies(section: str, column: str) -> str:
    """The client call answering one column, or empty if none does.

    A column named in its own right wins over its section being named, so a
    section can be supplied as a whole and still have a column excepted from
    it later without restating the rest.
    """
    return SUPPLIED_BY.get(f"{section}.{column}") or SUPPLIED_BY.get(section, "")


def ships(section: str, column: str, variation: Variation) -> bool:
    """Whether one column lands in this variation of the data."""
    return variation is Variation.FULL or not supplies(section, column)


def spelled(value: int, width: int) -> str:
    """One non-negative number as a fixed count of digits, most significant
    first.

    Raises:
        ValueError: the number needs more digits than the column reserved. A
            value that overflowed would run into the next one rather than
            wrap, so this can never be allowed to pass.
    """
    out = []
    left = value
    for _ in range(width):
        out.append(DIGITS[left % BASE])
        left //= BASE
    if left:
        raise ValueError(f"{value} does not fit in {width} digits")
    return "".join(reversed(out))


def digits_for(span: int) -> int:
    """How many digits per value a column spanning zero to `span` needs."""
    width, ceiling = 1, BASE
    while span >= ceiling:
        width += 1
        ceiling *= BASE
    return width


@dataclass
class Blob:
    """The one string a chunk ships, and where each column sits inside it.

    Columns are appended in the order they are described, and every header a
    writer returns carries the offset it was written at. Nothing here reads a
    value back: those offsets are the only account of the layout, which is why
    they are produced by the same call that writes.
    """

    parts: list[bytes] = field(default_factory=list)
    at: int = 0

    def payload(self) -> bytes:
        """Everything written so far, as the one string that ships."""
        return b"".join(self.parts)

    def append(self, written: bytes) -> int:
        """Add bytes to the blob and return the offset they start at.

        Bytes rather than characters, and counted from one, because that is
        what Lua's string library indexes by: `string.sub` and `string.byte`
        both address a byte. A blob measured in characters would agree with
        Lua only until a name outside ASCII appeared in it, and would then be
        wrong for every column written after that name.
        """
        start = self.at + 1
        self.parts.append(written)
        self.at += len(written)
        return start

    def numbers(self, values: Sequence[int]) -> dict[str, object]:
        """Write a column of whole numbers and describe it.

        Values are shifted by the column's own minimum, so a column of large
        or of negative numbers costs the width of its span rather than of its
        largest member.
        """
        if not values:
            return {"kind": "int", "at": self.at + 1, "n": 0,
                    "width": 1, "base": 0}
        low, high = min(values), max(values)
        width = digits_for(high - low)
        start = self.append("".join(spelled(value - low, width)
                                    for value in values).encode("ascii"))
        return {"kind": "int", "at": start, "n": len(values),
                "width": width, "base": low}

    def strings(self, values: Sequence[str],
                kind: str = "text") -> dict[str, object]:
        """Write a column of text and describe it.

        The text is concatenated with no separator and indexed by one more
        offset than there are values, so a row ends where the next begins and
        neither a length column nor a delimiter is needed. That also means no
        character inside the blob is reserved, which is what lets the text
        ship exactly as it stands.
        """
        encoded = [value.encode("utf-8") for value in values]
        offsets, at = [], 0
        for cell in encoded:
            offsets.append(at)
            at += len(cell)
        offsets.append(at)
        start = self.append(b"".join(encoded))
        return {"kind": kind, "at": start, "n": len(values),
                "index": self.numbers(offsets)}

    def column(self, values: object) -> dict[str, object]:
        """Write one produced column, whatever shape it arrived in.

        The shapes are the ones a section can produce and the encoder can
        return: a list of values, a list of lists, a mapping keyed by an id,
        and the two-part payloads a deduped or a sparse layout ships as. Each
        is described as what it is rather than flattened, so a reader undoes
        exactly what the browser's reader undoes.

        Raises:
            TypeError: a value the layouts have no spelling for. Guessing one
                would ship a column nothing can read back.
        """
        if isinstance(values, Mapping):
            # Two mappings ship, and what separates them is what they hold. A
            # vocabulary keyed by an id holds one value per key, so it becomes
            # a pair of parallel columns. A row family's payload holds a whole
            # column per key, so each key is described in its own right and
            # the keys stay in the header where a reader can ask for one by
            # name. Both are small in the header; only the first could be
            # large, and that is the one that does not go there.
            if values and all(isinstance(sub, (Mapping, list, tuple))
                              for sub in values.values()):
                return {"kind": "group",
                        "of": {str(key): self.column(sub)
                               for key, sub in values.items()}}
            return {"kind": "map",
                    "keys": self.column([str(key) for key in values]),
                    "values": self.column(list(values.values()))}
        if not isinstance(values, Sequence) or isinstance(values, str):
            raise TypeError(f"a column is a sequence or a mapping, not "
                            f"{type(values).__name__}")
        head = next((value for value in values if value is not None), None)
        if head is None:
            # Nothing says what the column holds, but its length is still a
            # fact about the section. Zeroes keep it, where an empty column
            # would tell a reader the section had no rows at all.
            return self.numbers([0] * len(values))
        if isinstance(head, (list, tuple)):
            rows = [list(row or ()) for row in values]
            # Offsets rather than counts, and one more of them than there are
            # rows, which is what text already does: a row's items begin where
            # the row before them ended, so both composite shapes are indexed
            # the same way and neither costs a walk to reach row n.
            offsets, at = [], 0
            for row in rows:
                offsets.append(at)
                at += len(row)
            offsets.append(at)
            return {"kind": "list", "n": len(rows),
                    "index": self.numbers(offsets),
                    "values": self.column([item for row in rows
                                           for item in row])}
        if isinstance(head, bool):
            return self.numbers([int(bool(value)) for value in values])
        if isinstance(head, int):
            return self.numbers([int(value or 0) for value in values])
        if isinstance(head, float):
            # Their own spelling rather than a scaled whole number: five
            # columns in the pack carry a float, and a shared exponent would
            # be a mechanism the other four hundred would never use.
            return self.strings([repr(float(value or 0.0))
                                 for value in values], kind="float")
        if isinstance(head, str):
            return self.strings([value if isinstance(value, str) else ""
                                 for value in values])
        raise TypeError(f"no spelling for {type(head).__name__}")

    def encoded(self, shipped: object, layout: Encoding) -> dict[str, object]:
        """One shipped column, written in the layout its record declared.

        The layout is read from the registry rather than inferred from what
        arrived, because the artifact cannot tell the two composite shapes
        apart: a deduped payload and a vocabulary keyed by id are both an
        object with string keys once serialised, and a reader guessing between
        them ships the pool where the values should be.

        Raises:
            KeyError: the payload is missing a part its layout ships.
        """
        if layout is Encoding.DEDUP:
            assert isinstance(shipped, Mapping)
            return {"kind": "dedup", "pool": self.column(shipped["text"]),
                    "of": self.column(shipped["of"])}
        if layout is Encoding.SPARSE:
            assert isinstance(shipped, Mapping)
            return {"kind": "sparse", "at": self.column(shipped["at"]),
                    "is": self.column(shipped["is"])}
        return self.column(shipped)


def described(section: Section, payload: object, blob: Blob, *,
              variation: Variation = Variation.FULL,
              policy: Mapping[Cardinality, Encoding] = FEWEST_BYTES
              ) -> dict[str, object]:
    """One section written into the blob, as the header describing it.

    A section that ships bare is named by the single column it declares, so a
    reader asks for a column by name whichever layout the section chose, and
    the bare form stops being a second shape for it to handle. Which sections
    those are is read from the record rather than from the payload: a bare
    section whose one column is deduped also arrives as an object, and telling
    the two apart by shape would split that column into two.

    A column the variation leaves to the client is left out here rather than
    written and marked. Writing it would cost its whole length to say
    something the index already says once.
    """
    if section.layout is Layout.BARE:
        items = [(section.columns[0], payload)]
    else:
        assert isinstance(payload, Mapping)
        items = list(payload.items())
    return {"columns": {str(name): blob.encoded(values,
                                                layout_for(section, str(name),
                                                           policy))
                        for name, values in items
                        if ships(section.name, str(name), variation)}}


NAMESPACE = "EpsilookData"
"""The global the data files assign into.

A data addon and the addon reading it are two addons, so the private table
each is handed at load is not shared between them. A named global is how the
data addons already on the client hand their payload over, and one is enough:
an axis is a key inside it rather than a global of its own.
"""

ADDON_PREFIX = "Epsilook_Data"
"""What each emitted addon directory is called, before its axis.

The index takes the bare prefix and an axis takes it with a suffix, which is
the arrangement a load-on-demand data set already uses elsewhere: a small
always-loaded part that says what exists, and one loadable addon per group.
"""


def interface_version(version: str) -> int:
    """The client interface number a build advertises, from its version.

    Two digits each for the minor and the patch under the major, which is what
    the client's own toc files carry: a 9.2.7 addon declares 90207.
    """
    major, minor, patch = (int(part) for part in version.split(".")[:3])
    return major * 10000 + minor * 100 + patch


def quoted(value: str) -> str:
    """One string as a Lua literal, escaped for a quoted context."""
    out = value.replace("\\", "\\\\").replace('"', '\\"')
    return '"' + out.replace("\n", "\\n").replace("\r", "\\r") + '"'


def rendered(value: object) -> str:
    """One header value as Lua source.

    Keys are always written in bracket form. A section or a column may be
    named anything the game's tables allow, and choosing between the bare and
    the bracketed spelling per key would be a rule that holds only until one
    of them is spelled like a Lua keyword.

    Raises:
        TypeError: a value with no Lua spelling.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return quoted(value)
    if isinstance(value, Mapping):
        return "{" + ",".join(f"[{quoted(str(key))}]={rendered(sub)}"
                              for key, sub in value.items()) + "}"
    if isinstance(value, Sequence):
        return "{" + ",".join(rendered(item) for item in value) + "}"
    raise TypeError(f"no Lua spelling for {type(value).__name__}")


def wrapped(payload: bytes) -> bytes:
    """The blob as a Lua long string, at a bracket level it cannot terminate.

    The level is raised until the payload holds neither bracket of that depth,
    so nothing about the data has to be reserved or escaped. Both brackets
    matter, not only the closing one: the client's Lua refuses an opening
    bracket found inside a long string as a nesting it no longer supports, so
    a payload holding one fails to load rather than ending early. A newline
    follows the opening bracket because Lua drops exactly one there, which
    keeps the payload starting at the offset the columns were written against.

    Raises:
        ValueError: the payload holds a carriage return. Lua rewrites every
            line ending inside a long string to a single newline, so a blob
            carrying one would be shorter in the client than it is here and
            every offset past it would address the wrong byte.
    """
    if b"\r" in payload:
        raise ValueError("the blob holds a carriage return, which Lua would "
                         "rewrite; every offset after it would be wrong")
    level = 0
    while (b"]" + b"=" * level + b"]" in payload
           or b"[" + b"=" * level + b"[" in payload):
        level += 1
    return (b"[" + b"=" * level + b"[\n" + payload
            + b"]" + b"=" * level + b"]")


@dataclass(frozen=True)
class Chunk:
    """One emitted addon directory, ready to write.

    Both files are bytes rather than text: the blob is indexed by byte offset,
    so a writer translating line endings on the way to disk would move every
    column in it.
    """

    addon: str
    """The directory name, which every file in it is also named after."""

    toc: bytes
    lua: bytes

    @property
    def files(self) -> Mapping[str, bytes]:
        """What lands in the directory, by file name."""
        return {f"{self.addon}.toc": self.toc, f"{self.addon}.lua": self.lua}


def toc_file(addon: str, title: str, notes: str, *, version: str, pack: str,
             demand: bool, extra: Sequence[tuple[str, str]] = ()) -> bytes:
    """One addon's toc, as the client reads it.

    The interface number is taken from the build being packed rather than from
    a constant, so a pack of another client's tables advertises that client.
    Nothing declares a dependency: every axis is loaded by name when a query
    first needs it, and a required dependency would only decide an order that
    an explicit load already fixes.
    """
    lines = [f"## Interface: {interface_version(version)}",
             f"## Title: {title}",
             f"## Notes: {notes}",
             f"## Version: {pack}",
             f"## X-Epsilook-Pack: {pack}",
             f"## X-Epsilook-Format: {ADDON_FORMAT}"]
    if demand:
        lines.insert(4, "## LoadOnDemand: 1")
    lines.extend(f"## X-Epsilook-{key}: {value}" for key, value in extra)
    lines.extend(("", f"{addon}.lua", ""))
    return "\n".join(lines).encode("utf-8")


def assignment(axis: str, header: Mapping[str, object],
               blob: bytes, pack: str) -> bytes:
    """One axis file: the header as a table, then the blob beside it.

    The blob is a second statement rather than a field inside the first, so
    the long string never has to be spliced into rendered source. Reading the
    file back is then two independent things to get right instead of one that
    depends on where the table happened to end.
    """
    opening = (f"-- Generated from pack {pack}. Do not edit.\n"
               f"{NAMESPACE} = {NAMESPACE} or {{}}\n"
               f"{NAMESPACE}[{quoted(axis)}] = {rendered(header)}\n"
               f"{NAMESPACE}[{quoted(axis)}].blob = ").encode("utf-8")
    return opening + wrapped(blob) + b"\n"


def axis_chunk(axis: str, holds: Sequence[Section],
               produced: Mapping[str, object], *, pack: str, version: str,
               built: str, variation: Variation) -> Chunk:
    """Every section of one axis, as the addon directory carrying them."""
    blob = Blob()
    described_all = ((section.name,
                      described(section, produced[section.name], blob,
                                variation=variation))
                     for section in holds)
    # A section every one of whose columns the client supplies contributes no
    # column at all, and an entry holding an empty set of them would read as a
    # section that came out empty rather than one deliberately left to the
    # game.
    sections = {name: entry for name, entry in described_all
                if entry["columns"]}
    header = {"format": ADDON_FORMAT, "pack": pack, "built": built,
              "axis": axis, "variation": variation.value,
              "sections": sections}
    addon = f"{ADDON_PREFIX}_{axis.capitalize()}"
    return Chunk(
        addon=addon,
        toc=toc_file(addon, f"Epsilook Data: {axis}",
                     f"Search data for the {axis} axis.", version=version,
                     pack=pack, demand=True, extra=(("Axis", axis),)),
        lua=assignment(axis, header, blob.payload(), pack))


def index_chunk(axes: Sequence[str], *, pack: str, version: str, built: str,
                variation: Variation, absent: Sequence[str] = ()) -> Chunk:
    """The small always-loaded addon that says what the rest of them hold.

    The peer of the browser's manifest, answering the same two questions:
    which files exist, and what this build has no data for. The third state is
    one only an addon has, so it is stated here rather than there -- a section
    the supply table names is missing from the payload on purpose, and the
    reader is meant to ask the client for it instead of reporting a gap.
    """
    header = {"format": ADDON_FORMAT, "pack": pack, "built": built,
              "variation": variation.value,
              "axes": {axis: f"{ADDON_PREFIX}_{axis.capitalize()}"
                       for axis in axes},
              "supplied": (dict(SUPPLIED_BY) if variation is Variation.LEAN
                           else {}),
              "absent": list(absent)}
    body = (f"-- Generated from pack {pack}. Do not edit.\n"
            f"{NAMESPACE} = {NAMESPACE} or {{}}\n"
            f"{NAMESPACE}.index = {rendered(header)}\n").encode("utf-8")
    return Chunk(
        addon=ADDON_PREFIX,
        toc=toc_file(ADDON_PREFIX, "Epsilook Data",
                     "Says which Epsilook data addons exist and what they hold.",
                     version=version, pack=pack, demand=False),
        lua=body)


def chunks(sections: Sequence[Section], produced: Mapping[str, object], *,
           pack: str, version: str, built: str, variation: Variation,
           absent: Sequence[str] = ()) -> list[Chunk]:
    """Every addon directory one variation of the data ships as.

    Args:
        sections: the registered sections, in registry order.
        produced: each section's encoded payload, by section name, exactly as
            the browser's modules carry it.
        pack: the pack's identity, which each toc advertises as its version.
        version: the build being packed, which decides the interface number.
        built: the day the pack was built, carried through rather than taken
            now, so emitting twice from one pack gives one answer.
        variation: whether a section a client route supplies is left out.
        absent: the sections this build has no data for at all.

    Returns:
        The index first, then one chunk per axis that has anything in it.

    Raises:
        KeyError: a produced section belongs to no axis. Dropping it silently
            would leave the addon unable to answer a whole route, with nothing
            in the artifact to show that anything had gone missing.
    """
    holding: dict[str, list[Section]] = {}
    for section in sections:
        if section.name not in produced:
            continue
        if not any(ships(section.name, column, variation)
                   for column in section.columns):
            continue
        axis = AXIS_OF.get(section.name)
        if axis is None:
            raise KeyError(f"{section.name} belongs to no axis; name it in "
                           f"AXES or the addon can never read it")
        holding.setdefault(axis, []).append(section)

    ordered = [axis for axis in AXES if axis in holding]
    return [index_chunk(ordered, pack=pack, version=version, built=built,
                        variation=variation, absent=absent),
            *(axis_chunk(axis, holding[axis], produced, pack=pack,
                         version=version, built=built, variation=variation)
              for axis in ordered)]
