// @ts-check
/* Data loading: fetch the gzipped JSON pack for a game version and build
 * the in-memory indexes every search runs against. No query engine —
 * plain arrays and Maps.
 *
 * The pack layout (SpellPack) and the index shapes (SpellData) are
 * documented in types.d.ts. */
"use strict";

window.EpsilookData = (() => {

  /**
   * Fetch the version manifest (always revalidated).
   * @returns {Promise<VersionEntry[]>}
   */
  async function loadVersions() {
    // no-cache = always revalidate (tiny file, 304 when unchanged), so a
    // fresh deploy is picked up immediately instead of after cache expiry
    const resp = await fetch("data/versions.json", { cache: "no-cache" });
    if (!resp.ok) throw new Error(`versions.json: HTTP ${resp.status}`);
    return resp.json();
  }

  /**
   * Fetch + gunzip + parse one version's pack, reporting download progress.
   * @param {VersionEntry} versionEntry
   * @param {(received: number, total: number) => void} [onProgress] - total
   *   is 0 when the server sends no Content-Length
   * @returns {Promise<SpellPack>}
   */
  async function loadPack(versionEntry, onProgress) {
    // the manifest's content hash busts the browser cache exactly when the
    // pack data changed; an unchanged hash keeps serving the cached 6+ MB
    const url = versionEntry.file + (versionEntry.hash ? "?v=" + versionEntry.hash : "");
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${versionEntry.file}: HTTP ${resp.status}`);

    const total = Number(resp.headers.get("Content-Length")) || 0;
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) onProgress(received, total);
    }

    const blob = new Blob(chunks);
    let text;
    try {
      const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
      text = await new Response(stream).text();
    } catch (e) {
      // Some hosts transparently gunzip .gz responses; fall back to plain text.
      text = await blob.text();
    }
    return JSON.parse(text);
  }

  /**
   * The part of a listfile path after the last "/".
   * @param {string} path
   * @returns {string}
   */
  function basename(path) {
    const i = path.lastIndexOf("/");
    return i >= 0 ? path.slice(i + 1) : path;
  }

  /**
   * Turn the column-oriented pack into fast lookup structures.
   * @param {SpellPack} pack
   * @returns {SpellData}
   */
  function buildIndexes(pack) {
    const t0 = performance.now();
    const sp = pack.spells;
    const n = sp.ids.length;

    /** @type {Map<number, number>} spell id -> array index */
    const spellIndex = new Map();
    /** @type {string[]} */
    const namesL = new Array(n);
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
    /** @type {string[]} */
    const icons = new Array(n);
    for (let i = 0; i < n; i++) {
      const idx = sp.icons ? sp.icons[i] : 0;
      icons[i] = idx ? iconNames[idx - 1] : "";
    }

    /** @type {Map<number, FileEntry>} fid -> {path, base, searchL} */
    const files = new Map();
    const fp = pack.files;
    for (let i = 0; i < fp.fids.length; i++) {
      const fid = fp.fids[i];
      const path = fp.paths[i];
      const base = path ? basename(path) : "";
      files.set(fid, { fid, path, base, searchL: path.toLowerCase() });
    }

    /**
     * Append value to the array at map[key], creating the array on first use.
     * @template K, V
     * @param {Map<K, V[]>} map
     * @param {K} key
     * @param {V} value
     */
    const pushTo = (map, key, value) => {
      const arr = map.get(key);
      if (arr) arr.push(value); else map.set(key, [value]);
    };

    // models — each (spell, fid) row carries a usage category
    // (attach/missile/area/trail/barrage) since pack format 15; a stale
    // cached pack has no cats and renders the old flat list
    /** @type {Map<number, number[]>} spell id -> [fid] (deduped) */
    const spellModels = new Map();
    /** @type {Map<number, number[]>} fid -> [spell id] */
    const modelSpells = new Map();
    /** @type {Map<number, {fid: number, cat: number}[]>} spell id -> [{fid, cat}] */
    const spellModelCats = new Map();
    /** @type {Map<number, Set<number>>} cat id -> Set(spell id) */
    const modelCatSpells = new Map();
    /** @type {Map<number, Map<number, number[]>>} cat id -> Map(fid -> [spell id]) */
    const modelCatFidSpells = new Map();
    /** @type {Record<number, string>} */
    const modelCatNames = pack.modelCatNames || {};
    {
      const { spellIds, fids, cats } = pack.spellModels;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(modelSpells, fids[i], spellIds[i]);
        if (!cats) { pushTo(spellModels, spellIds[i], fids[i]); continue; }
        pushTo(spellModelCats, spellIds[i], { fid: fids[i], cat: cats[i] });
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

    // sounds
    /** @type {Map<number, {soundKitId: number, fid: number}[]>} spell id -> [{soundKitId, fid}] */
    const spellSounds = new Map();
    /** @type {Map<number, number[]>} fid -> [spell id] */
    const soundSpells = new Map();
    /** @type {Map<number, number[]>} soundKitId -> [spell id] */
    const soundKitSpells = new Map();
    /** @type {Map<number, Set<number>>} soundKitId -> Set(fid) */
    const soundKitFiles = new Map();
    {
      const { spellIds, soundKitIds, fids } = pack.spellSounds;
      for (let i = 0; i < spellIds.length; i++) {
        const s = spellIds[i], k = soundKitIds[i], f = fids[i];
        pushTo(spellSounds, s, { soundKitId: k, fid: f });
        pushTo(soundSpells, f, s);
        pushTo(soundKitSpells, k, s);
        let set = soundKitFiles.get(k);
        if (!set) soundKitFiles.set(k, set = new Set());
        set.add(f);
      }
      // soundKitSpells values contain duplicates (one per kit file) — dedupe
      for (const [k, arr] of soundKitSpells) soundKitSpells.set(k, [...new Set(arr)]);
      for (const [s, arr] of spellSounds) {
        const seen = new Set();
        spellSounds.set(s, arr.filter((e) => {
          const key = e.soundKitId + ":" + e.fid;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }));
      }
    }

    // animkits
    /** @type {Map<number, number[]>} spell id -> [animKitId] */
    const spellAnimKits = new Map();
    /** @type {Map<number, number[]>} animKitId -> [spell id] */
    const animKitSpells = new Map();
    {
      const { spellIds, animKitIds } = pack.spellAnimKits;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellAnimKits, spellIds[i], animKitIds[i]);
        pushTo(animKitSpells, animKitIds[i], spellIds[i]);
      }
    }

    // animations contained in animkits (names indexed by AnimID)
    const animNames = pack.animNames;
    /** @type {string[]} */
    const animNamesL = animNames.map((n) => n.toLowerCase());
    /** @type {Map<number, number[]>} animKitId -> [animId] */
    const animKitAnims = new Map();
    /** @type {Map<number, number[]>} animId -> [animKitId] */
    const animAnimKits = new Map();
    {
      const { animKitIds, animIds } = pack.animKitAnims;
      for (let i = 0; i < animKitIds.length; i++) {
        pushTo(animKitAnims, animKitIds[i], animIds[i]);
        pushTo(animAnimKits, animIds[i], animKitIds[i]);
      }
    }

    /**
     * Packed RGB -> "#rrggbb" (the form fx corpora carry, so hex queries
     * like fx:#ff5800 — or just a hex prefix — match by substring).
     * @param {number} c
     * @returns {string}
     */
    const hexColor = (c) => "#" + c.toString(16).padStart(6, "0");

    // visual FX: chain/beam effects (category word "chain" since
    // 2026-07-19). Each chain has a tint (0xFFFFFF = untinted), a hue word,
    // textures (fids into `files`), and a lowercase search corpus:
    // "chain" + hue + tint hex + texture paths.
    /** @type {Map<number, number[]>} spell id -> [chainId] */
    const spellFx = new Map();
    /** @type {Map<number, number[]>} chainId -> [spell id] */
    const fxSpells = new Map();
    /** @type {Map<number, {color: number, hue: string}>} chainId -> {color, hue} */
    const fxChains = new Map();
    /** @type {Map<number, number[]>} chainId -> [fid] */
    const fxTextures = new Map();
    /** @type {Map<number, string>} chainId -> search corpus */
    const fxSearchL = new Map();
    {
      const { spellIds, chainIds } = pack.spellFx;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellFx, spellIds[i], chainIds[i]);
        pushTo(fxSpells, chainIds[i], spellIds[i]);
      }
      const fc = pack.fxChains;
      for (let i = 0; i < fc.ids.length; i++) {
        fxChains.set(fc.ids[i], { color: fc.colors[i], hue: fc.hues[i] });
      }
      const ft = pack.fxTextures;
      for (let i = 0; i < ft.chainIds.length; i++) {
        pushTo(fxTextures, ft.chainIds[i], ft.fids[i]);
      }
      for (const [c, info] of fxChains) {
        const tex = (fxTextures.get(c) || [])
          .map((fid) => (files.get(fid) || { searchL: "" }).searchL).join(" ");
        // 0xFFFFFF = untinted ("the texture's own color"), not white — no hex
        const hex = info.color === 0xffffff ? "" : hexColor(info.color);
        fxSearchL.set(c, ("chain " + info.hue + " " + hex + " " + tex).trim());
      }
    }

    // dissolves (DissolveEffect rows): duration + TextureBlendSet textures;
    // corpus: "dissolve" + texture paths — fx:"dissolve arcane_wisps" style.
    /** @type {Map<number, number[]>} spell id -> [dissolveId] */
    const spellDissolves = new Map();
    /** @type {Map<number, number[]>} dissolveId -> [spell id] */
    const dissolveSpells = new Map();
    /** @type {Map<number, number>} dissolveId -> seconds (0 = unspecified) */
    const dissolveDurations = new Map();
    /** @type {Map<number, number[]>} dissolveId -> [fid] */
    const dissolveTextures = new Map();
    /** @type {Map<number, string>} dissolveId -> search corpus */
    const dissolveSearchL = new Map();
    {
      const { spellIds, dissolveIds } = pack.spellDissolves;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellDissolves, spellIds[i], dissolveIds[i]);
        pushTo(dissolveSpells, dissolveIds[i], spellIds[i]);
      }
      const ds = pack.dissolves;
      for (let i = 0; i < ds.ids.length; i++) {
        dissolveDurations.set(ds.ids[i], ds.durations[i]);
      }
      const dt = pack.dissolveTextures;
      for (let i = 0; i < dt.dissolveIds.length; i++) {
        pushTo(dissolveTextures, dt.dissolveIds[i], dt.fids[i]);
      }
      for (const id of dissolveDurations.keys()) {
        const tex = (dissolveTextures.get(id) || [])
          .map((fid) => (files.get(fid) || { searchL: "" }).searchL).join(" ");
        dissolveSearchL.set(id, ("dissolve " + tex).trim());
      }
    }

    // glows (EdgeGlowEffect rows): color-only, no texture or model.
    // Corpus: "glow" + hue + hex — fx:"glow red" / fx:#ff5800.
    /** @type {Map<number, number[]>} spell id -> [glowId] */
    const spellGlows = new Map();
    /** @type {Map<number, number[]>} glowId -> [spell id] */
    const glowSpells = new Map();
    /** @type {Map<number, number>} glowId -> packed RGB */
    const glowColors = new Map();
    /** @type {Map<number, number>} glowId -> alpha 0..255 (pack format 17+) */
    const glowAlphas = new Map();
    /** @type {Map<number, string>} glowId -> search corpus */
    const glowSearchL = new Map();
    {
      const { spellIds, glowIds } = pack.spellGlows;
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
    /** @type {Map<number, number[]>} spell id -> [shadowyId] */
    const spellShadowies = new Map();
    /** @type {Map<number, number[]>} shadowyId -> [spell id] */
    const shadowySpells = new Map();
    /** @type {Map<number, {primary: number, secondary: number}>} shadowyId -> {primary, secondary} */
    const shadowyColors = new Map();
    /** @type {Map<number, string>} shadowyId -> search corpus */
    const shadowySearchL = new Map();
    {
      const { spellIds, shadowyIds } = pack.spellShadowies;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellShadowies, spellIds[i], shadowyIds[i]);
        pushTo(shadowySpells, shadowyIds[i], spellIds[i]);
      }
      const sh = pack.shadowies;
      for (let i = 0; i < sh.ids.length; i++) {
        const primary = sh.primaryColors[i], secondary = sh.secondaryColors[i];
        shadowyColors.set(sh.ids[i], { primary, secondary });
        // category is "ghost" now, but keep "shadowy" searchable for the
        // ShadowyEffect rows so old fx:shadowy queries still resolve
        shadowySearchL.set(sh.ids[i],
          ("ghost shadowy " + sh.hues[i] + " " + hexColor(primary) + " " + hexColor(secondary)).trim());
      }
    }

    // ghost materials (SpellProceduralEffect Type 22): single-color material
    // recolors that share the "ghost" category with the ShadowyEffect rows.
    // Corpus: "ghost" + hue + hex.
    /** @type {Map<number, number[]>} spell id -> [ghostMatId] */
    const spellGhostMats = new Map();
    /** @type {Map<number, number[]>} ghostMatId -> [spell id] */
    const ghostMatSpells = new Map();
    /** @type {Map<number, number>} ghostMatId -> packed RGB */
    const ghostMatColors = new Map();
    /** @type {Map<number, string>} ghostMatId -> search corpus */
    const ghostMatSearchL = new Map();
    if (pack.spellGhostMats) {
      const { spellIds, ghostIds } = pack.spellGhostMats;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellGhostMats, spellIds[i], ghostIds[i]);
        pushTo(ghostMatSpells, ghostIds[i], spellIds[i]);
      }
      const gm = pack.ghostMats;
      for (let i = 0; i < gm.ids.length; i++) {
        ghostMatColors.set(gm.ids[i], gm.colors[i]);
        ghostMatSearchL.set(gm.ids[i],
          ("ghost " + gm.hues[i] + " " + hexColor(gm.colors[i])).trim());
      }
    }

    // desaturate (Type 21) / transparency (Type 14): percent-only pills. The
    // pill "id" IS the percent (0..100); corpus per percent so fx:desaturate,
    // fx:"desaturate 70" and fx:transparency all match.
    /** @type {Map<number, number[]>} spell id -> [percent] */
    const spellDesaturates = new Map();
    /** @type {Map<number, number[]>} percent -> [spell id] */
    const desatSpells = new Map();
    /** @type {Map<number, string>} percent -> corpus */
    const desatSearchL = new Map();
    if (pack.spellDesaturates) {
      const { spellIds, percents } = pack.spellDesaturates;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellDesaturates, spellIds[i], percents[i]);
        pushTo(desatSpells, percents[i], spellIds[i]);
        if (!desatSearchL.has(percents[i]))
          desatSearchL.set(percents[i], "desaturate " + percents[i] + "%");
      }
    }
    /** @type {Map<number, number[]>} spell id -> [percent] */
    const spellTransps = new Map();
    /** @type {Map<number, number[]>} percent -> [spell id] */
    const transpSpells = new Map();
    /** @type {Map<number, string>} percent -> corpus */
    const transpSearchL = new Map();
    if (pack.spellTransparencies) {
      const { spellIds, percents } = pack.spellTransparencies;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellTransps, spellIds[i], percents[i]);
        pushTo(transpSpells, percents[i], spellIds[i]);
        if (!transpSearchL.has(percents[i]))
          transpSearchL.set(percents[i], "transparency " + percents[i] + "%");
      }
    }

    // freeze (Type 11) / camo (Type 18): valueless standalone pills
    const spellFreezes = new Set(pack.spellFreezes ? pack.spellFreezes.spellIds : []);
    const spellCamos = new Set(pack.spellCamos ? pack.spellCamos.spellIds : []);

    // screen effects (ScreenEffect rows): the whole screen tints/overlays
    // while the aura holds. Each row: internal name, optional fog tint and
    // FullScreenEffect multiply/addition colors (-1 = none — 0 is a real
    // black), texture fids. Corpus: "screen" + name + hues + hexes + paths.
    /** @type {Map<number, number[]>} spell id -> [screenId] */
    const spellScreens = new Map();
    /** @type {Map<number, number[]>} screenId -> [spell id] */
    const screenSpells = new Map();
    /** @type {Map<number, string>} screenId -> internal name */
    const screenNames = new Map();
    /** @type {Map<number, ScreenColors>} screenId -> {fog, fogAlpha, mul, add, mask*} */
    const screenColors = new Map();
    /**
     * screenId -> [{fid, mask}] — mask textures are flat blend-set art the
     * mul/add colors paint; overlays (mask false) carry their own colors.
     * @type {Map<number, {fid: number, mask: boolean}[]>}
     */
    const screenTextures = new Map();
    /** @type {Map<number, string>} screenId -> search corpus */
    const screenSearchL = new Map();
    if (pack.spellScreens) {
      const { spellIds, screenIds } = pack.spellScreens;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellScreens, spellIds[i], screenIds[i]);
        pushTo(screenSpells, screenIds[i], spellIds[i]);
      }
      const st = pack.screenTextures;
      for (let i = 0; i < st.screenIds.length; i++) {
        // roles arrived in pack format 17; a stale cached pack has none, and
        // its fids were overlay-first anyway — treat them all as overlays
        pushTo(screenTextures, st.screenIds[i],
          { fid: st.fids[i], mask: st.roles ? st.roles[i] === 1 : false });
      }
      const sc = pack.screens;
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
          .map((t) => (files.get(t.fid) || { searchL: "" }).searchL).join(" ");
        screenSearchL.set(id, ("screen " + sc.names[i].toLowerCase() + " "
          + sc.hues[i] + " " + hexes + " " + tex).trim());
      }
    }

    // direct stand/walk anim ids (Type 7) — a second source for the
    // Animations column; matched via the anim field like animkit anims
    /** @type {Map<number, number[]>} spell id -> [animId] */
    const spellAnims = new Map();
    /** @type {Map<number, number[]>} animId -> [spell id] */
    const animDirectSpells = new Map();
    if (pack.spellAnims) {
      const { spellIds, animIds } = pack.spellAnims;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellAnims, spellIds[i], animIds[i]);
        pushTo(animDirectSpells, animIds[i], spellIds[i]);
      }
    }

    // model tints (SpellProceduralEffect Type 1 rows): color-only like
    // glows. Corpus: "tint" + hue + hex — fx:"tint red" / fx:#ff5800.
    /** @type {Map<number, number[]>} spell id -> [tintId] */
    const spellTints = new Map();
    /** @type {Map<number, number[]>} tintId -> [spell id] */
    const tintSpells = new Map();
    /** @type {Map<number, number>} tintId -> packed RGB */
    const tintColors = new Map();
    /** @type {Map<number, string>} tintId -> search corpus */
    const tintSearchL = new Map();
    if (pack.spellTints) {
      const { spellIds, tintIds } = pack.spellTints;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellTints, spellIds[i], tintIds[i]);
        pushTo(tintSpells, tintIds[i], spellIds[i]);
      }
      const t = pack.tints;
      for (let i = 0; i < t.ids.length; i++) {
        tintColors.set(t.ids[i], t.colors[i]);
        tintSearchL.set(t.ids[i],
          ("tint " + t.hues[i] + " " + hexColor(t.colors[i])).trim());
      }
    }

    // spell effects (enum id -> name without the SPELL_EFFECT_ prefix)
    /** @type {Map<number, number[]>} spell id -> [effect enum id] */
    const spellEffects = new Map();
    /** @type {Map<number, number[]>} effect enum id -> [spell id] */
    const effectSpells = new Map();
    {
      const { spellIds, effects } = pack.spellEffects;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellEffects, spellIds[i], effects[i]);
        pushTo(effectSpells, effects[i], spellIds[i]);
      }
    }
    /** @type {Map<number, string>} */
    const effectNames = new Map(
      Object.entries(pack.effectNames).map(([k, v]) => [Number(k), v]));
    /** @type {Map<number, string>} */
    const effectNamesL = new Map(
      [...effectNames].map(([k, v]) => [k, v.toLowerCase()]));

    // morphs (transform auras): the spell references a CREATURE (NPC), the
    // creature has display ids (TDB creature_template_model), each display
    // resolves to a model file. Corpus per creature: "morph" + creature id
    // + NPC name + display ids + model paths — fx:"morph sheep", fx:"morph
    // 856" and fx:"morph 16372" all work.
    /** @type {Map<number, number[]>} spell id -> [creatureId] */
    const spellMorphs = new Map();
    /** @type {Map<number, number[]>} creatureId -> [spell id] */
    const morphSpells = new Map();
    /** @type {Map<number, string>} creatureId -> NPC name ("" = unknown) */
    const morphNames = new Map();
    /** @type {Map<number, DisplayRef[]>} creatureId -> [{displayId, fid}] */
    const morphDisplays = new Map();
    /** @type {Map<number, string>} creatureId -> search corpus */
    const morphSearchL = new Map();
    {
      const { spellIds, creatureIds } = pack.spellMorphs;
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
          { displayId: md.displayIds[i], fid: md.fids[i] });
      }
      for (const [c, name] of morphNames) {
        const parts = (morphDisplays.get(c) || []).map((e) =>
          e.displayId + " " + ((files.get(e.fid) || { searchL: "" }).searchL));
        morphSearchL.set(c,
          ("morph " + c + " " + name.toLowerCase() + " " + parts.join(" ")).trim());
      }
    }

    // shapeshift forms (MOD_SHAPESHIFT auras): a form name plus up to four
    // creature displays. Many forms (Battle Stance, Shadowform, Stealth) have
    // no display at all and are searchable/renderable by name alone.
    /** @type {Map<number, number[]>} spell id -> [formId] */
    const spellShapeshifts = new Map();
    /** @type {Map<number, number[]>} formId -> [spell id] */
    const shapeshiftSpells = new Map();
    /** @type {Map<number, string>} formId -> form name */
    const shapeshiftNames = new Map();
    /** @type {Map<number, DisplayRef[]>} formId -> [{displayId, fid}] */
    const shapeshiftDisplays = new Map();
    /** @type {Map<number, string>} formId -> search corpus */
    const shapeshiftSearchL = new Map();
    if (pack.spellShapeshifts) {
      const { spellIds, formIds } = pack.spellShapeshifts;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellShapeshifts, spellIds[i], formIds[i]);
        pushTo(shapeshiftSpells, formIds[i], spellIds[i]);
      }
      const f = pack.shapeshifts;
      for (let i = 0; i < f.ids.length; i++) shapeshiftNames.set(f.ids[i], f.names[i]);
      const sd = pack.shapeshiftDisplays;
      for (let i = 0; i < sd.formIds.length; i++) {
        pushTo(shapeshiftDisplays, sd.formIds[i],
          { displayId: sd.displayIds[i], fid: sd.fids[i] });
      }
      for (const [id, name] of shapeshiftNames) {
        const parts = (shapeshiftDisplays.get(id) || []).map((e) =>
          e.displayId + " " + ((files.get(e.fid) || { searchL: "" }).searchL));
        shapeshiftSearchL.set(id,
          ("shapeshift " + id + " " + name.toLowerCase() + " " + parts.join(" ")).trim());
      }
    }

    // summons (SUMMON spell effects): the spell summons a CREATURE (NPC);
    // control (guardian/pet/...) is per spell-effect row, from its
    // SummonProperties — so the corpus lives per (creature, control) pair:
    // "summon" + creature id + NPC name + control word. fx:"summon argi",
    // fx:"summon 88807" and fx:"summon guardian" all work.
    /** @type {Map<number, {creatureId: number, control: number}[]>} spell id -> [{creatureId, control}] */
    const spellSummons = new Map();
    /** @type {Map<number, string>} creatureId -> NPC name ("" = unknown) */
    const summonNames = new Map();
    /** @type {Map<string, number[]>} "creature:control" -> [spell id] */
    const summonPairSpells = new Map();
    /** @type {Map<string, string>} "creature:control" -> search corpus */
    const summonPairSearchL = new Map();
    /** @type {Record<number, string>} control id -> word */
    const summonControlNames = pack.summonControlNames || {};
    {
      const su = pack.summons;
      for (let i = 0; i < su.creatureIds.length; i++) {
        summonNames.set(su.creatureIds[i], su.names[i]);
      }
      // pack rows are unique (spell, creature, control) triples, so the
      // pair maps need no dedupe
      const { spellIds, creatureIds, controls } = pack.spellSummons;
      for (let i = 0; i < spellIds.length; i++) {
        const c = creatureIds[i], ctrl = controls[i];
        pushTo(spellSummons, spellIds[i], { creatureId: c, control: ctrl });
        const key = c + ":" + ctrl;
        pushTo(summonPairSpells, key, spellIds[i]);
        if (!summonPairSearchL.has(key)) {
          summonPairSearchL.set(key,
            ("summon " + c + " " + (summonNames.get(c) || "").toLowerCase()
              + " " + (summonControlNames[ctrl] || "")).trim());
        }
      }
    }

    // aura mechanics (SpellEffectAura enum id -> name without SPELL_AURA_)
    /** @type {Map<number, number[]>} spell id -> [aura enum id] */
    const spellAuras = new Map();
    /** @type {Map<number, number[]>} aura enum id -> [spell id] */
    const auraSpells = new Map();
    {
      const { spellIds, auras } = pack.spellAuras;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellAuras, spellIds[i], auras[i]);
        pushTo(auraSpells, auras[i], spellIds[i]);
      }
    }
    /** @type {Map<number, string>} */
    const auraNames = new Map(
      Object.entries(pack.auraNames).map(([k, v]) => [Number(k), v]));
    /** @type {Map<number, string>} */
    const auraNamesL = new Map(
      [...auraNames].map(([k, v]) => [k, v.toLowerCase()]));

    // fids referenced as models / as sounds (search scopes)
    /** @type {number[]} */
    const modelFids = [...modelSpells.keys()];
    /** @type {number[]} */
    const soundFids = [...soundSpells.keys()];

    console.info(`Epsilook: indexes built in ${(performance.now() - t0).toFixed(0)} ms`);
    return {
      meta: pack.meta,
      ids: sp.ids, names: sp.names, subtexts: sp.subtexts, icons,
      namesL, spellIndex, files,
      spellModels, modelSpells, modelFids,
      spellModelCats, modelCatSpells, modelCatFidSpells, modelCatNames,
      spellSounds, soundSpells, soundFids, soundKitSpells, soundKitFiles,
      spellAnimKits, animKitSpells,
      animNames, animNamesL, animKitAnims, animAnimKits,
      spellFx, fxSpells, fxChains, fxTextures, fxSearchL,
      spellDissolves, dissolveSpells, dissolveDurations, dissolveTextures, dissolveSearchL,
      spellGlows, glowSpells, glowColors, glowAlphas, glowSearchL,
      spellShadowies, shadowySpells, shadowyColors, shadowySearchL,
      spellGhostMats, ghostMatSpells, ghostMatColors, ghostMatSearchL,
      spellTints, tintSpells, tintColors, tintSearchL,
      spellDesaturates, desatSpells, desatSearchL,
      spellTransps, transpSpells, transpSearchL,
      spellFreezes, spellCamos,
      spellScreens, screenSpells, screenNames, screenColors, screenTextures, screenSearchL,
      spellAnims, animDirectSpells,
      spellMorphs, morphSpells, morphNames, morphDisplays, morphSearchL,
      spellShapeshifts, shapeshiftSpells, shapeshiftNames, shapeshiftDisplays,
      shapeshiftSearchL,
      spellSummons, summonNames, summonPairSpells, summonPairSearchL, summonControlNames,
      spellEffects, effectSpells, effectNames, effectNamesL,
      spellAuras, auraSpells, auraNames, auraNamesL,
    };
  }

  return { loadVersions, loadPack, buildIndexes };
})();
