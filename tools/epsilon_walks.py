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

import re
import struct
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import TYPE_CHECKING

from epsilon_storage import Reads, chunks
from tqdm import tqdm

if TYPE_CHECKING:  # pragma: no cover - the import is for annotations only
    from epsilon_tables import Table

WORKERS = 32
"""Concurrent reads for files the install does not hold.

These files are small, so a walk that reaches the network is bound by round
trips rather than by bandwidth and the width is what makes it finish.
"""

DERIVED_ROOT = "epsilon"
"""Where a derived path sits, so it is never mistaken for one the game uses."""

MAP_DIRECTORY, MAP_WDT = "Directory", "WdtFileDataID"
"""Which columns of ``Map.db2`` carry a map's directory and its world table's
file id. Its rows name every map, including the ones this client added."""

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
        extension: the child's own extension.
        beside: whether the game names this kind of file after its parent and
            puts it in the parent's own directory. Where that holds, the child's
            path is fully determined by the parent's, so it is not a derived
            path at all -- it is the name the game itself would look the file up
            by, and it is only as real as the parent's name is.
        bucket: the directory a derived path sits under, for the kinds where no
            such convention holds.
    """

    extension: str
    beside: bool = False
    bucket: str = ""


MODEL_CHILDREN = {
    b"SFID": Child("skin", beside=True, bucket="skin"),
    b"TXID": Child("blp", bucket="texture"),
    b"AFID": Child("anim", beside=True, bucket="anim"),
    b"BFID": Child("bone", bucket="bone"),
    b"SKID": Child("skel", bucket="skel"),
    b"PFID": Child("phys", bucket="phys"),
}
"""Which chunks of a model point at another file, and how to name what they
point at.

Only two of these follow a convention the listfile bears out. A model's skins
sit beside it as the model's name and a two-digit index, and its animations as
the model's name, the animation's own id and its variation -- both measured
across thousands of published names. The remaining three do live beside their
model but are named too irregularly to predict, and a texture's slot is a
material property rather than part of any filename, so all four keep the shape
that leans on the file id.
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
        unreadable: how many could not be read at all. Worth reporting rather
            than swallowing: a parent that fails to arrive takes every claim it
            would have made with it, and the result is simply a few files left
            unnamed with nothing to say why.
    """

    names: dict[int, str]
    read: int
    skipped: int
    unreadable: int = 0


def stem_of(path: str) -> str:
    """A parent's bare filename, which is what a derived path is keyed on."""
    return path.replace("\\", "/").rsplit("/", 1)[-1].rsplit(".", 1)[0]


def custom_maps(storage: Reads, floor: int) -> list[tuple[str, int]]:
    """Every map this client added, as its directory and its world table's id.

    A map whose world table sits in the client's own id space is one the client
    added; there is no other flag that says so.

    Read by column name. A positionally read table cannot tell a string from
    the offset that locates it, so the directory came back as the number
    `53330` where the row holds `Azeroth`, and every path built from it named
    a directory no storage has.
    """
    from epsilon_tables import open_table, table_ids  # pylint: disable=import-outside-toplevel

    table = open_table(storage, "Map", table_ids())
    if table is None or not table.has(MAP_DIRECTORY, MAP_WDT):
        return []
    found = []
    for directory, wdt_text in table.values(MAP_DIRECTORY, MAP_WDT):
        try:
            wdt = int(wdt_text)
        except ValueError:
            continue
        if wdt > floor:
            found.append((directory, wdt))
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


MODEL_BUCKET = "model"
"""Where a model named by the name it carries about itself sits."""

MD20_HEADER = struct.Struct("<III")
"""Version, then the length and offset of the model's own name.

The name is the first thing the header points at, so it is reachable without
understanding anything else in the format.
"""

MAX_MODEL_NAME = 512
"""Longer than any real name, and the guard that stops a misread length from
slicing an arbitrary megabyte out of the file and calling it a name."""


def heads_of(storage: Reads, ids: list[int], *, label: str,
             local_only: bool = True) -> dict[int, bytes]:
    """The start of every one of these files, from disk and then the service.

    Both routes that name a file from its own bytes read a header, so the tail
    is bought and thrown away. A capped read is a tenth of the bytes across the
    files an install lacks, and the same bytes for the third of them smaller
    than the cap.

    Goes wide for the same reason the parentage walks do: these are thousands
    of small requests and the wall clock is round trips, not bandwidth. Read
    one at a time the same set takes hours.

    ⛔ Only for a reader that wants the START of a file. The parentage walks
    read chunks that sit at the end, and a truncated container yields fewer of
    them with no error -- which reads as a parent with no children rather than
    as a short read.

    Args:
        storage: the opened storage.
        ids: the files to read.
        label: what to call this pass in its progress output.
        local_only: refuse to reach the network, reading only what is to hand.

    Returns:
        File id to the bytes read, for those that could be read at all.
    """
    storage.encoding_keys(ids)
    here = [fid for fid in ids if storage.holds_locally(fid)]
    remote = [] if local_only else [fid for fid in ids if fid not in set(here)]

    found: dict[int, bytes] = {}
    for fid in tqdm(here, desc=f"{label} (install)", unit="file"):
        raw = storage.read(fid, local_only=True)
        if raw:
            found[fid] = raw
    if not remote:
        return found

    # Said out loud before it starts, as the parentage walks do: this is
    # somebody else's service and a pass of this width is a decision.
    print(f"  {label}: {len(remote):,} files are not on disk and will be "
          f"requested from the service, capped to their heads")
    # Before going wide, never during: the fallback index every miss needs is
    # built lazily and is not thread safe, so a concurrent first read has each
    # worker build its own.
    storage.prepare_network()
    # One pass over the install's archive indices for the whole set. Asking per
    # file re-reads all of them each time, which is hours rather than minutes.
    locate = getattr(storage, "locate", None)
    if locate is not None:
        locate(remote)
    read_head = getattr(storage, "read_head", None)
    fetch = read_head if read_head is not None else storage.read
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        pending = {pool.submit(fetch, fid): fid for fid in remote}
        for done in tqdm(as_completed(pending), total=len(pending),
                         desc=f"{label} (network)", unit="file"):
            raw = done.result()
            if raw:
                found[pending[done]] = raw
    return found


def model_name(raw: bytes | None) -> str | None:
    """The name a model stores about itself.

    Every M2 carries one, and for a file nothing else reaches it is the only
    thing that says what the model IS rather than where it hangs. The modern
    container wraps the old header in an `MD21` chunk and keeps the `MD20`
    magic inside it, so both shapes are read the same way once the wrapper is
    off.

    Args:
        raw: the decoded file, or None when it could not be read.

    Returns:
        The name, or None when the bytes are not a model, carry no name, or
        declare a length that does not fit the file.
    """
    if not raw or raw[:4] not in (b"MD20", b"MD21"):
        return None
    body = raw
    if raw[:4] == b"MD21":
        for tag, data in chunks(raw, reversed_tags=False):
            if tag == b"MD21":
                body = data
                break
    start = 4 if body[:4] == b"MD20" else 0
    if len(body) < start + MD20_HEADER.size:
        return None
    _version, length, offset = MD20_HEADER.unpack_from(body, start)
    if not 0 < length < MAX_MODEL_NAME or offset + length > len(body):
        return None
    found = body[offset:offset + length].split(b"\x00")[0]
    text = found.decode("ascii", "replace").strip()
    # Some models name a texture here rather than themselves. That is a real
    # string about a different file, so taking it would name the model after
    # its own texture.
    if not text or text.lower().endswith(".blp"):
        return None
    # A few carry the whole path the model was built at, drive letter and all.
    # Everything after the archive it was packed into is a game-relative path
    # the author actually used, which says more than the bare filename does.
    text = text.replace(chr(92), "/")
    marker = text.lower().rfind(".mpq/")
    if marker != -1:
        text = text[marker + 5:]
    elif "/" in text or ":" in text:
        text = text.rsplit("/", 1)[-1]
    # The name usually carries its own extension, and the caller adds one.
    for suffix in (".m2", ".mdx"):
        if text.lower().endswith(suffix):
            text = text[:-len(suffix)]
            break
    return text.strip("/ ") or None


def model_self_names(storage: Reads, unnamed: set[int],
                     *, local_only: bool = True) -> dict[int, str]:
    """Models named by the name they carry, for the ones nothing else reaches.

    Args:
        storage: the opened storage.
        unnamed: the ids still wanting a name.
        local_only: refuse to reach the network, naming only what is to hand.

    Returns:
        File id to path.
    """
    heads = heads_of(storage, sorted(unnamed), label="model names",
                     local_only=local_only)
    found: dict[int, str] = {}
    retry: list[int] = []
    for fid, raw in heads.items():
        name = model_name(raw)
        if name:
            found[fid] = name
        elif raw[:4] in (b"MD20", b"MD21"):
            retry.append(fid)

    # A capped head is enough for most models and wrong for some: measured,
    # nine in ten of the ones it reports as nameless do carry a name that a
    # whole file yields. Which ones cannot be known without asking, so the
    # cheap read runs first and only its failures are paid for in full.
    if retry and not local_only:
        print(f"  model names: {len(retry):,} models reported no name from their "
              f"head and are being re-read whole")
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            pending = {pool.submit(storage.read, fid): fid for fid in retry}
            for done in tqdm(as_completed(pending), total=len(pending),
                             desc="model names (whole)", unit="file"):
                whole = done.result()
                name = model_name(whole) if whole else None
                if name:
                    found[pending[done]] = name

    # A name is the artist's, not the file's, so several models legitimately
    # share one. The id disambiguates exactly those, and only those, which is
    # the shape the object walk already uses.
    repeated = {name for name, count in Counter(found.values()).items() if count > 1}
    names: dict[int, str] = {}
    for fid, name in found.items():
        stem = f"{name}_{fid}" if name in repeated else name
        names[fid] = f"{DERIVED_ROOT}/{MODEL_BUCKET}/{stem}.m2"
    return names


RESKIN_BUCKET = "reskin"
"""Where a world model named after the one it was copied from sits."""

MOHD_WMOID_OFFSET = 32
"""Where `wmoID` sits inside a world model's header.

The chunk opens with seven counts and a four-byte ambient colour, so the id
begins at byte thirty-two. Documented on wowdev.wiki/WMO and confirmed against
the client: every stock root read carries a distinct one.
"""

GROUP_SUFFIX = re.compile(r"_\d{3}\.wmo$", re.IGNORECASE)
"""A world model group's filename. Groups carry no `MOHD`, so reading one costs
a fetch that can never contribute, and there are forty thousand of them."""


def world_model_id(raw: bytes | None) -> int | None:
    """The retail world model a file declares itself to be.

    Args:
        raw: the decoded file, or None when it could not be read.

    Returns:
        The `wmoID` from the file's header, or None when the bytes are not a
        world model root or carry no id.
    """
    if not raw or raw[:4] != b"REVM":
        return None
    for tag, data in chunks(raw, reversed_tags=True):
        if tag == b"MOHD" and len(data) >= MOHD_WMOID_OFFSET + 4:
            found = int(struct.unpack_from("<I", data, MOHD_WMOID_OFFSET)[0])
            return found or None
    return None


def reskin_names(storage: Reads, unnamed: set[int], stock: dict[int, str],
                 *, local_only: bool = True) -> dict[int, str]:
    """World models named by the retail model they were reskinned from.

    Nothing in the client references these files -- they are not doodads of any
    named model, no table mentions them, and the display entry they carry
    cannot be spawned -- so no parentage walk reaches them and there is nothing
    left to derive a path from. What they do carry is their own header, and a
    reskin that starts from a retail root inherits that root's `wmoID`. The id
    is a key into the retail id space, so matching it against the stock roots
    that declare the same one says which model the file began as.

    That is a description rather than the file's own name, so it ranks with the
    customization walk: it says what the thing IS, which parentage never does.

    Args:
        storage: the opened storage.
        unnamed: the ids still wanting a name. Every earlier route has already
            taken what it can, so this is the whole of what is left to try.
        stock: retail file id to path, for the roots to match against.
        local_only: refuse to reach the network, naming only what is to hand.

    Returns:
        File id to path. Empty when no stock root could be read, since without
        the retail side there is nothing to match against and a silent empty
        result would look like the custom files carrying no id.
    """
    roots = [fid for fid, path in stock.items() if not GROUP_SUFFIX.search(path)]
    storage.encoding_keys(roots)
    retail: dict[int, int] = {}
    # The retail side stays on disk whatever the caller asked for. There are
    # fifty thousand of these and any one of them might hold the id a custom
    # file is looking for, so fetching them is most of a gigabyte spent on the
    # half of the join that is not the point. The custom side is what the
    # network is for.
    for fid in tqdm(sorted(roots), desc="reskin: retail roots", unit="file"):
        found = world_model_id(storage.read(fid, local_only=True))
        if found is not None:
            retail.setdefault(found, fid)
    if not retail:
        print("  reskin: skipped, no stock world model root could be read")
        return {}

    names: dict[int, str] = {}
    heads = heads_of(storage, sorted(unnamed), label="reskin: custom roots",
                     local_only=local_only)
    for fid, raw in heads.items():
        found = world_model_id(raw)
        origin = retail.get(found) if found is not None else None
        if origin is None:
            continue
        stem = stock[origin].replace("\\", "/").rsplit("/", 1)[-1]
        stem = stem.rsplit(".", 1)[0].lower()
        names[fid] = f"{DERIVED_ROOT}/{RESKIN_BUCKET}/{stem}/{fid}.wmo"
    print(f"  reskin: {len(retail):,} retail roots read, {len(names):,} named")
    return names


CUSTOMIZATION_BUCKET = "chrcustomization"
"""Where a character-customization texture's derived path sits."""

CUSTOMIZATION_TABLES = ("TextureFileData", "ChrCustomizationMaterial",
                        "ChrCustomizationElement", "ChrCustomizationChoice",
                        "ChrCustomizationOption")
"""The chain from a texture to what it customises. Required; without all five
there is no name."""

CUSTOMIZATION_CONTEXT = ("ChrModel", "ChrRaceXChrModel", "ChrRaces")
"""Who the customisation is for. Optional: these add the race and sex segment,
and a client missing them yields a shorter path rather than no path."""

SEXES = {"0": "male", "1": "female"}
def wearers(tables: dict[str, Table | None]) -> dict[int, str]:
    """Which race and sex each character model belongs to.

    Context rather than identity: a customisation option names what is being
    changed but not who for, and the same option name is reused across every
    race. Without this a texture reads as `eye_color/04` whoever wears it.

    Args:
        tables: the opened context tables, any of which may be absent.

    Returns:
        Character model id to a path segment naming its wearer, empty when the
        client does not carry the tables that say.
    """
    models, mapping, races = (tables.get("ChrModel"), tables.get("ChrRaceXChrModel"),
                              tables.get("ChrRaces"))
    if models is None or mapping is None or races is None:
        return {}
    sex = {model: SEXES.get(value, "") for model, value
           in models.named("ID", "Sex").items()}
    named = races.named("ID", "ClientFileString")
    # Keyed on the model, because a race has one model per sex and keying the
    # other way would keep whichever row came last and lose the other.
    out: dict[int, str] = {}
    for model, race in mapping.pairs("ChrModelID", "ChrRacesID").items():
        label = slug(named.get(race, ""))
        if label:
            out[model] = f"{label}_{sex[model]}" if sex.get(model) else label
    return out


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
    choice_order = choices.pairs("ID", "OrderIndex")
    option_of = choices.pairs("ID", "ChrCustomizationOptionID")
    option_names = options.named("ID", "Name_lang")

    # Who the option is for. Optional, so a client without these tables gets a
    # shorter path rather than none.
    context = {name: open_table(storage, name, ids) for name in CUSTOMIZATION_CONTEXT}
    wearer_of = wearers(context)
    model_of = options.pairs("ID", "ChrModelID")

    names: dict[int, str] = {}
    for fid, resource in textures.pairs("FileDataID", "MaterialResourcesID").items():
        if fid <= floor:
            continue
        choice = choice_of.get(material_of.get(resource, -1), 0)
        if not choice:
            continue
        holder = option_of.get(choice, 0)
        option = slug(option_names.get(holder, ""))
        if not option:
            continue
        # A choice this client added usually carries no display name, and its
        # place in the option is what the game itself shows instead: these are
        # the numbered swatches in the character creator. So a nameless choice
        # becomes its position rather than its row id, which is the difference
        # between "eye colour, the fourth one" and an opaque number.
        chosen = slug(choice_names.get(choice, ""))
        if not chosen:
            order = choice_order.get(choice)
            chosen = f"{order:02d}" if order is not None else f"choice_{choice}"
        wearer = wearer_of.get(model_of.get(holder, 0), "")
        parts = [DERIVED_ROOT, CUSTOMIZATION_BUCKET]
        if wearer:
            parts.append(wearer)
        names[fid] = f"{'/'.join(parts)}/{option}/{chosen}/{fid}.blp"
    return names


def _model_children(raw: bytes) -> dict[bytes, list[tuple[int, str]]]:
    """The file ids one model points at, by chunk tag.

    A model from before the chunked format begins with a different magic and
    carries no chunks at all, so it yields nothing rather than failing: its
    references are inline and name no separate file.
    """
    found: dict[bytes, list[tuple[int, str]]] = {}
    for tag, body in chunks(raw):
        if tag not in MODEL_CHILDREN:
            continue
        if tag == b"AFID":
            # An animation is named by the animation it holds rather than by
            # its position in the list, so the two fields ahead of the file id
            # are the name and not something to skip past.
            found[tag] = []
            for at in range(0, len(body) - _ANIMATION_ENTRY + 1, _ANIMATION_ENTRY):
                animation, variation, fid = struct.unpack_from("<HHI", body, at)
                found[tag].append((fid, f"{animation:04d}-{variation:02d}"))
        else:
            found[tag] = [(fid, f"{index:02d}") for index, fid
                          in enumerate(struct.unpack_from(f"<{len(body) // 4}I", body))]
    return found


def _world_model_children(raw: bytes) -> dict[bytes, list[tuple[int, str]]]:
    """The group files and material textures one world model points at."""
    found: dict[bytes, list[tuple[int, str]]] = {}
    for tag, body in chunks(raw, reversed_tags=True):
        if tag == b"GFID":
            groups = found.setdefault(b"GFID", [])
            for fid in struct.unpack_from(f"<{len(body) // 4}I", body):
                groups.append((fid, f"_{len(groups):03d}"))
        elif tag == b"MOMT":
            textures = found.setdefault(b"MOMT", [])
            for at in range(0, len(body) - _MATERIAL + 1, _MATERIAL):
                for offset in _MATERIAL_TEXTURES:
                    fid = struct.unpack_from("<I", body, at + offset)[0]
                    if fid:
                        textures.append((fid, ""))
    return found


WORLD_MODEL_CHILDREN = {
    b"GFID": Child("wmo", beside=True, bucket="wmo"),
    b"MOMT": Child("blp", bucket="texture"),
}
"""The world-model counterpart of `MODEL_CHILDREN`.

A group sits beside its root as the root's name, an underscore and three
digits, which the listfile bears out for very nearly every published group.
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

    claims: dict[int, list[tuple[int, bytes, str]]] = defaultdict(list)
    read = unreadable = 0

    def collect(parent: int, raw: bytes | None) -> None:
        nonlocal read, unreadable
        if not raw:
            unreadable += 1
            return
        read += 1
        for tag, references in reader(raw).items():
            for child, suffix in references:
                if child in unnamed:
                    claims[child].append((parent, tag, suffix))

    for parent in tqdm(here, desc=f"{label} (install)", unit="file"):
        collect(parent, storage.read(parent, local_only=True))

    if not local_only and remote:
        # Said out loud before it starts. This is somebody else's service, run
        # for players rather than for tooling, and a walk of this width is a
        # decision rather than a detail of how a default happens to be set.
        print(f"  {label}: {len(remote):,} files are not on disk and will be "
              f"requested from the service")
        # Before going wide, never during: the fallback index every miss needs
        # is built lazily, so a concurrent first read has each worker build it.
        storage.prepare_network()
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            pending = {pool.submit(storage.read, fid): fid for fid in remote}
            for done in tqdm(as_completed(pending), total=len(pending),
                             desc=f"{label} (network)", unit="file"):
                collect(pending[done], done.result())

    names: dict[int, str] = {}
    for child, entries in claims.items():
        parent, tag, suffix = min(entries)
        kind = kinds[tag]
        parent_path = known[parent]
        stem = stem_of(parent_path)
        if kind.beside and len(entries) == 1:
            # The game's own name for this file, which is the parent's name and
            # the parent's directory. Whether it is a real path or a derived one
            # is settled by the parent's own name, not here.
            directory = parent_path.replace("\\", "/").rpartition("/")[0]
            spelled = f"{stem}{suffix}.{kind.extension}"
            names[child] = f"{directory}/{spelled}" if directory else spelled
        else:
            # Shared between parents, or a kind the game names irregularly: the
            # file id is what keeps the path unique, and the parent directory is
            # what carries the meaning.
            names[child] = f"{DERIVED_ROOT}/{kind.bucket}/{stem}/{child}.{kind.extension}"
    if unreadable:
        print(f"  {label}: {unreadable:,} of {len(here) + len(remote):,} parents "
              f"could not be read; their children stay unnamed")
    return Walk(names=names, read=read,
                skipped=len(remote) if local_only else 0, unreadable=unreadable)


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
