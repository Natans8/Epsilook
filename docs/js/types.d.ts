/* Shared type declarations for the Epsilook scripts (dev-time only — this
 * file is never served or loaded by the browser; jsconfig.json pulls it in
 * so every // @ts-check'd script sees the same shapes).
 *
 * The scripts are classic globals, not modules: config.js, data.js and
 * search.js each publish one object on window, and app.js consumes them.
 * These interfaces describe those objects plus the two data shapes that
 * flow between them — the JSON pack baked by build/build_data.py and the
 * in-memory indexes data.js builds from it. */

/* ------------------------------------------------------------- config */

/** One copy-command button on a spell row ({id} = spell ID). */
interface SpellCommand {
    label: string;
    template: string;
    hint: string;
}

/** The user-tunable surface (docs/js/config.js). */
interface EpsilookConfig {
    spellCommands: SpellCommand[];
    modelCopyTemplate: string;
    animCopyTemplate: string;
    soundKitCopyTemplate: string;
    animKitCopyTemplate: string;
    morphCopyTemplate: string;
    morphLookupTemplate: string;
    summonLookupTemplate: string;
    summonSpawnTemplate: string;
    objectLookupTemplate: string;
    objectSpawnTemplate: string;
    mountModifyTemplate: string;
    itemLookupTemplate: string;
    itemAddTemplate: string;
    wowheadSpellUrl: string;
    wowheadSoundUrl: string;
    wowheadMorphUrl: string;
    wowheadNpcUrl: string;
    wowheadItemUrl: string;
    wowheadObjectUrl: string;
    wowheadObjectTypes: number[];
    /** Wowhead site path prefix keyed by game major version ("classic/" for 1);
     *  unlisted versions fall back to retail (empty prefix). */
    wowheadSitePrefix: Record<number, string>;
    modelViewerUrl: string;
    soundPlayUrl: string;
    soundVolume: number;
    texturePreviewUrl: string;
    texturePreviewMax: number;
    /** Expansion logo per build MAJOR version, e.g. 9 -> Shadowlands. */
    expansionLogos: Record<number, { name: string; fid: number }>;
    /** Rendered height of that logo, in CSS pixels. */
    expansionLogoHeight: number;
    spellIconUrl: string;
    discordCharLimit: number;
    scrollBatch: number;
    collapsedRowHeight: number;
    searchDebounceMs: number;
    minQueryLength: number;
}

/* ----------------------------------------------------------- the pack */

/** One entry of docs/data/versions.json (the version manifest). */
interface VersionEntry {
    /** Full build id, e.g. "9.2.7.45745". */
    id: string;
    /** Display label, e.g. "Shadowlands". */
    label: string;
    /** Pack path relative to docs/, e.g. "data/9.2.7.45745/pack.json.gz". */
    file: string;
    /** Content hash appended as ?v= to bust the browser cache on data change. */
    hash?: string;
    /**
     * Reachable only through an explicit ?v= in the URL: kept out of the version
     * dropdown and never chosen as the default, so the pack is downloaded only
     * by someone who asked for it by name.
     */
    hidden?: boolean;
    /**
     * The pack to load when the URL names no version. At most one entry carries
     * it; without any, the newest visible pack wins.
     */
    default?: boolean;
}

/**
 * The gzipped column-oriented JSON pack build/build_data.py bakes per game
 * version (pack format 19). Parallel arrays throughout: `{spellIds, fids}`
 * means row i links spellIds[i] to fids[i]. Sections marked optional
 * arrived in later pack formats — data.js guards each so a stale cached
 * pack (or an old format on disk) still loads.
 */
interface SpellPack {
    meta: {
        listfileTag: string;
        built: string;
        counts: { spells: number; [k: string]: number };
        [k: string]: unknown;
    };
    /** Core spell columns; altNames (format 19+) = SpellOverrideName texts,
     *  searchable but never displayed. icons index into iconNames, 1-based,
     *  0 = none. */
    spells: {
        ids: number[];
        names: string[];
        subtexts: string[];
        icons?: number[];
        altNames?: string[];
    };
    iconNames?: string[];
    /** FileDataID -> listfile path (all models, sounds and textures). */
    files: { fids: number[]; paths: string[] };

    /** Spell -> model file; cats (format 15+) = usage category per row. */
    spellModels: {
        spellIds: number[]; fids: number[]; cats?: number[]; targets?: number[];
        /** Raw M2 attachment ids, -1 = unset (pack format 24+). Attached models
         *  use src only; missiles use both (launch -> impact). */
        srcAttach?: number[]; dstAttach?: number[];
        /** Ref id: CreatureDisplayID (display cat) or Item::ID (item cat), 0 else
         *  (format 28+). Format 27 shipped it as displayIds (display rows only). */
        refIds?: number[]; displayIds?: number[]
    };
    /** Items reached by "item"-category rows (format 28+), parallel by item id.
     *  names[i] is "" for a nameless item; icons[i] is a 1-based index into
     *  itemIconNames (0 = none); qualities[i] indexes itemQualityNames (-1 = none). */
    items?: { ids: number[]; names: string[]; qualities: number[]; icons: number[] };
    itemIconNames?: string[];
    itemQualityNames?: Record<number, string>;
    /** Raw M2 attachment id -> name (pack format 24+). */
    attachmentNames?: Record<number, string>;
    /** Category id -> word ("attached", "missile", "area", "trail", "barrage", "item"). */
    modelCatNames?: Record<number, string>;
    /** mask bit -> search word ("caster"/"target"/"area"); format 22+ */
    targetNames?: Record<number, string>;

    /** Spell -> (SoundKit, sound file) rows. */
    spellSounds: { spellIds: number[]; soundKitIds: number[]; fids: number[]; targets?: number[] };

    spellAnimKits: { spellIds: number[]; animKitIds: number[]; targets?: number[] };
    /** Animation names indexed by AnimID. */
    animNames: string[];
    animKitAnims: { animKitIds: number[]; animIds: number[] };
    /** Animation replacements — proc Type 7 + aura 312 merged (format 32+):
     *  one row per (base anim -> replacement anim). */
    spellReplaceAnims?: { spellIds: number[]; srcAnims: number[]; dstAnims: number[] };
    /** Animations the kits play directly, SpellVisualAnim ET 6 (format 21+). */
    spellVisualAnims?: { spellIds: number[]; animIds: number[]; targets?: number[] };

    /* --- visual fx sections (the Effects column) --- */

    /** Spell -> SpellChainEffects (chain/beam) rows. */
    spellFx: {
        spellIds: number[]; chainIds: number[]; targets?: number[];
        /** The drawing beam's attach points (format 24+), -1 = unset. */
        srcAttach?: number[]; dstAttach?: number[]
    };
    /** Chain tint as packed 0xRRGGBB (0xFFFFFF = untinted) + baked hue word. */
    fxChains: { ids: number[]; colors: number[]; hues: string[] };
    fxTextures: { chainIds: number[]; fids: number[] };

    spellDissolves: { spellIds: number[]; dissolveIds: number[]; targets?: number[] };
    /** durations in seconds, 0 = unspecified. */
    dissolves: { ids: number[]; durations: number[] };
    dissolveTextures: { dissolveIds: number[]; fids: number[] };

    spellGlows: { spellIds: number[]; glowIds: number[]; targets?: number[] };
    /** EdgeGlowEffect colors; alphas (format 17+) = GlowAlpha as 0..255. */
    glows: { ids: number[]; colors: number[]; hues: string[]; alphas?: number[] };

    spellShadowies: { spellIds: number[]; shadowyIds: number[]; targets?: number[] };
    /** ShadowyEffect primary/secondary packed RGB pairs. */
    shadowies: {
        ids: number[];
        primaryColors: number[];
        secondaryColors: number[];
        hues: string[];
    };

    /** Ghost material recolors, proc Type 22 (format 14+). */
    spellGhostMats?: { spellIds: number[]; ghostIds: number[]; targets?: number[] };
    ghostMats?: { ids: number[]; colors: number[]; hues: string[] };

    /** Model tints, proc Types 1/23 (format 13+). */
    spellTints?: { spellIds: number[]; tintIds: number[] };
    tints?: { ids: number[]; colors: number[]; hues: string[] };

    /** Percent-payload procs (format 14+): the percent IS the pill id. */
    spellDesaturates?: { spellIds: number[]; percents: number[] };
    spellTransparencies?: { spellIds: number[]; percents: number[] };
    /** Valueless procs (format 14+): membership is the whole payload. */
    spellFreezes?: { spellIds: number[] };
    spellCamos?: { spellIds: number[] };

    /** ScreenEffect rows (format 16+). Colors are packed RGB, -1 = none
     *  (0 is a real black). mask* (format 18+) = the radial vignette params,
     *  maskSize 0 = the row has no FullScreenEffect. */
    spellScreens?: { spellIds: number[]; screenIds: number[] };
    screens?: {
        ids: number[];
        names: string[];
        fogColors: number[];
        fogAlphas?: number[];
        mulColors: number[];
        addColors: number[];
        hues: string[];
        maskOffsetY?: number[];
        maskSize?: number[];
        maskPower?: number[];
    };
    /** roles (format 17+): 0 = overlay art, 1 = blend-set mask. Rows sort
     *  overlays first. */
    screenTextures?: { screenIds: number[]; fids: number[]; roles?: number[] };

    /** Morph (transform aura) creatures; names/displays come from the TDB. */
    spellMorphs: { spellIds: number[]; creatureIds: number[] };
    morphs: { creatureIds: number[]; names: string[] };
    morphDisplays: { creatureIds: number[]; displayIds: number[]; fids: number[] };

    /** Shapeshift forms (format 19+); a form may have no display at all. */
    spellShapeshifts?: { spellIds: number[]; formIds: number[] };
    shapeshifts?: { ids: number[]; names: string[] };
    shapeshiftDisplays?: { formIds: number[]; displayIds: number[]; fids: number[] };

    /** Mounts (format 32+): spell -> CreatureDisplayID, and each display's
     *  mount name and model fid. Client data, so it needs no TDB. */
    spellMounts?: { spellIds: number[]; displayIds: number[] };
    mounts?: { displayIds: number[]; names: string[]; fids: number[] };

    /** GameObject spawners (format 32+): spell -> gameobject_template entry.
     *  Names/models come from the TDB world dump, so both are "" / 0 without one. */
    spellObjects?: { spellIds: number[]; objectIds: number[]; targets?: number[] };
    objects?: { ids: number[]; names: string[]; fids: number[]; types?: number[] };


    /** Summoned creatures with their SummonProperties control per row. */
    spellSummons: { spellIds: number[]; creatureIds: number[]; controls: number[] };
    summons: { creatureIds: number[]; names: string[] };
    /** Control id -> word (1 guardian, 2 pet, ...; 0 shows no word). */
    summonControlNames?: Record<number, string>;

    /** Vehicles (SET_VEHICLE_ID auras): spell -> Vehicle.db2 id, and each
     *  vehicle's seat count. 0-seat vehicles are dropped at build. */
    spellVehicles?: { spellIds: number[]; vehicleIds: number[] };
    vehicles?: { vehicleIds: number[]; seats: number[] };
    /** One row per seat in SeatID_0..7 order: which vehicle it belongs to and
     *  the M2 attachment point it sits at ("" when unset/unknown). */
    vehicleSeats?: { vehicleIds: number[]; attachments: string[] };
    /** Invisibility / detection channels (pack format 26). `types` is the
     *  invisibility TYPE — the pairing key. Only channels with an invis side are
     *  built, so every detect row here has ≥1 invis counterpart. */
    spellInvis?: { spellIds: number[]; types: number[]; targets: number[] };
    spellDetects?: { spellIds: number[]; types: number[]; targets: number[] };
    /** The rider's animations while entering/seated/exiting (a vehicle seat's
     *  passenger AnimationData). animIds index animNames. */
    spellPassengerAnims?: { spellIds: number[]; animIds: number[] };
    /** The vehicle's own animations — rendered as loose pills, not under
     *  "passenger". Same id space. */
    spellVehicleAnims?: { spellIds: number[]; animIds: number[] };
    /** AnimKit ids reached through a vehicle seat; join the animkit groups. */
    spellVehicleAnimKits?: { spellIds: number[]; animKitIds: number[] };

    /* --- mechanics --- */

    /**
     * One row per distinct SpellEffect: what it does (effect + aura enum ids,
     * 0 = neither) and who it is aimed at (ImplicitTarget_0/_1, 0 = unset).
     * Pack format 29+; older packs ship spellEffects/spellAuras instead.
     */
    spellMechanics?: {
        spellIds: number[]; effects: number[]; auras: number[];
        targetsA: number[]; targetsB: number[];
    };
    /** Flat per-spell sets, pack format <= 28 only. */
    spellEffects?: { spellIds: number[]; effects: number[] };
    spellAuras?: { spellIds: number[]; auras: number[] };
    /** SpellEffect enum id -> name without the SPELL_EFFECT_ prefix. */
    effectNames: Record<string, string>;
    /** SpellEffectAura enum id -> name without the SPELL_AURA_ prefix. */
    auraNames: Record<string, string>;
    /** ImplicitTarget enum id -> name without the TARGET_ prefix. */
    implicitTargetNames?: Record<string, string>;
    /** ImplicitTarget enum id -> the caster/target/area bits it contributes. */
    implicitTargetBits?: Record<string, number>;

    /* --- keybound overrides (aura 406) --- */

    spellKeybinds?: { spellIds: number[]; overrideIds: number[]; targets: number[] };
    /**
     * Per SpellKeyboundOverride row: the client keybinding name, the word for
     * when it applies ("" = ordinary press, "mid-air" = airborne) and the
     * Spell::ID the retail client casts in its place (which this build may no
     * longer ship, and which the app deliberately does not display).
     */
    keybinds?: { ids: number[]; functions: string[]; whens: string[]; spells: number[] };

    /* --- movement-speed modifiers (SPEED_AURAS) --- */

    /**
     * One row per (spell, movement, percent). `movements` is the movement the
     * aura scales — "run", "mounted", "swim", "flight", or "all" for the one
     * aura that reaches every type — and `percents` the signed change.
     */
    spellSpeeds?: {
        spellIds: number[]; movements: string[]; percents: number[]; targets: number[];
    };

    /* --- object-scale modifiers (SCALE_AURAS) --- */

    /**
     * One row per (spell, percent). `percents` is the signed change to the
     * unit's scale — there is only one thing these auras scale, so unlike
     * spellSpeeds there is no word beside the number.
     */
    spellScales?: { spellIds: number[]; percents: number[]; targets: number[] };
}

/* ------------------------------------------------- in-memory indexes */

/** One listfile entry as indexed by data.js. */
interface FileEntry {
    fid: number;
    path: string;
    /** File name without the directory part ("" when the path is unknown). */
    base: string;
    /** Lowercased path — the substring-search corpus. */
    searchL: string;
}

/** A creature-display reference on a morph / shapeshift pill. */
interface DisplayRef {
    displayId: number;
    fid: number;
}

/**
 * The lookup structures every search and render runs against — built once
 * per pack by EpsilookData.buildIndexes. Naming convention: `spellXs` maps
 * spell id -> its Xs, `xSpells` maps an X id -> spell ids using it, and
 * `xSearchL` maps an X id -> its lowercase search corpus (category word +
 * payload words, matched by substring).
 */
interface SpellData {
    meta: SpellPack["meta"];
    /** Spell ids, names, subtexts as parallel arrays (pack order). */
    ids: number[];
    names: string[];
    subtexts: string[];
    /** Icon name per spell ("" = none). */
    icons: string[];
    /** Lowercased "name subtext altnames" search corpus per spell. */
    namesL: string[];
    /** Spell id -> index into the parallel arrays. */
    spellIndex: Map<number, number>;
    files: Map<number, FileEntry>;
    /** Does `files` hold any fileless sentinel (negative fid, synthetic label)? */
    hasSyntheticFiles: boolean;

    spellModels: Map<number, number[]>;
    /** Raw M2 attachment id -> name; {} on packs before format 24. */
    attachmentNames: Record<number, string>;
    /** spell -> chain rows carrying the drawing beam's attach points. */
    spellChainRows: Map<number, { chain: number; src: number; dst: number }[]>;
    modelSpells: Map<number, number[]>;
    /** All fids referenced as models (the model-search scope). */
    modelFids: number[];
    /** Per-(fid, category) view; empty Maps on a stale pack without cats. */
    spellModelCats: Map<number, {
        fid: number; cat: number; targets: number;
        /** Raw M2 attachment ids, -1 = unset. */
        src: number; dst: number;
        /** Ref id: CreatureDisplayID (display cat) or Item::ID (item cat); 0 else. */
        ref: number;
    }[]>;
    /** Item::ID -> {name, quality, icon} for "item"-category rows (format 28+).
     *  name "" = a nameless item (renders as a plain model pill). */
    items: Map<number, { name: string; quality: string; icon: string }>;
    /** Item::ID -> its search corpus (name / quality / id). */
    itemSearchL: Map<number, string>;
    /** Item::ID -> the spells that reach it, for model:"item <name>" search. */
    itemSpells: Map<number, Set<number>>;
    modelCatSpells: Map<number, Set<number>>;
    modelCatFidSpells: Map<number, Map<number, number[]>>;
    /** Category id -> word; "" means the category renders as loose pills. */
    modelCatNames: Record<number, string>;

    /**
     * Who each row's content plays on: a mask of TARGET_BITS (1 caster,
     * 2 target, 4 area, 8 target-never-caster, 16 missile destination),
     * unioned over every kit the spell reaches the content through. 0 means
     * the content came from outside the event graph (missile sets) and has no
     * target type. Empty Maps on a pack older than format 22.
     */
    targetNames: Record<number, string>;
    animKitTargets: Map<number, Map<number, number>>;
    visualAnimTargets: Map<number, Map<number, number>>;
    fxTargets: Map<number, Map<number, number>>;
    dissolveTargets: Map<number, Map<number, number>>;
    glowTargets: Map<number, Map<number, number>>;
    shadowyTargets: Map<number, Map<number, number>>;
    ghostMatTargets: Map<number, Map<number, number>>;
    morphTargets: Map<number, Map<number, number>>;
    summonTargets: Map<number, Map<number, number>>;
    objectTargets: Map<number, Map<number, number>>;
    vehicleTargets: Map<number, Map<number, number>>;
    shapeshiftTargets: Map<number, Map<number, number>>;
    screenTargets: Map<number, Map<number, number>>;

    spellSounds: Map<number, { soundKitId: number; fid: number; targets: number }[]>;
    soundSpells: Map<number, number[]>;
    /** All fids referenced as sounds (the sound-search scope). */
    soundFids: number[];
    soundKitSpells: Map<number, number[]>;
    soundKitFiles: Map<number, Set<number>>;

    spellAnimKits: Map<number, number[]>;
    animKitSpells: Map<number, number[]>;
    animNames: string[];
    animNamesL: string[];
    animKitAnims: Map<number, number[]>;
    animAnimKits: Map<number, number[]>;
    /** Direct stand/walk anim overrides (the "stance" group). */
    /** Animation replacements: spell -> [{src,dst}] pairs, and each anim id
     *  (either side) -> the spells whose swaps touch it. */
    spellReplaceAnims: Map<number, { src: number; dst: number }[]>;
    replaceSpells: Map<number, Set<number>>;
    /** Animations the kits play directly (SpellVisualAnim) — loose pills. */
    spellVisualAnims: Map<number, number[]>;
    visualAnimSpells: Map<number, number[]>;

    spellFx: Map<number, number[]>;
    fxSpells: Map<number, number[]>;
    fxChains: Map<number, { color: number; hue: string }>;
    fxTextures: Map<number, number[]>;
    fxSearchL: Map<number, string>;

    spellDissolves: Map<number, number[]>;
    dissolveSpells: Map<number, number[]>;
    dissolveDurations: Map<number, number>;
    dissolveTextures: Map<number, number[]>;
    dissolveSearchL: Map<number, string>;

    spellGlows: Map<number, number[]>;
    glowSpells: Map<number, number[]>;
    glowColors: Map<number, number>;
    glowAlphas: Map<number, number>;
    glowSearchL: Map<number, string>;

    spellShadowies: Map<number, number[]>;
    shadowySpells: Map<number, number[]>;
    shadowyColors: Map<number, { primary: number; secondary: number }>;
    shadowySearchL: Map<number, string>;

    spellGhostMats: Map<number, number[]>;
    ghostMatSpells: Map<number, number[]>;
    ghostMatColors: Map<number, number>;
    ghostMatSearchL: Map<number, string>;

    spellTints: Map<number, number[]>;
    tintSpells: Map<number, number[]>;
    tintColors: Map<number, number>;
    tintSearchL: Map<number, string>;

    /** Percent-payload fx: the percent doubles as the pill id. */
    spellDesaturates: Map<number, number[]>;
    desatSpells: Map<number, number[]>;
    desatSearchL: Map<number, string>;
    spellTransps: Map<number, number[]>;
    transpSpells: Map<number, number[]>;
    transpSearchL: Map<number, string>;

    spellFreezes: Set<number>;
    spellCamos: Set<number>;

    spellScreens: Map<number, number[]>;
    screenSpells: Map<number, number[]>;
    screenNames: Map<number, string>;
    screenColors: Map<number, ScreenColors>;
    screenTextures: Map<number, { fid: number; mask: boolean }[]>;
    screenSearchL: Map<number, string>;

    spellMorphs: Map<number, number[]>;
    morphSpells: Map<number, number[]>;
    morphNames: Map<number, string>;
    morphDisplays: Map<number, DisplayRef[]>;
    morphSearchL: Map<number, string>;

    spellShapeshifts: Map<number, number[]>;
    shapeshiftSpells: Map<number, number[]>;
    shapeshiftNames: Map<number, string>;
    shapeshiftDisplays: Map<number, DisplayRef[]>;
    shapeshiftSearchL: Map<number, string>;

    /** Mounts: spell -> [displayId], plus each display's name, model and corpus. */
    spellMounts: Map<number, number[]>;
    mountSpells: Map<number, number[]>;
    mountNames: Map<number, string>;
    mountFids: Map<number, number>;
    mountSearchL: Map<number, string>;

    /** GameObject spawners: spell -> [gameobject entry] and each entry's payload. */
    spellObjects: Map<number, number[]>;
    objectSpells: Map<number, number[]>;
    objectNames: Map<number, string>;
    objectFids: Map<number, number>;
    objectTypes: Map<number, number>;
    objectSearchL: Map<number, string>;


    spellSummons: Map<number, { creatureId: number; control: number }[]>;
    summonNames: Map<number, string>;
    /** Keyed "creatureId:control" — control words must not leak across a
     *  creature's other summon rows. */
    summonPairSpells: Map<string, number[]>;
    summonPairSearchL: Map<string, string>;
    summonControlNames: Record<number, string>;

    /** spell id -> [vehicle id]; also the fx filter row's presence test. */
    spellVehicles: Map<number, number[]>;
    vehicleSpells: Map<number, number[]>;
    /** vehicle id -> one attachment name per seat, in SeatID_0..7 order. */
    vehicleSeats: Map<number, string[]>;
    /** vehicle id -> lowercased corpus ("vehicle" + its attachment names).
     *  Seat COUNT is matched numerically instead, so it is not in here. */
    vehicleSearchL: Map<number, string>;

    /** Invisibility / detection channels, grouped by invisibility TYPE (the
     *  pairing key). Per spell: its (type, target mask) pills to render. Per
     *  type: both membership lists — a list's length is the counterpart count
     *  shown on the opposite side's pills, and the lists back fx:invis/fx:detect. */
    spellInvisTypes: Map<number, { type: number; mask: number }[]>;
    spellDetectTypes: Map<number, { type: number; mask: number }[]>;
    invisTypeSpells: Map<number, number[]>;
    detectTypeSpells: Map<number, number[]>;

    /** Movement-speed modifiers. A pill is a (movement, percent) pair, so that
     *  pair is the id everything keys on — as the string "run|70" / "all|-50".
     *  `amount` is the percent already printed the way the pill shows it, so the
     *  corpus and the label can never drift apart. */
    spellSpeedMods: Map<number, {
        move: string; pct: number; amount: string; key: string; mask: number;
    }[]>;
    speedSpells: Map<string, number[]>;
    speedSearchL: Map<string, string>;
    speedPercents: Map<string, number>;

    /** Object-scale modifiers. A pill is a percent and nothing else, so the
     *  percent is the id everything keys on — no separate map is needed for the
     *  numeric axis, which reads the key itself. */
    spellScaleMods: Map<number, { pct: number; amount: string; mask: number }[]>;
    scaleSpells: Map<number, number[]>;
    scaleSearchL: Map<number, string>;

    /** spell id -> [animId] the rider plays; the "passenger" anim group. */
    spellPassengerAnims: Map<number, number[]>;
    passengerAnimSpells: Map<number, number[]>;

    /** spell id -> [overrideId] the keybind fx category renders. */
    spellKeybinds: Map<number, number[]>;
    keybindSpells: Map<number, number[]>;
    keybinds: Map<number, KeybindRow>;
    keybindSearchL: Map<number, string>;
    keybindTargets: Map<number, Map<number, number>>;

    /**
     * spell id -> its mechanic rows, in build order. There is no reverse
     * (name id -> spells) index: mech: matches whole ROWS, so it resolves its
     * tokens against the three name maps once and walks these.
     */
    spellMechanics: Map<number, MechanicRow[]>;
    /** The same rows as flat parallel arrays, for mech:'s row sweep. */
    mechanicCols: MechanicColumns;
    effectNames: Map<number, string>;
    effectNamesL: Map<number, string>;
    auraNames: Map<number, string>;
    auraNamesL: Map<number, string>;
    implicitTargetNames: Map<number, string>;
    implicitTargetNamesL: Map<number, string>;
    implicitTargetBits: Map<number, number>;
}

/** The mechanic rows as parallel arrays (row i is one SpellEffect). */
interface MechanicColumns {
    spellIds: number[];
    effects: number[];
    auras: number[];
    targetsA: number[];
    targetsB: number[];
}

/**
 * One rendered Mechanics pill: the rows that look alike, merged. `rows` holds
 * every row behind it — they differ only in implicit target, which the pill
 * shows as icons, so they feed the tooltip and the hit test instead.
 */
interface MechanicPill {
    effect: number;
    aura: number;
    mask: number;
    rows: MechanicRow[];
}

/** One row of the Mechanics column: an effect and what it is aimed at. */
interface MechanicRow {
    /** SpellEffect.Effect enum id, 0 = none. */
    effect: number;
    /** SpellEffect.EffectAura enum id, 0 = none. */
    aura: number;
    /** ImplicitTarget_0 / _1 enum ids, 0 = unset. */
    targetA: number;
    targetB: number;
    /** caster/target/area bits the row's target icons read. */
    mask: number;
}

/** One SpellKeyboundOverride row. */
interface KeybindRow {
    /** Client keybinding name — JUMP, MOVEFORWARD, TOGGLEWORLDMAP, ... */
    fn: string;
    /** When it applies: "" = the ordinary press, "mid-air" = the airborne one. */
    when: string;
    /**
     * Spell::ID the retail client casts in the key's place; may not exist in
     * this build. Carried for a future pass but NOT displayed — Epsilon only
     * disables the key, it does not cast this.
     */
    spell: number;
}

/** A ScreenEffect row's color payload (-1 = the row has no such color). */
interface ScreenColors {
    fog: number;
    /** Fog opacity byte 0..255, -1 = none. */
    fogAlpha: number;
    mul: number;
    add: number;
    /** Radial vignette params; maskSize 0 = no FullScreenEffect row. */
    maskOffsetY: number;
    maskSize: number;
    maskPower: number;
}

/**
 * One entry of an exported row's `fx` list — one pill of the Effects column.
 * The shape varies by category (a chain has textures, a glow has a color, a
 * freeze has nothing but its type), so everything past `type` is optional;
 * see exportRows in app.js for which fields each category fills.
 */
interface ExportFxEntry {
    /** Category word: "chain", "dissolve", "glow", "ghost", "tint", … */
    type: string;
    textures?: string[];
    /** Chain tint, null when the chain uses the texture's own color. */
    tint?: string;
    /** Dissolve length in seconds, null when unspecified. */
    duration?: number;
    color?: string;
    /** Ghost/shadowy primary + secondary. */
    colors?: string[];
    /** desaturate / transparency strength; also the signed speed / scale change. */
    percent?: number;
    screenId?: number;
    name?: string;
    fogTint?: string;
    fogAlpha?: number;
    colorMultiply?: string;
    colorAddition?: string;
    overlays?: string[];
    masks?: string[];
    formId?: number;
    form?: string;
    creatureId?: number;
    creature?: string;
    control?: string;
    /** Morph / shapeshift creature displays. */
    displays?: { displayId: number; model: string }[];
    /** Movement speed: which movement is scaled, and the signed percent. */
    movement?: string;
}

/** window.EpsilookData (docs/js/data.js). */
interface EpsilookDataApi {
    loadVersions(): Promise<VersionEntry[]>;

    loadPack(
        versionEntry: VersionEntry,
        onProgress?: (received: number, total: number) => void
    ): Promise<SpellPack>;

    buildIndexes(pack: SpellPack): SpellData;
}

/* ------------------------------------------------------------- search */

/** One search word (or exact "quoted phrase", spaces preserved). */
interface QueryToken {
    text: string;
}

/**
 * One search group = one bar chip (or the free text). Within a group every
 * token must match the same entity; groups AND together across spells.
 */
interface QueryGroup {
    /** A FIELDS key; unknown fields fall back to "all". */
    field: string;
    tokens: QueryToken[];
    /** true = the group excludes its matches instead. */
    not?: boolean;
}

/** One entry of the FIELDS registry — a search prefix + its field button. */
interface SearchFieldSpec {
    /** Button label ("Model"). */
    label: string;
    /** Whether the field gets a button in the tab strip. */
    tab: boolean;
    /** Longer example hint shown in autocomplete. */
    hint?: string;
    /** Short placeholder text while the chip is being typed. */
    short?: string;
    /** Exact-ID field: multiple groups of it union (OR) before ANDing. */
    orGroups?: boolean;

    /** Evaluate one group; disabled lists fields the "all" field must skip
     *  (hidden columns). */
    run(tokens: QueryToken[], data: SpellData, disabled?: Set<string>): Set<number>;
}

/** window.EpsilookSearch (docs/js/search.js). */
interface EpsilookSearchApi {
    searchGroups(
        groups: QueryGroup[],
        data: SpellData,
        disabledFields?: Set<string>
    ): { spellIds: number[]; ms: number };

    sortByRelevance(spellIds: number[], rawQuery: string, data: SpellData): number[];

    FIELDS: Record<string, SearchFieldSpec>;
    /** Target-type query words ("caster", "target", "area", "both"). */
    TARGET_WORDS: string[];

    /** True when `text` is a numeric-comparison token ("4", ">2", "<=3")
     *  satisfied by `n`. Shared by the fx column's numeric categories. */
    matchNumeric(text: string, n: number): boolean;

    /** True when a token is operator-prefixed (<, >, <=, >=, =) — i.e. it asks
     *  for a numeric comparison rather than a literal value match. */
    hasOperator(text: string): boolean;
}

/* --------------------------------------------------------------- pills */

/**
 * One segment of a pill, as plain data. Exactly one CONTENT key (text / svg /
 * img / nodes) and at most one ACTION key (search / copy / href / play); the
 * rest is optional decoration. See docs/js/pills.js and PILLS.md.
 */
interface PillSegment {
    kind: string;
    text?: string;
    svg?: string;
    img?: { src: string; alt?: string };
    nodes?: Node[];
    search?: string;
    copy?: string;
    href?: string;
    play?: string;
    title?: string;
    aria?: string;
    hit?: boolean;
    cls?: string;
    bg?: string;
    data?: Record<string, any>;
}

/** What every text segment (label / note / aside) accepts. */
interface PillSegmentOpts {
    title?: string;
    detail?: (string | false | 0 | undefined)[];
    search?: string;
    finds?: string;
    click?: string;
    hit?: boolean;
    data?: Record<string, any>;
    cls?: string;
}

/** A segment slot: falsy entries are dropped, arrays flatten. */
type PillSlot = PillSegment | false | null | undefined | "" | 0 | PillSlot[];

/** A number a pill type carries: a count of things, or a measured value. */
interface PillNumericAxis {
    kind: "count" | "value";

    of(data: SpellData, id: any): number;

    /** Bare numbers keep their text/bare meaning; only <, >, <=, >=, = reach here. */
    operatorOnly?: boolean;
}

/**
 * One kind of content the app shows and searches — the record app.js renders
 * from and search.js selects with. See docs/js/pilltypes.js.
 */
interface PillType {
    key: string;
    field: string;
    /** Its category word; absent = the column matches it through its own index. */
    word?: string;
    /** One-line description: autocomplete entry and group-head tooltip. */
    hint?: string;

    /** id -> lowercase haystack; absent = matched on `word` alone. */
    corpus?(data: SpellData): Map<any, string>;

    /** id -> spell ids, or a plain Set of spells for a valueless type. */
    spells?(data: SpellData): Map<any, number[]> | Set<number>;

    numeric?: PillNumericAxis;

    /** A bare number that IS the id's identity (an invisibility type). */
    bare?(data: SpellData, id: any): number | string;

    /** Does the loaded pack carry this content at all? */
    when?(data: SpellData): boolean;
}

/** window.EpsilookPills (docs/js/pills.js). */
interface EpsilookPillsApi {
    pill(spec: { cls?: string; hit?: boolean; title?: string; segments: PillSlot[] }): HTMLElement;

    group(spec: { head: HTMLElement; items: HTMLElement[] }): HTMLElement;

    /** Declare a new segment kind — the extension point for new pill parts. */
    defineSegment(kind: string, spec: {
        cls: string;
        role: "action" | "content" | "meta";
        sep: "none" | "left" | "right";
        wrapCls?: string;
        inert?: boolean;
    }): void;

    renderSegment(seg: PillSegment): HTMLElement;

    link(href: string, title: string): PillSegment;

    view(href: string, title: string): PillSegment;

    play(url: string, title: string): PillSegment;

    targets(mask: number): PillSegment | null;

    swatch(hex: string, opts?: { title?: string; info?: string; alpha?: number }): PillSegment;

    icon(src: string, opts?: {
        href?: string; title?: string; data?: Record<string, any>;
    }): PillSegment;

    label(text: string, opts?: PillSegmentOpts): PillSegment;

    note(text: string, opts?: PillSegmentOpts): PillSegment;

    aside(text: string, opts?: PillSegmentOpts): PillSegment;

    copy(glyph: string, title: string, value: string): PillSegment;

    cmd(glyph: string, template: string, vars: Record<string, any>): PillSegment;

    /* --- pill-type registry --- */

    /** Register a content type; throws on a duplicate key. */
    defineType(type: PillType): void;

    /** Every registered type of one field, in declaration order. */
    typesFor(field: string): PillType[];

    /** Does one id of this type satisfy every token of a chip? */
    idMatches(type: PillType, data: SpellData, id: any, tokens: { text: string }[]): boolean;

    /** Add every spell this type's matching ids reach to `out`. */
    scanType(type: PillType, data: SpellData, tokens: { text: string }[], out: Set<number>): void;

    /** A field's autocomplete words and their descriptions, gated by `when`. */
    keywordsFor(field: string, data: SpellData): { words: string[]; titles: Record<string, string> };

    /** The description of one category word (a head pill's tooltip). */
    hintFor(field: string, word: string): string;

    TYPES: Map<string, PillType>;

    tip(lines: (string | false | 0 | null | undefined)[]): string;

    /** `field:value`, quoted only when the value needs it. */
    query(field: string, value: string | number): string;

    /** `field:"value"` — always quoted (values taken from game data). */
    quoted(field: string, value: string | number): string;

    /** `field:"word value"` — a value scoped to its category word. */
    catQuery(field: string, word: string, value?: string | number): string;

    fillTemplate(tpl: string, vars: Record<string, any>): string;

    el<K extends keyof HTMLElementTagNameMap>(
        tag: K, className?: string, text?: string
    ): HTMLElementTagNameMap[K];

    TARGET_CASTER: number;
    TARGET_TARGET: number;
    TARGET_AREA: number;
    TARGET_NOT_CASTER: number;
    TARGET_MISSILE_DEST: number;
    TARGET_ICONS: { bits: number; cls: string; svg: string; title(mask: number): string }[];

    targetIconNodes(mask: number): HTMLElement[];

    CUBE_SVG: string;
    KINDS: Map<string, any>;
}

/* ------------------------------------------------------------ globals */

/**
 * The vendored .blp decoder (docs/js/js-blp.js, Kruithne/js-blp, MIT) —
 * declared here because the vendored file itself is excluded from checking.
 */
declare class BLPFile {
    constructor(buf: ArrayBuffer);

    readonly width: number;
    readonly height: number;

    /** Decode one mip level; with a canvas, draws the pixels straight into it. */
    getPixels(mipmap: number, canvas?: HTMLCanvasElement | null): Uint8Array;
}

interface Window {
    EpsilookConfig: EpsilookConfig;
    EpsilookData: EpsilookDataApi;
    EpsilookSearch: EpsilookSearchApi;
    EpsilookPills: EpsilookPillsApi;
}
