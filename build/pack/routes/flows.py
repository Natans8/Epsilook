"""Every route that is a declaration, in one place.

A route here is a flow and the shape it lands in, registered as the field it
fills. Its needs are read off the flow, so nothing is said twice; a change to
a route is a change to its line; a version that reads the same fact through
another table declares its own plan for the same field with `since`.

What is not here is a computation rather than a read: the graph walk, the
row flattening, the families and the text cooker, each a decorated function
in its own module.
"""

from __future__ import annotations

from .anims import SPEED_UNIT
from .columns import to_int
from .factions import FactionTemplateRow
from .flow import (
    as_map,
    as_records,
    as_rows,
    as_sets,
    as_tree,
    c,
    flow,
    key_of,
    number_of,
    text,
    typed,
    values_of,
    word,
)
from .gameobjects import GameObjectData, GameObjectRow
from .keybinds import KeyboundOverride, keybound_type_word
from .missiles import MissileMotion
from .mounts import MountData, MountRow
from .route import declare
from .shapeshifts import FormRow, ShapeshiftForms
from .sounds import Ambience, ZoneMusic

factions = declare(
    "factions",
    flow("the faction a spell sets")
    .read("FactionTemplate", c.ID, c.Faction, c.FactionGroup)
    .narrow(c.ID, "effects.factions.named")
    .join(c.Faction, "Faction", c.Name_lang)
    >> as_rows(FactionTemplateRow, c.ID, c.Faction, c.FactionGroup, word(c.Name_lang), sort=True),
)
"""The template each aura sets, resolved to the faction's name and group."""

zone_music = declare(
    "zone_music",
    flow("the music set a screen effect swaps in").read("ZoneMusic", c.ID, c.SetName, c.Sounds_0, c.Sounds_1)
    >> as_records(c.ID, ZoneMusic, word(c.SetName), c.Sounds_0, c.Sounds_1),
)

ambiences = declare(
    "ambiences",
    flow("the ambience a screen effect swaps in").read("SoundAmbience", c.ID, c.AmbienceID_0, c.AmbienceID_1)
    >> as_records(c.ID, Ambience, c.AmbienceID_0, c.AmbienceID_1),
)

soundkit_files = declare(
    "soundkit_files",
    flow("the files a sound kit plays")
    .read("SoundKitEntry", c.SoundKitID, c.FileDataID)
    .where((c.SoundKitID != 0) & (c.FileDataID != 0))
    >> as_sets(c.SoundKitID, c.FileDataID),
)

kit_types = declare(
    "kit_types",
    flow("what each reached sound kit is for")
    .read("SoundKit", c.ID, c.SoundType)
    .narrow(c.ID, "used_kits")
    .narrow(c.SoundType, "sound_type_names", "the types the vendored enum names")
    >> as_map(c.ID, c.SoundType),
)

kit_names = declare(
    "kit_names",
    flow("the names the pinned build gives the sound kits this pack reaches")
    .read("SoundKitName", c.ID, c.Name, source="pinned")
    .narrow(c.ID, "used_kits")
    .map("named", ~c.Name.is_empty())
    .where(c.named == 1)
    >> as_rows(lambda kit, name: (kit, name), c.ID, word(c.Name), sort=True),
)
"""Kits added after the pinned build have no name anywhere and stay unnamed."""

animkit_anims = declare(
    "animkit_anims",
    flow("the animations a kit segments")
    .read("AnimKitSegment", c.ParentAnimKitID, c.AnimID)
    .where(c.ParentAnimKitID != 0)
    .narrow(c.AnimID, "anim_ids")
    >> as_sets(c.ParentAnimKitID, c.AnimID),
)

animkit_speeds = declare(
    "animkit_speeds",
    flow("the pace a kit plays each animation at")
    .read("AnimKitSegment", c.ParentAnimKitID, c.AnimID, c.Speed)
    .where(c.ParentAnimKitID != 0)
    >> as_map(
        (c.ParentAnimKitID, c.AnimID), typed(c.Speed, lambda cell: round(number_of(cell) * SPEED_UNIT)), first=True
    ),
)
"""In thousandths; negative plays backwards and nought holds the first frame.
A kit segmenting one animation twice keeps the first segment's pace."""

animkit_bonesets = declare(
    "animkit_bonesets",
    flow("the body regions a kit's animation moves")
    .read("AnimKitSegment", c.ParentAnimKitID, c.AnimID, c.AnimKitConfigID)
    .join(
        c.AnimKitConfigID, "AnimKitConfigBoneSet", c.AnimKitBoneSetID, by="ParentAnimKitConfigID", inner=True, many=True
    )
    .join(c.AnimKitBoneSetID, "AnimKitBoneSet", c.Name, inner=True)
    .where(~c.Name.is_empty() & (c.Name != "Full Body"))
    >> as_tree(c.ParentAnimKitID, c.AnimID, value=text(c.Name)),
)
"""The default region, the whole body, is never shown because it distinguishes nothing."""

anim_replacements = declare(
    "anim_replacements",
    flow("the animation swaps a replacement set makes")
    .read("AnimReplacement", c.ParentAnimReplacementSetID, c.SrcAnimID, c.DstAnimID)
    .where(c.ParentAnimReplacementSetID != 0)
    .narrow(c.SrcAnimID, "anim_ids")
    .narrow(c.DstAnimID, "anim_ids")
    >> as_sets(c.ParentAnimReplacementSetID, c.SrcAnimID, c.DstAnimID),
)

keybinds = declare(
    "keybinds",
    flow("the game functions a key override casts a spell from").read(
        "SpellKeyboundOverride", c.ID, c.Function, c.Type, c.Data
    )
    >> as_records(
        c.ID,
        KeyboundOverride,
        word(c.Function),
        typed(c.Type, lambda cell: keybound_type_word(key_of(cell))),
        c.Data,
    ),
)

motions = declare(
    "motions",
    flow("the flight paths a missile can fly")
    .read("SpellMissileMotion", c.ID, c.Name, c.MissileCount)
    .where(~c.Name.is_empty())
    >> as_records(c.ID, MissileMotion, text(c.Name), c.MissileCount),
)

forms = declare(
    "forms",
    (
        flow("the shapeshift forms and the creatures they wear").read(
            "SpellShapeshiftForm", c.ID, c.Name_lang, c.CreatureDisplayID[:]
        )
        >> as_rows(
            FormRow,
            c.ID,
            text(c.Name_lang),
            typed(c.CreatureDisplayID[:], lambda cell: [d for d in map(to_int, values_of(cell)) if d > 0]),
        )
    ).then(ShapeshiftForms.assemble),
)

objects = declare(
    "objects",
    (
        flow("the gameobjects a spell spawns, named and modelled")
        .read("gameobject_template", c.entry, c.name, c.displayId, c.type, source="world")
        .join(c.displayId, "GameObjectDisplayInfo", c.FileDataID)
        >> as_rows(GameObjectRow, c.entry, word(c.name), c.type, c.FileDataID)
    ).then(GameObjectData.assemble),
)

mounts = declare(
    "mounts",
    (
        flow("the displays a mount-granting spell puts you on")
        .read("Mount", c.ID, c.Name_lang, c.SourceSpellID, c.Description_lang)
        .narrow(c.SourceSpellID, "names.names")
        .join(c.ID, "MountXDisplay", c.CreatureDisplayInfoID, by="MountID", many=True)
        >> as_rows(
            MountRow, c.ID, word(c.Name_lang), c.SourceSpellID, word(c.Description_lang), c.CreatureDisplayInfoID
        )
    ).then(MountData.assemble, creatures="creatures"),
)
