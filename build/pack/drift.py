"""What differs between game builds, declared rather than branched on.

Building an older game version is mostly a story of things that do not exist
yet: db2 tables get introduced, split and renamed as the game evolves, so a
reader written against the newest build asks for columns Legion never had and
tables WotLK never had.

Every difference is declared here and nowhere else. Anything undeclared stays
a hard error, because an unexpected schema change must fail the build loudly
rather than silently lose data. To add a game version, run the build and let it
tell you what is missing, then decide per item whether it belongs here or is a
genuine bug.

Package-root vocabulary, because more than one layer reads it: acquisition
needs to know which downloads may legitimately 404, and whatever serves those
tables needs to know which absences to answer quietly and which columns carry
a stand-in value.
"""

from __future__ import annotations

# table -> the user-facing feature that switches off when the build predates it
OPTIONAL_TABLES = {
    "SpellName": "spell names (pre-BfA they live on Spell itself)",
    # The two map tables are the area pill's OPTIONAL half: without them the
    # pill still names its areas and still links Wowhead, it just offers no
    # `/run OpenWorldMap(id)` button. Confirmed present on 9.2.7; the other nine
    # are undeclared rather than checked, and this is the declaration path
    # exactly so a Classic build lacking them is not a blocker.
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
    # both confirmed present on all ten builds as of 2026-08-05; declared
    # optional anyway so a build that predates one loses only that half of the
    # delivery line rather than failing — no duration reads as "no limit shown",
    # no interrupts reads as "nothing known to break it"
    "SpellDuration": "the channel duration on the delivery line",
    "SpellInterrupts": "the 'breaks on move' half of the delivery line",
    # The description route's optional halves (§3x). A missing table costs the
    # feature nothing structural — spelltext.py elides a value it cannot look
    # up exactly as it elides a caster-dependent one, so the prose still cooks,
    # just without that number. Measured absences: SpellDescriptionVariables
    # 404s on TBC, and the journal tables on Vanilla/TBC/WotLK.
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
    # the raid missile-set variant arrived after Legion; 0 = "no raid set",
    # which is exactly how a present-but-unset row already reads
    ("SpellVisual", "RaidSpellVisualMissileSetID"): "0",
    # the reduced-camera-movement variant is missing on Legion and BfA only
    # (present either side of them); 0 = "no variant", same as an unset row
    ("SpellVisual", "ReducedUnexpectedCameraMovementSpellVisualID"): "0",
    # Legion's FullScreenEffect has the colour grade but no overlay art yet
    ("FullScreenEffect", "OverlayTextureFileDataID"): "0",
    # An effect's amount (the movement-speed percent, among much else) is
    # exported under two spellings and EVERY build has exactly one of them
    # populated — so both are declared optional and read in order, int first.
    # The int column is the real one wherever it exists (through Legion); the
    # float replaced it in BfA. The overlap builds are the trap: Vanilla, TBC
    # and MoP export BOTH, and there the float is vestigial — 46 of 40,249 rows
    # nonzero on Vanilla, and zero on 771 of 783 speed rows — so preferring the
    # float would silently blank those packs.
    ("SpellEffect", "EffectBasePoints"): "",
    ("SpellEffect", "EffectBasePointsF"): "",
    # effect attach points (§3): the Classic re-release clients carry the effect
    # tables but not their attach column (irregularly — Vanilla's DissolveEffect
    # has AttachID, TBC's does not). -1 is exactly a present-but-unset row: the
    # whole body, "full body", which is what an effect with no anchor animates.
    ("ShadowyEffect", "AttachPos"): "-1",
    ("DissolveEffect", "AttachID"): "-1",
    ("BarrageEffect", "AttachmentPoint"): "-1",
}

# Spell names moved: SpellName.db2 was split out of Spell.db2 in BfA, so Legion
# and earlier carry the name on Spell itself. First candidate whose table this
# build actually has wins. (Both spellings are "ID" + a localised name column,
# so the reader downstream is identical.)
SPELL_NAME_SOURCES = [
    ("SpellName", ["ID", "Name_lang"]),
    ("Spell", ["ID", "Name_lang"]),
]
# The same three kinds of drift exist on the TrinityCore side, since a TDB
# release tracks the server schema of its era. Declared separately from the
# wago-side maps above because the table names live in a different namespace.
TDB_OPTIONAL_TABLES = {
    # split out of creature_template's modelid1..4 columns after the Legion era
    "creature_template_model": "creature displays (legacy dumps keep them on creature_template)",
}
TDB_OPTIONAL_COLUMNS = {
    # the legacy spelling: present on Legion-era dumps, gone once the
    # creature_template_model table took over
    ("creature_template", "modelid1"): "0",
    ("creature_template", "modelid2"): "0",
    ("creature_template", "modelid3"): "0",
    ("creature_template", "modelid4"): "0",
}

# Creature -> display id moved on the TrinityCore side too: Legion-era world
# dumps keep up to four display ids as modelid1..4 ON creature_template, later
# releases split them into their own table. Whichever the release has wins.
CREATURE_DISPLAY_SOURCES = [
    ("creature_template_model", ["CreatureID", "Idx", "CreatureDisplayID"]),
    ("creature_template", ["entry", "modelid1", "modelid2", "modelid3", "modelid4"]),
]
