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

from operator import attrgetter

from ..drift import SPELL_NAME_SOURCES
from .anims import SPEED_UNIT
from .areas import UI_MAP_TYPE_ZONE, AreaGates, GateRow
from .columns import BASE_DIFFICULTY, to_float, to_int
from .delivery import CHANNEL_BITS, MOVING_BIT, DeliveryRow, assemble_delivery
from .factions import FactionTemplateRow
from .flow import (
    Read,
    as_ids,
    as_map,
    as_records,
    as_rows,
    as_sets,
    as_text,
    as_tree,
    c,
    flow,
    key_of,
    number_of,
    real,
    text,
    typed,
    values_of,
    word,
)
from .gameobjects import GameObjectData, GameObjectRow
from .interrupts import interrupt_bits
from .keybinds import KeyboundOverride, keybound_type_word
from .missiles import MissileMotion
from .mounts import MountData, MountRow
from .names import SpellNames, override_names
from .reach import REACH_FLAGS, YARD_DIGITS, Reach
from .route import declare
from .shapeshifts import FormRow, ShapeshiftForms
from .sounds import Ambience, ZoneMusic
from .spells import PropertiesRow, SpellProperties
from .text import assignments

BASE = c.DifficultyID == BASE_DIFFICULTY
"""The row a player sees, which stands for the spell wherever a table keeps a
row per difficulty."""

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


# The spell itself.

names = declare(
    "names",
    (
        flow("the spell list").first_of(*(Read(table, tuple(columns)) for table, columns in SPELL_NAME_SOURCES))
        >> as_map(c.ID, text(c.Name_lang))
    ).then(SpellNames.assemble, subtexts="spell_subtexts"),
)
"""Membership is the spell list: every route downstream filters against it."""

spell_subtexts = declare(
    "spell_subtexts",
    flow("the parenthetical rank or variant under a spell's name")
    .read("Spell", c.ID, c.NameSubtext_lang)
    .where(~c.NameSubtext_lang.is_empty())
    >> as_map(c.ID, text(c.NameSubtext_lang)),
)

alt_names = declare(
    "alt_names",
    (
        flow("the names a spell can rename its target to").read("SpellOverrideName", c.ID, c.OverrideName_lang)
        >> as_map(c.ID, text(c.OverrideName_lang))
    ).then(override_names, by_spell="effects.altnames"),
)

spell_icons = declare(
    "spell_icons",
    flow("each spell's icon, from the row that has one")
    .read("SpellMisc", c.SpellID, c.DifficultyID, c.SpellIconFileDataID)
    .narrow(c.SpellID, "names.names")
    .where(c.SpellIconFileDataID != 0)
    .prefer(c.SpellID, base=BASE)
    >> as_map(c.SpellID, c.SpellIconFileDataID),
)
"""An icon of zero never displaces one, so the icon is read apart from the
rest of the row, base row first among the rows that have one."""

props = declare(
    "props",
    (
        flow("what SpellMisc says about a spell")
        .read(
            "SpellMisc",
            c.SpellID,
            c.DifficultyID,
            c.SchoolMask,
            c.CastingTimeIndex,
            c.DurationIndex,
            c.RangeIndex,
            c.Speed,
            c.LaunchDelay,
            c.Attributes[:],
        )
        .narrow(c.SpellID, "names.names")
        .prefer(c.SpellID, base=BASE)
        >> as_rows(
            PropertiesRow,
            c.SpellID,
            c.SchoolMask,
            c.CastingTimeIndex,
            c.DurationIndex,
            c.RangeIndex,
            real(c.Speed),
            real(c.LaunchDelay),
            typed(c.Attributes[:], lambda cell: tuple(to_int(value) for value in values_of(cell))),
        )
    ).then(SpellProperties.assemble, icons="spell_icons"),
)

reach = declare(
    "reach",
    (
        flow("how far a spell reaches")
        .read("SpellMisc", c.SpellID, c.DifficultyID, c.RangeIndex)
        .narrow(c.SpellID, "names.names")
        .prefer(c.SpellID, base=BASE)
        .join(c.RangeIndex, "SpellRange", c.RangeMax_0, c.RangeMin_0, c.Flags, inner=True)
        >> as_rows(
            Reach,
            c.SpellID,
            typed(c.RangeMax_0, lambda cell: to_float(as_text(cell), YARD_DIGITS)),
            typed(c.RangeMin_0, lambda cell: to_float(as_text(cell), YARD_DIGITS)),
            typed(c.Flags, lambda cell: key_of(cell) & REACH_FLAGS),
            sort=attrgetter("spell"),
        )
    ).then(lambda bands: [band for band in bands if band.max_yards > 0]),
)
"""A spell reaching no further than its caster is left out, which makes self
the complement worked out at load."""

channel_breaks = declare(
    "channel_breaks",
    flow("the channels that movement cancels")
    .read("SpellInterrupts", c.SpellID, c.DifficultyID, c.ChannelInterruptFlags[:], optional=True)
    .narrow(c.SpellID, "names.names")
    .prefer(c.SpellID, base=BASE)
    .where(c.ChannelInterruptFlags[:].bit(MOVING_BIT))
    >> as_ids(c.SpellID),
)
"""The channel column, so the channel enum rather than the cast one."""

delivery = declare(
    "delivery",
    (
        flow("how a spell is delivered: a cast time, a channel, or both")
        .read("SpellMisc", c.SpellID, c.DifficultyID, c.CastingTimeIndex, c.DurationIndex, c.Attributes[:])
        .narrow(c.SpellID, "names.names")
        .prefer(c.SpellID, base=BASE)
        .join(c.CastingTimeIndex, "SpellCastTimes", c.Base)
        .join(c.DurationIndex, "SpellDuration", c.Duration)
        .map("channelled", c.Attributes[:].bit(CHANNEL_BITS[0]) | c.Attributes[:].bit(CHANNEL_BITS[1]))
        >> as_rows(
            DeliveryRow,
            c.SpellID,
            c.Base,
            typed(c.Duration, lambda cell: None if cell == "" else key_of(cell)),
            typed(c.channelled, lambda cell: cell == "1"),
        )
    ).then(assemble_delivery, breaks="channel_breaks"),
)

aura_interrupts = declare(
    "aura_interrupts",
    (
        flow("what removes a spell's aura")
        .read("SpellInterrupts", c.SpellID, c.DifficultyID, c.AuraInterruptFlags[:], optional=True)
        .narrow(c.SpellID, "names.names")
        .prefer(c.SpellID, base=BASE)
        >> as_map(c.SpellID, typed(c.AuraInterruptFlags[:], interrupt_bits))
    ).then(lambda found: {spell: bits for spell, bits in found.items() if bits}),
)
"""A spell carrying only housekeeping bits is absent rather than empty."""

# The prose.

spell_descriptions = declare(
    "spell_descriptions",
    flow("what the tooltip says the cast does")
    .read("Spell", c.ID, c.Description_lang)
    .where(~c.Description_lang.is_empty())
    >> as_map(c.ID, text(c.Description_lang)),
)
"""Unfiltered against the spell list: a template routinely redirects to a
spell that has no name row of its own."""

spell_aura_texts = declare(
    "spell_aura_texts",
    flow("what the buff says while it is on you")
    .read("Spell", c.ID, c.AuraDescription_lang)
    .where(~c.AuraDescription_lang.is_empty())
    >> as_map(c.ID, text(c.AuraDescription_lang)),
)

spell_variables = declare(
    "spell_variables",
    (
        flow("the named variable bodies a description may interpolate")
        .read("SpellXDescriptionVariables", c.SpellID, c.SpellDescriptionVariablesID)
        .join(c.SpellDescriptionVariablesID, "SpellDescriptionVariables", c.Variables, inner=True)
        >> as_map(c.SpellID, typed(c.Variables, assignments))
    ).then(lambda bodies: {spell: body for spell, body in bodies.items() if body}),
)

# Where a spell may be cast.

area_parents = declare(
    "area_parents",
    flow("each area's parent").read("AreaTable", c.ID, c.ParentAreaID) >> as_map(c.ID, c.ParentAreaID),
)

areas = declare(
    "areas",
    (
        flow("where a spell may be cast")
        .read("SpellCastingRequirements", c.SpellID, c.RequiredAreasID)
        .where(c.RequiredAreasID != 0)
        .join(c.RequiredAreasID, "AreaGroupMember", c.AreaID, by="AreaGroupID", inner=True, many=True)
        .join(c.AreaID, "AreaTable", c.AreaName_lang, inner=True)
        >> as_rows(GateRow, c.SpellID, c.AreaID, text(c.AreaName_lang))
    ).then(AreaGates.assemble, parents="area_parents", maps="zone_maps"),
)
"""A group naming an area the build has no row for is skipped rather than
shipped nameless."""

zone_maps = flow("each area's zone map, where one names the same place the area does").read(
    "UiMapAssignment", c.AreaID, c.UiMapID
).join(c.UiMapID, "UiMap", c.Name_lang, c.Type, inner=True).join(
    c.AreaID, "AreaTable", c.AreaName_lang, inner=True
).where((c.Type == UI_MAP_TYPE_ZONE) & (c.Name_lang == c.AreaName_lang)) >> as_map(c.AreaID, c.UiMapID, reduce=min)
"""A given rather than a field: read once in the build's own language and
shared by every other, because the match is between two translated names
and its result must be one fact about the build. Both filters are
load-bearing: type alone reaches continent maps, assignment alone reaches a
neighbour's map."""
