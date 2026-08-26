"""Asset names Epsilon's own client carries for the files it adds.

Two sources, told apart by what they cost rather than by what they name:

    the icon library   a file in the install, read in a second
    the object dump    an enumeration through a client API that answers only to
                       a logged-in player, so it costs an evening in game

Both hand back file id to asset path, confined to the id space the client
allocates its own assets from. Neither reads the game's storage, so both run
without a CASC and without the network.

The object dump is the expensive half and the one worth protecting: it names
roughly three quarters of everything the supplement carries, and the client
overwrites its own capture file on the next unrelated dump. Read a fresh one out
of SavedVariables when a walk has just been run; otherwise read the copy kept
beside the other exploration data.
"""

from __future__ import annotations

import json
import os
import re
from collections import Counter
from pathlib import Path

INSTALL = Path(os.environ.get("EPSILON_INSTALL", r"C:\Games\Epsilon"))
"""Where the Epsilon client is installed.

Overridable by environment because it is the one input that is a fact of the
machine rather than of the repository, and the pipeline is otherwise portable.
"""

ICON_LIBRARY = (
    INSTALL / "_retail_" / "Interface" / "AddOns" / "EpsilonLib" / "Lib" / "LibRPMedia" / "LibRPMedia-Retail-1.0.lua"
)
"""The client's own generated copy of the icon database.

It is a Lua source file rather than data, but the two arrays this reads are
plain literals, so it needs no interpreter.
"""

ACCOUNTS = INSTALL / "_retail_" / "WTF" / "Account"
"""Where per-account SavedVariables live, one directory per account name."""

DUMP_ADDON = "EpsilonDump"
"""The addon whose SavedVariables carry a client-API walk."""

ICON_DIRECTORY = "Interface/ICONS"
"""Where a named icon is placed.

The client hands back a bare icon name with no path and no extension, and every
consumer of one resolves it against this directory. The casing matches the
capitalised community listfile; nothing matches on it, since every comparison
folds case.
"""

_ANNOTATION = re.compile(r"(\.\w+)\s*\[.*$")
"""A human note appended after the extension, as in ``foo.m2 [Door]``."""

_TAG = re.compile(r"^\[[^\]]*\]\s*")
"""A bracketed prefix: an expansion tag, or the numeric one the API adds."""

_LUA_ESCAPE = re.compile(r"\\(\d{1,3}|.)")

_LUA_ESCAPES = {
    "r": "\r",
    "n": "\n",
    "t": "\t",
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "v": "\v",
    "\\": "\\",
    '"': '"',
    "'": "'",
}

_FALLBACK_EXTENSION = "wmo"
"""What a name with no extension is given.

Measured rather than assumed: every one of a spread sample of the extensionless
entries decoded as a world model.
"""

_MAX_EXTENSION = 5
"""Longest run of characters after the final dot still read as an extension.

Beyond this the dot belongs to the name, which happens often enough among these
to matter -- a version number or a coordinate reads as an extension otherwise.
"""

TILE_KINDS = ("buildingtile", "buildingplane", "emptywmo")
"""Bare-name prefixes that get a top-level bucket of their own.

Tiles and planes are deliberately separate buckets even though bare planes are
currently empty: they are different kinds of object, and declaring the split now
means a later capture routes them apart rather than merging them into tiles.
"""

WATER_KINDS = ("laketile", "watertile", "oceantile")
"""Bare-name prefixes that share the one water bucket, whatever they lead with."""

WATER_BUCKET = "watertile"

OBJECT_BUCKET = "object"

ROOT_BUCKET = "epsilon"
"""The top-level directory every derived path sits under.

It states that the path was derived here rather than read from the game, which
is what keeps a derived path from being mistaken for one the client uses.
"""


def unescape(text: str) -> str:
    """One Lua string literal's body, with its escapes resolved.

    Args:
        text: the literal's contents, without the surrounding quotes.

    Returns:
        The string the client actually stored.
    """

    def replace(match: re.Match[str]) -> str:
        body = match.group(1)
        if body.isdigit():
            return chr(int(body))
        return _LUA_ESCAPES.get(body, body)

    return _LUA_ESCAPE.sub(replace, text)


def read_saved_table(path: Path, section: str) -> dict[str, str]:
    """One flat ``key = value`` table out of a SavedVariables file.

    The addon stores each walk as a single level of key to scalar, so this
    reads the named section and stops at the line that closes it rather than
    parsing Lua.

    A value is quoted or bare depending on what the client handed the addon: a
    name arrives as a string and an id as a number, and the writer passes both
    through as they are. Reading only the quoted form makes a whole section of
    numbers look like an empty table, which reads as "the walk captured
    nothing" rather than as a value this cannot see. A nested table is skipped
    rather than mis-read.

    Args:
        path: the SavedVariables file.
        section: the top-level key to read, such as ``gob``.

    Returns:
        The section's pairs, empty if the file carries no such section.
    """
    text = path.read_text(encoding="utf-8", errors="replace")
    opening = f'\n\t["{section}"] = {{\n'
    at = text.find(opening)
    if at < 0:
        return {}
    start = at + len(opening)
    end = text.find("\n\t},", start)
    body = text[start : end if end > 0 else len(text)]
    found = {}
    for key, quoted, bare in re.findall(r'\["([^"]+)"\]\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\n{]+))', body):
        found[key] = unescape(quoted) if bare == "" else bare.strip()
    return found


def account_dumps(addon: str = DUMP_ADDON) -> list[Path]:
    """Every account's SavedVariables file for one addon, newest first.

    More than one account can have run the walk, and the newest capture is the
    one to prefer.
    """
    found = list(ACCOUNTS.glob(f"*/SavedVariables/{addon}.lua"))
    return sorted(found, key=lambda p: p.stat().st_mtime, reverse=True)


OBJECT_CATALOGUE = 23_200_000
"""The client's own gameobject name list, shipped as a file in its storage.

This is where the client API reads from, so it is the same catalogue rather
than a second opinion: measured against a captured walk it holds the identical
166,671 ids and agrees on 166,670 of them. The one row that differs is this
file being right -- the walk returns `Катапульта` through the addon's chat
layer as mojibake, and reading the bytes avoids the round trip that mangles it.
"""

SOUND_CATALOGUE = 23_200_001
"""The same shape for sounds: file id to name, 194,720 rows. It carries no id
in the client's own range, so it names no custom asset and no route reads it."""


def read_catalogue(storage: object, file_id: int) -> dict[int, str]:
    """One of the client's shipped `id;name` lists.

    Args:
        storage: the opened storage.
        file_id: which catalogue to read.

    Returns:
        File id to the raw name, uncleaned. Empty when the file cannot be read.
    """
    storage.encoding_keys([file_id])  # type: ignore[attr-defined]
    raw = storage.read(file_id, local_only=True)  # type: ignore[attr-defined]
    if not raw:
        return {}
    rows: dict[int, str] = {}
    for line in raw.decode("utf-8", "replace").splitlines():
        fid, sep, name = line.partition(";")
        if sep and fid.strip().isdigit():
            rows[int(fid)] = name.strip()
    return rows


def read_object_dump(cached: Path | None = None, storage: object | None = None) -> dict[int, str]:
    """The gameobject-display catalogue: file id to the name the client reports.

    Prefers the list the client ships, because reading it costs nothing and
    needs nobody to log in. Falls back to a live capture and then to a saved
    copy, both of which were the only routes before that file was found.

    Args:
        cached: a previously saved copy, as ``{file id: name}`` json.
        storage: the opened storage, when the shipped list may be read.

    Returns:
        File id to the raw name, uncleaned.

    Raises:
        FileNotFoundError: if no source is readable at all.
    """
    if storage is not None:
        shipped = read_catalogue(storage, OBJECT_CATALOGUE)
        if shipped:
            return shipped
    for path in account_dumps():
        section = read_saved_table(path, "gob")
        if section:
            return {int(fid): name for fid, name in section.items()}
    if cached is not None and cached.exists():
        return {int(fid): name for fid, name in json.loads(cached.read_text(encoding="utf-8")).items()}
    raise FileNotFoundError(
        f"no gameobject catalogue: file {OBJECT_CATALOGUE} unreadable, no live "
        f"capture, and no cached copy (looked for {cached})"
    )


def clean(name: str) -> str:
    """One reported name, with everything that is not part of it removed.

    Three things ride along with a name and none of them belong to it: the
    client terminates every one with a carriage return, some carry a human note
    after the extension, and some lead with a bracketed tag naming an expansion
    or repeating an id.
    """
    name = name.strip().replace("\\", "/")
    name = _ANNOTATION.sub(r"\1", name).strip()
    while True:
        shorter = _TAG.sub("", name).strip()
        if shorter == name:
            return name
        name = shorter


def split_extension(name: str) -> tuple[str, str]:
    """A cleaned name's stem and extension.

    A name with no usable extension is given one rather than left without: the
    supplement's rows are paths, and a path with no extension sorts and reads
    as a directory.

    Returns:
        The stem, trailing separators removed, and the extension without its
        dot. A stem that repeats its own extension is reduced to one.
    """
    stem, _, extension = name.rpartition(".")
    if not stem or " " in extension or len(extension) > _MAX_EXTENSION:
        stem, extension = name, _FALLBACK_EXTENSION
    stem = stem.rstrip("_ \t")
    while stem.lower().endswith(f".{extension.lower()}"):
        stem = stem[: -len(extension) - 1].rstrip("_ \t")
    return stem, extension


def bucket_of(stem: str) -> tuple[str, str | None]:
    """Which bucket a bare name belongs in, and its sub-path within it.

    Bare names are not arbitrary: they lead with a prefix naming what the thing
    is, or with the client's own marker followed by a theme. That is what a
    derived path states -- where the file belongs, never what it is called.

    Returns:
        The bucket directory, and the sub-path under it or None.
    """
    lowered = stem.lower()
    for kind in TILE_KINDS:
        if lowered.startswith(f"{kind}_"):
            return kind, None
    for kind in WATER_KINDS:
        if lowered.startswith(f"{kind}_"):
            return WATER_BUCKET, None

    tokens = stem.split("_")
    if lowered.startswith("eps_") and len(tokens) > 1:
        theme = tokens[1].lower()
        if len(tokens) > 2:
            if theme in TILE_KINDS:
                return OBJECT_BUCKET, f"{theme}/{tokens[2].lower()}"
            if theme in WATER_KINDS:
                return OBJECT_BUCKET, f"{WATER_BUCKET}/{tokens[2].lower()}"
        return OBJECT_BUCKET, theme
    if len(tokens) > 1:
        return OBJECT_BUCKET, tokens[0].lower()
    return OBJECT_BUCKET, None


def derived_path(name: str) -> str:
    """The path a bare filename is given, before collisions are resolved."""
    stem, extension = split_extension(name)
    bucket, sub = bucket_of(stem)
    parts = [ROOT_BUCKET, bucket] + ([sub] if sub else [])
    return f"{'/'.join(parts)}/{stem}.{extension}"


def object_names(dump: dict[int, str], floor: int) -> dict[int, str]:
    """Every custom asset the object walk names, as a path.

    A reported name is either already a path, in which case it is the client's
    own and is kept as it stands, or a bare filename, in which case it is given
    one that states where the file belongs.

    Args:
        dump: file id to the raw reported name.
        floor: the id below which a name is not this client's to give.

    Returns:
        File id to asset path. Two bare names that derive the same path both
        keep the file id, so a path stays unique to a file.
    """
    cleaned = {fid: clean(name) for fid, name in dump.items() if fid > floor}

    named = {fid: name for fid, name in cleaned.items() if "/" in name}
    bare = {fid: name for fid, name in cleaned.items() if "/" not in name}

    derived = {fid: derived_path(name) for fid, name in bare.items()}
    collisions = {path for path, count in Counter(derived.values()).items() if count > 1}
    for fid, path in derived.items():
        if path in collisions:
            stem, _, extension = path.rpartition(".")
            derived[fid] = f"{stem}_{fid}.{extension}"

    return named | derived


def icon_names(library: Path = ICON_LIBRARY) -> dict[int, str]:
    """Every custom icon the client's icon database names, as a path.

    The database stores two parallel arrays: a flat list of file ids, and a
    front-coded list of names in which each entry is a prefix length and the
    suffix to append to the previous name.

    The two arrays do not pair to the end. The library's own generator says so,
    and the excess ids carry no name at all -- so the tail past the last name is
    dropped rather than guessed at.

    Args:
        library: the icon database Lua file.

    Returns:
        File id to icon path, for every icon with a name.

    Raises:
        ValueError: if the file does not hold the two arrays, which means the
            client changed the database's shape rather than its contents.
    """
    text = library.read_text(encoding="utf-8", errors="replace")
    try:
        start = text.index('NewDatabase("icons"')
        end = text.index('NewDatabase("music"')
    except ValueError as exc:
        raise ValueError(f"{library} carries no icon database") from exc
    block = text[start:end]

    ids = re.search(r"file\s*=\s*\{(.*?)\}", block, re.S)
    coded = re.search(r"LoadFrontCodedStringList\(\{(.*?)\}\)", block, re.S)
    if ids is None or coded is None:
        raise ValueError(f"{library} holds an icon database of an unknown shape")

    files = [int(cell) for cell in ids.group(1).split(",") if cell.strip()]
    names, previous = [], ""
    for prefix, suffix in re.findall(r'(\d+)\s*,\s*"((?:[^"\\]|\\.)*)"', coded.group(1)):
        previous = previous[: int(prefix)] + unescape(suffix)
        names.append(previous)

    return {fid: f"{ICON_DIRECTORY}/{name}.blp" for fid, name in zip(files, names)}
