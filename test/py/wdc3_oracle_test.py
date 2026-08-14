"""Epsilon's own tables, decoded and checked against the export for one build.

A reader that is wrong about a field agrees with itself perfectly, so nothing
the decoder can be asked about itself catches a decode defect. What does is a
second source for the same bytes: wago's export and Epsilon's client both cover
9.2.7.45745, so every table the build reads can be checked column by column
against data that is known good.

What the check reports is a per-table status rather than a count of differing
rows. A count cannot tell a misread field from a value Epsilon ships
differently, and reading one as the other is how a decode defect gets accepted:
the two tables whose row counts looked worst were a repacked table and a
server-wide flag change, while a table reading one column of every row wrongly
looked like a rounding artifact.

Two comparisons are deliberately loose, and neither hides a decoding question:

  * A float column is compared as a float32. The export spells an extreme or
    exactly-halfway decimal its own way, and two spellings of one float32 do
    not disagree about the value.
  * A column named in `EPSILON_CHANGES` is not compared. Those are values
    Epsilon's own client ships differently, each verified against the raw bytes
    rather than assumed from the size of the disagreement.

Everything else must match exactly, which is what makes a new disagreement a
failure rather than a number someone has to re-interpret.

Reading the client means fetching from its content network, so this is opt-in:
set `EPSILOOK_EPSILON_ORACLE` to run it. The declarations below stay useful
while it is skipped, because they are the record of what was measured.
"""

from __future__ import annotations

import csv
import importlib.util
import os
import struct
import sys
from pathlib import Path
from typing import Any

import pytest

from pack.sources import casc, wdc3

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache"
BUILD = (9, 2, 7, 45745)
EXPORT = CACHE / "9.2.7.45745"
LISTFILE = CACHE / "listfile" / "community-listfile-withcapitals.csv"
DEFINITIONS = CACHE / "dbd"
HOST = "tact.epsilonwow.net"


def load_definitions_parser() -> Any:
    """The `.dbd` parser, loaded from the tools directory by its path.

    Loaded rather than imported because the package does not hold it yet, and
    tolerantly because a checkout without it should skip this rather than fail
    to collect.

    TODO: import it as an ordinary module once the source layer places the
    parser inside the package. Where a schema parser belongs is that layer's
    question, and the oracle follows it wherever it lands.
    """
    path = ROOT / "tools" / "dbd.py"
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location("dbd", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    # Registered before it runs: a dataclass declared inside it resolves its
    # own module while being built, and finds nothing if this is left until
    # afterwards.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


dbd = load_definitions_parser()

EPSILON_CHANGES: dict[str, tuple[str, ...]] = {
    # Attribute bits set and cleared across nearly every spell, which is a
    # server making its whole spell list castable rather than a misread field:
    # the raw record carries the bits, and the deltas are one or two named bits
    # rather than noise.
    "SpellMisc": ("Attributes_0", "Attributes_1", "Attributes_4"),
    # Tables the client has repacked wholesale, adding hundreds of thousands of
    # rows and losing or rewriting columns of the stock ones. The bounding
    # boxes read as zero because the records hold zeros.
    "GameObjectDisplayInfo": ("GeoBox_0", "GeoBox_1", "GeoBox_2", "GeoBox_3",
                              "GeoBox_4", "GeoBox_5", "ObjectEffectPackageID",
                              "OverrideLootEffectScale", "OverrideNameScale"),
    "ItemModifiedAppearance": ("TransmogSourceTypeEnum",),
    "ItemAppearance": ("TransmogPlayerConditionID",),
    "ItemDisplayInfo": ("GeosetGroup_0", "ModelMaterialResourcesID_0",
                        "ModelType_0"),
    # Columns the client's own packing has collapsed to a constant: the pallet
    # backing each one holds a single entry, so the table itself says no other
    # value is reachable.
    "ItemSearchName": ("AllowableClass", "AllowableRace", "MinFactionID",
                       "MinReputation", "RequiredAbility", "RequiredSkill",
                       "RequiredSkillRank"),
    # Content the server has edited: replaced sounds, a repurposed area, and
    # scattered model geometry.
    "SoundKitEntry": ("FileDataID", "Volume"),
    "AreaTable": ("AreaName_lang", "ContentTuningID", "Flags_0", "ZoneName"),
    "CreatureDisplayInfo": ("StateSpellVisualKitID",),
    "CreatureModelData": ("BloodID", "CollisionHeight", "CollisionWidth",
                          "Flags", "GeoBox_0", "GeoBox_1", "GeoBox_2",
                          "GeoBox_3", "GeoBox_4", "GeoBox_5", "MountHeight"),
    "UiMapAssignment": ("AreaID", "MapID", "Region_0", "Region_1", "Region_3",
                        "Region_4", "UiMapID", "WMODoodadPlacementID",
                        "WMOGroupID"),
}
"""Columns where Epsilon's client and the export hold different values.

Not decode defects. Each was read back from the raw record before being listed,
because the size of a disagreement says nothing about its cause.
"""

RENAMED_COLUMNS = {"SpellOverrideName"}
"""Tables the export and the definitions disagree about the NAME of a column in.

The definition has since named a column the export still calls
`Field_9_1_0_38709_001_lang`. The header comparison is skipped; the values are
still compared positionally.
"""

_DEFAULT_BITS = {"float": 32, "string": 32, "locstring": 32}

pytestmark = pytest.mark.skipif(
    not os.environ.get("EPSILOOK_EPSILON_ORACLE") or dbd is None,
    reason="reads Epsilon's content network; set EPSILOOK_EPSILON_ORACLE to run")


def schema_for(definition: Any,
               build: tuple[int, int, int, int]) -> list[wdc3.ColumnSpec] | None:
    """The reader's schema, out of a parsed definition's build block."""
    block = definition.block_for(build) if definition else None
    if block is None or definition is None:
        return None
    out = []
    for entry in block.columns:
        meaning = definition.columns.get(entry.name)
        kind = meaning.type if meaning else "int"
        out.append(wdc3.ColumnSpec(
            name=entry.name, kind=kind,
            bits=entry.width or _DEFAULT_BITS.get(kind, 32),
            signed=not entry.unsigned, count=entry.array or 1,
            is_id=entry.is_id, is_relation=entry.is_relation,
            in_record=not entry.noninline))
    return out


def same_float32(left: str, right: str) -> bool:
    """Whether two decimal spellings denote the same float32."""
    try:
        pair = [struct.unpack("<f", struct.pack("<f", float(text)))[0]
                for text in (left, right)]
    except (ValueError, OverflowError):
        return False
    return pair[0] == pair[1]


@pytest.fixture(name="client", scope="session")
def _client() -> tuple[casc.Storage, dict[str, int]]:
    """Epsilon's storage, and the file data id of every client table.

    Matching on the `.db2` extension is not optional: each of these tables also
    has a legacy `.dbc` id that no modern root references, and matching the
    stem resolves to a file the game stopped shipping several expansions ago.
    """
    if not LISTFILE.exists() or not EXPORT.is_dir():
        pytest.skip("the listfile and the cached export are not both present")
    fids: dict[str, int] = {}
    with LISTFILE.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            fid, _, path = line.partition(";")
            path = path.strip()
            if path.lower().startswith("dbfilesclient/") \
                    and path.lower().endswith(".db2"):
                fids[Path(path).stem] = int(fid)
    return casc.Storage(casc.Service(host=HOST)), fids


def export_rows(table: str) -> tuple[list[str], list[tuple[str, ...]]]:
    """One cached export CSV: its header and its rows."""
    path = EXPORT / f"{table}.csv"
    if not path.exists():
        return [], []
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        return next(reader, []), [tuple(row) for row in reader]


def tables() -> list[str]:
    """Every table the build reads, which is what the oracle has to cover."""
    from pack.sources.wago import TABLES
    return sorted({"SpellName", *TABLES})


@pytest.mark.parametrize("table", tables())
def test_epsilons_copy_decodes_to_the_export(
        table: str, client: tuple[casc.Storage, dict[str, int]]) -> None:
    """Every column of every shared row, bar the declared differences."""
    storage, fids = client
    header, export = export_rows(table)
    if not export:
        pytest.skip(f"{table} is not in the cached export")
    if table not in fids or fids[table] not in storage.root.keys:
        pytest.skip(f"{table} is not in Epsilon's root")

    definition = dbd.load(table, DEFINITIONS)
    data = wdc3.Db2(storage.open(fids[table]), schema_for(definition, BUILD))
    columns = data.columns
    rows = list(data.rows())

    if table not in RENAMED_COLUMNS:
        assert columns == header, (
            f"{table}: the decoded header is not the export's. A column order "
            f"or naming rule is wrong, and every value comparison below it "
            f"would be meaningless.")
    assert len(columns) == len(header), f"{table}: column count differs"

    at = data.id_position()
    export_by = {row[at]: row for row in export}
    epsilon_by = {row[at]: row for row in rows}
    shared = export_by.keys() & epsilon_by.keys()
    assert shared, f"{table}: no row id is present in both sources"

    floats = {name for column in data.declared if column.spec.kind == "float"
              for name in column.spec.spellings()}
    allowed = set(EPSILON_CHANGES.get(table, ()))

    failures: dict[str, tuple[str, str, str]] = {}
    for key in shared:
        want, got = export_by[key], epsilon_by[key]
        if want == got:
            continue
        for index, name in enumerate(columns):
            if name in allowed or name in failures:
                continue
            if want[index] == got[index]:
                continue
            if name in floats and same_float32(want[index], got[index]):
                continue
            failures[name] = (key, want[index], got[index])

    assert not failures, (
        f"{table}: {len(failures)} column(s) decode to something the export "
        f"does not hold, and none is a declared Epsilon change: "
        + "; ".join(f"{name} at id {key}: export {want!r}, decoded {got!r}"
                    for name, (key, want, got) in sorted(failures.items())))
