"""What the registered sections, taken together, must satisfy.

`registry_test.py` is what one registration refuses. These are the claims that
only hold over the whole roster: the order the artifact keys on, and the
vocabulary chain the row tables resolve stored numbers through.
"""

from __future__ import annotations

from pack.derive.kinds import COLUMN_FAMILIES, VOCABULARIES
from pack.drift import OPTIONAL_TABLES, TDB_OPTIONAL_TABLES
from pack.model import SECTIONS
from pack.sources.tdb import TDB_TABLES

REGISTERED_ORDER = (
    "animKitAnims", "bonesetNames", "animKitAnimBoneset", "animNames",
    "animEmoteOneshots", "animEmoteLoops", "iconNames", "iconFids", "files",
    "morphs", "morphDisplays", "mounts", "shapeshifts", "shapeshiftDisplays",
    "summons", "summonControlNames", "objects", "expansions", "fxChains",
    "fxTextures", "dissolves", "dissolveTextures", "glows", "shadowies",
    "ghostMats", "tints", "anchorNames", "spellAttrs", "spellDelivery",
    "areas", "keybinds", "linkKindNames", "effectNames", "auraNames",
    "implicitTargetNames", "implicitTargetBits", "missileMotions", "items",
    "itemIconNames", "itemQualityNames", "attachmentNames", "modelCatNames",
    "targetNames", "speedModeNames", "modelRows", "soundRows", "animRows",
    "fxRows", "mechRows", "equippedSlots", "rowVocabs", "screens",
    "screenTextures", "soundKitNames", "spells", "spellText", "vehicles",
    "vehicleSeats", "spellVehicleAnims", "spellVehicleAnimKits",
)
"""Every section, in registration order, pinned on purpose.

Registration order is the artifact's key order, the key order is each module's
bytes, and the bytes are the module's content-addressed name -- so reordering
two imports in `model/sections/__init__.py`, or two `register` calls inside one
module, renames every module of every pack and re-ships the whole roster with
nothing in it changed. Adding a section appends a name here, one edit riding a
change that re-ships anyway; a REORDER showing up in this diff is the pin doing
its job, and taking it means meaning the re-ship.
"""


def test_the_registration_order_is_the_pinned_one() -> None:
    assert tuple(section.name for section in SECTIONS) == REGISTERED_ORDER


def test_every_vocabulary_points_at_a_registered_section() -> None:
    """The second hop of the chain a reader resolves a stored number through.

    A row property names a vocabulary and the vocabulary names a section and
    its columns. `build_column` guards the first hop; nothing at build time
    guards this one, and its failure is silent in the worst way -- the lookup
    misses, the property keeps the raw number, and every query on it answers
    nothing forever.
    """
    columns = {section.name: set(section.columns) for section in SECTIONS}
    for name, where in VOCABULARIES.items():
        home = where["in"]
        assert home in columns, (
            f"vocabulary {name} lives in {home!r}, which no section declares")
        for half in ("keys", "values"):
            if half in where:
                assert where[half] in columns[home], (
                    f"vocabulary {name} reads {home}.{where[half]}, which the "
                    f"section does not produce")
        assert "keys" not in where or "values" in where, (
            f"vocabulary {name} names keys and no values, which is none of the "
            f"three declared shapes")


def test_every_needed_table_is_one_some_build_can_lack() -> None:
    """`needs` and `degraded_without` only fire on a table that can be absent,
    so an entry no drift declaration covers is dead: a typo there means the
    section never switches off and nothing ever says so.
    """
    absentable = (set(OPTIONAL_TABLES) | set(TDB_OPTIONAL_TABLES)
                  | set(TDB_TABLES["world"]))
    for section in SECTIONS:
        for table in (*section.needs, *section.degraded_without):
            assert table in absentable, (
                f"{section.name} names {table!r}, which no drift declaration "
                f"covers and so is never absent")


def test_every_family_resolves_through_a_declared_vocabulary() -> None:
    """`build_column` refuses this per column at build time; refusing it here
    means a family cannot sit wrong in the tree until a rebuild finds it."""
    for column, families in COLUMN_FAMILIES.items():
        for family in families:
            unknown = sorted(set(family.vocab.values()) - set(VOCABULARIES))
            assert not unknown, (
                f"{column}.{family.kind} resolves {', '.join(unknown)}, "
                f"which no vocabulary declares")
