"""Names derived from where a file sits, for the assets nothing reports a name for.

The client names its models and its icons, and says nothing at all about the
textures, skins and geometry those models are built from. Those files are not
unreachable, though: the model that uses one points at it by file id, so a path
can be derived that states where the file hangs even though nothing states what
it is called.

Three kinds of derivation live here and they are not equally good:

    terrain    a real name. A map's own directory plus the position of a tile in
               the map's grid is exactly the filename the game's convention
               produces, so nothing is invented.
    semantic   what the file is FOR, joined out of the tables that use it. Not
               the name the game looks it up by, but a description of the thing
               rather than of its neighbours, which is what makes it worth more
               than parentage.
    parentage  a placeholder. It says which model refers to the file, which is
               all anyone knows, and is marked as derived by the directory it
               sits under.

Both are ordered after every route that reports a real name, and parentage last
of all. A walk also depends on what ran before it, because it can only derive a
child's path from a parent that is already named -- so running one against a
larger set of known names yields fewer new rows, not more, and re-running after
another route lands is how the last few are picked up.
"""

from __future__ import annotations

import struct
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

from epsilon_storage import Reads, chunks
from tqdm import tqdm

WORKERS = 32
"""Concurrent reads for files the install does not hold.

These files are small, so a walk that reaches the network is bound by round
trips rather than by bandwidth and the width is what makes it finish.
"""

DERIVED_ROOT = "epsilon"
"""Where a derived path sits, so it is never mistaken for one the game uses."""

MAP_TABLE = 1349477
"""``Map.db2``. Its rows name every map, including the ones this client added."""

MAP_DIRECTORY, MAP_NAME, MAP_WDT = 0, 1, 21
"""Which columns of that table carry the directory, the display name and the
world table's file id."""

GRID = 64
"""A map is a fixed grid of this many cells on each side."""

_TILE_ENTRY = 32
"""One grid cell in the world table's file-id array: eight file ids."""

TILE_SLOTS = {
    0: "{stem}.adt",
    1: "{stem}_obj0.adt",
    2: "{stem}_obj1.adt",
    3: "{stem}_tex0.adt",
    4: "{stem}_lod.adt",
    5: "{stem}.blp",
    6: "{stem}_n.blp",
    7: "world/minimaps/{directory}/map{x}_{y}.blp",
}
"""What each of a cell's eight file ids is, by position.

The position is the whole reason terrain comes out with real names: the array
is fixed-width and every slot means the same thing in every cell, so a file id's
place in it determines the name the game would look the file up by.
"""

@dataclass(frozen=True)
class Child:
    """How a file found through one chunk is named.

    Args:
        bucket: the directory the derived path sits under.
        extension: the child's own extension.
        numbering: how the child's position is spelled, or None when the format
            does not guarantee a position. The spelling is the game's own for
            that kind of file, not a house style: a world model's groups are
            numbered with a separator and three digits, a model's skins with
            two and none, and using one convention for both produces paths that
            look right and match nothing.
    """

    bucket: str
    extension: str
    numbering: str | None = None


MODEL_CHILDREN = {
    b"SFID": Child("skin", "skin", "{stem}{index:02d}"),
    b"TXID": Child("texture", "blp"),
    b"AFID": Child("anim", "anim", "{stem}{index:02d}"),
    b"BFID": Child("bone", "bone", "{stem}{index:02d}"),
    b"SKID": Child("skel", "skel", "{stem}{index:02d}"),
    b"PFID": Child("phys", "phys", "{stem}{index:02d}"),
}
"""Which chunks of a model point at another file, and how to name what they
point at.

A texture is the one with no position worth carrying. Its slot is a property of
the material rather than part of any filename the game uses, so those keep the
shape that leans on the file id instead.
"""

_ANIMATION_ENTRY = 8
"""An ``AFID`` entry is an animation id, a variation and then the file id."""

_MATERIAL = 64
"""One world-model material entry."""

_MATERIAL_TEXTURES = (12, 24, 36)
"""Where a material's three texture file ids sit within it.

A current world model carries no texture-name chunk at all, so these ids are
the only reference to the texture that exists anywhere.
"""


@dataclass(frozen=True)
class Walk:
    """What one pass over the storage found.

    Args:
        names: file id to the path derived for it.
        read: how many parent files were opened.
        skipped: how many were passed over because the install lacks them.
    """

    names: dict[int, str]
    read: int
    skipped: int


def stem_of(path: str) -> str:
    """A parent's bare filename, which is what a derived path is keyed on."""
    return path.replace("\\", "/").rsplit("/", 1)[-1].rsplit(".", 1)[0]


def custom_maps(storage: Reads, floor: int) -> list[tuple[str, int]]:
    """Every map this client added, as its directory and its world table's id.

    A map whose world table sits in the client's own id space is one the client
    added; there is no other flag that says so.
    """
    from pack.sources.wdc3 import Db2  # pylint: disable=import-outside-toplevel

    raw = storage.read(MAP_TABLE)
    if not raw:
        return []
    found = []
    for row in Db2(raw, None).rows():
        if len(row) <= MAP_WDT:
            continue
        try:
            wdt = int(row[MAP_WDT])
        except ValueError:
            continue
        if wdt > floor:
            found.append((row[MAP_DIRECTORY], wdt))
    return found


def terrain_names(storage: Reads, floor: int) -> dict[int, str]:
    """Real paths for every terrain file the client's own maps own.

    Args:
        storage: the opened storage.
        floor: the id above which a file is the client's own.

    Returns:
        File id to path, for the client's terrain and minimap files.
    """
    names: dict[int, str] = {}
    for directory, wdt in tqdm(custom_maps(storage, floor), desc="custom maps",
                               unit="map"):
        raw = storage.read(wdt)
        if not raw:
            continue
        names[wdt] = f"world/maps/{directory}/{directory}.wdt"
        for tag, body in chunks(raw, reversed_tags=True):
            if tag != b"MAID":
                continue
            for cell in range(min(GRID * GRID, len(body) // _TILE_ENTRY)):
                x, y = divmod(cell, GRID)
                stem = f"world/maps/{directory}/{directory}_{x}_{y}"
                ids = struct.unpack_from("<8I", body, cell * _TILE_ENTRY)
                for slot, fid in enumerate(ids):
                    if fid > floor and slot in TILE_SLOTS:
                        names[fid] = TILE_SLOTS[slot].format(
                            stem=stem, directory=directory, x=x, y=y)
    return names


CUSTOMIZATION_BUCKET = "chrcustomization"
"""Where a character-customization texture's derived path sits."""

CUSTOMIZATION_TABLES = ("TextureFileData", "ChrCustomizationMaterial",
                        "ChrCustomizationElement", "ChrCustomizationChoice",
                        "ChrCustomizationOption")
"""The chain a texture is named through, from the file to what it is for.

Each step is a join on a named column, never a position: two of the positions
recorded for these tables were wrong, and a wrong position produces a confident
name for the wrong thing rather than an error.
"""


def slug(text: str) -> str:
    """One path segment, out of a name written for a user interface.

    These names carry spaces and punctuation because they are shown in the
    character creator. A path segment cannot, and matching folds case anyway.
    """
    kept = [character if character.isalnum() else "_" for character in text.lower()]
    return "_".join(part for part in "".join(kept).split("_") if part)


def customization_names(storage: Reads, floor: int) -> dict[int, str]:
    """Character-customization textures, named by what they customise.

    These are the largest group nothing else can name, and no parentage walk
    reaches them: they hang off the customization tables rather than off any
    model. The chain runs from the texture's file id to the material it backs,
    to the element that uses the material, to the choice that element belongs
    to, and finally to the option that choice sits under -- so a texture comes
    out as the option and the choice it paints.

    Args:
        storage: the opened storage.
        floor: the id above which a file is the client's own.

    Returns:
        File id to path. Empty when any table in the chain is unreadable, since
        a partial chain names a texture after the wrong thing rather than
        failing to name it.
    """
    from epsilon_tables import open_table, table_ids  # pylint: disable=import-outside-toplevel

    ids = table_ids()
    tables = {name: open_table(storage, name, ids) for name in CUSTOMIZATION_TABLES}
    if any(table is None for table in tables.values()):
        missing = [name for name, table in tables.items() if table is None]
        print(f"  customization: skipped, unreadable: {', '.join(missing)}")
        return {}

    textures = tables["TextureFileData"]
    materials = tables["ChrCustomizationMaterial"]
    elements = tables["ChrCustomizationElement"]
    choices = tables["ChrCustomizationChoice"]
    options = tables["ChrCustomizationOption"]
    assert textures and materials and elements and choices and options

    # Each of the three joins below is many-to-one in the direction it is read,
    # so the lowest id wins rather than whichever row came last. That is what
    # keeps two runs over the same tables producing the same paths.
    material_of: dict[int, int] = {}
    for material, resource in materials.pairs("ID", "MaterialResourcesID").items():
        material_of[resource] = min(material, material_of.get(resource, material))

    choice_of: dict[int, int] = {}
    for material_text, choice_text in elements.values("ChrCustomizationMaterialID",
                                                      "ChrCustomizationChoiceID"):
        try:
            material, choice = int(material_text), int(choice_text)
        except ValueError:
            continue
        if material and choice:
            choice_of[material] = min(choice, choice_of.get(material, choice))

    choice_names = choices.named("ID", "Name_lang")
    option_of = choices.pairs("ID", "ChrCustomizationOptionID")
    option_names = options.named("ID", "Name_lang")

    names: dict[int, str] = {}
    for fid, resource in textures.pairs("FileDataID", "MaterialResourcesID").items():
        if fid <= floor:
            continue
        choice = choice_of.get(material_of.get(resource, -1), 0)
        if not choice:
            continue
        option = slug(option_names.get(option_of.get(choice, 0), ""))
        chosen = slug(choice_names.get(choice, ""))
        if not option or not chosen:
            continue
        names[fid] = (f"{DERIVED_ROOT}/{CUSTOMIZATION_BUCKET}/{option}/"
                      f"{chosen}/{fid}.blp")
    return names


def _model_children(raw: bytes) -> dict[bytes, list[int]]:
    """The file ids one model points at, by chunk tag.

    A model from before the chunked format begins with a different magic and
    carries no chunks at all, so it yields nothing rather than failing: its
    references are inline and name no separate file.
    """
    found: dict[bytes, list[int]] = {}
    for tag, body in chunks(raw):
        if tag not in MODEL_CHILDREN:
            continue
        if tag == b"AFID":
            found[tag] = [struct.unpack_from("<I", body, at + 4)[0]
                          for at in range(0, len(body) - _ANIMATION_ENTRY + 1,
                                          _ANIMATION_ENTRY)]
        else:
            found[tag] = list(struct.unpack_from(f"<{len(body) // 4}I", body))
    return found


def _world_model_children(raw: bytes) -> dict[bytes, list[int]]:
    """The group files and material textures one world model points at."""
    found: dict[bytes, list[int]] = {}
    for tag, body in chunks(raw, reversed_tags=True):
        if tag == b"GFID":
            found.setdefault(b"GFID", []).extend(
                struct.unpack_from(f"<{len(body) // 4}I", body))
        elif tag == b"MOMT":
            textures = found.setdefault(b"MOMT", [])
            for at in range(0, len(body) - _MATERIAL + 1, _MATERIAL):
                for offset in _MATERIAL_TEXTURES:
                    fid = struct.unpack_from("<I", body, at + offset)[0]
                    if fid:
                        textures.append(fid)
    return found


WORLD_MODEL_CHILDREN = {
    b"GFID": Child("wmo", "wmo", "{stem}_{index:03d}"),
    b"MOMT": Child("texture", "blp"),
}
"""The world-model counterpart of `MODEL_CHILDREN`.

A group file's numbering is the game's own: a root's groups are the root's name,
an underscore and three digits.
"""


def walk_parents(storage: Reads, known: dict[int, str], unnamed: set[int],
                 *, suffix: str, reader, kinds, local_only: bool,
                 label: str) -> Walk:
    """Every unnamed file reachable from a parent that already has a name.

    Claims are gathered before any path is built, because the shape a child gets
    depends on how many parents claim the same slot, and that is not known until
    every parent has been read.

    Args:
        storage: the opened storage.
        known: file id to the name already derived for it.
        unnamed: the ids still without one.
        suffix: which parents to walk, by their name's extension.
        reader: pulls a parent's child ids out of its bytes, by chunk tag.
        kinds: how a child found through each tag is named.
        local_only: skip any parent the install does not hold.
        label: what to call this walk in its progress bar.

    Returns:
        What the walk found.
    """
    parents = sorted(fid for fid, path in known.items()
                     if path.lower().endswith(suffix))
    storage.encoding_keys(parents)
    here = [fid for fid in parents if storage.holds_locally(fid)]
    remote = [fid for fid in parents if not storage.holds_locally(fid)]

    claims: dict[int, list[tuple[int, bytes, int]]] = defaultdict(list)
    read = 0

    def collect(parent: int, raw: bytes | None) -> None:
        nonlocal read
        if not raw:
            return
        read += 1
        for tag, ids in reader(raw).items():
            for index, child in enumerate(ids):
                if child in unnamed:
                    claims[child].append((parent, tag, index))

    for parent in tqdm(here, desc=f"{label} (install)", unit="file"):
        collect(parent, storage.read(parent, local_only=True))

    if not local_only and remote:
        # Said out loud before it starts. This is somebody else's service, run
        # for players rather than for tooling, and a walk of this width is a
        # decision rather than a detail of how a default happens to be set.
        print(f"  {label}: {len(remote):,} files are not on disk and will be "
              f"requested from the service")
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            pending = {pool.submit(storage.read, fid): fid for fid in remote}
            for done in tqdm(as_completed(pending), total=len(pending),
                             desc=f"{label} (network)", unit="file"):
                collect(pending[done], done.result())

    names: dict[int, str] = {}
    for child, entries in claims.items():
        parent, tag, index = min(entries)
        kind = kinds[tag]
        stem = stem_of(known[parent])
        if kind.numbering is not None and len(entries) == 1:
            spelled = kind.numbering.format(stem=stem, index=index)
            names[child] = f"{DERIVED_ROOT}/{kind.bucket}/{spelled}.{kind.extension}"
        else:
            # Shared between parents, or a slot the format does not number: the
            # file id is what keeps the path unique, and the parent directory is
            # what carries the meaning.
            names[child] = f"{DERIVED_ROOT}/{kind.bucket}/{stem}/{child}.{kind.extension}"
    return Walk(names=names, read=read,
                skipped=len(remote) if local_only else 0)


TERRAIN_CHUNKS = (b"MHDR", b"MCNK", b"MCIN")
"""Chunks only a terrain tile carries."""

WORLD_TABLE_CHUNKS = (b"MPHD", b"MAIN", b"MAID")
"""Chunks only a map's world table carries."""

WORLD_MODEL_ROOT_CHUNKS = (b"MOHD",)
WORLD_MODEL_GROUP_CHUNKS = (b"MOGP",)


def classify(raw: bytes) -> str:
    """What kind of file some bytes are.

    The leading four bytes are not enough and reading them alone is a known
    wrong answer: terrain, world tables and world models all begin with the same
    version chunk, so classifying on the magic calls thousands of map tiles
    world models. Anything sharing that magic is separated on the chunks it
    carries instead.

    Args:
        raw: the decoded file, or as much of it as is to hand.

    Returns:
        A short kind name, or ``unknown`` when nothing recognises it.
    """
    if not raw:
        return "empty"
    magic = raw[:4]
    if magic == b"BLP2":
        return "blp"
    if magic in (b"MD21", b"MD20"):
        return "m2"
    if magic == b"SKIN":
        return "skin"
    if magic[:3] == b"ID3" or magic[:2] == b"\xff\xfb":
        return "mp3"
    if magic == b"OggS":
        return "ogg"
    if magic != b"REVM":
        return "unknown"

    tags = {tag for tag, _ in chunks(raw, reversed_tags=True)}
    if tags & set(WORLD_TABLE_CHUNKS):
        return "wdt"
    if tags & set(TERRAIN_CHUNKS):
        return "adt"
    if tags & set(WORLD_MODEL_ROOT_CHUNKS):
        return "wmo root"
    if tags & set(WORLD_MODEL_GROUP_CHUNKS):
        return "wmo group"
    return "chunked, unrecognised"


def model_children(storage: Reads, known: dict[int, str],
                   unnamed: set[int], *, local_only: bool = True) -> Walk:
    """Skins, textures and animations, from the models that use them."""
    return walk_parents(storage, known, unnamed, suffix=".m2",
                        reader=_model_children, kinds=MODEL_CHILDREN,
                        local_only=local_only, label="models")


def world_model_children(storage: Reads, known: dict[int, str],
                         unnamed: set[int], *, local_only: bool = True) -> Walk:
    """Group geometry and material textures, from the world models that use them."""
    return walk_parents(storage, known, unnamed, suffix=".wmo",
                        reader=_world_model_children, kinds=WORLD_MODEL_CHILDREN,
                        local_only=local_only, label="world models")
