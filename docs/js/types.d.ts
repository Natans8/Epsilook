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
  wowheadSpellUrl: string;
  wowheadSoundUrl: string;
  wowheadMorphUrl: string;
  wowheadNpcUrl: string;
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
  tagsCollapsedLimit: number;
  kitFilesCollapsedLimit: number;
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
  spellModels: { spellIds: number[]; fids: number[]; cats?: number[]; targets?: number[];
    /** Raw M2 attachment ids, -1 = unset (pack format 24+). Attached models
     *  use src only; missiles use both (launch -> impact). */
    srcAttach?: number[]; dstAttach?: number[] };
  /** Raw M2 attachment id -> name (pack format 24+). */
  attachmentNames?: Record<number, string>;
  /** Category id -> word ("attached", "missile", "area", "trail", "barrage"). */
  modelCatNames?: Record<number, string>;
  /** mask bit -> search word ("caster"/"target"/"area"); format 22+ */
  targetNames?: Record<number, string>;

  /** Spell -> (SoundKit, sound file) rows. */
  spellSounds: { spellIds: number[]; soundKitIds: number[]; fids: number[]; targets?: number[] };

  spellAnimKits: { spellIds: number[]; animKitIds: number[]; targets?: number[] };
  /** Animation names indexed by AnimID. */
  animNames: string[];
  animKitAnims: { animKitIds: number[]; animIds: number[] };
  /** Direct stand/walk anim overrides, proc Type 7 (format 14+). */
  spellAnims?: { spellIds: number[]; animIds: number[] };
  /** Animations the kits play directly, SpellVisualAnim ET 6 (format 21+). */
  spellVisualAnims?: { spellIds: number[]; animIds: number[]; targets?: number[] };

  /* --- visual fx sections (the Effects column) --- */

  /** Spell -> SpellChainEffects (chain/beam) rows. */
  spellFx: { spellIds: number[]; chainIds: number[]; targets?: number[];
    /** The drawing beam's attach points (format 24+), -1 = unset. */
    srcAttach?: number[]; dstAttach?: number[] };
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
  /** The rider's animations while entering/seated/exiting (a vehicle seat's
   *  passenger AnimationData). animIds index animNames. */
  spellPassengerAnims?: { spellIds: number[]; animIds: number[] };
  /** The vehicle's own animations — rendered as loose pills, not under
   *  "passenger". Same id space. */
  spellVehicleAnims?: { spellIds: number[]; animIds: number[] };
  /** AnimKit ids reached through a vehicle seat; join the animkit groups. */
  spellVehicleAnimKits?: { spellIds: number[]; animKitIds: number[] };

  /* --- mechanics --- */

  spellEffects: { spellIds: number[]; effects: number[] };
  /** SpellEffect enum id -> name without the SPELL_EFFECT_ prefix. */
  effectNames: Record<string, string>;
  spellAuras: { spellIds: number[]; auras: number[] };
  /** SpellEffectAura enum id -> name without the SPELL_AURA_ prefix. */
  auraNames: Record<string, string>;
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
  }[]>;
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
  spellAnims: Map<number, number[]>;
  animDirectSpells: Map<number, number[]>;
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

  /** spell id -> [animId] the rider plays; the "passenger" anim group. */
  spellPassengerAnims: Map<number, number[]>;
  passengerAnimSpells: Map<number, number[]>;

  spellEffects: Map<number, number[]>;
  effectSpells: Map<number, number[]>;
  effectNames: Map<number, string>;
  effectNamesL: Map<number, string>;
  spellAuras: Map<number, number[]>;
  auraSpells: Map<number, number[]>;
  auraNames: Map<number, string>;
  auraNamesL: Map<number, string>;
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
  /** desaturate / transparency strength. */
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
}
