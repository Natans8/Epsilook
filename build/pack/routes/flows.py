"""Every route that is a declaration, in one place.

A route here is a flow and the shape it lands in, an attribute of `Routes`
named for the field it fills. Its needs are read off the flow, so nothing is
said twice, and a change to a route is a change to its line.

What is not here is a computation rather than a read: the graph walk, the
row flattening, the families and the text cooker, each a decorated function
in its own module.
"""

from __future__ import annotations

from operator import attrgetter, or_

from ..drift import RETIRED_SPAWN_OBJECT_EFFECTS, SPAWN_OBJECT_SLOTS_UNTIL, SPELL_NAME_SOURCES
from ..targets import NO_TARGET, VISUAL_REDIRECTS
from . import catalogue as T
from .anims import SPEED_UNIT
from .areas import UI_MAP_TYPE_ZONE, AreaGates, GateRow
from .colors import channel, rgb_of
from .columns import BASE_DIFFICULTY, to_float, to_int
from .creatures import CreatureKind, CreatureModels
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
    EFFECT_ACTIVATE_OBJECT,
    EFFECT_SPAWN_OBJECT,
    EFFECT_SUMMON,
    MISC0,
    MISC1,
    SCALE_AURAS,
    SPEED_AURAS,
    VALUE_MULTIPLIER_AURAS,
    VALUE_MULTIPLIER_EFFECTS,
    EffectNumbers,
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
    parameter,
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
from .reach import REACH_FLAGS, YARD_DIGITS, Cone, Reach
from .route import Declarations
from .shapeshifts import FormRow, ShapeshiftForms
from .sources import LootRow, quest_rewards_of
from .sounds import Ambience, ZoneMusic
from .spells import PropertiesRow, SpellProperties
from .text import assignments
from .values import DescriptionValues, EffectValues, PointRow, effect_number, resolve_points
from .vehicles import SEAT_COLUMNS, Seat, VehicleSeats
from .visuals import KitEvent, VisualGraph, target_bit

BASE = c.DifficultyID == BASE_DIFFICULTY
"""The row a player sees, which stands for the spell wherever a table keeps a
row per difficulty."""


class Routes(Declarations):
    """The declared routes: each attribute is the field it fills, in the order the build reads them.

    A bare flow or a shared terminal held here is a helper the plans below it build on, and no field.
    """

    # A long table's alias is its name without the Spell or SpellVisual prefix.
    KitEffect = T.SpellVisualKitEffect
    ProceduralEffect = T.SpellProceduralEffect
    ChainEffects = T.SpellChainEffects
    KitAreaModel = T.SpellVisualKitAreaModel
    TargetRestrictions = T.SpellTargetRestrictions
    KitModelAttach = T.SpellVisualKitModelAttach
    ShapeshiftForm = T.SpellShapeshiftForm
    CastingRequirements = T.SpellCastingRequirements
    DescriptionVariables = T.SpellDescriptionVariables
    EffectEmission = T.SpellEffectEmission
    Missile = T.SpellVisualMissile

    factions = (
        flow("the faction a spell sets")
        .read(T.FactionTemplate)
        .narrow(T.FactionTemplate.ID, "effects.factions.named")
        .join(T.FactionTemplate.Faction, T.Faction)
        .into(
            as_rows(
                FactionTemplateRow,
                T.FactionTemplate.ID,
                T.FactionTemplate.Faction,
                T.FactionTemplate.FactionGroup,
                word(T.Faction.Name_lang),
                sort=True,
            )
        )
    )
    """The template each aura sets, resolved to the faction's name and group."""

    zone_music = (
        flow("the music set a screen effect swaps in")
        .read(T.ZoneMusic)
        .into(
            as_records(
                T.ZoneMusic.ID, ZoneMusic, word(T.ZoneMusic.SetName), T.ZoneMusic.Sounds[0], T.ZoneMusic.Sounds[1]
            )
        )
    )

    ambiences = (
        flow("the ambience a screen effect swaps in")
        .read(T.SoundAmbience)
        .into(as_records(T.SoundAmbience.ID, Ambience, T.SoundAmbience.AmbienceID[0], T.SoundAmbience.AmbienceID[1]))
    )

    soundkit_files = (
        flow("the files a sound kit plays")
        .read(T.SoundKitEntry)
        .where((T.SoundKitEntry.SoundKitID != 0) & (T.SoundKitEntry.FileDataID != 0))
        .into(as_sets(T.SoundKitEntry.SoundKitID, T.SoundKitEntry.FileDataID))
    )

    kit_types = (
        flow("what each reached sound kit is for")
        .read(T.SoundKit)
        .narrow(T.SoundKit.ID, "used_kits")
        .narrow(T.SoundKit.SoundType, "sound_type_names", "the types the vendored enum names")
        .into(as_map(T.SoundKit.ID, T.SoundKit.SoundType))
    )

    looping_kits = (
        flow("the reached sound kits that loop until stopped")
        .read(T.SoundKit)
        .narrow(T.SoundKit.ID, "used_kits")
        .where(T.SoundKit.Flags.bit(9))
        .into(as_ids(T.SoundKit.ID))
    )
    """Bit 9 of the kit's flags is the loop; the other bits vary the pitch and
    volume or forbid a repeat, which are not a fact a row needs."""

    kit_names = (
        flow("the names the pinned build gives the sound kits this pack reaches")
        .read(T.SoundKitName)
        .narrow(T.SoundKitName.ID, "used_kits")
        .map("named", ~T.SoundKitName.Name.is_empty())
        .where(c.named == 1)
        .into(as_rows(lambda kit, name: (kit, name), T.SoundKitName.ID, word(T.SoundKitName.Name), sort=True))
    )
    """Kits added after the pinned build have no name anywhere and stay unnamed."""

    animkit_anims = (
        flow("the animations a kit segments")
        .read(T.AnimKitSegment)
        .where(T.AnimKitSegment.ParentAnimKitID != 0)
        .narrow(T.AnimKitSegment.AnimID, "anim_ids")
        .into(as_sets(T.AnimKitSegment.ParentAnimKitID, T.AnimKitSegment.AnimID))
    )

    animkit_speeds = (
        flow("the pace a kit plays each animation at")
        .read(T.AnimKitSegment)
        .where(T.AnimKitSegment.ParentAnimKitID != 0)
        .into(
            as_map(
                (T.AnimKitSegment.ParentAnimKitID, T.AnimKitSegment.AnimID),
                typed(T.AnimKitSegment.Speed, lambda cell: round(number_of(cell) * SPEED_UNIT)),
                first=True,
            )
        )
    )
    """In thousandths; negative plays backwards and nought holds the first frame.
    A kit segmenting one animation twice keeps the first segment's pace."""

    animkit_bonesets = (
        flow("the body regions a kit's animation moves")
        .read(
            T.AnimKitSegment,
        )
        .join(
            T.AnimKitSegment.AnimKitConfigID,
            T.AnimKitConfigBoneSet,
            by=T.AnimKitConfigBoneSet.ParentAnimKitConfigID,
            inner=True,
            many=True,
        )
        .join(T.AnimKitConfigBoneSet.AnimKitBoneSetID, T.AnimKitBoneSet, inner=True)
        .where(~T.AnimKitBoneSet.Name.is_empty() & (T.AnimKitBoneSet.Name != "Full Body"))
        .into(as_tree(T.AnimKitSegment.ParentAnimKitID, T.AnimKitSegment.AnimID, value=text(T.AnimKitBoneSet.Name)))
    )
    """The default region, the whole body, is never shown because it distinguishes nothing."""

    anim_replacements = (
        flow("the animation swaps a replacement set makes")
        .read(
            T.AnimReplacement,
        )
        .where(T.AnimReplacement.ParentAnimReplacementSetID != 0)
        .narrow(T.AnimReplacement.SrcAnimID, "anim_ids")
        .narrow(T.AnimReplacement.DstAnimID, "anim_ids")
        .into(
            as_sets(
                T.AnimReplacement.ParentAnimReplacementSetID, T.AnimReplacement.SrcAnimID, T.AnimReplacement.DstAnimID
            )
        )
    )

    keybinds = (
        flow("the game functions a key override casts a spell from")
        .read(
            T.SpellKeyboundOverride,
        )
        .into(
            as_records(
                T.SpellKeyboundOverride.ID,
                KeyboundOverride,
                word(T.SpellKeyboundOverride.Function),
                typed(T.SpellKeyboundOverride.Type, lambda cell: keybound_type_word(key_of(cell))),
                T.SpellKeyboundOverride.Data,
            )
        )
    )

    motions = (
        flow("the flight paths a missile can fly")
        .read(T.SpellMissileMotion)
        .where(~T.SpellMissileMotion.Name.is_empty())
        .into(
            as_records(
                T.SpellMissileMotion.ID,
                MissileMotion,
                text(T.SpellMissileMotion.Name),
                T.SpellMissileMotion.MissileCount,
            )
        )
    )

    forms = (
        flow("the shapeshift forms and the creatures they wear")
        .read(
            ShapeshiftForm,
        )
        .into(
            as_rows(
                FormRow,
                ShapeshiftForm.ID,
                text(ShapeshiftForm.Name_lang),
                typed(
                    ShapeshiftForm.CreatureDisplayID[:],
                    lambda cell: [d for d in map(to_int, values_of(cell)) if d > 0],
                ),
            )
        )
    ).then(ShapeshiftForms.assemble)

    objects = (
        flow("the gameobjects a spell spawns, named and modelled")
        .read(
            T.gameobject_template,
        )
        .join(T.gameobject_template.displayId, T.GameObjectDisplayInfo)
        .into(
            as_rows(
                GameObjectRow,
                T.gameobject_template.entry,
                word(T.gameobject_template.name),
                T.gameobject_template.type,
                T.GameObjectDisplayInfo.FileDataID,
            )
        )
    ).then(GameObjectData.assemble)

    mounts = (
        flow("the displays a mount-granting spell puts you on")
        .read(T.Mount)
        .narrow(T.Mount.SourceSpellID, "names.names")
        .join(T.Mount.ID, T.MountXDisplay, by=T.MountXDisplay.MountID, many=True)
        .into(
            as_rows(
                MountRow,
                T.Mount.ID,
                word(T.Mount.Name_lang),
                T.Mount.SourceSpellID,
                word(T.Mount.Description_lang),
                T.MountXDisplay.CreatureDisplayInfoID,
            )
        )
    ).then(MountData.assemble, creatures="creatures")

    # The creature chain, and the items: what a display and an item resolve to.

    creature_names = (
        flow("what the server calls each creature")
        .read(T.creature_template)
        .into(as_map(T.creature_template.entry, word(T.creature_template.name)))
    )

    creature_kinds = (
        flow("what the server bills each creature as")
        .read(T.creature_template, optional=True)
        .map("billed", coalesce(T.creature_template.rank, T.creature_template.Classification))
        .where((T.creature_template.type != 0) | (c.billed != 0) | (T.creature_template.faction != 0))
        .into(
            as_rows(
                CreatureKind,
                T.creature_template.entry,
                T.creature_template.type,
                c.billed,
                T.creature_template.faction,
                sort=True,
            )
        )
    )
    """Every creature the server dump describes rather than only the ones a
    spell reaches: which of them the pack lists is the section's question."""

    # Where a spell comes from. The two halves are apart: a spell reaches an
    # item, and an item reaches whoever hands it over.

    spell_trainers = (
        flow("the creatures that teach each spell")
        .read(T.creature_trainer, optional=True)
        .where(T.creature_trainer.CreatureID != 0)
        .join(T.creature_trainer.TrainerID, T.trainer_spell, by=T.trainer_spell.TrainerId, many=True)
        .where(T.trainer_spell.SpellId != 0)
        .narrow(T.trainer_spell.SpellId, "names.names")
        .into(as_sets(T.trainer_spell.SpellId, T.creature_trainer.CreatureID))
    )
    """Read from the creature rather than from the spell, because a trainer's
    list is often shared and the join then takes every creature standing behind
    one."""

    quest_rewards = (
        flow("what each quest grants")
        .read(T.quest_template, optional=True)
        .where(
            (T.quest_template.RewardSpell != 0)
            | (T.quest_template.RewardDisplaySpell1 != 0)
            | (T.quest_template.RewardItem1 != 0)
        )
        .into(
            as_records(
                T.quest_template.ID,
                quest_rewards_of,
                T.quest_template.ID,
                word(T.quest_template.LogTitle),
                T.quest_template.RewardSpell,
                T.quest_template.RewardDisplaySpell1,
                T.quest_template.RewardDisplaySpell2,
                T.quest_template.RewardDisplaySpell3,
                T.quest_template.RewardItem1,
                T.quest_template.RewardItem2,
                T.quest_template.RewardItem3,
                T.quest_template.RewardItem4,
                first=True,
            )
        )
    )
    """A quest's rewards as one record, since its spells and its items sit in
    columns rather than in rows of their own."""

    item_spells = (
        flow("the spell each item casts or teaches")
        .read(T.ItemEffect, optional=True)
        .join(T.ItemEffect.ID, T.ItemXItemEffect, by=T.ItemXItemEffect.ItemEffectID, many=True)
        .map("item", coalesce(T.ItemEffect.ParentItemID, T.ItemXItemEffect.ItemID))
        .where(c.item != 0)
        .narrow(T.ItemEffect.SpellID, "names.names")
        .into(as_sets(T.ItemEffect.SpellID, c.item))
    )
    """Shadowlands split the item off the effect row into a bridge table, so a
    build carries one spelling or the other and the row reads whichever."""

    item_vendors = (
        flow("the creatures that sell each item")
        .read(T.npc_vendor, optional=True)
        .where(T.npc_vendor.item != 0)
        .into(as_sets(T.npc_vendor.item, T.npc_vendor.entry))
    )

    creature_drops = (
        flow("the creatures that drop each item")
        .read(T.creature_loot_template, optional=True)
        .into(
            as_rows(
                LootRow,
                T.creature_loot_template.Entry,
                T.creature_loot_template.Item,
                T.creature_loot_template.Reference,
                T.creature_loot_template.ItemType,
            )
        )
    )

    object_drops = (
        flow("the gameobjects that hold each item")
        .read(T.gameobject_loot_template, optional=True)
        .into(
            as_rows(
                LootRow,
                T.gameobject_loot_template.Entry,
                T.gameobject_loot_template.Item,
                T.gameobject_loot_template.Reference,
                T.gameobject_loot_template.ItemType,
            )
        )
    )

    loot_references = (
        flow("the items each pooled loot list holds")
        .read(T.reference_loot_template, optional=True)
        .into(
            as_rows(
                LootRow,
                T.reference_loot_template.Entry,
                T.reference_loot_template.Item,
                T.reference_loot_template.Reference,
                T.reference_loot_template.ItemType,
            )
        )
    )
    """A loot row naming a reference draws from this pool rather than carrying
    an item, so a drop is reachable only by following it."""

    faction_names = (
        flow("what every faction is called").read(T.Faction).into(as_map(T.Faction.ID, word(T.Faction.Name_lang)))
    )

    skill_names = (
        flow("what every skill line is called")
        .read(T.SkillLine)
        .into(as_map(T.SkillLine.ID, word(T.SkillLine.DisplayName_lang)))
    )

    enchantment_names = (
        flow("what every enchantment is called")
        .read(T.SpellItemEnchantment)
        .into(as_map(T.SpellItemEnchantment.ID, word(T.SpellItemEnchantment.Name_lang)))
    )

    creature_displays = first_available(
        flow("the displays a creature wears, by slot")
        .read(
            T.creature_template_model,
        )
        .into(
            as_sets(
                T.creature_template_model.CreatureID,
                T.creature_template_model.Idx,
                T.creature_template_model.CreatureDisplayID,
            )
        ),
        flow("the same in the legacy shape, where the column is the slot")
        .read(
            T.creature_template,
        )
        .explode(
            T.creature_template.modelid1,
            T.creature_template.modelid2,
            T.creature_template.modelid3,
            T.creature_template.modelid4,
            into="display",
            slot="slot",
        )
        .into(as_sets(T.creature_template.entry, c.slot, c.display)),
    ).then(ordered)
    """Whichever shape the release has wins; a display named in two slots is two
    rows, since the first slot is the one the pill shows."""

    display_models = (
        flow("the model each creature display wears")
        .read(T.CreatureDisplayInfo)
        .into(as_map(T.CreatureDisplayInfo.ID, T.CreatureDisplayInfo.ModelID))
    )

    display_skins = (
        flow("the textures a display paints its model with")
        .read(T.CreatureDisplayInfo)
        .into(as_map(T.CreatureDisplayInfo.ID, typed(T.CreatureDisplayInfo.TextureVariationFileDataID[:], ids_of)))
    ).then(nonzero)
    """As many slots as the build has, in slot order; a display painting nothing
    is absent rather than empty."""

    creature_model_files = (
        flow("each creature model's file")
        .read(T.CreatureModelData)
        .into(as_map(T.CreatureModelData.ID, T.CreatureModelData.FileDataID))
    )

    totem_displays = (
        flow("the displays a totem wears, one per caster race")
        .read(T.spell_totem_model, optional=True)
        .where(T.spell_totem_model.DisplayID != 0)
        .into(as_sets(T.spell_totem_model.SpellID, T.spell_totem_model.DisplayID))
    ).then(ordered)
    """Two races sharing a model is one display, in display order, since no race
    travels with it."""

    creatures = compose(
        CreatureModels,
        names="creature_names",
        displays="creature_displays",
        display_model="display_models",
        model_fid="creature_model_files",
        totem_displays="totem_displays",
        display_skins="display_skins",
    )

    item_names = (
        flow("the items a visual holds up, by name and quality")
        .read(T.ItemSearchName)
        .where(~T.ItemSearchName.Display_lang.is_empty())
        .into(
            as_records(
                T.ItemSearchName.ID, ItemName, text(T.ItemSearchName.Display_lang), T.ItemSearchName.OverallQualityID
            )
        )
    )

    model_files = (
        flow("the base file of each model resource")
        .read(T.ModelFileData)
        .where((T.ModelFileData.FileDataID != 0) & (T.ModelFileData.ModelResourcesID != 0))
        .into(as_map(T.ModelFileData.ModelResourcesID, T.ModelFileData.FileDataID, reduce=min))
    )
    """A model shipping with levels of detail names several files, and the lowest
    is the base model."""

    looks = (
        flow("each item's appearances, the base look first")
        .read(T.ItemModifiedAppearance)
        .where(T.ItemModifiedAppearance.ItemID != 0)
        .join(
            T.ItemModifiedAppearance.ItemAppearanceID,
            T.ItemAppearance,
            inner=True,
        )
    )

    item_icons = looks.where(T.ItemAppearance.DefaultIconFileDataID != 0).into(
        as_map(T.ItemModifiedAppearance.ItemID, T.ItemAppearance.DefaultIconFileDataID, first=True)
    )

    item_models = (
        looks.join(T.ItemAppearance.ItemDisplayInfoID, T.ItemDisplayInfo)
        .explode(T.ItemDisplayInfo.ModelResourcesID[:], into="resource")
        .narrow(c.resource, "model_files")
        .into(as_map(T.ItemModifiedAppearance.ItemID, c.resource, first=True))
    ).then(lambda held, files: {item: files[resource] for item, resource in held.items()}, files="model_files")
    """The first appearance whose display reaches a file, and its first slot that
    does: a paired item carries its second component in the second slot."""

    items = compose(ItemModels, names="item_names", icons="item_icons", models="item_models")

    # The models: every table that ends in a model file.

    effect_names = (
        flow("what each effect name reaches: a file, an item, a display or a weapon slot")
        .read(
            T.SpellVisualEffectName,
        )
        .into(
            as_records(
                T.SpellVisualEffectName.ID,
                EffectName,
                T.SpellVisualEffectName.ModelFileDataID,
                T.SpellVisualEffectName.Type,
                T.SpellVisualEffectName.GenericID,
                typed(T.SpellVisualEffectName.Scale, lambda cell: round(number_of(cell) * SCALE_UNIT)),
            )
        )
    ).then(without_placeholders, named="named")

    attachments = (
        flow("the models a kit hangs on a unit, and where")
        .read(KitModelAttach)
        .where(KitModelAttach.ParentSpellVisualKitID != 0)
        .into(
            as_rows(
                AttachRow.of,
                KitModelAttach.ParentSpellVisualKitID,
                KitModelAttach.SpellVisualEffectNameID,
                KitModelAttach.AttachmentID,
                *(text(column) for column in PLACEMENT_COLUMNS),
            )
        )
    ).then(KitAttachments.assemble, names="effect_names", creatures="creatures", items="items")

    area_models = (
        flow("the ground models").read(KitAreaModel).into(as_map(KitAreaModel.ID, KitAreaModel.ModelFileDataID))
    )

    emissions = (
        flow("the ground model an emitter spawns copies of")
        .read(EffectEmission)
        .join(
            EffectEmission.AreaModelID,
            KitAreaModel,
            inner=True,
        )
        .where(KitAreaModel.ModelFileDataID != 0)
        .into(as_map(EffectEmission.ID, typed(KitAreaModel.ModelFileDataID, ground_model)))
    )

    barrages = (
        flow("the model a volley is made of, and where on the caster it spawns")
        .read(
            T.BarrageEffect,
        )
        .join(
            T.BarrageEffect.SpellVisualEffectNameID,
            T.SpellVisualEffectName,
            inner=True,
        )
        .where(T.SpellVisualEffectName.ModelFileDataID != 0)
        .into(
            as_records(
                T.BarrageEffect.ID,
                barrage_model,
                T.SpellVisualEffectName.ModelFileDataID,
                T.BarrageEffect.AttachmentPoint,
            )
        )
    )

    weapon_trails = (
        flow("the trail models").read(T.WeaponTrail).into(as_map(T.WeaponTrail.ID, T.WeaponTrail.FileDataID))
    )

    missiles = (
        flow("the projectiles a visual launches, from its base set and its raid set")
        .read(
            T.SpellVisual,
        )
        .explode(T.SpellVisual.SpellVisualMissileSetID, T.SpellVisual.RaidSpellVisualMissileSetID, into="set")
        .join(
            c.set,
            Missile,
            by=Missile.SpellVisualMissileSetID,
            inner=True,
            many=True,
        )
        .into(
            as_rows(
                MissileRow,
                T.SpellVisual.ID,
                Missile.SpellVisualEffectNameID,
                Missile.SoundEntriesID,
                Missile.AnimKitID,
                Missile.SpellMissileMotionID,
                Missile.Attachment,
                Missile.DestinationAttachment,
                T.SpellVisual.MissileAttachment,
                T.SpellVisual.MissileDestinationAttachment,
            )
        )
    ).then(assemble_missiles, names="effect_names")

    # The fx payloads: six unrelated tables a kit reaches by effect type.

    chains = (
        flow("what a beam segment draws with")
        .read(
            ChainEffects,
        )
        .into(
            as_records(
                ChainEffects.ID,
                ChainEffect,
                ChainEffects.Red,
                ChainEffects.Green,
                ChainEffects.Blue,
                ChainEffects.SoundKitID,
                typed(ChainEffects.TextureFileDataID[:], ids_of),
                typed(ChainEffects.SpellChainEffectID[:], ids_of),
                typed(ChainEffects.ArcHeight, positive),
                typed(ChainEffects.MaxFlickerOnDuration, positive),
                typed(ChainEffects.JointOffsetRadius, positive),
                typed(ChainEffects.WaveHeight, visible_wave),
                typed(ChainEffects.StartWidth, yards),
            )
        )
    )
    """Chains nest: a composite chain names up to eleven others. The flicker and
    wave columns are tuning read as traits, and the geometry is dropped."""

    beams = (
        flow("the chain a beam draws, and its two ends")
        .read(T.BeamEffect)
        .into(
            as_records(
                T.BeamEffect.ID, Beam, T.BeamEffect.BeamID, T.BeamEffect.SourceAttachID, T.BeamEffect.DestAttachID
            )
        )
    )

    dissolves = (
        flow("the dissolve materials")
        .read(
            T.DissolveEffect,
        )
        .join(T.DissolveEffect.TextureBlendSetID, T.TextureBlendSet)
        .into(
            as_records(
                T.DissolveEffect.ID,
                Dissolve,
                typed(T.DissolveEffect.Duration, seconds),
                typed(T.TextureBlendSet.TextureFileDataID[:], ids_of),
                T.DissolveEffect.AttachID,
            )
        )
    )

    glows = (
        flow("the colour an edge glow paints")
        .read(
            T.EdgeGlowEffect,
        )
        .into(
            as_records(
                T.EdgeGlowEffect.ID,
                lambda red, green, blue: (red << 16) | (green << 8) | blue,
                typed(T.EdgeGlowEffect.GlowRed, channel),
                typed(T.EdgeGlowEffect.GlowGreen, channel),
                typed(T.EdgeGlowEffect.GlowBlue, channel),
            )
        )
    )
    """The colour is the whole visible payload; the multiplier, fade and fresnel
    columns are tuning."""

    glow_alphas = (
        flow("how opaque an edge glow is")
        .read(T.EdgeGlowEffect)
        .into(as_map(T.EdgeGlowEffect.ID, typed(T.EdgeGlowEffect.GlowAlpha, channel)))
    )

    shadowies = (
        flow("the two colours of a ghost effect, and where it anchors")
        .read(
            T.ShadowyEffect,
        )
        .into(
            as_records(
                T.ShadowyEffect.ID,
                Shadowy,
                typed(T.ShadowyEffect.PrimaryColor, rgb_of),
                typed(T.ShadowyEffect.SecondaryColor, rgb_of),
                T.ShadowyEffect.AttachPos,
            )
        )
    )

    screens = (
        flow("what a screen effect does to the frame, the sky, the sound and the hour")
        .read(
            T.ScreenEffect,
        )
        .join(
            T.ScreenEffect.FullScreenEffectID,
            T.FullScreenEffect,
        )
        .join(T.FullScreenEffect.TextureBlendSetID, T.TextureBlendSet)
        .into(
            as_records(
                T.ScreenEffect.ID,
                ScreenRow.of,
                text(T.ScreenEffect.Name),
                T.ScreenEffect.Param[0],
                T.ScreenEffect.Effect,
                typed(T.FullScreenEffect.ColorMultiplyRed, grade),
                typed(T.FullScreenEffect.ColorMultiplyGreen, grade),
                typed(T.FullScreenEffect.ColorMultiplyBlue, grade),
                typed(T.FullScreenEffect.ColorAdditionRed, grade),
                typed(T.FullScreenEffect.ColorAdditionGreen, grade),
                typed(T.FullScreenEffect.ColorAdditionBlue, grade),
                T.FullScreenEffect.OverlayTextureFileDataID,
                typed(T.TextureBlendSet.TextureFileDataID[:], ids_of),
                typed(T.FullScreenEffect.MaskOffsetY, thousandths),
                typed(T.FullScreenEffect.MaskSizeMultiplier, thousandths),
                typed(T.FullScreenEffect.MaskPower, thousandths),
                T.ScreenEffect.LightParamsID,
                T.ScreenEffect.LightParamsFadeIn,
                T.ScreenEffect.LightParamsFadeOut,
                T.ScreenEffect.SoundAmbienceID,
                T.ScreenEffect.ZoneMusicID,
                T.ScreenEffect.TimeOfDayOverride,
            )
        )
    )

    visual_screens = (
        flow("the kit's route into a screen effect")
        .read(T.SpellVisualScreenEffect)
        .into(as_map(T.SpellVisualScreenEffect.ID, T.SpellVisualScreenEffect.ScreenEffectID))
    )

    fx = compose(FxPayloads)

    # The character procedures: one table, many meanings, chosen by its Type.

    procedures = flow("the character procedures").read(
        ProceduralEffect,
    )

    proc_chains = procedures.where(ProceduralEffect.Type.among(PROC_TYPES_CHAIN)).into(
        as_map(ProceduralEffect.ID, ProceduralEffect.Value[0])
    )

    proc_tints = procedures.where(ProceduralEffect.Type.among((PROC_TYPE_TINT, PROC_TYPE_TINT_MAT))).into(
        as_records(
            ProceduralEffect.ID,
            tint,
            ProceduralEffect.Type,
            ProceduralEffect.Value[0],
            ProceduralEffect.Value[3],
        )
    )
    """The payload column differs per Type, and a colourless tint folds in as black."""

    proc_ghosts = procedures.where(
        (ProceduralEffect.Type == PROC_TYPE_GHOST_MAT) & (ProceduralEffect.Value[3] != 0)
    ).into(as_map(ProceduralEffect.ID, typed(ProceduralEffect.Value[3], rgb_of)))
    """A colourless ghost has nothing to show and is dropped."""

    proc_desats = (
        procedures.where(ProceduralEffect.Type == PROC_TYPE_DESATURATE).into(
            as_map(ProceduralEffect.ID, typed(ProceduralEffect.Value[2], percent))
        )
    ).then(nonzero)

    proc_transps = (
        procedures.where(ProceduralEffect.Type == PROC_TYPE_TRANSPARENCY).into(
            as_map(ProceduralEffect.ID, typed(ProceduralEffect.Value[0], percent))
        )
    ).then(nonzero)
    """A percentage of zero would render as a claim that something happened."""

    proc_freezes = procedures.where(ProceduralEffect.Type == PROC_TYPE_FREEZE).into(as_ids(ProceduralEffect.ID))

    proc_camos = procedures.where(ProceduralEffect.Type == PROC_TYPE_CAMO).into(as_ids(ProceduralEffect.ID))

    proc_ground = (
        procedures.where(ProceduralEffect.Type == PROC_TYPE_AREAMODEL)
        .join(
            ProceduralEffect.Value[0],
            KitAreaModel,
            inner=True,
        )
        .where(KitAreaModel.ModelFileDataID != 0)
        .into(as_map(ProceduralEffect.ID, typed(KitAreaModel.ModelFileDataID, ground_model)))
    )

    proc_trails = (
        procedures.where(ProceduralEffect.Type == PROC_TYPE_WEAPONTRAIL)
        .join(ProceduralEffect.Value[0], T.WeaponTrail, inner=True)
        .where(T.WeaponTrail.FileDataID != 0)
        .into(as_map(ProceduralEffect.ID, typed(T.WeaponTrail.FileDataID, trail_model)))
    )

    proc_anims = (
        procedures.where(ProceduralEffect.Type == PROC_TYPE_STANDWALK).into(
            as_records(
                ProceduralEffect.ID,
                standwalk,
                ProceduralEffect.Value[0],
                ProceduralEffect.Value[1],
                ProceduralEffect.Value[2],
            )
        )
    ).then(nonzero)

    procs = compose(
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
    )

    # The kit dispatch: one row says which effect of which type a kit plays, and
    # the type decides which table the effect is an id in.

    kit_effects = (
        flow("what a kit's effect rows reach, by type")
        .read(
            KitEffect,
        )
        .where((KitEffect.ParentSpellVisualKitID != 0) & (KitEffect.Effect != 0))
    )

    kit_sounds = kit_effects.where(KitEffect.EffectType == EFFECT_TYPE_SOUND).into(
        as_sets(KitEffect.ParentSpellVisualKitID, KitEffect.Effect)
    )

    kit_anim_rows = kit_effects.where(KitEffect.EffectType == EFFECT_TYPE_ANIM).join(
        KitEffect.Effect,
        T.SpellVisualAnim,
    )

    kit_visual_anims = (
        kit_anim_rows.explode(T.SpellVisualAnim.InitialAnimID, T.SpellVisualAnim.LoopAnimID, into="anim")
        .where(c.anim > 0)
        .into(as_sets(KitEffect.ParentSpellVisualKitID, c.anim))
    )
    """Nought would be Stand and minus one is unset, so neither is played."""

    kit_animkits = kit_anim_rows.where(T.SpellVisualAnim.AnimKitID != 0).into(
        as_sets(KitEffect.ParentSpellVisualKitID, T.SpellVisualAnim.AnimKitID)
    )

    kit_dissolves = (
        kit_effects.where(KitEffect.EffectType == EFFECT_TYPE_DISSOLVE)
        .narrow(KitEffect.Effect, "dissolves")
        .into(as_sets(KitEffect.ParentSpellVisualKitID, KitEffect.Effect))
    )

    kit_glows = (
        kit_effects.where(KitEffect.EffectType == EFFECT_TYPE_EDGE_GLOW)
        .narrow(KitEffect.Effect, "glows")
        .into(as_sets(KitEffect.ParentSpellVisualKitID, KitEffect.Effect))
    )

    kit_shadowies = (
        kit_effects.where(KitEffect.EffectType == EFFECT_TYPE_SHADOWY)
        .narrow(KitEffect.Effect, "shadowies")
        .into(as_sets(KitEffect.ParentSpellVisualKitID, KitEffect.Effect))
    )
    """A row pointing at a payload this build lacks is dropped rather than an error."""

    kit_screens = (
        kit_effects.where(KitEffect.EffectType == EFFECT_TYPE_SCREEN)
        .join(
            KitEffect.Effect,
            T.SpellVisualScreenEffect,
            inner=True,
        )
        .narrow(T.SpellVisualScreenEffect.ScreenEffectID, "screens")
        .into(as_sets(KitEffect.ParentSpellVisualKitID, T.SpellVisualScreenEffect.ScreenEffectID))
    )

    kit_emissions = (
        kit_effects.where(KitEffect.EffectType == EFFECT_TYPE_EMISSION)
        .narrow(KitEffect.Effect, "emissions")
        .into(as_sets(KitEffect.ParentSpellVisualKitID, KitEffect.Effect))
    )

    kit_barrages = (
        kit_effects.where(KitEffect.EffectType == EFFECT_TYPE_BARRAGE)
        .narrow(KitEffect.Effect, "barrages")
        .into(as_sets(KitEffect.ParentSpellVisualKitID, KitEffect.Effect))
    )

    kit_beams = (
        kit_effects.where(KitEffect.EffectType == EFFECT_TYPE_BEAM)
        .join(
            KitEffect.Effect,
            T.BeamEffect,
            inner=True,
        )
        .expand(T.BeamEffect.BeamID, ChainEffects, {"SpellChainEffectID_*": 0}, into="chain", bits="hops")
        .narrow(c.chain, "chains")
        .into(
            as_sets(
                KitEffect.ParentSpellVisualKitID,
                c.chain,
                T.BeamEffect.SourceAttachID,
                T.BeamEffect.DestAttachID,
            )
        )
    )
    """A beam's chains and every chain those nest, each tagged with the beam's two
    ends: nested chains are segments of the same beam. The graph may cycle."""

    kit_procedures = kit_effects.where(KitEffect.EffectType == EFFECT_TYPE_PROC).into(
        as_sets(KitEffect.ParentSpellVisualKitID, KitEffect.Effect)
    )
    """Dispatched a second time, by membership in the procedure route's buckets."""

    kit_proc_chains = (
        kit_effects.where(KitEffect.EffectType == EFFECT_TYPE_PROC)
        .lookup(KitEffect.Effect, "proc_chains", into="seed")
        .expand(c.seed, ChainEffects, {"SpellChainEffectID_*": 0}, into="chain", bits="hops")
        .narrow(c.chain, "chains")
        .into(as_sets(KitEffect.ParentSpellVisualKitID, c.chain))
    )
    """A procedure-route chain has no beam row, so it carries no attachment pair."""

    kits = compose(KitEffects.assemble)

    # The spine: spell to visual to kit, each hop carrying who the content plays for.

    spell_visuals = (
        flow("the visuals a spell reaches, its redirects followed")
        .read(T.SpellXSpellVisual)
        .where((T.SpellXSpellVisual.SpellID != 0) & (T.SpellXSpellVisual.SpellVisualID != 0))
        .expand(T.SpellXSpellVisual.SpellVisualID, T.SpellVisual, VISUAL_REDIRECTS, into="visual", bits="reached")
        .into(as_nested(T.SpellXSpellVisual.SpellID, c.visual, c.reached, reduce=or_))
    )
    """A visual reached straight from the spell carries no extra bits; one reached
    through a redirect carries the bits of the columns the path went through, and
    a visual reached two ways carries both. The graph may cycle."""

    visual_events = (
        flow("what a visual plays, when, and for whom")
        .read(
            T.SpellVisualEvent,
        )
        .where((T.SpellVisualEvent.SpellVisualID != 0) & (T.SpellVisualEvent.SpellVisualKitID != 0))
        .into(
            as_lists(
                T.SpellVisualEvent.SpellVisualID,
                T.SpellVisualEvent.SpellVisualKitID,
                T.SpellVisualEvent.StartEvent,
                typed(T.SpellVisualEvent.TargetType, target_bit),
                record=KitEvent,
            )
        )
    )
    """Distinct, in table order, and kept per event rather than folded per kit:
    the phase is what the pack ships."""

    visual_sounds = (
        flow("the sound a visual's own animation events play")
        .read(T.SpellVisual)
        .where(T.SpellVisual.AnimEventSoundID != 0)
        .into(as_map(T.SpellVisual.ID, T.SpellVisual.AnimEventSoundID))
    )

    graph = compose(VisualGraph)

    # The vehicles.

    seats = (
        flow("each seat's attachment and what the rider and the vehicle animate")
        .read(T.VehicleSeat)
        .into(as_records(T.VehicleSeat.ID, Seat.of, T.VehicleSeat.AttachmentID, *SEAT_COLUMNS))
    )

    vehicles = (
        flow("each vehicle's seats, by slot")
        .read(T.Vehicle)
        .into(
            as_map(
                T.Vehicle.ID,
                typed(T.Vehicle.SeatID[:], lambda cell: [seat for seat in map(key_of, values_of(cell)) if seat > 0]),
            )
        )
    ).then(VehicleSeats.assemble, seats="seats")
    """Empty slots are dropped, so the list length is the seat count, and a seat
    the build has no row for keeps its slot and loses its name."""

    # The spell itself.

    names = first_available(
        *(
            flow("the spell list").read(table, *columns).into(as_map(c.ID, text(c.Name_lang)))
            for table, columns in SPELL_NAME_SOURCES
        )
    ).then(SpellNames.assemble, subtexts="spell_subtexts")
    """Membership is the spell list: every route downstream filters against it."""

    spell_subtexts = (
        flow("the parenthetical rank or variant under a spell's name")
        .read(T.Spell)
        .where(~T.Spell.NameSubtext_lang.is_empty())
        .into(as_map(T.Spell.ID, text(T.Spell.NameSubtext_lang)))
    )

    alt_names = (
        flow("the names a spell can rename its target to")
        .read(T.SpellOverrideName)
        .into(as_map(T.SpellOverrideName.ID, text(T.SpellOverrideName.OverrideName_lang)))
    ).then(override_names, by_spell="effects.altnames")

    spell_icons = (
        flow("each spell's icon, from the row that has one")
        .read(T.SpellMisc)
        .narrow(T.SpellMisc.SpellID, "names.names")
        .where(T.SpellMisc.SpellIconFileDataID != 0)
        .prefer(T.SpellMisc.SpellID, base=BASE)
        .into(as_map(T.SpellMisc.SpellID, T.SpellMisc.SpellIconFileDataID))
    )
    """An icon of zero never displaces one, so the icon is read apart from the
    rest of the row, base row first among the rows that have one."""

    props = (
        flow("what SpellMisc says about a spell")
        .read(
            T.SpellMisc,
        )
        .narrow(T.SpellMisc.SpellID, "names.names")
        .prefer(T.SpellMisc.SpellID, base=BASE)
        .into(
            as_rows(
                PropertiesRow,
                T.SpellMisc.SpellID,
                T.SpellMisc.SchoolMask,
                T.SpellMisc.CastingTimeIndex,
                T.SpellMisc.DurationIndex,
                T.SpellMisc.RangeIndex,
                real(T.SpellMisc.Speed),
                real(T.SpellMisc.LaunchDelay),
                typed(T.SpellMisc.Attributes[:], lambda cell: tuple(to_int(value) for value in values_of(cell))),
            )
        )
    ).then(SpellProperties.assemble, icons="spell_icons")

    reach = (
        flow("how far a spell reaches")
        .read(T.SpellMisc)
        .narrow(T.SpellMisc.SpellID, "names.names")
        .prefer(T.SpellMisc.SpellID, base=BASE)
        .join(
            T.SpellMisc.RangeIndex,
            T.SpellRange,
            inner=True,
        )
        .into(
            as_rows(
                Reach,
                T.SpellMisc.SpellID,
                typed(T.SpellRange.RangeMax[0], lambda cell: to_float(as_text(cell), YARD_DIGITS)),
                typed(T.SpellRange.RangeMin[0], lambda cell: to_float(as_text(cell), YARD_DIGITS)),
                typed(T.SpellRange.Flags, lambda cell: key_of(cell) & REACH_FLAGS),
                sort=attrgetter("spell"),
            )
        )
    ).then(lambda bands: [band for band in bands if band.max_yards > 0])
    """A spell reaching no further than its caster is left out, which makes self
    the complement worked out at load."""

    channel_breaks = (
        flow("the channels that movement cancels")
        .read(
            T.SpellInterrupts,
            optional=True,
        )
        .narrow(T.SpellInterrupts.SpellID, "names.names")
        .prefer(T.SpellInterrupts.SpellID, base=BASE)
        .where(T.SpellInterrupts.ChannelInterruptFlags[:].bit(MOVING_BIT))
        .into(as_ids(T.SpellInterrupts.SpellID))
    )
    """The channel column, so the channel enum rather than the cast one."""

    delivery = (
        flow("how a spell is delivered: a cast time, a channel, or both")
        .read(
            T.SpellMisc,
        )
        .narrow(T.SpellMisc.SpellID, "names.names")
        .prefer(T.SpellMisc.SpellID, base=BASE)
        .join(T.SpellMisc.CastingTimeIndex, T.SpellCastTimes)
        .join(T.SpellMisc.DurationIndex, T.SpellDuration)
        .map(
            "channelled",
            T.SpellMisc.Attributes[:].bit(CHANNEL_BITS[0]) | T.SpellMisc.Attributes[:].bit(CHANNEL_BITS[1]),
        )
        .into(
            as_rows(
                DeliveryRow,
                T.SpellMisc.SpellID,
                T.SpellCastTimes.Base,
                typed(T.SpellDuration.Duration, lambda cell: None if cell == "" else key_of(cell)),
                typed(c.channelled, lambda cell: cell == "1"),
            )
        )
    ).then(assemble_delivery, breaks="channel_breaks")

    aura_interrupts = (
        flow("what removes a spell's aura")
        .read(
            T.SpellInterrupts,
            optional=True,
        )
        .narrow(T.SpellInterrupts.SpellID, "names.names")
        .prefer(T.SpellInterrupts.SpellID, base=BASE)
        .into(as_map(T.SpellInterrupts.SpellID, typed(T.SpellInterrupts.AuraInterruptFlags[:], interrupt_bits)))
    ).then(nonzero)
    """A spell carrying only housekeeping bits is absent rather than empty."""

    # The effects: one read of SpellEffect, each row split into the payloads it
    # feeds. A selector column and a value choose a meaning, and the slots say
    # what the row's other columns then hold: a reference into a table, a value
    # a vocabulary names, a number. The shipped selector table is read off these.

    summon_controls = (
        flow("how a summoned creature is controlled")
        .read(T.SummonProperties)
        .into(as_map(T.SummonProperties.ID, T.SummonProperties.Control))
    )

    effect_rows = (
        flow("a spell's effects, and who each is aimed at")
        .read(
            T.SpellEffect,
        )
        .narrow(T.SpellEffect.SpellID, "names.names")
        .lookup(T.SpellEffect.ImplicitTarget[0], "target_bits", into="bit_a", default=NO_TARGET)
        .lookup(T.SpellEffect.ImplicitTarget[1], "target_bits", into="bit_b", default=NO_TARGET)
        .map("mask", bits_of(c.bit_a, c.bit_b))
        .map("amount", coalesce(T.SpellEffect.EffectBasePoints, T.SpellEffect.EffectBasePointsF, digits=1))
    )
    """The mask is the union of the row's two implicit targets; an implicit target
    the build does not name contributes nothing. The amount is whichever of the two
    spellings this build exports."""

    masked = as_masked(T.SpellEffect.SpellID, MISC0, c.mask)
    """Where a payload of one reference lands: the ids per spell, each pair masked."""

    effects = effect_rows.split(
        SpellEffectRows,
        morphs=flow("morphs")
        .when(T.SpellEffect.EffectAura, AURA_TRANSFORM, [reference(MISC0, T.creature_template)])
        .into(masked),
        forms=flow("forms")
        .when(T.SpellEffect.EffectAura, AURA_SHAPESHIFT, [reference(MISC0, ShapeshiftForm)])
        .into(masked),
        vehicles=flow("vehicles")
        .when(T.SpellEffect.EffectAura, AURA_SET_VEHICLE_ID, [reference(MISC0, T.Vehicle)])
        .into(masked),
        invis=flow("invis")
        .when(
            T.SpellEffect.EffectAura,
            AURA_MOD_INVISIBILITY,
            [vocabulary(MISC0, "invisibility_types", zero_is_a_value=True)],
        )
        .into(masked),
        detect=flow("detect")
        .when(
            T.SpellEffect.EffectAura,
            AURA_MOD_INVISIBILITY_DETECT,
            [vocabulary(MISC0, "invisibility_types", zero_is_a_value=True)],
        )
        .into(masked),
        screens=flow("screens")
        .when(T.SpellEffect.EffectAura, AURA_SCREEN_EFFECT, [reference(MISC0, T.ScreenEffect)])
        .narrow(MISC0, "screens")
        .into(masked),
        keybinds=flow("keybinds")
        .when(T.SpellEffect.EffectAura, AURA_KEYBOUND_OVERRIDE, [reference(MISC0, T.SpellKeyboundOverride)])
        .narrow(MISC0, "keybinds")
        .into(masked),
        altnames=flow("altnames")
        .when(T.SpellEffect.EffectAura, AURA_OVERRIDE_NAME, [reference(MISC0, T.SpellOverrideName)])
        .into(as_sets(T.SpellEffect.SpellID, MISC0)),
        anim_sets=flow("anim sets")
        .when(T.SpellEffect.EffectAura, AURA_ANIM_REPLACEMENT_SET, [reference(MISC0, "AnimReplacementSet")])
        .into(masked),
        factions=flow("factions")
        .when(T.SpellEffect.EffectAura, AURA_MOD_FACTION, [reference(MISC0, T.FactionTemplate)])
        .into(masked),
        objects=flow("objects")
        .any_of(
            when(T.SpellEffect.Effect, sorted(EFFECT_SPAWN_OBJECT), [reference(MISC0, T.gameobject_template)]),
            when(
                T.SpellEffect.Effect,
                sorted(RETIRED_SPAWN_OBJECT_EFFECTS),
                [reference(MISC0, T.gameobject_template)],
                until=SPAWN_OBJECT_SLOTS_UNTIL,
            ),
        )
        .into(masked),
        summons=flow("summons")
        .when(
            T.SpellEffect.Effect,
            EFFECT_SUMMON,
            [reference(MISC0, T.creature_template), reference(MISC1, T.SummonProperties, zero_is_a_value=True)],
        )
        .lookup(MISC1, "summon_controls", into="control", default=0)
        .into(as_sets(T.SpellEffect.SpellID, MISC0, c.control)),
        summon_targets=flow("summon targets")
        .when(
            T.SpellEffect.Effect,
            EFFECT_SUMMON,
            [reference(MISC0, T.creature_template), reference(MISC1, T.SummonProperties, zero_is_a_value=True)],
        )
        .into(as_map((T.SpellEffect.SpellID, MISC0), c.mask, reduce=or_)),
        activations=flow("activations")
        .when(
            T.SpellEffect.Effect,
            EFFECT_ACTIVATE_OBJECT,
            [vocabulary(MISC0, "gameobject_actions", zero_is_a_value=True), parameter(MISC1, zero_is_a_value=True)],
        )
        .into(as_sets(T.SpellEffect.SpellID, MISC0, MISC1)),
        activation_targets=flow("activation targets")
        .when(
            T.SpellEffect.Effect,
            EFFECT_ACTIVATE_OBJECT,
            [vocabulary(MISC0, "gameobject_actions", zero_is_a_value=True), parameter(MISC1, zero_is_a_value=True)],
        )
        .into(as_map((T.SpellEffect.SpellID, MISC0, MISC1), c.mask, reduce=or_)),
        sounds=flow("sounds")
        .when(T.SpellEffect.Effect, sorted(EFFECT_PLAYS_SOUND), [reference(MISC0, T.SoundKit)])
        .into(as_map((T.SpellEffect.SpellID, MISC0), c.mask, reduce=or_)),
        speeds=flow("speeds")
        .when(T.SpellEffect.EffectAura, sorted(SPEED_AURAS), [amount(AMOUNT, "percent")])
        .where(c.amount != 0)
        .lookup(T.SpellEffect.EffectAura, SPEED_AURAS, into="movement")
        .into(as_sets(T.SpellEffect.SpellID, text(c.movement), real(c.amount))),
        speed_targets=flow("speed targets")
        .when(T.SpellEffect.EffectAura, sorted(SPEED_AURAS), [amount(AMOUNT, "percent")])
        .where(c.amount != 0)
        .lookup(T.SpellEffect.EffectAura, SPEED_AURAS, into="movement")
        .into(as_map((T.SpellEffect.SpellID, text(c.movement), real(c.amount)), c.mask, reduce=or_)),
        scales=flow("scales")
        .when(T.SpellEffect.EffectAura, sorted(SCALE_AURAS), [amount(AMOUNT, "percent")])
        .where(c.amount != 0)
        .into(as_sets(T.SpellEffect.SpellID, real(c.amount))),
        scale_targets=flow("scale targets")
        .when(T.SpellEffect.EffectAura, sorted(SCALE_AURAS), [amount(AMOUNT, "percent")])
        .where(c.amount != 0)
        .into(as_map((T.SpellEffect.SpellID, real(c.amount)), c.mask, reduce=or_)),
        numbers=flow("numbers")
        .where(
            BASE
            & (
                (T.SpellEffect.EffectMechanic != 0)
                | (T.SpellEffect.EffectItemType != 0)
                | (T.SpellEffect.EffectRadiusIndex[0] != 0)
                | (T.SpellEffect.EffectRadiusIndex[1] != 0)
                | (T.SpellEffect.EffectPos_facing != 0)
                | (T.SpellEffect.EffectChainAmplitude != 1)
                | (T.SpellEffect.EffectBonusCoefficient != 0)
                | (T.SpellEffect.BonusCoefficientFromAP != 0)
                | (T.SpellEffect.EffectRealPointsPerLevel != 0)
                | (T.SpellEffect.EffectPointsPerResource != 0)
                | (T.SpellEffect.PvpMultiplier != 1)
                | (T.SpellEffect.Variance != 0)
            )
        )
        .into(
            as_rows(
                EffectNumbers,
                T.SpellEffect.SpellID,
                T.SpellEffect.EffectIndex,
                T.SpellEffect.EffectMechanic,
                T.SpellEffect.EffectItemType,
                T.SpellEffect.EffectRadiusIndex[0],
                T.SpellEffect.EffectRadiusIndex[1],
                real(T.SpellEffect.EffectPos_facing),
                real(T.SpellEffect.EffectChainAmplitude),
                real(T.SpellEffect.EffectBonusCoefficient),
                real(T.SpellEffect.BonusCoefficientFromAP),
                real(T.SpellEffect.EffectRealPointsPerLevel),
                real(T.SpellEffect.EffectPointsPerResource),
                real(T.SpellEffect.PvpMultiplier),
                real(T.SpellEffect.Variance),
                sort=True,
            )
        ),
        multipliers=flow("value multipliers")
        .where(
            BASE
            & (T.SpellEffect.EffectAmplitude != 0)
            & (
                T.SpellEffect.Effect.among(VALUE_MULTIPLIER_EFFECTS)
                | T.SpellEffect.EffectAura.among(VALUE_MULTIPLIER_AURAS)
            )
        )
        .into(as_map((T.SpellEffect.SpellID, T.SpellEffect.EffectIndex), real(T.SpellEffect.EffectAmplitude))),
        links=flow("links")
        .where((T.SpellEffect.EffectTriggerSpell != 0) & (T.SpellEffect.EffectTriggerSpell != T.SpellEffect.SpellID))
        .narrow(T.SpellEffect.EffectTriggerSpell, "names.names")
        .into(
            as_ids(
                T.SpellEffect.SpellID, T.SpellEffect.EffectTriggerSpell, T.SpellEffect.Effect, T.SpellEffect.EffectAura
            )
        ),
        link_targets=flow("link targets")
        .where((T.SpellEffect.EffectTriggerSpell != 0) & (T.SpellEffect.EffectTriggerSpell != T.SpellEffect.SpellID))
        .narrow(T.SpellEffect.EffectTriggerSpell, "names.names")
        .into(as_map((T.SpellEffect.SpellID, T.SpellEffect.EffectTriggerSpell), c.mask, reduce=or_)),
        cast_target_bits=flow("cast targets").into(as_map(T.SpellEffect.SpellID, c.mask, reduce=or_)),
        aura_target_bits=flow("aura targets")
        .where(T.SpellEffect.Effect == EFFECT_APPLY_AURA)
        .into(as_map(T.SpellEffect.SpellID, c.mask, reduce=or_)),
        mechanics=landing(
            (
                flow("mechanics")
                .where((T.SpellEffect.Effect != 0) | (T.SpellEffect.EffectAura != 0))
                .into(
                    as_rows(
                        EffectRow,
                        T.SpellEffect.SpellID,
                        T.SpellEffect.Effect,
                        T.SpellEffect.EffectAura,
                        T.SpellEffect.ImplicitTarget[0],
                        T.SpellEffect.ImplicitTarget[1],
                        MISC0,
                        MISC1,
                        flag(c.consumed_Effect),
                        flag(c.consumed_EffectAura),
                        T.SpellEffect.EffectIndex,
                        T.SpellEffect.EffectAuraPeriod,
                        T.SpellEffect.EffectChainTargets,
                        T.SpellEffect.EffectAttributes,
                    )
                )
            ).then(set)
        ),
    )
    """A zero amount is dropped: a pill made of nothing but the number would
    promise a change and deliver none. A payload naming a roster drops a value the
    build has nothing to show for. The mechanics rows are every distinct effect,
    each half flagged where a branch landed it, so a value whose payload was
    dropped stays raw and unflagged. The link through the trigger column selects
    nothing: every row carries it."""

    spell_radii = (
        flow("how far each radius reaches")
        .read(T.SpellRadius, optional=True)
        .into(as_map(T.SpellRadius.ID, real(T.SpellRadius.Radius)))
    )

    spell_cones = (
        flow("the cone or line a spell's area takes")
        .read(TargetRestrictions, optional=True)
        .where(BASE & ((TargetRestrictions.ConeDegrees != 0) | (TargetRestrictions.Width != 0)))
        .narrow(TargetRestrictions.SpellID, "names.names")
        .into(
            as_rows(
                Cone,
                TargetRestrictions.SpellID,
                real(TargetRestrictions.ConeDegrees),
                real(TargetRestrictions.Width),
                sort=True,
            )
        )
    )

    # The numbers a description asks for, read from the client's own tables and
    # never the server's revisions: a hotfix prints a float at six significant
    # digits and carries only the integer spelling of an amount, so on a build
    # whose client exports only the float column the overlay would replace a
    # precise value with a coarse one.

    effect_values = (
        flow("the numbers a template asks of each effect")
        .read(
            T.SpellEffect,
            revised=False,
        )
        .where(BASE)
        .join(
            T.SpellEffect.SpellID,
            T.SpellScaling,
            by=T.SpellScaling.SpellID,
            revised=False,
        )
        .join(T.SpellEffect.EffectRadiusIndex[0], T.SpellRadius, revised=False)
        .map("amount", coalesce(T.SpellEffect.EffectBasePoints, T.SpellEffect.EffectBasePointsF, digits=1))
        .map("spread", coalesce(T.SpellEffect.Variance, digits=1))
        .map("reached", coalesce(T.SpellRadius.Radius, digits=1))
        .split(
            EffectValues,
            points=(
                flow("points").into(
                    as_rows(
                        PointRow,
                        T.SpellEffect.SpellID,
                        typed(T.SpellEffect.EffectIndex, effect_number),
                        real(c.amount),
                        T.SpellEffect.ScalingClass,
                        typed(T.SpellEffect.Coefficient, tenth),
                        T.SpellScaling.MinScalingLevel,
                        T.SpellScaling.MaxScalingLevel,
                    )
                )
            ).then(resolve_points, level="level", scaling="scaling"),
            variance=flow("variance")
            .where(c.spread != 0)
            .into(as_nested(T.SpellEffect.SpellID, typed(T.SpellEffect.EffectIndex, effect_number), real(c.spread))),
            period=flow("period")
            .where(T.SpellEffect.EffectAuraPeriod != 0)
            .into(
                as_nested(
                    T.SpellEffect.SpellID,
                    typed(T.SpellEffect.EffectIndex, effect_number),
                    T.SpellEffect.EffectAuraPeriod,
                )
            ),
            radius=flow("radius")
            .where(c.reached != 0)
            .into(as_nested(T.SpellEffect.SpellID, typed(T.SpellEffect.EffectIndex, effect_number), real(c.reached))),
            chain_targets=flow("chain targets")
            .where(T.SpellEffect.EffectChainTargets != 0)
            .into(
                as_nested(
                    T.SpellEffect.SpellID,
                    typed(T.SpellEffect.EffectIndex, effect_number),
                    T.SpellEffect.EffectChainTargets,
                )
            ),
            misc_value=flow("misc value")
            .where(T.SpellEffect.EffectMiscValue[0] != 0)
            .into(
                as_nested(
                    T.SpellEffect.SpellID,
                    typed(T.SpellEffect.EffectIndex, effect_number),
                    T.SpellEffect.EffectMiscValue[0],
                )
            ),
        )
    )
    """Base difficulty only, and a zero is left out rather than recorded, so the
    cooker elides the code instead of substituting nothing."""

    spell_durations = (
        flow("how long a spell lasts")
        .read(T.SpellMisc, revised=False)
        .where(BASE)
        .join(T.SpellMisc.DurationIndex, T.SpellDuration, inner=True, revised=False)
        .into(as_map(T.SpellMisc.SpellID, T.SpellDuration.Duration))
    )

    spell_ranges = (
        flow("how far a spell's description says it reaches")
        .read(T.SpellMisc, revised=False)
        .where(BASE)
        .join(T.SpellMisc.RangeIndex, T.SpellRange, inner=True, revised=False)
        .map("distance", coalesce(T.SpellRange.RangeMax[0], digits=1))
        .where(c.distance != 0)
        .into(as_map(T.SpellMisc.SpellID, real(c.distance)))
    )

    aura_caps = (
        flow("what an aura's options cap")
        .read(
            T.SpellAuraOptions,
            revised=False,
        )
        .where(BASE)
    )

    spell_stack_caps = aura_caps.where(T.SpellAuraOptions.CumulativeAura != 0).into(
        as_map(T.SpellAuraOptions.SpellID, T.SpellAuraOptions.CumulativeAura)
    )

    spell_charges = aura_caps.where(T.SpellAuraOptions.ProcCharges != 0).into(
        as_map(T.SpellAuraOptions.SpellID, T.SpellAuraOptions.ProcCharges)
    )

    spell_proc_chances = aura_caps.where(T.SpellAuraOptions.ProcChance != 0).into(
        as_map(T.SpellAuraOptions.SpellID, T.SpellAuraOptions.ProcChance)
    )

    target_caps = (
        flow("what a spell's targeting caps")
        .read(
            TargetRestrictions,
            revised=False,
        )
        .where(BASE)
    )

    spell_target_caps = target_caps.where(TargetRestrictions.MaxTargets != 0).into(
        as_map(TargetRestrictions.SpellID, TargetRestrictions.MaxTargets)
    )

    spell_target_levels = target_caps.where(TargetRestrictions.MaxTargetLevel != 0).into(
        as_map(TargetRestrictions.SpellID, TargetRestrictions.MaxTargetLevel)
    )

    values = compose(
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
    )
    """None of it reaches the pack; only the substituted text does."""

    # The prose.

    spell_descriptions = (
        flow("what the tooltip says the cast does")
        .read(T.Spell)
        .where(~T.Spell.Description_lang.is_empty())
        .into(as_map(T.Spell.ID, text(T.Spell.Description_lang)))
    )
    """Unfiltered against the spell list: a template routinely redirects to a
    spell that has no name row of its own."""

    spell_aura_texts = (
        flow("what the buff says while it is on you")
        .read(T.Spell)
        .where(~T.Spell.AuraDescription_lang.is_empty())
        .into(as_map(T.Spell.ID, text(T.Spell.AuraDescription_lang)))
    )

    spell_variables = (
        flow("the named variable bodies a description may interpolate")
        .read(
            T.SpellXDescriptionVariables,
        )
        .join(
            T.SpellXDescriptionVariables.SpellDescriptionVariablesID,
            DescriptionVariables,
            inner=True,
        )
        .into(as_map(T.SpellXDescriptionVariables.SpellID, typed(DescriptionVariables.Variables, assignments)))
    ).then(nonzero)

    # Where a spell may be cast.

    area_parents = flow("each area's parent").read(T.AreaTable).into(as_map(T.AreaTable.ID, T.AreaTable.ParentAreaID))

    areas = (
        flow("where a spell may be cast")
        .read(CastingRequirements)
        .where(CastingRequirements.RequiredAreasID != 0)
        .join(
            CastingRequirements.RequiredAreasID,
            T.AreaGroupMember,
            by=T.AreaGroupMember.AreaGroupID,
            inner=True,
            many=True,
        )
        .join(T.AreaGroupMember.AreaID, T.AreaTable, inner=True)
        .into(as_rows(GateRow, CastingRequirements.SpellID, T.AreaGroupMember.AreaID, text(T.AreaTable.AreaName_lang)))
    ).then(AreaGates.assemble, parents="area_parents", maps="zone_maps")
    """A group naming an area the build has no row for is skipped rather than
    shipped nameless."""


zone_maps = (
    flow("each area's zone map, where one names the same place the area does")
    .read(T.UiMapAssignment)
    .join(T.UiMapAssignment.UiMapID, T.UiMap, inner=True)
    .join(T.UiMapAssignment.AreaID, T.AreaTable, inner=True)
    .where((T.UiMap.Type == UI_MAP_TYPE_ZONE) & (T.UiMap.Name_lang == T.AreaTable.AreaName_lang))
    .into(as_map(T.UiMapAssignment.AreaID, T.UiMapAssignment.UiMapID, reduce=min))
)
"""A given rather than a field: read once in the build's own language and
shared by every other, because the match is between two translated names
and its result must be one fact about the build. Both filters are
load-bearing: type alone reaches continent maps, assignment alone reaches a
neighbour's map."""
