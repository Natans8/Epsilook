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

from operator import attrgetter, or_

from ..drift import RETIRED_SPAWN_OBJECT_EFFECTS, SPAWN_OBJECT_SLOTS_UNTIL, SPELL_NAME_SOURCES
from ..targets import NO_TARGET, VISUAL_REDIRECTS
from .anims import SPEED_UNIT
from .areas import UI_MAP_TYPE_ZONE, AreaGates, GateRow
from .colors import channel, rgb_of
from .columns import BASE_DIFFICULTY, to_float, to_int
from .creatures import CreatureModels
from .delivery import CHANNEL_BITS, MOVING_BIT, DeliveryRow, assemble_delivery
from .effects import (
    AMOUNT,
    AURA_ANIM_REPLACEMENT_SET,
    AURA_KEYBOUND_OVERRIDE,
    AURA_MOD_FACTION,
    AURA_MOD_INVISIBILITY,
    AURA_MOD_INVISIBILITY_DETECT,
    AURA_OVERRIDE_NAME,
    AURA_SCREEN_EFFECT,
    AURA_SET_VEHICLE_ID,
    AURA_SHAPESHIFT,
    AURA_TRANSFORM,
    EFFECT_APPLY_AURA,
    EFFECT_PLAYS_SOUND,
    EFFECT_SPAWN_OBJECT,
    EFFECT_SUMMON,
    MISC0,
    MISC1,
    SCALE_AURAS,
    SPEED_AURAS,
    EffectRow,
    SpellEffectRows,
    as_masked,
    tenth,
)
from .factions import FactionTemplateRow
from .flow import (
    amount,
    as_ids,
    as_lists,
    as_map,
    as_nested,
    as_records,
    as_rows,
    as_sets,
    as_text,
    as_tree,
    bits_of,
    c,
    coalesce,
    compose,
    first_available,
    flag,
    flow,
    ids_of,
    key_of,
    landing,
    nonzero,
    number_of,
    ordered,
    real,
    reference,
    text,
    typed,
    values_of,
    vocabulary,
    when,
    word,
)
from .fx import (
    Beam,
    ChainEffect,
    Dissolve,
    FxPayloads,
    ScreenRow,
    Shadowy,
    grade,
    positive,
    seconds,
    thousandths,
    visible_wave,
    yards,
)
from .gameobjects import GameObjectData, GameObjectRow
from .interrupts import interrupt_bits
from .items import ItemModels, ItemName
from .keybinds import KeyboundOverride, keybound_type_word
from .kits import (
    EFFECT_TYPE_ANIM,
    EFFECT_TYPE_BARRAGE,
    EFFECT_TYPE_BEAM,
    EFFECT_TYPE_DISSOLVE,
    EFFECT_TYPE_EDGE_GLOW,
    EFFECT_TYPE_EMISSION,
    EFFECT_TYPE_PROC,
    EFFECT_TYPE_SCREEN,
    EFFECT_TYPE_SHADOWY,
    EFFECT_TYPE_SOUND,
    KitEffects,
)
from .missiles import MissileMotion, MissileRow, assemble_missiles
from .models import (
    PLACEMENT_COLUMNS,
    SCALE_UNIT,
    AttachRow,
    EffectName,
    KitAttachments,
    barrage_model,
    ground_model,
    trail_model,
    without_placeholders,
)
from .mounts import MountData, MountRow
from .names import SpellNames, override_names
from .procedures import (
    PROC_TYPE_AREAMODEL,
    PROC_TYPE_CAMO,
    PROC_TYPE_DESATURATE,
    PROC_TYPE_FREEZE,
    PROC_TYPE_GHOST_MAT,
    PROC_TYPE_STANDWALK,
    PROC_TYPE_TINT,
    PROC_TYPE_TINT_MAT,
    PROC_TYPE_TRANSPARENCY,
    PROC_TYPE_WEAPONTRAIL,
    PROC_TYPES_CHAIN,
    ProcEffects,
    percent,
    standwalk,
    tint,
)
from .reach import REACH_FLAGS, YARD_DIGITS, Reach
from .route import declare
from .shapeshifts import FormRow, ShapeshiftForms
from .sounds import Ambience, ZoneMusic
from .spells import PropertiesRow, SpellProperties
from .text import assignments
from .values import DescriptionValues, EffectValues, PointRow, effect_number, resolve_points
from .vehicles import SEAT_COLUMNS, Seat, VehicleSeats
from .visuals import KitEvent, VisualGraph, target_bit

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


# The creature chain, and the items: what a display and an item resolve to.

creature_names = declare(
    "creature_names",
    flow("what the server calls each creature").read("creature_template", c.entry, c.name, source="world")
    >> as_map(c.entry, word(c.name)),
)

creature_displays = declare(
    "creature_displays",
    first_available(
        flow("the displays a creature wears, by slot").read(
            "creature_template_model", c.CreatureID, c.Idx, c.CreatureDisplayID, source="world"
        )
        >> as_sets(c.CreatureID, c.Idx, c.CreatureDisplayID),
        flow("the same in the legacy shape, where the column is the slot")
        .read("creature_template", c.entry, c.modelid1, c.modelid2, c.modelid3, c.modelid4, source="world")
        .explode(c.modelid1, c.modelid2, c.modelid3, c.modelid4, into="display", slot="slot")
        >> as_sets(c.entry, c.slot, c.display),
    ).then(ordered),
)
"""Whichever shape the release has wins; a display named in two slots is two
rows, since the first slot is the one the pill shows."""

display_models = declare(
    "display_models",
    flow("the model each creature display wears").read("CreatureDisplayInfo", c.ID, c.ModelID)
    >> as_map(c.ID, c.ModelID),
)

display_skins = declare(
    "display_skins",
    (
        flow("the textures a display paints its model with").read(
            "CreatureDisplayInfo", c.ID, c.TextureVariationFileDataID[:]
        )
        >> as_map(c.ID, typed(c.TextureVariationFileDataID[:], ids_of))
    ).then(nonzero),
)
"""As many slots as the build has, in slot order; a display painting nothing
is absent rather than empty."""

creature_model_files = declare(
    "creature_model_files",
    flow("each creature model's file").read("CreatureModelData", c.ID, c.FileDataID) >> as_map(c.ID, c.FileDataID),
)

totem_displays = declare(
    "totem_displays",
    (
        flow("the displays a totem wears, one per caster race")
        .read("spell_totem_model", c.SpellID, c.DisplayID, source="world", optional=True)
        .where(c.DisplayID != 0)
        >> as_sets(c.SpellID, c.DisplayID)
    ).then(ordered),
)
"""Two races sharing a model is one display, in display order, since no race
travels with it."""

creatures = declare(
    "creatures",
    compose(
        CreatureModels,
        names="creature_names",
        displays="creature_displays",
        display_model="display_models",
        model_fid="creature_model_files",
        totem_displays="totem_displays",
        display_skins="display_skins",
    ),
)

item_names = declare(
    "item_names",
    flow("the items a visual holds up, by name and quality")
    .read("ItemSearchName", c.ID, c.Display_lang, c.OverallQualityID)
    .where(~c.Display_lang.is_empty())
    >> as_records(c.ID, ItemName, text(c.Display_lang), c.OverallQualityID),
)

model_files = declare(
    "model_files",
    flow("the base file of each model resource")
    .read("ModelFileData", c.FileDataID, c.ModelResourcesID)
    .where((c.FileDataID != 0) & (c.ModelResourcesID != 0))
    >> as_map(c.ModelResourcesID, c.FileDataID, reduce=min),
)
"""A model shipping with levels of detail names several files, and the lowest
is the base model."""

looks = (
    flow("each item's appearances, the base look first")
    .read("ItemModifiedAppearance", c.ItemID, c.ItemAppearanceID)
    .where(c.ItemID != 0)
    .join(c.ItemAppearanceID, "ItemAppearance", c.ItemDisplayInfoID, c.DefaultIconFileDataID, inner=True)
)

item_icons = declare(
    "item_icons", looks.where(c.DefaultIconFileDataID != 0) >> as_map(c.ItemID, c.DefaultIconFileDataID, first=True)
)

item_models = declare(
    "item_models",
    (
        looks.join(c.ItemDisplayInfoID, "ItemDisplayInfo", c.ModelResourcesID[:])
        .explode(c.ModelResourcesID[:], into="resource")
        .narrow(c.resource, "model_files")
        >> as_map(c.ItemID, c.resource, first=True)
    ).then(lambda held, files: {item: files[resource] for item, resource in held.items()}, files="model_files"),
)
"""The first appearance whose display reaches a file, and its first slot that
does: a paired item carries its second component in the second slot."""

items = declare("items", compose(ItemModels, names="item_names", icons="item_icons", models="item_models"))


# The models: every table that ends in a model file.

effect_names = declare(
    "effect_names",
    (
        flow("what each effect name reaches: a file, an item, a display or a weapon slot").read(
            "SpellVisualEffectName", c.ID, c.ModelFileDataID, c.Type, c.GenericID, c.Scale
        )
        >> as_records(
            c.ID,
            EffectName,
            c.ModelFileDataID,
            c.Type,
            c.GenericID,
            typed(c.Scale, lambda cell: round(number_of(cell) * SCALE_UNIT)),
        )
    ).then(without_placeholders, named="named"),
)

attachments = declare(
    "attachments",
    (
        flow("the models a kit hangs on a unit, and where")
        .read(
            "SpellVisualKitModelAttach",
            c.ParentSpellVisualKitID,
            c.SpellVisualEffectNameID,
            c.AttachmentID,
            *PLACEMENT_COLUMNS,
        )
        .where(c.ParentSpellVisualKitID != 0)
        >> as_rows(
            AttachRow.of,
            c.ParentSpellVisualKitID,
            c.SpellVisualEffectNameID,
            c.AttachmentID,
            *(text(column) for column in PLACEMENT_COLUMNS),
        )
    ).then(KitAttachments.assemble, names="effect_names", creatures="creatures", items="items"),
)

area_models = declare(
    "area_models",
    flow("the ground models").read("SpellVisualKitAreaModel", c.ID, c.ModelFileDataID)
    >> as_map(c.ID, c.ModelFileDataID),
)

emissions = declare(
    "emissions",
    flow("the ground model an emitter spawns copies of")
    .read("SpellEffectEmission", c.ID, c.AreaModelID)
    .join(c.AreaModelID, "SpellVisualKitAreaModel", c.ModelFileDataID, inner=True)
    .where(c.ModelFileDataID != 0)
    >> as_map(c.ID, typed(c.ModelFileDataID, ground_model)),
)

barrages = declare(
    "barrages",
    flow("the model a volley is made of, and where on the caster it spawns")
    .read("BarrageEffect", c.ID, c.SpellVisualEffectNameID, c.AttachmentPoint)
    .join(c.SpellVisualEffectNameID, "SpellVisualEffectName", c.ModelFileDataID, inner=True)
    .where(c.ModelFileDataID != 0)
    >> as_records(c.ID, barrage_model, c.ModelFileDataID, c.AttachmentPoint),
)

weapon_trails = declare(
    "weapon_trails", flow("the trail models").read("WeaponTrail", c.ID, c.FileDataID) >> as_map(c.ID, c.FileDataID)
)

missiles = declare(
    "missiles",
    (
        flow("the projectiles a visual launches, from its base set and its raid set")
        .read(
            "SpellVisual",
            c.ID,
            c.SpellVisualMissileSetID,
            c.RaidSpellVisualMissileSetID,
            c.MissileAttachment,
            c.MissileDestinationAttachment,
        )
        .explode(c.SpellVisualMissileSetID, c.RaidSpellVisualMissileSetID, into="set")
        .join(
            c.set,
            "SpellVisualMissile",
            c.SpellVisualEffectNameID,
            c.SoundEntriesID,
            c.AnimKitID,
            c.SpellMissileMotionID,
            c.Attachment,
            c.DestinationAttachment,
            by="SpellVisualMissileSetID",
            inner=True,
            many=True,
        )
        >> as_rows(
            MissileRow,
            c.ID,
            c.SpellVisualEffectNameID,
            c.SoundEntriesID,
            c.AnimKitID,
            c.SpellMissileMotionID,
            c.Attachment,
            c.DestinationAttachment,
            c.MissileAttachment,
            c.MissileDestinationAttachment,
        )
    ).then(assemble_missiles, names="effect_names"),
)


# The fx payloads: six unrelated tables a kit reaches by effect type.

chains = declare(
    "chains",
    flow("what a beam segment draws with").read(
        "SpellChainEffects",
        c.ID,
        c.Red,
        c.Green,
        c.Blue,
        c.SoundKitID,
        c.ArcHeight,
        c.MaxFlickerOnDuration,
        c.JointOffsetRadius,
        c.WaveHeight,
        c.StartWidth,
        c.TextureFileDataID[:],
        c.SpellChainEffectID[:],
    )
    >> as_records(
        c.ID,
        ChainEffect,
        c.Red,
        c.Green,
        c.Blue,
        c.SoundKitID,
        typed(c.TextureFileDataID[:], ids_of),
        typed(c.SpellChainEffectID[:], ids_of),
        typed(c.ArcHeight, positive),
        typed(c.MaxFlickerOnDuration, positive),
        typed(c.JointOffsetRadius, positive),
        typed(c.WaveHeight, visible_wave),
        typed(c.StartWidth, yards),
    ),
)
"""Chains nest: a composite chain names up to eleven others. The flicker and
wave columns are tuning read as traits, and the geometry is dropped."""

beams = declare(
    "beams",
    flow("the chain a beam draws, and its two ends").read(
        "BeamEffect", c.ID, c.BeamID, c.SourceAttachID, c.DestAttachID
    )
    >> as_records(c.ID, Beam, c.BeamID, c.SourceAttachID, c.DestAttachID),
)

dissolves = declare(
    "dissolves",
    flow("the dissolve materials")
    .read("DissolveEffect", c.ID, c.TextureBlendSetID, c.Duration, c.AttachID)
    .join(c.TextureBlendSetID, "TextureBlendSet", c.TextureFileDataID[:])
    >> as_records(c.ID, Dissolve, typed(c.Duration, seconds), typed(c.TextureFileDataID[:], ids_of), c.AttachID),
)

glows = declare(
    "glows",
    flow("the colour an edge glow paints").read("EdgeGlowEffect", c.ID, c.GlowRed, c.GlowGreen, c.GlowBlue)
    >> as_records(
        c.ID,
        lambda red, green, blue: (red << 16) | (green << 8) | blue,
        typed(c.GlowRed, channel),
        typed(c.GlowGreen, channel),
        typed(c.GlowBlue, channel),
    ),
)
"""The colour is the whole visible payload; the multiplier, fade and fresnel
columns are tuning."""

glow_alphas = declare(
    "glow_alphas",
    flow("how opaque an edge glow is").read("EdgeGlowEffect", c.ID, c.GlowAlpha)
    >> as_map(c.ID, typed(c.GlowAlpha, channel)),
)

shadowies = declare(
    "shadowies",
    flow("the two colours of a ghost effect, and where it anchors").read(
        "ShadowyEffect", c.ID, c.PrimaryColor, c.SecondaryColor, c.AttachPos
    )
    >> as_records(c.ID, Shadowy, typed(c.PrimaryColor, rgb_of), typed(c.SecondaryColor, rgb_of), c.AttachPos),
)

screens = declare(
    "screens",
    flow("what a screen effect does to the frame, the sky, the sound and the hour")
    .read(
        "ScreenEffect",
        c.ID,
        c.Name,
        c.Param_0,
        c.Effect,
        c.FullScreenEffectID,
        c.LightParamsID,
        c.LightParamsFadeIn,
        c.LightParamsFadeOut,
        c.SoundAmbienceID,
        c.ZoneMusicID,
        c.TimeOfDayOverride,
    )
    .join(
        c.FullScreenEffectID,
        "FullScreenEffect",
        c.ColorMultiplyRed,
        c.ColorMultiplyGreen,
        c.ColorMultiplyBlue,
        c.ColorAdditionRed,
        c.ColorAdditionGreen,
        c.ColorAdditionBlue,
        c.OverlayTextureFileDataID,
        c.TextureBlendSetID,
        c.MaskOffsetY,
        c.MaskSizeMultiplier,
        c.MaskPower,
    )
    .join(c.TextureBlendSetID, "TextureBlendSet", c.TextureFileDataID[:])
    >> as_records(
        c.ID,
        ScreenRow.of,
        text(c.Name),
        c.Param_0,
        c.Effect,
        typed(c.ColorMultiplyRed, grade),
        typed(c.ColorMultiplyGreen, grade),
        typed(c.ColorMultiplyBlue, grade),
        typed(c.ColorAdditionRed, grade),
        typed(c.ColorAdditionGreen, grade),
        typed(c.ColorAdditionBlue, grade),
        c.OverlayTextureFileDataID,
        typed(c.TextureFileDataID[:], ids_of),
        typed(c.MaskOffsetY, thousandths),
        typed(c.MaskSizeMultiplier, thousandths),
        typed(c.MaskPower, thousandths),
        c.LightParamsID,
        c.LightParamsFadeIn,
        c.LightParamsFadeOut,
        c.SoundAmbienceID,
        c.ZoneMusicID,
        c.TimeOfDayOverride,
    ),
)

visual_screens = declare(
    "visual_screens",
    flow("the kit's route into a screen effect").read("SpellVisualScreenEffect", c.ID, c.ScreenEffectID)
    >> as_map(c.ID, c.ScreenEffectID),
)

fx = declare("fx", compose(FxPayloads))


# The character procedures: one table, many meanings, chosen by its Type.

procedures = flow("the character procedures").read(
    "SpellProceduralEffect", c.ID, c.Type, c.Value_0, c.Value_1, c.Value_2, c.Value_3
)

proc_chains = declare("proc_chains", procedures.where(c.Type.among(PROC_TYPES_CHAIN)) >> as_map(c.ID, c.Value_0))

proc_tints = declare(
    "proc_tints",
    procedures.where(c.Type.among((PROC_TYPE_TINT, PROC_TYPE_TINT_MAT)))
    >> as_records(c.ID, tint, c.Type, c.Value_0, c.Value_3),
)
"""The payload column differs per Type, and a colourless tint folds in as black."""

proc_ghosts = declare(
    "proc_ghosts",
    procedures.where((c.Type == PROC_TYPE_GHOST_MAT) & (c.Value_3 != 0)) >> as_map(c.ID, typed(c.Value_3, rgb_of)),
)
"""A colourless ghost has nothing to show and is dropped."""

proc_desats = declare(
    "proc_desats",
    (procedures.where(c.Type == PROC_TYPE_DESATURATE) >> as_map(c.ID, typed(c.Value_2, percent))).then(nonzero),
)

proc_transps = declare(
    "proc_transps",
    (procedures.where(c.Type == PROC_TYPE_TRANSPARENCY) >> as_map(c.ID, typed(c.Value_0, percent))).then(nonzero),
)
"""A percentage of zero would render as a claim that something happened."""

proc_freezes = declare("proc_freezes", procedures.where(c.Type == PROC_TYPE_FREEZE) >> as_ids(c.ID))

proc_camos = declare("proc_camos", procedures.where(c.Type == PROC_TYPE_CAMO) >> as_ids(c.ID))

proc_ground = declare(
    "proc_ground",
    procedures.where(c.Type == PROC_TYPE_AREAMODEL)
    .join(c.Value_0, "SpellVisualKitAreaModel", c.ModelFileDataID, inner=True)
    .where(c.ModelFileDataID != 0)
    >> as_map(c.ID, typed(c.ModelFileDataID, ground_model)),
)

proc_trails = declare(
    "proc_trails",
    procedures.where(c.Type == PROC_TYPE_WEAPONTRAIL)
    .join(c.Value_0, "WeaponTrail", c.FileDataID, inner=True)
    .where(c.FileDataID != 0)
    >> as_map(c.ID, typed(c.FileDataID, trail_model)),
)

proc_anims = declare(
    "proc_anims",
    (
        procedures.where(c.Type == PROC_TYPE_STANDWALK) >> as_records(c.ID, standwalk, c.Value_0, c.Value_1, c.Value_2)
    ).then(nonzero),
)

procs = declare(
    "procs",
    compose(
        ProcEffects,
        chains="proc_chains",
        tints="proc_tints",
        ghost_mats="proc_ghosts",
        desats="proc_desats",
        transps="proc_transps",
        freezes="proc_freezes",
        camos="proc_camos",
        ground="proc_ground",
        trails="proc_trails",
        anims="proc_anims",
    ),
)


# The kit dispatch: one row says which effect of which type a kit plays, and
# the type decides which table the effect is an id in.

kit_effects = (
    flow("what a kit's effect rows reach, by type")
    .read("SpellVisualKitEffect", c.ParentSpellVisualKitID, c.EffectType, c.Effect)
    .where((c.ParentSpellVisualKitID != 0) & (c.Effect != 0))
)

kit_sounds = declare(
    "kit_sounds", kit_effects.where(c.EffectType == EFFECT_TYPE_SOUND) >> as_sets(c.ParentSpellVisualKitID, c.Effect)
)

kit_anim_rows = kit_effects.where(c.EffectType == EFFECT_TYPE_ANIM).join(
    c.Effect, "SpellVisualAnim", c.InitialAnimID, c.LoopAnimID, c.AnimKitID
)

kit_visual_anims = declare(
    "kit_visual_anims",
    kit_anim_rows.explode(c.InitialAnimID, c.LoopAnimID, into="anim").where(c.anim > 0)
    >> as_sets(c.ParentSpellVisualKitID, c.anim),
)
"""Nought would be Stand and minus one is unset, so neither is played."""

kit_animkits = declare(
    "kit_animkits", kit_anim_rows.where(c.AnimKitID != 0) >> as_sets(c.ParentSpellVisualKitID, c.AnimKitID)
)

kit_dissolves = declare(
    "kit_dissolves",
    kit_effects.where(c.EffectType == EFFECT_TYPE_DISSOLVE).narrow(c.Effect, "dissolves")
    >> as_sets(c.ParentSpellVisualKitID, c.Effect),
)

kit_glows = declare(
    "kit_glows",
    kit_effects.where(c.EffectType == EFFECT_TYPE_EDGE_GLOW).narrow(c.Effect, "glows")
    >> as_sets(c.ParentSpellVisualKitID, c.Effect),
)

kit_shadowies = declare(
    "kit_shadowies",
    kit_effects.where(c.EffectType == EFFECT_TYPE_SHADOWY).narrow(c.Effect, "shadowies")
    >> as_sets(c.ParentSpellVisualKitID, c.Effect),
)
"""A row pointing at a payload this build lacks is dropped rather than an error."""

kit_screens = declare(
    "kit_screens",
    kit_effects.where(c.EffectType == EFFECT_TYPE_SCREEN)
    .join(c.Effect, "SpellVisualScreenEffect", c.ScreenEffectID, inner=True)
    .narrow(c.ScreenEffectID, "screens")
    >> as_sets(c.ParentSpellVisualKitID, c.ScreenEffectID),
)

kit_emissions = declare(
    "kit_emissions",
    kit_effects.where(c.EffectType == EFFECT_TYPE_EMISSION).narrow(c.Effect, "emissions")
    >> as_sets(c.ParentSpellVisualKitID, c.Effect),
)

kit_barrages = declare(
    "kit_barrages",
    kit_effects.where(c.EffectType == EFFECT_TYPE_BARRAGE).narrow(c.Effect, "barrages")
    >> as_sets(c.ParentSpellVisualKitID, c.Effect),
)

kit_beams = declare(
    "kit_beams",
    kit_effects.where(c.EffectType == EFFECT_TYPE_BEAM)
    .join(c.Effect, "BeamEffect", c.BeamID, c.SourceAttachID, c.DestAttachID, inner=True)
    .expand(c.BeamID, "SpellChainEffects", {"SpellChainEffectID_*": 0}, into="chain", bits="hops")
    .narrow(c.chain, "chains")
    >> as_sets(c.ParentSpellVisualKitID, c.chain, c.SourceAttachID, c.DestAttachID),
)
"""A beam's chains and every chain those nest, each tagged with the beam's two
ends: nested chains are segments of the same beam. The graph may cycle."""

kit_procedures = declare(
    "kit_procedures", kit_effects.where(c.EffectType == EFFECT_TYPE_PROC) >> as_sets(c.ParentSpellVisualKitID, c.Effect)
)
"""Dispatched a second time, by membership in the procedure route's buckets."""

kit_proc_chains = declare(
    "kit_proc_chains",
    kit_effects.where(c.EffectType == EFFECT_TYPE_PROC)
    .lookup(c.Effect, "proc_chains", into="seed")
    .expand(c.seed, "SpellChainEffects", {"SpellChainEffectID_*": 0}, into="chain", bits="hops")
    .narrow(c.chain, "chains")
    >> as_sets(c.ParentSpellVisualKitID, c.chain),
)
"""A procedure-route chain has no beam row, so it carries no attachment pair."""

kits = declare("kits", compose(KitEffects.assemble))


# The spine: spell to visual to kit, each hop carrying who the content plays for.

spell_visuals = declare(
    "spell_visuals",
    flow("the visuals a spell reaches, its redirects followed")
    .read("SpellXSpellVisual", c.SpellID, c.SpellVisualID)
    .where((c.SpellID != 0) & (c.SpellVisualID != 0))
    .expand(c.SpellVisualID, "SpellVisual", VISUAL_REDIRECTS, into="visual", bits="reached")
    >> as_nested(c.SpellID, c.visual, c.reached, reduce=or_),
)
"""A visual reached straight from the spell carries no extra bits; one reached
through a redirect carries the bits of the columns the path went through, and
a visual reached two ways carries both. The graph may cycle."""

visual_events = declare(
    "visual_events",
    flow("what a visual plays, when, and for whom")
    .read("SpellVisualEvent", c.SpellVisualID, c.SpellVisualKitID, c.TargetType, c.StartEvent)
    .where((c.SpellVisualID != 0) & (c.SpellVisualKitID != 0))
    >> as_lists(c.SpellVisualID, c.SpellVisualKitID, c.StartEvent, typed(c.TargetType, target_bit), record=KitEvent),
)
"""Distinct, in table order, and kept per event rather than folded per kit:
the phase is what the pack ships."""

visual_sounds = declare(
    "visual_sounds",
    flow("the sound a visual's own animation events play")
    .read("SpellVisual", c.ID, c.AnimEventSoundID)
    .where(c.AnimEventSoundID != 0)
    >> as_map(c.ID, c.AnimEventSoundID),
)

graph = declare("graph", compose(VisualGraph))


# The vehicles.

seats = declare(
    "seats",
    flow("each seat's attachment and what the rider and the vehicle animate").read(
        "VehicleSeat", c.ID, c.AttachmentID, *SEAT_COLUMNS
    )
    >> as_records(c.ID, Seat.of, c.AttachmentID, *SEAT_COLUMNS),
)

vehicles = declare(
    "vehicles",
    (
        flow("each vehicle's seats, by slot").read("Vehicle", c.ID, c.SeatID[:])
        >> as_map(c.ID, typed(c.SeatID[:], lambda cell: [seat for seat in map(key_of, values_of(cell)) if seat > 0]))
    ).then(VehicleSeats.assemble, seats="seats"),
)
"""Empty slots are dropped, so the list length is the seat count, and a seat
the build has no row for keeps its slot and loses its name."""


# The spell itself.

names = declare(
    "names",
    first_available(
        *(
            flow("the spell list").read(table, *columns) >> as_map(c.ID, text(c.Name_lang))
            for table, columns in SPELL_NAME_SOURCES
        )
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
    ).then(nonzero),
)
"""A spell carrying only housekeeping bits is absent rather than empty."""

# The effects: one read of SpellEffect, each row split into the payloads it
# feeds. A selector column and a value choose a meaning, and the slots say
# what the row's other columns then hold: a reference into a table, a value
# a vocabulary names, a number. The shipped selector table is read off these.

summon_controls = declare(
    "summon_controls",
    flow("how a summoned creature is controlled").read("SummonProperties", c.ID, c.Control) >> as_map(c.ID, c.Control),
)

effect_rows = (
    flow("a spell's effects, and who each is aimed at")
    .read(
        "SpellEffect",
        c.SpellID,
        c.Effect,
        c.EffectAura,
        c.EffectMiscValue_0,
        c.EffectMiscValue_1,
        c.ImplicitTarget_0,
        c.ImplicitTarget_1,
        c.EffectBasePoints,
        c.EffectBasePointsF,
        c.EffectTriggerSpell,
        c.EffectIndex,
        c.EffectAuraPeriod,
        c.EffectChainTargets,
        c.EffectAttributes,
    )
    .narrow(c.SpellID, "names.names")
    .lookup(c.ImplicitTarget_0, "target_bits", into="bit_a", default=NO_TARGET)
    .lookup(c.ImplicitTarget_1, "target_bits", into="bit_b", default=NO_TARGET)
    .map("mask", bits_of(c.bit_a, c.bit_b))
    .map("amount", coalesce(c.EffectBasePoints, c.EffectBasePointsF, digits=1))
)
"""The mask is the union of the row's two implicit targets; an implicit target
the build does not name contributes nothing. The amount is whichever of the two
spellings this build exports."""

masked = as_masked(c.SpellID, MISC0, c.mask)
"""Where a payload of one reference lands: the ids per spell, each pair masked."""

effects = declare(
    "effects",
    effect_rows.split(
        SpellEffectRows,
        morphs=flow("morphs").when("EffectAura", AURA_TRANSFORM, [reference(MISC0, "creature_template")]) >> masked,
        forms=flow("forms").when("EffectAura", AURA_SHAPESHIFT, [reference(MISC0, "SpellShapeshiftForm")]) >> masked,
        vehicles=flow("vehicles").when("EffectAura", AURA_SET_VEHICLE_ID, [reference(MISC0, "Vehicle")]) >> masked,
        invis=flow("invis").when(
            "EffectAura", AURA_MOD_INVISIBILITY, [vocabulary(MISC0, "channels", zero_is_a_value=True)]
        )
        >> masked,
        detect=flow("detect").when(
            "EffectAura", AURA_MOD_INVISIBILITY_DETECT, [vocabulary(MISC0, "channels", zero_is_a_value=True)]
        )
        >> masked,
        screens=flow("screens")
        .when("EffectAura", AURA_SCREEN_EFFECT, [reference(MISC0, "ScreenEffect")])
        .narrow(MISC0, "screens")
        >> masked,
        keybinds=flow("keybinds")
        .when("EffectAura", AURA_KEYBOUND_OVERRIDE, [reference(MISC0, "SpellKeyboundOverride")])
        .narrow(MISC0, "keybinds")
        >> masked,
        altnames=flow("altnames").when("EffectAura", AURA_OVERRIDE_NAME, [reference(MISC0, "SpellOverrideName")])
        >> as_sets(c.SpellID, MISC0),
        anim_sets=flow("anim sets").when(
            "EffectAura", AURA_ANIM_REPLACEMENT_SET, [reference(MISC0, "AnimReplacementSet")]
        )
        >> masked,
        factions=flow("factions").when("EffectAura", AURA_MOD_FACTION, [reference(MISC0, "FactionTemplate")]) >> masked,
        objects=flow("objects").any_of(
            when("Effect", sorted(EFFECT_SPAWN_OBJECT), [reference(MISC0, "gameobject_template")]),
            when(
                "Effect",
                sorted(RETIRED_SPAWN_OBJECT_EFFECTS),
                [reference(MISC0, "gameobject_template")],
                until=SPAWN_OBJECT_SLOTS_UNTIL,
            ),
        )
        >> masked,
        summons=flow("summons")
        .when(
            "Effect",
            EFFECT_SUMMON,
            [reference(MISC0, "creature_template"), reference(MISC1, "SummonProperties", zero_is_a_value=True)],
        )
        .lookup(MISC1, "summon_controls", into="control", default=0)
        >> as_sets(c.SpellID, MISC0, c.control),
        summon_targets=flow("summon targets").when(
            "Effect",
            EFFECT_SUMMON,
            [reference(MISC0, "creature_template"), reference(MISC1, "SummonProperties", zero_is_a_value=True)],
        )
        >> as_map((c.SpellID, MISC0), c.mask, reduce=or_),
        sounds=flow("sounds").when("Effect", sorted(EFFECT_PLAYS_SOUND), [reference(MISC0, "SoundKit")])
        >> as_map((c.SpellID, MISC0), c.mask, reduce=or_),
        speeds=flow("speeds")
        .when("EffectAura", sorted(SPEED_AURAS), [amount(AMOUNT)])
        .where(c.amount != 0)
        .lookup(c.EffectAura, SPEED_AURAS, into="movement")
        >> as_sets(c.SpellID, text(c.movement), real(c.amount)),
        speed_targets=flow("speed targets")
        .when("EffectAura", sorted(SPEED_AURAS), [amount(AMOUNT)])
        .where(c.amount != 0)
        .lookup(c.EffectAura, SPEED_AURAS, into="movement")
        >> as_map((c.SpellID, text(c.movement), real(c.amount)), c.mask, reduce=or_),
        scales=flow("scales").when("EffectAura", sorted(SCALE_AURAS), [amount(AMOUNT)]).where(c.amount != 0)
        >> as_sets(c.SpellID, real(c.amount)),
        scale_targets=flow("scale targets")
        .when("EffectAura", sorted(SCALE_AURAS), [amount(AMOUNT)])
        .where(c.amount != 0)
        >> as_map((c.SpellID, real(c.amount)), c.mask, reduce=or_),
        links=flow("links")
        .where((c.EffectTriggerSpell != 0) & (c.EffectTriggerSpell != c.SpellID))
        .narrow(c.EffectTriggerSpell, "names.names")
        >> as_ids(c.SpellID, c.EffectTriggerSpell, c.Effect, c.EffectAura),
        link_targets=flow("link targets")
        .where((c.EffectTriggerSpell != 0) & (c.EffectTriggerSpell != c.SpellID))
        .narrow(c.EffectTriggerSpell, "names.names")
        >> as_map((c.SpellID, c.EffectTriggerSpell), c.mask, reduce=or_),
        cast_target_bits=flow("cast targets") >> as_map(c.SpellID, c.mask, reduce=or_),
        aura_target_bits=flow("aura targets").where(c.Effect == EFFECT_APPLY_AURA)
        >> as_map(c.SpellID, c.mask, reduce=or_),
        mechanics=landing(
            (
                flow("mechanics").where((c.Effect != 0) | (c.EffectAura != 0))
                >> as_rows(
                    EffectRow,
                    c.SpellID,
                    c.Effect,
                    c.EffectAura,
                    c.ImplicitTarget_0,
                    c.ImplicitTarget_1,
                    MISC0,
                    MISC1,
                    flag(c.consumed_Effect),
                    flag(c.consumed_EffectAura),
                    c.EffectIndex,
                    c.EffectAuraPeriod,
                    c.EffectChainTargets,
                    c.EffectAttributes,
                )
            ).then(set)
        ),
    ),
)
"""A zero amount is dropped: a pill made of nothing but the number would
promise a change and deliver none. A payload naming a roster drops a value the
build has nothing to show for. The mechanics rows are every distinct effect,
each half flagged where a branch landed it, so a value whose payload was
dropped stays raw and unflagged. The link through the trigger column selects
nothing: every row carries it."""


# The numbers a description asks for, read from the client's own tables and
# never the server's revisions: a hotfix prints a float at six significant
# digits and carries only the integer spelling of an amount, so on a build
# whose client exports only the float column the overlay would replace a
# precise value with a coarse one.

effect_values = declare(
    "effect_values",
    flow("the numbers a template asks of each effect")
    .read(
        "SpellEffect",
        c.SpellID,
        c.DifficultyID,
        c.EffectIndex,
        c.EffectBasePoints,
        c.EffectBasePointsF,
        c.EffectAuraPeriod,
        c.EffectRadiusIndex_0,
        c.EffectChainTargets,
        c.EffectMiscValue_0,
        c.Variance,
        c.ScalingClass,
        c.Coefficient,
        source="base",
    )
    .where(BASE)
    .join(c.SpellID, "SpellScaling", c.MinScalingLevel, c.MaxScalingLevel, by="SpellID", source="base")
    .join(c.EffectRadiusIndex_0, "SpellRadius", c.Radius, source="base")
    .map("amount", coalesce(c.EffectBasePoints, c.EffectBasePointsF, digits=1))
    .map("spread", coalesce(c.Variance, digits=1))
    .map("reached", coalesce(c.Radius, digits=1))
    .split(
        EffectValues,
        points=(
            flow("points")
            >> as_rows(
                PointRow,
                c.SpellID,
                typed(c.EffectIndex, effect_number),
                real(c.amount),
                c.ScalingClass,
                typed(c.Coefficient, tenth),
                c.MinScalingLevel,
                c.MaxScalingLevel,
            )
        ).then(resolve_points, level="level", scaling="scaling"),
        variance=flow("variance").where(c.spread != 0)
        >> as_nested(c.SpellID, typed(c.EffectIndex, effect_number), real(c.spread)),
        period=flow("period").where(c.EffectAuraPeriod != 0)
        >> as_nested(c.SpellID, typed(c.EffectIndex, effect_number), c.EffectAuraPeriod),
        radius=flow("radius").where(c.reached != 0)
        >> as_nested(c.SpellID, typed(c.EffectIndex, effect_number), real(c.reached)),
        chain_targets=flow("chain targets").where(c.EffectChainTargets != 0)
        >> as_nested(c.SpellID, typed(c.EffectIndex, effect_number), c.EffectChainTargets),
        misc_value=flow("misc value").where(c.EffectMiscValue_0 != 0)
        >> as_nested(c.SpellID, typed(c.EffectIndex, effect_number), c.EffectMiscValue_0),
    ),
)
"""Base difficulty only, and a zero is left out rather than recorded, so the
cooker elides the code instead of substituting nothing."""

spell_durations = declare(
    "spell_durations",
    flow("how long a spell lasts")
    .read("SpellMisc", c.SpellID, c.DifficultyID, c.DurationIndex, source="base")
    .where(BASE)
    .join(c.DurationIndex, "SpellDuration", c.Duration, inner=True, source="base")
    >> as_map(c.SpellID, c.Duration),
)

spell_ranges = declare(
    "spell_ranges",
    flow("how far a spell's description says it reaches")
    .read("SpellMisc", c.SpellID, c.DifficultyID, c.RangeIndex, source="base")
    .where(BASE)
    .join(c.RangeIndex, "SpellRange", c.RangeMax_0, inner=True, source="base")
    .map("distance", coalesce(c.RangeMax_0, digits=1))
    .where(c.distance != 0)
    >> as_map(c.SpellID, real(c.distance)),
)

aura_caps = (
    flow("what an aura's options cap")
    .read("SpellAuraOptions", c.SpellID, c.DifficultyID, c.CumulativeAura, c.ProcCharges, c.ProcChance, source="base")
    .where(BASE)
)

spell_stack_caps = declare(
    "spell_stack_caps", aura_caps.where(c.CumulativeAura != 0) >> as_map(c.SpellID, c.CumulativeAura)
)

spell_charges = declare("spell_charges", aura_caps.where(c.ProcCharges != 0) >> as_map(c.SpellID, c.ProcCharges))

spell_proc_chances = declare(
    "spell_proc_chances", aura_caps.where(c.ProcChance != 0) >> as_map(c.SpellID, c.ProcChance)
)

target_caps = (
    flow("what a spell's targeting caps")
    .read("SpellTargetRestrictions", c.SpellID, c.DifficultyID, c.MaxTargets, c.MaxTargetLevel, source="base")
    .where(BASE)
)

spell_target_caps = declare(
    "spell_target_caps", target_caps.where(c.MaxTargets != 0) >> as_map(c.SpellID, c.MaxTargets)
)

spell_target_levels = declare(
    "spell_target_levels", target_caps.where(c.MaxTargetLevel != 0) >> as_map(c.SpellID, c.MaxTargetLevel)
)

values = declare(
    "values",
    compose(
        DescriptionValues,
        points="effect_values.points",
        variance="effect_values.variance",
        period="effect_values.period",
        radius="effect_values.radius",
        chain_targets="effect_values.chain_targets",
        misc_value="effect_values.misc_value",
        duration="spell_durations",
        max_stacks="spell_stack_caps",
        charges="spell_charges",
        proc_chance="spell_proc_chances",
        max_targets="spell_target_caps",
        max_target_level="spell_target_levels",
        level="level",
        range_max="spell_ranges",
    ),
)
"""None of it reaches the pack; only the substituted text does."""


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
    ).then(nonzero),
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
