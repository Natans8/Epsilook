"""What differs between game builds, declared rather than branched on.

Every difference is declared here and nowhere else; anything undeclared is a
hard error. To add a game version, run the build, let it name what is missing,
and decide per item whether it belongs here or is a bug.
"""

from __future__ import annotations

# table -> the user-facing feature that switches off when the build predates it
OPTIONAL_TABLES = {
    "SpellName": "spell names (pre-BfA they live on Spell itself)",
    # Without these the area pill still names its areas and links Wowhead; it
    # only loses the map button.
    "UiMap": "zone map ids for the area pill's map command",
    "UiMapAssignment": "AreaID -> UiMapID, the only bridge from an area to a map",
    "BeamEffect": "the BeamEffect route into chain/beam fx",
    "SpellEffectEmission": "area-emitter models",
    "SpellVisualKitAreaModel": "area models",
    "WeaponTrail": "weapon-trail models",
    "BarrageEffect": "barrage models",
    "DissolveEffect": "the dissolve fx category",
    "TextureBlendSet": "dissolve materials + screen mask textures",
    "EdgeGlowEffect": "the glow fx category",
    "ShadowyEffect": "the ghost/shadowy fx category",
    "SpellVisualScreenEffect": "the kit route into screen fx",
    "ScreenEffect": "the screen fx category",
    "FullScreenEffect": "screen fx colour grading + overlay textures",
    "AnimReplacement": "anim-replacement sets (aura 312)",
    "SpellShapeshiftForm": "the shapeshift fx category",
    "SpellOverrideName": "override names in the search corpus",
    "SummonProperties": "summon control words (guardian/pet/...)",
    "Vehicle": "the vehicle fx category",
    "VehicleSeat": "vehicle seat attachments and passenger animations",
    "Mount": "the mount model pills",
    "MountXDisplay": "mount -> display id resolution",
    "GameObjectDisplayInfo": "gameobject model files (names still resolve)",
    # arrives in MoP (5.0.1); 404s on Vanilla/TBC/WotLK/Cata
    "SpellKeyboundOverride": "the keybind fx category (aura 406)",
    # Absent, these read as "no limit shown" and "nothing known to break it".
    "SpellDuration": "the channel duration on the delivery line",
    "SpellInterrupts": "the 'breaks on move' half of the delivery line",
    # A missing table elides that value from the cooked prose, nothing more.
    "SpellRadius": "radii inside cooked descriptions ($A1 yards)",
    "SpellRange": "ranges inside cooked descriptions ($r yards)",
    "SpellDescriptionVariables": "the named $<var> bodies in descriptions",
    "SpellXDescriptionVariables": "spell -> description-variable set",
    "SpellTargetRestrictions": "max-target counts inside cooked descriptions",
    "SpellAuraOptions": "stack caps and proc chances inside cooked descriptions",
    "JournalEncounterSection": "dungeon-journal notes on a boss ability",
}
# (table, column) -> the value to use on builds that lack the column
OPTIONAL_COLUMNS = {
    # the raid missile-set variant arrived after Legion; 0 = "no raid set"
    ("SpellVisual", "RaidSpellVisualMissileSetID"): "0",
    # missing on Legion and BfA only; 0 = "no variant"
    ("SpellVisual", "ReducedUnexpectedCameraMovementSpellVisualID"): "0",
    # Legion's FullScreenEffect has the colour grade but no overlay art yet
    ("FullScreenEffect", "OverlayTextureFileDataID"): "0",
    # Both spellings of an effect's amount, read in order, int first: the int
    # column is the real one through Legion, the float replaced it in BfA, and
    # Vanilla, TBC and MoP export both with the float vestigial.
    ("SpellEffect", "EffectBasePoints"): "",
    ("SpellEffect", "EffectBasePointsF"): "",
    # The Classic re-release clients carry the effect tables but not their
    # attach column, irregularly. -1 is a present-but-unset row: the whole
    # body, which is what an effect with no anchor animates.
    ("ShadowyEffect", "AttachPos"): "-1",
    ("DissolveEffect", "AttachID"): "-1",
    ("BarrageEffect", "AttachmentPoint"): "-1",
}

# SpellName.db2 was split out of Spell.db2 in BfA. The first candidate whose
# table this build has wins; both spellings read the same downstream.
SPELL_NAME_SOURCES = [
    ("SpellName", ["ID", "Name_lang"]),
    ("Spell", ["ID", "Name_lang"]),
]
# The same drift on the TrinityCore side, where the table names differ.
TDB_OPTIONAL_TABLES = {
    # split out of creature_template's modelid1..4 columns after the Legion era
    "creature_template_model": "creature displays (legacy dumps keep them on creature_template)",
}
TDB_OPTIONAL_COLUMNS = {
    # the legacy spelling, gone once creature_template_model took over
    ("creature_template", "modelid1"): "0",
    ("creature_template", "modelid2"): "0",
    ("creature_template", "modelid3"): "0",
    ("creature_template", "modelid4"): "0",
}

# Legion-era world dumps keep up to four display ids on creature_template,
# later releases split them into their own table. Whichever the release has
# wins.
CREATURE_DISPLAY_SOURCES = [
    ("creature_template_model", ["CreatureID", "Idx", "CreatureDisplayID"]),
    ("creature_template", ["entry", "modelid1", "modelid2", "modelid3", "modelid4"]),
]
