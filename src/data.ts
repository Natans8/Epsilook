/* Data loading: fetch the gzipped JSON pack for a game version and build
 * the in-memory indexes every search runs against. No query engine —
 * plain arrays and Maps.
 *
 * This module also owns the two data shapes that flow through the app:
 * the JSON pack baked by build/build_data.py (SpellPack) and the in-memory
 * indexes built from it (SpellData). */
import {hexColor} from "./util";

/* ----------------------------------------------------------- the pack */

/** One entry of site/data/versions.json (the version manifest). */
export interface VersionEntry {
    /** Full build id, e.g. "9.2.7.45745". */
    id: string;
    /** Display label, e.g. "Shadowlands". */
    label: string;
    /** Pack path relative to site/, e.g. "data/9.2.7.45745/pack.json.gz". */
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
 * version. Parallel arrays throughout: `{spellIds, fids}` means row i links
 * spellIds[i] to fids[i]. Sections marked optional arrived in later pack
 * formats — buildIndexes guards each so a stale cached pack (or an old
 * format on disk) still loads.
 */
export interface SpellPack {
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
        /** SpellMissileMotion id, 0 = none (format 34+). Missile rows only —
         *  the arc the projectile flies. Part of the row key like the attach
         *  pair, so one model flown two ways is two rows. */
        motions?: number[]
    };
    /** Flight paths "motions" points at (format 34+), parallel by motion id. */
    missileMotions?: { ids: number[]; names: string[] };
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
    /** Boneset region names (format 33+), referenced by index below. */
    bonesetNames?: string[];
    /** Per-anim bonesets: (kit, anim) -> region name indices (Full Body dropped). */
    animKitAnimBoneset?: { animKitIds: number[]; animIds: number[]; bonesets: number[][] };
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
    /** durations in seconds, 0 = unspecified; attaches = M2 attach id, -1 = full body (format 33+). */
    dissolves: { ids: number[]; durations: number[]; attaches?: number[] };
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
        /** M2 attach id where anchored, -1 = full body (format 33+). */
        attaches?: number[];
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

    /* --- spell -> spell links (SpellEffect.EffectTriggerSpell) --- */

    /**
     * One row per edge: `srcIds[i]` is joined to `dstIds[i]` in the way
     * `kindNames[kinds[i]]` names ("on cast", "periodically", "removes", ...).
     *
     * ONE DIRECTION ONLY — the reverse ("origin") index is built at load rather
     * than shipped twice. Both ends are always spells this pack names, and a
     * self-link never appears; the build drops both cases.
     *
     * `targets[i]` is the ImplicitTarget mask of the effect carrying the
     * trigger — the edge's own target, read exactly like every other
     * effect-driven route's (pack format 36).
     */
    spellLinks?: {
        srcIds: number[]; dstIds: number[]; kinds: number[];
        targets?: number[]; kindNames: string[];
    };
}

/* ------------------------------------------------- in-memory indexes */

/** One listfile entry as indexed here. */
export interface FileEntry {
    fid: number;
    path: string;
    /** File name without the directory part ("" when the path is unknown). */
    base: string;
    /** Lowercased path — the substring-search corpus. */
    searchL: string;
}

/** A creature-display reference on a morph / shapeshift pill. */
export interface DisplayRef {
    displayId: number;
    fid: number;
}

/** The mechanic rows as parallel arrays (row i is one SpellEffect). */
export interface MechanicColumns {
    spellIds: number[];
    effects: number[];
    auras: number[];
    targetsA: number[];
    targetsB: number[];
}

/** One row of the Mechanics column: an effect and what it is aimed at. */
export interface MechanicRow {
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
export interface KeybindRow {
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

/**
 * One end of a spell -> spell link, as a chip renders it: the OTHER spell, and
 * the word(s) joining it to the row being drawn. `kinds` holds more than one
 * only where the same pair really is joined twice — e.g. a spell that both
 * triggers another on cast and removes it — which is 252 of 58,214 pairs on
 * 9.2.7. Order is the pack's, so it is stable between loads.
 */
export interface SpellLink {
    spell: number;
    kinds: string[];
    /**
     * caster/target/area bits of the effect carrying the trigger, unioned over
     * the ways the pair is joined. Rides both directions because it describes
     * the EDGE: who the triggering effect is aimed at is equally who the
     * triggered spell lands on. 0 on a pack older than format 36.
     */
    mask: number;
}

/** A ScreenEffect row's color payload (-1 = the row has no such color). */
export interface ScreenColors {
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
 * The lookup structures every search and render runs against — built once
 * per pack by buildIndexes. Naming convention: `spellXs` maps
 * spell id -> its Xs, `xSpells` maps an X id -> spell ids using it, and
 * `xSearchL` maps an X id -> its lowercase search corpus (category word +
 * payload words, matched by substring).
 */
export interface SpellData {
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
        /** Flight path name (format 34+); "" on every non-missile row. */
        motion: string;
    }[]>;
    /** Item::ID -> {name, quality, icon} for "item"-category rows (format 28+).
     *  name "" = a nameless item (renders as a plain model pill). */
    items: Map<number, { name: string; quality: string; icon: string }>;
    /** Item::ID -> its search corpus (name / quality / id). */
    itemSearchL: Map<number, string>;
    /** Item::ID -> the spells that reach it, for model:"item <name>" search. */
    itemSpells: Map<number, Set<number>>;
    /** The "item" model category id, or -1 when this pack has none. `ref` is a
     *  PER-CATEGORY id space, so any itemSearchL lookup must gate on this —
     *  a display row's CreatureDisplayID can otherwise collide with an
     *  Item::ID and match an unrelated item's corpus. */
    itemCat: number;
    /** Every missile flight-path name this pack uses (format 34+). */
    missileMotionNames: string[];
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
    /** Boneset region names, index -> name (format 33+). */
    bonesetNames: string[];
    /** AnimKit -> (anim -> specific region names), one entry per region pill. */
    animKitAnimBoneset: Map<number, Map<number, string[]>>;
    /** Spell -> the lowercased region names its animkits animate, one per name. */
    spellBonesets: Map<number, string[]>;
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
    /** Dissolve id -> M2 attach id (-1 = full body). */
    dissolveAttach: Map<number, number>;
    dissolveSearchL: Map<number, string>;

    spellGlows: Map<number, number[]>;
    glowSpells: Map<number, number[]>;
    glowColors: Map<number, number>;
    glowAlphas: Map<number, number>;
    glowSearchL: Map<number, string>;

    spellShadowies: Map<number, number[]>;
    shadowySpells: Map<number, number[]>;
    shadowyColors: Map<number, { primary: number; secondary: number }>;
    /** Shadowy id -> M2 attach id (-1 = full body). */
    shadowyAttach: Map<number, number>;
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

    /* --- spell -> spell links (pack format 35) --- */

    /**
     * The two directions of one edge set, as the Mechanics column renders them:
     * `spellTriggers` is what a spell reaches, `spellOrigins` what reaches
     * it. Keyed by the spell whose ROW is being drawn; the entry's `spell` is
     * the other end, and `kinds` the word(s) joining them — several when one
     * pair is joined two ways (252 pairs on 9.2.7).
     */
    spellTriggers: Map<number, SpellLink[]>;
    spellOrigins: Map<number, SpellLink[]>;
    /**
     * The search side, keyed by the LINKED spell — the id a chip stands for —
     * mapping to the spells whose row carries that chip. `triggersSpells` backs
     * mech:triggers, `originSpells` mech:origin, and each has a corpus of the
     * linked spell's name plus every word it is joined by — but NOT its id,
     * which a substring match turns into numeric noise across the whole field
     * (see the measurement where the corpus is built).
     */
    triggersSpells: Map<number, number[]>;
    triggersSearchL: Map<number, string>;
    originSpells: Map<number, number[]>;
    originSearchL: Map<number, string>;
}

/* ------------------------------------------------------------ loading */

/** Fetch the version manifest (always revalidated). */
export async function loadVersions(): Promise<VersionEntry[]> {
    // no-cache = always revalidate (tiny file, 304 when unchanged), so a
    // fresh deploy is picked up immediately instead of after cache expiry
    const resp = await fetch("data/versions.json", {cache: "no-cache"});
    if (!resp.ok) throw new Error(`versions.json: HTTP ${resp.status}`);
    return resp.json();
}

/**
 * Fetch + gunzip + parse one version's pack, reporting download progress.
 * onProgress's total is 0 when the server sends no Content-Length.
 */
export async function loadPack(
    versionEntry: VersionEntry,
    onProgress?: (received: number, total: number) => void): Promise<SpellPack> {
    // the manifest's content hash busts the browser cache exactly when the
    // pack data changed; an unchanged hash keeps serving the cached 6+ MB
    const url = versionEntry.file + (versionEntry.hash ? "?v=" + versionEntry.hash : "");
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) throw new Error(`${versionEntry.file}: HTTP ${resp.status}`);

    const total = Number(resp.headers.get("Content-Length")) || 0;
    const reader = resp.body.getReader();
    // fetch chunks are always plain ArrayBuffers, which is what Blob wants —
    // the stream type just can't promise it (SharedArrayBuffer is in its union)
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    for (; ;) {
        const {done, value} = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array<ArrayBuffer>);
        received += value.length;
        if (onProgress) onProgress(received, total);
    }

    const blob = new Blob(chunks);
    let text;
    try {
        const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
        text = await new Response(stream).text();
    } catch {
        // Some hosts transparently gunzip .gz responses; fall back to plain text.
        text = await blob.text();
    }
    return JSON.parse(text);
}

/** The part of a listfile path after the last "/". */
function basename(path: string): string {
    const i = path.lastIndexOf("/");
    return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Stand-in for an optional id -> word table an older pack doesn't ship.
 * Shared by every such fallback: they are read-only lookups, and one typed
 * constant keeps `pack.x || NO_WORDS` a Record rather than a union with a
 * bare object literal.
 */
const NO_WORDS: Record<number, string> = Object.freeze({});

/** Turn the column-oriented pack into fast lookup structures. */
export function buildIndexes(pack: SpellPack): SpellData {
    const t0 = performance.now();
    const sp = pack.spells;
    const n = sp.ids.length;

    // spell id -> array index
    const spellIndex = new Map<number, number>();
    const namesL: string[] = new Array(n);
    for (let i = 0; i < n; i++) {
        spellIndex.set(sp.ids[i], i);
        // altNames (SpellOverrideName, pack format 19+) join the search corpus
        // but are never displayed — the row keeps showing its real name
        const alt = sp.altNames ? sp.altNames[i] : "";
        namesL[i] = [sp.names[i], sp.subtexts[i], alt]
            .filter(Boolean).join(" ").toLowerCase();
    }

    // spell icon names ("" = none); older packs have no icon data
    const iconNames = pack.iconNames || [];
    const icons: string[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const idx = sp.icons ? sp.icons[i] : 0;
        icons[i] = idx ? iconNames[idx - 1] : "";
    }

    // fid -> {path, base, searchL}
    const files = new Map<number, FileEntry>();
    const fp = pack.files;
    // a NEGATIVE fid is a fileless sentinel (SYNTHETIC_MODEL_FILES in
    // build_data): no real file, its "path" is the label the pill shows and
    // searches by. Whether the pack has any at all is what gates the
    // `equipped` autocomplete word — asked here, so no fid list is hardcoded.
    let hasSyntheticFiles = false;
    for (let i = 0; i < fp.fids.length; i++) {
        const fid = fp.fids[i];
        const path = fp.paths[i];
        const base = path ? basename(path) : "";
        if (fid < 0) hasSyntheticFiles = true;
        files.set(fid, {fid, path, base, searchL: path.toLowerCase()});
    }

    /** Append value to the array at map[key], creating the array on first use. */
    const pushTo = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
        const arr = map.get(key);
        if (arr) arr.push(value); else map.set(key, [value]);
    };

    /**
     * A percent CHANGE, printed the way the pill shows it: signed, so the
     * sign carries more-or-less, and no trailing ".0" on the whole numbers
     * that are almost all of them. Shared by the two routes whose payload is
     * a signed percent — movement speed and object scale. (Zero never
     * reaches it: the build drops those rows, since a pill made of nothing
     * but the number has nothing to say when the number is nothing.)
     *
     * The pills and the search corpus are both built from this one function,
     * which is what lets a user type what they read: fx:"speed +70%".
     */
    const signedPercent = (pct: number): string => `${pct > 0 ? "+" : ""}${pct}%`;

    /**
     * Index one section's per-row target masks as spell -> item -> mask.
     *
     * Every kit-derived section carries a parallel "targets" array since pack
     * format 22 (who the content plays on — see TARGET_BITS in build_data.py).
     * Sections whose rows are plain ids all index the same way, so adding the
     * icons to another column is one more call here. A pack without the array
     * yields an empty map, which reads app-side as "no icons".
     *
     * @param section pack section with {spellIds, targets} + an id array
     * @param idKey name of that section's id array
     */
    const maskIndex = (
        section: { spellIds: number[]; targets?: number[]; [k: string]: unknown } | undefined,
        idKey: string): Map<number, Map<number, number>> => {
        const out = new Map<number, Map<number, number>>();
        if (!section || !section.targets) return out;
        const {spellIds, targets} = section;
        const ids = section[idKey] as number[];
        for (let i = 0; i < spellIds.length; i++) {
            let m = out.get(spellIds[i]);
            if (!m) out.set(spellIds[i], m = new Map());
            m.set(ids[i], (m.get(ids[i]) || 0) | targets[i]);
        }
        return out;
    };

    // models — each (spell, fid) row carries a usage category
    // (attach/missile/area/trail/barrage) since pack format 15; a stale
    // cached pack has no cats and renders the old flat list
    const spellModels = new Map<number, number[]>();       // spell id -> [fid] (deduped)
    const modelSpells = new Map<number, number[]>();       // fid -> [spell id]
    const spellModelCats = new Map<number, {
        fid: number; cat: number; targets: number; src: number; dst: number; ref: number;
        motion: string;
    }[]>();
    const modelCatSpells = new Map<number, Set<number>>(); // cat id -> Set(spell id)
    const modelCatFidSpells = new Map<number, Map<number, number[]>>(); // cat id -> (fid -> [spell id])
    const modelCatNames = pack.modelCatNames || NO_WORDS;
    // raw M2 attachment id -> name
    const attachmentNames = pack.attachmentNames || NO_WORDS;
    // every flight path this pack uses — the `motion` keyword's availability
    // gate and its value-matching pool (format 34+; empty on older packs)
    const missileMotionNames = pack.missileMotions ? pack.missileMotions.names : [];
    {
        const sm = pack.spellModels;
        const {spellIds, fids, cats, targets, srcAttach, dstAttach} = sm;
        // ref id per row: the entity the model came from, in the id space its
        // category names (a CreatureDisplayID on display rows, an Item::ID on
        // item rows). Renamed refIds in format 28; format 27 packs still ship it
        // as displayIds (display rows only), so fall back to that.
        const refIds = sm.refIds || sm.displayIds;
        // flight path per row (format 34+), missile rows only. The pack ships
        // only the motions in use, so this is id -> name over ~1.2k entries.
        const motions = sm.motions;
        const motionNames = new Map<number, string>();
        if (pack.missileMotions) {
            const mm = pack.missileMotions;
            for (let i = 0; i < mm.ids.length; i++) motionNames.set(mm.ids[i], mm.names[i]);
        }
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(modelSpells, fids[i], spellIds[i]);
            if (!cats) {
                pushTo(spellModels, spellIds[i], fids[i]);
                continue;
            }
            pushTo(spellModelCats, spellIds[i], {
                fid: fids[i], cat: cats[i], targets: targets ? targets[i] : 0,
                // attachment points arrived in pack format 24; older packs have
                // none, which renders as no attachment segment
                src: srcAttach ? srcAttach[i] : -1,
                dst: dstAttach ? dstAttach[i] : -1,
                // ref id: CreatureDisplayID (display cat) or Item::ID (item cat); 0 else
                ref: refIds ? refIds[i] : 0,
                // the arc the projectile flies; "" on every non-missile row
                motion: motions ? (motionNames.get(motions[i]) || "") : "",
            });
            let set = modelCatSpells.get(cats[i]);
            if (!set) modelCatSpells.set(cats[i], set = new Set());
            set.add(spellIds[i]);
            let byFid = modelCatFidSpells.get(cats[i]);
            if (!byFid) modelCatFidSpells.set(cats[i], byFid = new Map());
            pushTo(byFid, fids[i], spellIds[i]);
        }
        if (cats) {
            // spellModels stays fid-only (deduped across categories) for the
            // filters / export / search paths that don't care about usage
            for (const [s, entries] of spellModelCats)
                spellModels.set(s, [...new Set(entries.map((e) => e.fid))]);
            for (const [f, arr] of modelSpells) modelSpells.set(f, [...new Set(arr)]);
        }
    }

    // items (MODEL_CAT_ITEM rows, pack format 28): Item::ID -> its name,
    // quality word and icon name. A nameless item still has an entry (name "")
    // — it renders as a plain model pill; the presence of a name is what the
    // renderer branches on. Quality drives the label COLOUR only. `itemSearchL`
    // is the per-item search corpus — item id and name, so model:"item sickle
    // axe" matches on the NAME; quality is deliberately NOT searchable.
    const items = new Map<number, { name: string; quality: string; icon: string }>();
    const itemSearchL = new Map<number, string>(); // item id -> search corpus
    if (pack.items) {
        const it = pack.items;
        const iconNames = pack.itemIconNames || [];
        const qualityNames = pack.itemQualityNames || {};
        for (let i = 0; i < it.ids.length; i++) {
            const id = it.ids[i];
            const name = it.names[i] || "";
            const quality = qualityNames[it.qualities[i]] || "";
            const icon = it.icons[i] ? (iconNames[it.icons[i] - 1] || "") : "";
            items.set(id, {name, quality, icon});
            itemSearchL.set(id,
                ("item " + id + " " + name.toLowerCase()).trim());
        }
    }
    // item id -> the spells that reach it (through a MODEL_CAT_ITEM row), so a
    // model:"item <name>" query can match on the item corpus. The pill's fid
    // and category word are already searchable through the ordinary model
    // index; this is the extra dimension items add — their NAME and quality.
    const itemSpells = new Map<number, Set<number>>();
    // derived once and carried on SpellData: search.ts needs the same gate, and
    // a second copy of this lookup is how the two would drift apart
    const foundCat = Number(Object.keys(modelCatNames)
        .find((c) => modelCatNames[Number(c)] === "item"));
    const itemCat = Number.isFinite(foundCat) ? foundCat : -1;
    if (items.size && itemCat >= 0) {
        for (const [s, entries] of spellModelCats)
            for (const e of entries)
                if (e.cat === itemCat && e.ref) {
                    let set = itemSpells.get(e.ref);
                    if (!set) itemSpells.set(e.ref, set = new Set());
                    set.add(s);
                }
    }

    // sounds
    const spellSounds = new Map<number, { soundKitId: number; fid: number; targets: number }[]>();
    const soundSpells = new Map<number, number[]>();    // fid -> [spell id]
    const soundKitSpells = new Map<number, number[]>(); // soundKitId -> [spell id]
    const soundKitFiles = new Map<number, Set<number>>(); // soundKitId -> Set(fid)
    {
        const {spellIds, soundKitIds, fids, targets} = pack.spellSounds;
        for (let i = 0; i < spellIds.length; i++) {
            const s = spellIds[i], k = soundKitIds[i], f = fids[i];
            pushTo(spellSounds, s, {soundKitId: k, fid: f, targets: targets ? targets[i] : 0});
            pushTo(soundSpells, f, s);
            pushTo(soundKitSpells, k, s);
            let set = soundKitFiles.get(k);
            if (!set) soundKitFiles.set(k, set = new Set());
            set.add(f);
        }
        // soundKitSpells values contain duplicates (one per kit file) — dedupe
        for (const [k, arr] of soundKitSpells) soundKitSpells.set(k, [...new Set(arr)]);
        // dedupe (kit, file) per spell, unioning the target masks of the rows
        // that collapse together rather than keeping only the first one's
        for (const [s, arr] of spellSounds) {
            const seen = new Map<string, { soundKitId: number; fid: number; targets: number }>();
            for (const e of arr) {
                const key = e.soundKitId + ":" + e.fid;
                const kept = seen.get(key);
                if (kept) kept.targets |= e.targets; else seen.set(key, e);
            }
            spellSounds.set(s, [...seen.values()]);
        }
    }

    // target masks for the id-keyed sections — who each row's content plays
    // on (pack format 22; empty for older packs, which renders as no icons)
    const animKitTargets = maskIndex(pack.spellAnimKits, "animKitIds");
    const visualAnimTargets = maskIndex(pack.spellVisualAnims, "animIds");
    const fxTargets = maskIndex(pack.spellFx, "chainIds");
    const dissolveTargets = maskIndex(pack.spellDissolves, "dissolveIds");
    const glowTargets = maskIndex(pack.spellGlows, "glowIds");
    const shadowyTargets = maskIndex(pack.spellShadowies, "shadowyIds");
    const ghostMatTargets = maskIndex(pack.spellGhostMats, "ghostIds");
    // effect-driven fx (pack format 25): masks from SpellEffect.ImplicitTarget
    // rather than the visual-event graph — who a morph/summon/vehicle/screen/
    // shapeshift lands on (a polymorph's morph is on the target, not the caster)
    const morphTargets = maskIndex(pack.spellMorphs, "creatureIds");
    const summonTargets = maskIndex(pack.spellSummons, "creatureIds");
    // where a spawned gameobject is placed — usually a ground point
    const objectTargets = maskIndex(pack.spellObjects, "objectIds");
    const vehicleTargets = maskIndex(pack.spellVehicles, "vehicleIds");
    const shapeshiftTargets = maskIndex(pack.spellShapeshifts, "formIds");
    const screenTargets = maskIndex(pack.spellScreens, "screenIds");
    // mask bit -> search word
    const targetNames = pack.targetNames || NO_WORDS;

    // animkits
    const spellAnimKits = new Map<number, number[]>(); // spell id -> [animKitId]
    const animKitSpells = new Map<number, number[]>(); // animKitId -> [spell id]
    {
        const {spellIds, animKitIds} = pack.spellAnimKits;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellAnimKits, spellIds[i], animKitIds[i]);
            pushTo(animKitSpells, animKitIds[i], spellIds[i]);
        }
    }
    // AnimKits reached through a vehicle seat are AnimKit::IDs like any
    // other, so they join the same groups and resolve through animKitAnims;
    // the build counts them as "used" so their anims ship too.
    if (pack.spellVehicleAnimKits) {
        const {spellIds, animKitIds} = pack.spellVehicleAnimKits;
        for (let i = 0; i < spellIds.length; i++) {
            const have = spellAnimKits.get(spellIds[i]);
            if (have && have.includes(animKitIds[i])) continue;
            pushTo(spellAnimKits, spellIds[i], animKitIds[i]);
            pushTo(animKitSpells, animKitIds[i], spellIds[i]);
        }
    }

    // animations contained in animkits (names indexed by AnimID)
    const animNames = pack.animNames;
    const animNamesL: string[] = animNames.map((n) => n.toLowerCase());
    const animKitAnims = new Map<number, number[]>(); // animKitId -> [animId]
    const animAnimKits = new Map<number, number[]>(); // animId -> [animKitId]
    {
        const {animKitIds, animIds} = pack.animKitAnims;
        for (let i = 0; i < animKitIds.length; i++) {
            pushTo(animKitAnims, animKitIds[i], animIds[i]);
            pushTo(animAnimKits, animIds[i], animKitIds[i]);
        }
    }

    // bonesets (pack format 33): the specific body region each of an
    // AnimKit's anims (segments) animates, resolved from name indices and
    // shown on that anim's pill. "Full Body" is the default and never
    // shipped. Keyed by (kit, anim).
    const bonesetNames: string[] = pack.bonesetNames || [];
    const bonesetList = (ids: number[]): string[] => ids.map((i) => bonesetNames[i]);
    const animKitAnimBoneset = new Map<number, Map<number, string[]>>();
    if (pack.animKitAnimBoneset) {
        const {animKitIds, animIds, bonesets} = pack.animKitAnimBoneset;
        for (let i = 0; i < animKitIds.length; i++) {
            let byAnim = animKitAnimBoneset.get(animKitIds[i]);
            if (!byAnim) animKitAnimBoneset.set(animKitIds[i], byAnim = new Map());
            byAnim.set(animIds[i], bonesetList(bonesets[i]));
        }
    }
    // The regions the `boneset` search keyword measures itself against: every
    // region name the spell's AnimKits animate, lowercased. A LIST, not one
    // joined haystack — a keyword value has to answer to a single region
    // ("left arm" is not satisfied by a spell that animates Left Hand and
    // Right Arm), which a haystack cannot express.
    const spellBonesets = new Map<number, string[]>();
    for (const [spellId, kits] of spellAnimKits) {
        const names = new Set<string>();
        for (const kit of kits) {
            const byAnim = animKitAnimBoneset.get(kit);
            if (byAnim) for (const ns of byAnim.values()) for (const nm of ns) names.add(nm.toLowerCase());
        }
        if (names.size) spellBonesets.set(spellId, [...names]);
    }

    // visual FX: chain/beam effects (category word "chain" since
    // 2026-07-19). Each chain has a tint (0xFFFFFF = untinted), a hue word,
    // textures (fids into `files`), and a lowercase search corpus:
    // "chain" + hue + tint hex + texture paths.
    const spellFx = new Map<number, number[]>(); // spell id -> [chainId]
    const fxSpells = new Map<number, number[]>(); // chainId -> [spell id]
    const fxChains = new Map<number, { color: number; hue: string }>();
    const fxTextures = new Map<number, number[]>(); // chainId -> [fid]
    const fxSearchL = new Map<number, string>();    // chainId -> search corpus
    const spellChainRows = new Map<number, { chain: number; src: number; dst: number }[]>();
    {
        const {spellIds, chainIds, srcAttach, dstAttach} = pack.spellFx;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(fxSpells, chainIds[i], spellIds[i]);
            // spellFx stays deduped chain ids for search/filters/export; the row
            // list keeps the beam's attach pair, so one chain drawn by two beams
            // with different attachments renders as two pills
            const have = spellFx.get(spellIds[i]);
            if (!have || !have.includes(chainIds[i])) pushTo(spellFx, spellIds[i], chainIds[i]);
            pushTo(spellChainRows, spellIds[i], {
                chain: chainIds[i],
                src: srcAttach ? srcAttach[i] : -1,
                dst: dstAttach ? dstAttach[i] : -1,
            });
        }
        for (const [c, arr] of fxSpells) fxSpells.set(c, [...new Set(arr)]);
        const fc = pack.fxChains;
        for (let i = 0; i < fc.ids.length; i++) {
            fxChains.set(fc.ids[i], {color: fc.colors[i], hue: fc.hues[i]});
        }
        const ft = pack.fxTextures;
        for (let i = 0; i < ft.chainIds.length; i++) {
            pushTo(fxTextures, ft.chainIds[i], ft.fids[i]);
        }
        for (const [c, info] of fxChains) {
            const tex = (fxTextures.get(c) || [])
                .map((fid) => files.get(fid)?.searchL ?? "").join(" ");
            // 0xFFFFFF = untinted ("the texture's own color"), not white — no hex
            const hex = info.color === 0xffffff ? "" : hexColor(info.color);
            fxSearchL.set(c, ("chain " + info.hue + " " + hex + " " + tex).trim());
        }
    }

    // Effect attach point (pack format 33): where on the model a Shadowy /
    // Dissolve effect is anchored. A raw M2 attachment id, with -1 meaning
    // the WHOLE body ("full body") rather than "unset". The word joins the
    // effect's search corpus, so fx:"dissolve chest" / fx:"ghost full body"
    // narrow by anchor the same way a texture or hue word does.
    const effectAttachName = (a: number): string => a < 0 ? "full body" : (attachmentNames[a] || "");

    // dissolves (DissolveEffect rows): duration + TextureBlendSet textures;
    // corpus: "dissolve" + texture paths + attach — fx:"dissolve arcane_wisps".
    const spellDissolves = new Map<number, number[]>();  // spell id -> [dissolveId]
    const dissolveSpells = new Map<number, number[]>();  // dissolveId -> [spell id]
    const dissolveDurations = new Map<number, number>(); // dissolveId -> seconds (0 = unspecified)
    const dissolveTextures = new Map<number, number[]>(); // dissolveId -> [fid]
    const dissolveAttach = new Map<number, number>();    // dissolveId -> M2 attach id (-1 = full body)
    const dissolveSearchL = new Map<number, string>();   // dissolveId -> search corpus
    {
        const {spellIds, dissolveIds} = pack.spellDissolves;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellDissolves, spellIds[i], dissolveIds[i]);
            pushTo(dissolveSpells, dissolveIds[i], spellIds[i]);
        }
        const ds = pack.dissolves;
        for (let i = 0; i < ds.ids.length; i++) {
            dissolveDurations.set(ds.ids[i], ds.durations[i]);
            if (ds.attaches) dissolveAttach.set(ds.ids[i], ds.attaches[i]);
        }
        const dt = pack.dissolveTextures;
        for (let i = 0; i < dt.dissolveIds.length; i++) {
            pushTo(dissolveTextures, dt.dissolveIds[i], dt.fids[i]);
        }
        for (const id of dissolveDurations.keys()) {
            const tex = (dissolveTextures.get(id) || [])
                .map((fid) => files.get(fid)?.searchL ?? "").join(" ");
            const attach = dissolveAttach.has(id) ? effectAttachName(dissolveAttach.get(id)!) : "";
            dissolveSearchL.set(id, ("dissolve " + tex + " " + attach).trim().toLowerCase());
        }
    }

    // glows (EdgeGlowEffect rows): color-only, no texture or model.
    // Corpus: "glow" + hue + hex — fx:"glow red" / fx:#ff5800.
    const spellGlows = new Map<number, number[]>(); // spell id -> [glowId]
    const glowSpells = new Map<number, number[]>(); // glowId -> [spell id]
    const glowColors = new Map<number, number>();   // glowId -> packed RGB
    const glowAlphas = new Map<number, number>();   // glowId -> alpha 0..255 (pack format 17+)
    const glowSearchL = new Map<number, string>();  // glowId -> search corpus
    {
        const {spellIds, glowIds} = pack.spellGlows;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellGlows, spellIds[i], glowIds[i]);
            pushTo(glowSpells, glowIds[i], spellIds[i]);
        }
        const g = pack.glows;
        for (let i = 0; i < g.ids.length; i++) {
            glowColors.set(g.ids[i], g.colors[i]);
            if (g.alphas) glowAlphas.set(g.ids[i], g.alphas[i]);
            glowSearchL.set(g.ids[i],
                ("glow " + g.hues[i] + " " + hexColor(g.colors[i])).trim());
        }
    }

    // shadowy effects (ShadowyEffect rows): two colors per row, no texture.
    // Corpus: "shadowy" + hue words + both hexes.
    const spellShadowies = new Map<number, number[]>(); // spell id -> [shadowyId]
    const shadowySpells = new Map<number, number[]>();  // shadowyId -> [spell id]
    const shadowyColors = new Map<number, { primary: number; secondary: number }>();
    const shadowyAttach = new Map<number, number>();    // shadowyId -> M2 attach id (-1 = full body)
    const shadowySearchL = new Map<number, string>();   // shadowyId -> search corpus
    {
        const {spellIds, shadowyIds} = pack.spellShadowies;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellShadowies, spellIds[i], shadowyIds[i]);
            pushTo(shadowySpells, shadowyIds[i], spellIds[i]);
        }
        const sh = pack.shadowies;
        for (let i = 0; i < sh.ids.length; i++) {
            const primary = sh.primaryColors[i], secondary = sh.secondaryColors[i];
            shadowyColors.set(sh.ids[i], {primary, secondary});
            if (sh.attaches) shadowyAttach.set(sh.ids[i], sh.attaches[i]);
            const attach = sh.attaches ? effectAttachName(sh.attaches[i]) : "";
            // category is "ghost" now, but keep "shadowy" searchable for the
            // ShadowyEffect rows so old fx:shadowy queries still resolve
            shadowySearchL.set(sh.ids[i],
                ("ghost shadowy " + sh.hues[i] + " " + hexColor(primary) + " " + hexColor(secondary)
                    + " " + attach).trim().toLowerCase());
        }
    }

    // ghost materials (SpellProceduralEffect Type 22): single-color material
    // recolors that share the "ghost" category with the ShadowyEffect rows.
    // Corpus: "ghost" + hue + hex.
    const spellGhostMats = new Map<number, number[]>(); // spell id -> [ghostMatId]
    const ghostMatSpells = new Map<number, number[]>(); // ghostMatId -> [spell id]
    const ghostMatColors = new Map<number, number>();   // ghostMatId -> packed RGB
    const ghostMatSearchL = new Map<number, string>();  // ghostMatId -> search corpus
    if (pack.spellGhostMats) {
        const {spellIds, ghostIds} = pack.spellGhostMats;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellGhostMats, spellIds[i], ghostIds[i]);
            pushTo(ghostMatSpells, ghostIds[i], spellIds[i]);
        }
        const gm = pack.ghostMats!;
        for (let i = 0; i < gm.ids.length; i++) {
            ghostMatColors.set(gm.ids[i], gm.colors[i]);
            ghostMatSearchL.set(gm.ids[i],
                ("ghost " + gm.hues[i] + " " + hexColor(gm.colors[i])).trim());
        }
    }

    // desaturate (Type 21) / transparency (Type 14): percent-only pills. The
    // pill "id" IS the percent (0..100); corpus per percent so fx:desaturate,
    // fx:"desaturate 70" and fx:transparency all match.
    const spellDesaturates = new Map<number, number[]>(); // spell id -> [percent]
    const desatSpells = new Map<number, number[]>();      // percent -> [spell id]
    const desatSearchL = new Map<number, string>();       // percent -> corpus
    if (pack.spellDesaturates) {
        const {spellIds, percents} = pack.spellDesaturates;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellDesaturates, spellIds[i], percents[i]);
            pushTo(desatSpells, percents[i], spellIds[i]);
            if (!desatSearchL.has(percents[i]))
                desatSearchL.set(percents[i], "desaturate " + percents[i] + "%");
        }
    }
    const spellTransps = new Map<number, number[]>(); // spell id -> [percent]
    const transpSpells = new Map<number, number[]>(); // percent -> [spell id]
    const transpSearchL = new Map<number, string>();  // percent -> corpus
    if (pack.spellTransparencies) {
        const {spellIds, percents} = pack.spellTransparencies;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellTransps, spellIds[i], percents[i]);
            pushTo(transpSpells, percents[i], spellIds[i]);
            if (!transpSearchL.has(percents[i]))
                transpSearchL.set(percents[i], "transparency " + percents[i] + "%");
        }
    }

    // freeze (Type 11) / camo (Type 18): valueless standalone pills
    const spellFreezes = new Set<number>(pack.spellFreezes ? pack.spellFreezes.spellIds : []);
    const spellCamos = new Set<number>(pack.spellCamos ? pack.spellCamos.spellIds : []);

    // screen effects (ScreenEffect rows): the whole screen tints/overlays
    // while the aura holds. Each row: internal name, optional fog tint and
    // FullScreenEffect multiply/addition colors (-1 = none — 0 is a real
    // black), texture fids. Corpus: "screen" + name + hues + hexes + paths.
    const spellScreens = new Map<number, number[]>(); // spell id -> [screenId]
    const screenSpells = new Map<number, number[]>(); // screenId -> [spell id]
    const screenNames = new Map<number, string>();    // screenId -> internal name
    const screenColors = new Map<number, ScreenColors>();
    // screenId -> [{fid, mask}] — mask textures are flat blend-set art the
    // mul/add colors paint; overlays (mask false) carry their own colors.
    const screenTextures = new Map<number, { fid: number; mask: boolean }[]>();
    const screenSearchL = new Map<number, string>();  // screenId -> search corpus
    if (pack.spellScreens) {
        const {spellIds, screenIds} = pack.spellScreens;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellScreens, spellIds[i], screenIds[i]);
            pushTo(screenSpells, screenIds[i], spellIds[i]);
        }
        const st = pack.screenTextures!;
        for (let i = 0; i < st.screenIds.length; i++) {
            // roles arrived in pack format 17; a stale cached pack has none, and
            // its fids were overlay-first anyway — treat them all as overlays
            pushTo(screenTextures, st.screenIds[i],
                {fid: st.fids[i], mask: st.roles ? st.roles[i] === 1 : false});
        }
        const sc = pack.screens!;
        for (let i = 0; i < sc.ids.length; i++) {
            const id = sc.ids[i];
            screenNames.set(id, sc.names[i]);
            screenColors.set(id, {
                fog: sc.fogColors[i],
                fogAlpha: sc.fogAlphas ? sc.fogAlphas[i] : -1,
                mul: sc.mulColors[i],
                add: sc.addColors[i],
                // radial vignette (pack format 18+); size 0 = none
                maskOffsetY: sc.maskOffsetY ? sc.maskOffsetY[i] : 0,
                maskSize: sc.maskSize ? sc.maskSize[i] : 0,
                maskPower: sc.maskPower ? sc.maskPower[i] : 0,
            });
            const hexes = [sc.fogColors[i], sc.mulColors[i], sc.addColors[i]]
                .filter((c) => c >= 0).map(hexColor).join(" ");
            const tex = (screenTextures.get(id) || [])
                .map((t) => files.get(t.fid)?.searchL ?? "").join(" ");
            screenSearchL.set(id, ("screen " + sc.names[i].toLowerCase() + " "
                + sc.hues[i] + " " + hexes + " " + tex).trim());
        }
    }

    // animation replacements (proc Type 7 + aura 312, merged): the character
    // swaps a base animation for another. One "replace" group in the
    // Animations column; matched via the anim field on either side's name,
    // plus the word "replace" itself. ("stance" was the proc-7 form's name
    // before the merge and is NOT an alias — it is in no corpus and
    // anim:stance returns nothing.)
    const spellReplaceAnims = new Map<number, { src: number; dst: number }[]>();
    const replaceSpells = new Map<number, Set<number>>(); // animId (either side) -> spell ids
    if (pack.spellReplaceAnims) {
        const {spellIds, srcAnims, dstAnims} = pack.spellReplaceAnims;
        for (let i = 0; i < spellIds.length; i++) {
            const s = spellIds[i], src = srcAnims[i], dst = dstAnims[i];
            pushTo(spellReplaceAnims, s, {src, dst});
            for (const a of [src, dst]) {
                let set = replaceSpells.get(a);
                if (!set) replaceSpells.set(a, set = new Set());
                set.add(s);
            }
        }
    }

    // animations a spell's visual kits play directly (SpellVisualAnim
    // initial/loop anims, kit EffectType 6) — the largest animation source;
    // rendered as loose pills in the Animations column
    const spellVisualAnims = new Map<number, number[]>(); // spell id -> [animId]
    const visualAnimSpells = new Map<number, number[]>(); // animId -> [spell id]
    if (pack.spellVisualAnims) {
        const {spellIds, animIds} = pack.spellVisualAnims;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellVisualAnims, spellIds[i], animIds[i]);
            pushTo(visualAnimSpells, animIds[i], spellIds[i]);
        }
    }
    // a vehicle's OWN animations (VehicleEnter/Exit/RideAnimLoop on its
    // seats) join the loose pills rather than the "passenger" group: they
    // are the vehicle's behaviour, not the rider's. Same id space, no target
    // mask (so no icon), and de-duped against anims already present.
    if (pack.spellVehicleAnims) {
        const {spellIds, animIds} = pack.spellVehicleAnims;
        for (let i = 0; i < spellIds.length; i++) {
            const have = spellVisualAnims.get(spellIds[i]);
            if (have && have.includes(animIds[i])) continue;
            pushTo(spellVisualAnims, spellIds[i], animIds[i]);
            pushTo(visualAnimSpells, animIds[i], spellIds[i]);
        }
    }

    // model tints (SpellProceduralEffect Type 1 rows): color-only like
    // glows. Corpus: "tint" + hue + hex — fx:"tint red" / fx:#ff5800.
    const spellTints = new Map<number, number[]>(); // spell id -> [tintId]
    const tintSpells = new Map<number, number[]>(); // tintId -> [spell id]
    const tintColors = new Map<number, number>();   // tintId -> packed RGB
    const tintSearchL = new Map<number, string>();  // tintId -> search corpus
    if (pack.spellTints) {
        const {spellIds, tintIds} = pack.spellTints;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellTints, spellIds[i], tintIds[i]);
            pushTo(tintSpells, tintIds[i], spellIds[i]);
        }
        const t = pack.tints!;
        for (let i = 0; i < t.ids.length; i++) {
            tintColors.set(t.ids[i], t.colors[i]);
            tintSearchL.set(t.ids[i],
                ("tint " + t.hues[i] + " " + hexColor(t.colors[i])).trim());
        }
    }

    /* Mechanics (pack format 29). One row per distinct SpellEffect, carrying
     * what the effect does (Effect + EffectAura enum ids, 0 = neither) AND who
     * it is aimed at (ImplicitTarget_0/_1). Keeping the two together is the
     * whole point of the section: a spell whose effects aim at different
     * things — 10.4% of them — cannot say which target belongs to which effect
     * from per-spell sets alone.
     *
     * Format <= 28 packs ship flat spellEffects/spellAuras sets instead; they
     * are read into the same row shape with no targets, so every consumer
     * below sees one structure and stale packs simply render no target
     * segment or icons. */
    const spellMechanics = new Map<number, MechanicRow[]>();
    const implicitTargetBits = new Map<number, number>(
        Object.entries(pack.implicitTargetBits || {}).map(([k, v]) => [Number(k), v]));
    /* The same rows as flat parallel arrays. No reverse (name id -> spells)
     * index is built for mechanics: mech: matches whole ROWS, so it resolves
     * its tokens to id sets once per query and sweeps these arrays. A reverse
     * index could only answer "has this name somewhere", which is exactly the
     * question the pairing exists to stop asking — and sweeping the flat
     * arrays is ~10x faster than walking the Map's row objects (measured on
     * 9.2.7: 372k rows, 170 ms -> 15-25 ms per query), for no extra memory
     * when the pack ships them, since these are its own arrays by reference. */
    let mechanicCols: MechanicColumns = pack.spellMechanics
        ? {...pack.spellMechanics}
        : {spellIds: [], effects: [], auras: [], targetsA: [], targetsB: []};
    {
        // stale packs (format <= 28): concatenate the two flat sets into the
        // same column shape, target-less, so both consumers see one structure
        if (!pack.spellMechanics) {
            const eff = pack.spellEffects, aur = pack.spellAuras;
            const n = (eff ? eff.spellIds.length : 0) + (aur ? aur.spellIds.length : 0);
            const cols: MechanicColumns = {
                spellIds: new Array(n), effects: new Array(n), auras: new Array(n),
                targetsA: new Array(n).fill(0), targetsB: new Array(n).fill(0),
            };
            let k = 0;
            if (eff) {
                for (let i = 0; i < eff.spellIds.length; i++, k++) {
                    cols.spellIds[k] = eff.spellIds[i];
                    cols.effects[k] = eff.effects[i];
                    cols.auras[k] = 0;
                }
            }
            if (aur) {
                for (let i = 0; i < aur.spellIds.length; i++, k++) {
                    cols.spellIds[k] = aur.spellIds[i];
                    cols.effects[k] = 0;
                    cols.auras[k] = aur.auras[i];
                }
            }
            mechanicCols = cols;
        }
        const {spellIds, effects, auras, targetsA, targetsB} = mechanicCols;
        for (let i = 0; i < spellIds.length; i++) {
            const tA = targetsA[i] || 0, tB = targetsB[i] || 0;
            pushTo(spellMechanics, spellIds[i], {
                effect: effects[i], aura: auras[i], targetA: tA, targetB: tB,
                mask: (implicitTargetBits.get(tA) || 0) | (implicitTargetBits.get(tB) || 0),
            });
        }
    }
    const effectNames = new Map<number, string>(
        Object.entries(pack.effectNames).map(([k, v]) => [Number(k), v]));
    const effectNamesL = new Map<number, string>(
        [...effectNames].map(([k, v]) => [k, v.toLowerCase()]));
    // implicit targets: enum id -> name with "TARGET_" stripped, matching how
    // effect/aura names drop SPELL_EFFECT_/SPELL_AURA_. Ids the build's enum
    // has no entry for are absent and fall back to "TARGET_<id>" at render.
    const implicitTargetNames = new Map<number, string>(
        Object.entries(pack.implicitTargetNames || {}).map(([k, v]) => [Number(k), v]));
    const implicitTargetNamesL = new Map<number, string>(
        [...implicitTargetNames].map(([k, v]) => [k, v.toLowerCase()]));

    // morphs (transform auras): the spell references a CREATURE (NPC), the
    // creature has display ids (TDB creature_template_model), each display
    // resolves to a model file. Corpus per creature: "morph" + creature id
    // + NPC name + display ids + model paths — fx:"morph sheep", fx:"morph
    // 856" and fx:"morph 16372" all work.
    const spellMorphs = new Map<number, number[]>(); // spell id -> [creatureId]
    const morphSpells = new Map<number, number[]>(); // creatureId -> [spell id]
    const morphNames = new Map<number, string>();    // creatureId -> NPC name ("" = unknown)
    const morphDisplays = new Map<number, DisplayRef[]>();
    const morphSearchL = new Map<number, string>();  // creatureId -> search corpus
    {
        const {spellIds, creatureIds} = pack.spellMorphs;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellMorphs, spellIds[i], creatureIds[i]);
            pushTo(morphSpells, creatureIds[i], spellIds[i]);
        }
        const m = pack.morphs;
        for (let i = 0; i < m.creatureIds.length; i++) {
            morphNames.set(m.creatureIds[i], m.names[i]);
        }
        const md = pack.morphDisplays;
        for (let i = 0; i < md.creatureIds.length; i++) {
            pushTo(morphDisplays, md.creatureIds[i],
                {displayId: md.displayIds[i], fid: md.fids[i]});
        }
        for (const [c, name] of morphNames) {
            const parts = (morphDisplays.get(c) || []).map((e) =>
                e.displayId + " " + (files.get(e.fid)?.searchL ?? ""));
            morphSearchL.set(c,
                ("morph " + c + " " + name.toLowerCase() + " " + parts.join(" ")).trim());
        }
    }

    // shapeshift forms (MOD_SHAPESHIFT auras): a form name plus up to four
    // creature displays. Many forms (Battle Stance, Shadowform, Stealth) have
    // no display at all and are searchable/renderable by name alone.
    const spellShapeshifts = new Map<number, number[]>(); // spell id -> [formId]
    const shapeshiftSpells = new Map<number, number[]>(); // formId -> [spell id]
    const shapeshiftNames = new Map<number, string>();    // formId -> form name
    const shapeshiftDisplays = new Map<number, DisplayRef[]>();
    const shapeshiftSearchL = new Map<number, string>();  // formId -> search corpus
    if (pack.spellShapeshifts) {
        const {spellIds, formIds} = pack.spellShapeshifts;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellShapeshifts, spellIds[i], formIds[i]);
            pushTo(shapeshiftSpells, formIds[i], spellIds[i]);
        }
        const f = pack.shapeshifts!;
        for (let i = 0; i < f.ids.length; i++) shapeshiftNames.set(f.ids[i], f.names[i]);
        const sd = pack.shapeshiftDisplays!;
        for (let i = 0; i < sd.formIds.length; i++) {
            pushTo(shapeshiftDisplays, sd.formIds[i],
                {displayId: sd.displayIds[i], fid: sd.fids[i]});
        }
        for (const [id, name] of shapeshiftNames) {
            const parts = (shapeshiftDisplays.get(id) || []).map((e) =>
                e.displayId + " " + (files.get(e.fid)?.searchL ?? ""));
            shapeshiftSearchL.set(id,
                ("shapeshift " + id + " " + name.toLowerCase() + " " + parts.join(" ")).trim());
        }
    }

    // summons (SUMMON spell effects): the spell summons a CREATURE (NPC);
    // control (guardian/pet/...) is per spell-effect row, from its
    // SummonProperties — so the corpus lives per (creature, control) pair:
    // "summon" + creature id + NPC name + control word. fx:"summon argi",
    // fx:"summon 88807" and fx:"summon guardian" all work.
    const spellSummons = new Map<number, { creatureId: number; control: number }[]>();
    const summonNames = new Map<number, string>(); // creatureId -> NPC name ("" = unknown)
    const summonPairSpells = new Map<string, number[]>(); // "creature:control" -> [spell id]
    const summonPairSearchL = new Map<string, string>();  // "creature:control" -> search corpus
    // control id -> word
    const summonControlNames = pack.summonControlNames || NO_WORDS;
    {
        const su = pack.summons;
        for (let i = 0; i < su.creatureIds.length; i++) {
            summonNames.set(su.creatureIds[i], su.names[i]);
        }
        // pack rows are unique (spell, creature, control) triples, so the
        // pair maps need no dedupe
        const {spellIds, creatureIds, controls} = pack.spellSummons;
        for (let i = 0; i < spellIds.length; i++) {
            const c = creatureIds[i], ctrl = controls[i];
            pushTo(spellSummons, spellIds[i], {creatureId: c, control: ctrl});
            const key = c + ":" + ctrl;
            pushTo(summonPairSpells, key, spellIds[i]);
            if (!summonPairSearchL.has(key)) {
                summonPairSearchL.set(key,
                    ("summon " + c + " " + (summonNames.get(c) || "").toLowerCase()
                        + " " + (summonControlNames[ctrl] || "")).trim());
            }
        }
    }

    // mounts (Mount.db2 keyed by SourceSpellID): the spell puts you on a
    // CreatureDisplayID. Client data end to end — unlike morphs, which need a
    // TDB for the creature name — so mounts resolve on every pack. Corpus per
    // display: "mount" + display id + mount name + model path, so
    // model:mount, model:"mount swift" and model:"mount 2404" all work.
    const spellMounts = new Map<number, number[]>(); // spell id -> [displayId]
    const mountSpells = new Map<number, number[]>(); // displayId -> [spell id]
    const mountNames = new Map<number, string>();    // displayId -> mount name ("" = unnamed)
    const mountFids = new Map<number, number>();     // displayId -> model fid (0 = unresolved)
    const mountSearchL = new Map<number, string>();  // displayId -> search corpus
    if (pack.spellMounts) {
        const {spellIds, displayIds} = pack.spellMounts;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellMounts, spellIds[i], displayIds[i]);
            pushTo(mountSpells, displayIds[i], spellIds[i]);
        }
        const mo = pack.mounts!;
        for (let i = 0; i < mo.displayIds.length; i++) {
            mountNames.set(mo.displayIds[i], mo.names[i]);
            mountFids.set(mo.displayIds[i], mo.fids[i]);
        }
        for (const dsp of mountSpells.keys()) {
            const f = files.get(mountFids.get(dsp) || 0);
            mountSearchL.set(dsp, ("mount " + dsp + " "
                + (mountNames.get(dsp) || "").toLowerCase()
                + " " + (f ? f.searchL : "")).trim());
        }
    }

    // gameobject spawners (TRANS_DOOR / SUMMON_OBJECT_*): the spell PLACES an
    // object. Sibling of summon (which conjures a creature). The name and the
    // model both come from the TDB world dump's gameobject_template, so on the
    // TDB-less Classic packs both are empty and the pill degrades to a bare
    // `.gobject spawn` id. Corpus per entry: "object" + entry + name + model.
    const spellObjects = new Map<number, number[]>(); // spell id -> [gameobject entry]
    const objectSpells = new Map<number, number[]>(); // entry -> [spell id]
    const objectNames = new Map<number, string>();    // entry -> object name ("" = unresolved)
    const objectFids = new Map<number, number>();     // entry -> model fid (0 = unresolved)
    const objectTypes = new Map<number, number>();    // entry -> GAMEOBJECT_TYPE (gates the Wowhead link)
    const objectSearchL = new Map<number, string>();  // entry -> search corpus
    if (pack.spellObjects) {
        const {spellIds, objectIds} = pack.spellObjects;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellObjects, spellIds[i], objectIds[i]);
            pushTo(objectSpells, objectIds[i], spellIds[i]);
        }
        const ob = pack.objects!;
        for (let i = 0; i < ob.ids.length; i++) {
            objectNames.set(ob.ids[i], ob.names[i]);
            objectFids.set(ob.ids[i], ob.fids[i]);
            if (ob.types) objectTypes.set(ob.ids[i], ob.types[i]);
        }
        for (const e of objectSpells.keys()) {
            const f = files.get(objectFids.get(e) || 0);
            objectSearchL.set(e, ("object " + e + " "
                + (objectNames.get(e) || "").toLowerCase()
                + " " + (f ? f.searchL : "")).trim());
        }
    }

    // vehicles (SET_VEHICLE_ID auras): the aura references a Vehicle.db2 id.
    // Each vehicle carries a seat count and one attachment name per seat, in
    // SeatID_0..7 order — where on the vehicle's model that seat sits. 0-seat
    // vehicles carry no pill (dropped at build). Corpus per vehicle is
    // "vehicle" + its attachment names, so fx:vehicle finds any and
    // fx:"vehicle base" finds one seated at Base; the seat COUNT is matched
    // numerically instead (fx:"vehicle >2"), so it stays out of the corpus.
    const vehicleSeats = new Map<number, string[]>(); // vehicle id -> [attachment name per seat]
    if (pack.vehicleSeats) {
        const {vehicleIds, attachments} = pack.vehicleSeats;
        for (let i = 0; i < vehicleIds.length; i++) {
            pushTo(vehicleSeats, vehicleIds[i], attachments[i]);
        }
    }
    const spellVehicles = new Map<number, number[]>(); // spell id -> [vehicle id]
    const vehicleSpells = new Map<number, number[]>(); // vehicle id -> [spell id]
    const vehicleSearchL = new Map<number, string>();  // vehicle id -> lowercased search corpus
    if (pack.spellVehicles) {
        const {spellIds, vehicleIds} = pack.spellVehicles;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellVehicles, spellIds[i], vehicleIds[i]);
            pushTo(vehicleSpells, vehicleIds[i], spellIds[i]);
        }
        for (const v of vehicleSpells.keys()) {
            const seats = vehicleSeats.get(v) || [];
            vehicleSearchL.set(v, `seat ${seats.join(" ")}`.toLowerCase());
        }
    }

    /* Keybound overrides (aura 406, pack format 29). While the aura holds, a
     * movement/UI key stops doing what it normally does. Each override carries
     * the key's client binding name, a word for WHEN it applies ("" = the
     * ordinary press, "mid-air" = the airborne one) and the Spell::ID the
     * retail client casts in its place.
     *
     * That cast spell is deliberately NOT surfaced (user's call, 2026-07-23):
     * on Epsilon the override only DISABLES the key, it does not cast the
     * replacement, so showing the spell would promise behaviour Epsilon users
     * cannot actually get. The pack keeps `spells` for a future pass —
     * restoring it means adding the id and name back to this corpus and to
     * keybindTag, nothing more.
     *
     * Corpus per override is therefore "keybind" + the key + the timing word:
     * fx:keybind finds any, fx:"keybind jump" the jump ones, fx:"keybind
     * mid-air" the airborne ones. */
    const keybinds = new Map<number, KeybindRow>(); // override id -> what it binds
    if (pack.keybinds) {
        const {ids, functions, whens, spells} = pack.keybinds;
        for (let i = 0; i < ids.length; i++) {
            keybinds.set(ids[i], {
                fn: functions[i], when: whens[i], spell: spells[i],
            });
        }
    }
    const spellKeybinds = new Map<number, number[]>(); // spell id -> [override id]
    const keybindSpells = new Map<number, number[]>(); // override id -> [spell id]
    const keybindSearchL = new Map<number, string>();  // override id -> lowercased search corpus
    if (pack.spellKeybinds) {
        const {spellIds, overrideIds} = pack.spellKeybinds;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellKeybinds, spellIds[i], overrideIds[i]);
            pushTo(keybindSpells, overrideIds[i], spellIds[i]);
        }
        for (const o of keybindSpells.keys()) {
            const row = keybinds.get(o);
            if (!row) continue;
            keybindSearchL.set(o,
                `keybind ${row.fn} ${row.when}`.replace(/\s+/g, " ").trim().toLowerCase());
        }
    }
    const keybindTargets = maskIndex(pack.spellKeybinds, "overrideIds");

    /* Spell -> spell links (pack format 35). The pack ships ONE direction; both
     * are built here, because "what triggers this" is the same edge list read
     * backwards and shipping it twice would pay for it twice.
     *
     * Four indexes per direction, and the split matters: the RENDER side is
     * keyed by the spell whose row is drawn (its chips), while the SEARCH side
     * is keyed by the spell a chip STANDS FOR — that is the id `mech:triggers`
     * resolves, exactly as fx:summon resolves a creature id.
     *
     * The corpus opens with the category word so a bare `mech:triggers` matches
     * through the same path as `mech:"triggers fireball"`, and carries the
     * linked spell's name plus every word it is joined by — so
     * mech:"triggers periodically" finds spells whose link is periodic. */
    const spellTriggers = new Map<number, SpellLink[]>();
    const spellOrigins = new Map<number, SpellLink[]>();
    const triggersSpells = new Map<number, number[]>();
    const originSpells = new Map<number, number[]>();
    const triggersSearchL = new Map<number, string>();
    const originSearchL = new Map<number, string>();
    if (pack.spellLinks) {
        const {srcIds, dstIds, kinds, targets, kindNames} = pack.spellLinks;
        // one entry per (row spell, other end), collecting the words — a pair
        // joined two ways is ONE chip listing both, not two chips, so its mask
        // is the union of the ways too
        const push = (into: Map<number, SpellLink[]>, key: number, other: number,
                      word: string, mask: number) => {
            const list = into.get(key);
            if (!list) {
                into.set(key, [{spell: other, kinds: [word], mask}]);
                return;
            }
            const prev = list.find((l) => l.spell === other);
            if (!prev) list.push({spell: other, kinds: [word], mask});
            else {
                if (!prev.kinds.includes(word)) prev.kinds.push(word);
                prev.mask |= mask;
            }
        };
        for (let i = 0; i < srcIds.length; i++) {
            const word = kindNames[kinds[i]] || "";
            const mask = targets ? targets[i] : 0;
            push(spellTriggers, srcIds[i], dstIds[i], word, mask);
            push(spellOrigins, dstIds[i], srcIds[i], word, mask);
        }
        /* The two directions are DUALS, which is what makes the search side
         * free: the spells whose row shows "triggers X" are exactly the spells
         * X is triggered BY. So each search index is the opposite render map
         * with the words dropped, and each corpus is that map's words joined —
         * no third pass over the edges, and no chance of the two disagreeing. */
        const nameOf = (id: number) => {
            const idx = spellIndex.get(id);
            return idx === undefined ? "" : sp.names[idx];
        };
        /* THE LINKED SPELL'S ID IS DELIBERATELY NOT IN THE CORPUS, and it was
         * measured out rather than left out. A corpus is matched by SUBSTRING,
         * so a 6-digit id makes every numeric token in the whole `mech:` field
         * match a tenth of the graph by accident. It broke a bound number
         * outright: `mech:"speed 70"` is 76 spells and became 85, which
         * contradicts this app's own rule that a number written against its
         * word means `=` on that axis. `mech:"invis 13"` went 11 -> 47, i.e.
         * 77% noise, against 11 -> 16 without the id.
         *
         * The cost is that `mech:"triggers 133"` finds nothing, and that is
         * the right trade: the chip's own click already navigates to `id:133`,
         * which answers the same question exactly rather than by substring.
         * `mech:"triggers fireball"` is the name route and is unaffected. */
        const derive = (from: Map<number, SpellLink[]>, word: string,
                        spells: Map<number, number[]>, out: Map<number, string>) => {
            for (const [id, list] of from) {
                spells.set(id, list.map((l) => l.spell));
                const ws = new Set(list.flatMap((l) => l.kinds));
                out.set(id, `${word} ${nameOf(id)} ${[...ws].join(" ")}`
                    .replace(/\s+/g, " ").trim().toLowerCase());
            }
        };
        derive(spellOrigins, "triggers", triggersSpells, triggersSearchL);
        derive(spellTriggers, "origin", originSpells, originSearchL);
    }

    // invisibility / detection channels (pack format 26). Grouped by
    // invisibility TYPE, which is the pairing key: an invis spell links to the
    // detect spells sharing its type and vice versa. Per spell we keep the
    // (type, target mask) pills to render; per type we keep both membership
    // lists — their lengths are the counterpart counts shown on the pills, and
    // they back fx:invis / fx:detect searches. Only channels with an invis side
    // exist in the pack, so a detect pill's counterpart count is always ≥1.
    const spellInvisTypes = new Map<number, { type: number; mask: number }[]>();
    const spellDetectTypes = new Map<number, { type: number; mask: number }[]>();
    const invisTypeSpells = new Map<number, number[]>();  // invisibility type -> [invis spell id]
    const detectTypeSpells = new Map<number, number[]>(); // invisibility type -> [detect spell id]
    const loadChannels = (
        section: { spellIds: number[]; types: number[]; targets: number[] } | undefined,
        spellPills: Map<number, { type: number; mask: number }[]>,
        typeSpells: Map<number, number[]>): void => {
        if (!section) return;
        const {spellIds, types, targets} = section;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellPills, spellIds[i], {type: types[i], mask: targets[i]});
            pushTo(typeSpells, types[i], spellIds[i]);
        }
    };
    loadChannels(pack.spellInvis, spellInvisTypes, invisTypeSpells);
    loadChannels(pack.spellDetects, spellDetectTypes, detectTypeSpells);

    // movement-speed modifiers (pack format 30). A pill is a (movement,
    // percent) pair, so that pair is the id the search matches on and it
    // rides as one string key — "run|70", "all|-50". Only the two maps the
    // registry needs are built here; the pills themselves keep the numbers
    // apart so the renderer never re-parses the key.
    const spellSpeedMods = new Map<number, {
        move: string; pct: number; amount: string; key: string; mask: number;
    }[]>();
    const speedSpells = new Map<string, number[]>();  // "move|pct" -> [spell id]
    const speedSearchL = new Map<string, string>();   // "move|pct" -> lowercase haystack
    const speedPercents = new Map<string, number>();  // "move|pct" -> the percent, for the numeric axis
    if (pack.spellSpeeds) {
        const {spellIds, movements, percents, targets} = pack.spellSpeeds;
        for (let i = 0; i < spellIds.length; i++) {
            const move = movements[i], pct = percents[i];
            const key = `${move}|${pct}`;
            const amount = signedPercent(pct);
            pushTo(spellSpeedMods, spellIds[i], {move, pct, amount, key, mask: targets[i]});
            pushTo(speedSpells, key, spellIds[i]);
            // the corpus carries the percent exactly as the pill prints it,
            // sign and all, so typing what you see works: fx:"speed +70%"
            speedSearchL.set(key, `speed ${move} ${amount}`.toLowerCase());
            speedPercents.set(key, pct);
        }
    }

    // object-scale modifiers (pack format 31). One axis shorter than speed:
    // there is only one thing an aura can scale, so the PERCENT itself is
    // the id — the same shape desaturate and transparency already use, and
    // it needs no separate map for the numeric axis.
    const spellScaleMods = new Map<number, { pct: number; amount: string; mask: number }[]>();
    const scaleSpells = new Map<number, number[]>(); // percent -> [spell id]
    const scaleSearchL = new Map<number, string>();  // percent -> lowercase haystack
    if (pack.spellScales) {
        const {spellIds, percents, targets} = pack.spellScales;
        for (let i = 0; i < spellIds.length; i++) {
            const pct = percents[i], amount = signedPercent(pct);
            pushTo(spellScaleMods, spellIds[i], {pct, amount, mask: targets[i]});
            pushTo(scaleSpells, pct, spellIds[i]);
            scaleSearchL.set(pct, `scale ${amount}`.toLowerCase());
        }
    }

    // the rider's own animations while entering/seated/exiting — their own
    // "passenger" group in the Animations column
    const spellPassengerAnims = new Map<number, number[]>(); // spell id -> [animId]
    const passengerAnimSpells = new Map<number, number[]>(); // animId -> [spell id]
    if (pack.spellPassengerAnims) {
        const {spellIds, animIds} = pack.spellPassengerAnims;
        for (let i = 0; i < spellIds.length; i++) {
            pushTo(spellPassengerAnims, spellIds[i], animIds[i]);
            pushTo(passengerAnimSpells, animIds[i], spellIds[i]);
        }
    }

    // aura mechanics (SpellEffectAura enum id -> name without SPELL_AURA_).
    // The spell->aura links live on the mechanic rows above; only the names
    // are read here.
    const auraNames = new Map<number, string>(
        Object.entries(pack.auraNames).map(([k, v]) => [Number(k), v]));
    const auraNamesL = new Map<number, string>(
        [...auraNames].map(([k, v]) => [k, v.toLowerCase()]));

    // fids referenced as models / as sounds (search scopes)
    const modelFids: number[] = [...modelSpells.keys()];
    const soundFids: number[] = [...soundSpells.keys()];

    console.info(`Epsilook: indexes built in ${(performance.now() - t0).toFixed(0)} ms`);
    return {
        meta: pack.meta,
        ids: sp.ids, names: sp.names, subtexts: sp.subtexts, icons,
        namesL, spellIndex, files, hasSyntheticFiles,
        spellModels, modelSpells, modelFids, attachmentNames,
        spellModelCats, modelCatSpells, modelCatFidSpells, modelCatNames,
        items, itemSearchL, itemSpells, itemCat, missileMotionNames,
        spellSounds, soundSpells, soundFids, soundKitSpells, soundKitFiles,
        spellAnimKits, animKitSpells,
        animNames, animNamesL, animKitAnims, animAnimKits,
        bonesetNames, animKitAnimBoneset, spellBonesets,
        spellFx, spellChainRows, fxSpells, fxChains, fxTextures, fxSearchL,
        spellDissolves, dissolveSpells, dissolveDurations, dissolveTextures,
        dissolveAttach, dissolveSearchL,
        spellGlows, glowSpells, glowColors, glowAlphas, glowSearchL,
        spellShadowies, shadowySpells, shadowyColors, shadowyAttach, shadowySearchL,
        spellGhostMats, ghostMatSpells, ghostMatColors, ghostMatSearchL,
        spellTints, tintSpells, tintColors, tintSearchL,
        spellDesaturates, desatSpells, desatSearchL,
        spellTransps, transpSpells, transpSearchL,
        spellFreezes, spellCamos,
        spellScreens, screenSpells, screenNames, screenColors, screenTextures, screenSearchL,
        spellVisualAnims, visualAnimSpells,
        targetNames, animKitTargets, visualAnimTargets, fxTargets,
        dissolveTargets, glowTargets, shadowyTargets, ghostMatTargets,
        morphTargets, summonTargets, objectTargets, vehicleTargets, shapeshiftTargets,
        screenTargets,
        spellMounts, mountSpells, mountNames, mountFids, mountSearchL,
        spellObjects, objectSpells, objectNames, objectFids, objectTypes, objectSearchL,
        spellReplaceAnims, replaceSpells,
        spellMorphs, morphSpells, morphNames, morphDisplays, morphSearchL,
        spellShapeshifts, shapeshiftSpells, shapeshiftNames, shapeshiftDisplays,
        shapeshiftSearchL,
        spellSummons, summonNames, summonPairSpells, summonPairSearchL, summonControlNames,
        spellVehicles, vehicleSpells, vehicleSeats, vehicleSearchL,
        spellInvisTypes, spellDetectTypes, invisTypeSpells, detectTypeSpells,
        spellSpeedMods, speedSpells, speedSearchL, speedPercents,
        spellScaleMods, scaleSpells, scaleSearchL,
        spellPassengerAnims, passengerAnimSpells,
        spellKeybinds, keybindSpells, keybinds, keybindSearchL, keybindTargets,
        spellTriggers, spellOrigins,
        triggersSpells, triggersSearchL, originSpells, originSearchL,
        spellMechanics, mechanicCols,
        effectNames, effectNamesL, auraNames, auraNamesL,
        implicitTargetNames, implicitTargetNamesL, implicitTargetBits,
    };
}
