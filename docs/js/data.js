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

    /**
     * Index one section's per-row target masks as spell -> item -> mask.
     *
     * Every kit-derived section carries a parallel "targets" array since pack
     * format 22 (who the content plays on — see TARGET_BITS in build_data.py).
     * Sections whose rows are plain ids all index the same way, so adding the
     * icons to another column is one more call here. A pack without the array
     * yields an empty map, which reads app-side as "no icons".
     * @param {any} section pack section with {spellIds, targets} + an id array
     * @param {string} idKey name of that section's id array
     * @returns {Map<number, Map<number, number>>}
     */
    const maskIndex = (section, idKey) => {
      /** @type {Map<number, Map<number, number>>} */
      const out = new Map();
      if (!section || !section.targets) return out;
      const { spellIds, targets } = section;
      const ids = section[idKey];
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
    /** @type {Map<number, number[]>} spell id -> [fid] (deduped) */
    const spellModels = new Map();
    /** @type {Map<number, number[]>} fid -> [spell id] */
    const modelSpells = new Map();
    /** @type {Map<number, {fid: number, cat: number, targets: number, src: number, dst: number, ref: number}[]>} */
    const spellModelCats = new Map();
    /** @type {Map<number, Set<number>>} cat id -> Set(spell id) */
    const modelCatSpells = new Map();
    /** @type {Map<number, Map<number, number[]>>} cat id -> Map(fid -> [spell id]) */
    const modelCatFidSpells = new Map();
    /** @type {Record<number, string>} */
    const modelCatNames = pack.modelCatNames || {};
    /** @type {Record<number, string>} raw M2 attachment id -> name */
    const attachmentNames = pack.attachmentNames || {};
    {
      const sm = pack.spellModels;
      const { spellIds, fids, cats, targets, srcAttach, dstAttach } = sm;
      // ref id per row: the entity the model came from, in the id space its
      // category names (a CreatureDisplayID on display rows, an Item::ID on
      // item rows). Renamed refIds in format 28; format 27 packs still ship it
      // as displayIds (display rows only), so fall back to that.
      const refIds = sm.refIds || sm.displayIds;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(modelSpells, fids[i], spellIds[i]);
        if (!cats) { pushTo(spellModels, spellIds[i], fids[i]); continue; }
        pushTo(spellModelCats, spellIds[i], {
          fid: fids[i], cat: cats[i], targets: targets ? targets[i] : 0,
          // attachment points arrived in pack format 24; older packs have
          // none, which renders as no attachment segment
          src: srcAttach ? srcAttach[i] : -1,
          dst: dstAttach ? dstAttach[i] : -1,
          // ref id: CreatureDisplayID (display cat) or Item::ID (item cat); 0 else
          ref: refIds ? refIds[i] : 0,
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
    /** @type {Map<number, {name: string, quality: string, icon: string}>} */
    const items = new Map();
    /** @type {Map<number, string>} item id -> search corpus */
    const itemSearchL = new Map();
    if (pack.items) {
      const it = pack.items;
      const iconNames = pack.itemIconNames || [];
      const qualityNames = pack.itemQualityNames || {};
      for (let i = 0; i < it.ids.length; i++) {
        const id = it.ids[i];
        const name = it.names[i] || "";
        const quality = qualityNames[it.qualities[i]] || "";
        const icon = it.icons[i] ? (iconNames[it.icons[i] - 1] || "") : "";
        items.set(id, { name, quality, icon });
        itemSearchL.set(id,
          ("item " + id + " " + name.toLowerCase()).trim());
      }
    }
    // item id -> the spells that reach it (through a MODEL_CAT_ITEM row), so a
    // model:"item <name>" query can match on the item corpus. The pill's fid
    // and category word are already searchable through the ordinary model
    // index; this is the extra dimension items add — their NAME and quality.
    /** @type {Map<number, Set<number>>} item id -> Set(spell id) */
    const itemSpells = new Map();
    if (items.size) {
      const itemCat = Number(Object.keys(modelCatNames)
        .find((c) => modelCatNames[c] === "item"));
      if (Number.isFinite(itemCat)) {
        for (const [s, entries] of spellModelCats)
          for (const e of entries)
            if (e.cat === itemCat && e.ref) {
              let set = itemSpells.get(e.ref);
              if (!set) itemSpells.set(e.ref, set = new Set());
              set.add(s);
            }
      }
    }

    // sounds
    /** @type {Map<number, {soundKitId: number, fid: number, targets: number}[]>} spell id -> [{soundKitId, fid, targets}] */
    const spellSounds = new Map();
    /** @type {Map<number, number[]>} fid -> [spell id] */
    const soundSpells = new Map();
    /** @type {Map<number, number[]>} soundKitId -> [spell id] */
    const soundKitSpells = new Map();
    /** @type {Map<number, Set<number>>} soundKitId -> Set(fid) */
    const soundKitFiles = new Map();
    {
      const { spellIds, soundKitIds, fids, targets } = pack.spellSounds;
      for (let i = 0; i < spellIds.length; i++) {
        const s = spellIds[i], k = soundKitIds[i], f = fids[i];
        pushTo(spellSounds, s, { soundKitId: k, fid: f, targets: targets ? targets[i] : 0 });
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
        const seen = new Map();
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
    const vehicleTargets = maskIndex(pack.spellVehicles, "vehicleIds");
    const shapeshiftTargets = maskIndex(pack.spellShapeshifts, "formIds");
    const screenTargets = maskIndex(pack.spellScreens, "screenIds");
    /** @type {Record<number, string>} mask bit -> search word */
    const targetNames = pack.targetNames || {};

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
    // AnimKits reached through a vehicle seat are AnimKit::IDs like any
    // other, so they join the same groups and resolve through animKitAnims;
    // the build counts them as "used" so their anims ship too.
    if (pack.spellVehicleAnimKits) {
      const { spellIds, animKitIds } = pack.spellVehicleAnimKits;
      for (let i = 0; i < spellIds.length; i++) {
        const have = spellAnimKits.get(spellIds[i]);
        if (have && have.includes(animKitIds[i])) continue;
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
    /** @type {Map<number, {chain: number, src: number, dst: number}[]>} spell -> chain rows */
    const spellChainRows = new Map();
    {
      const { spellIds, chainIds, srcAttach, dstAttach } = pack.spellFx;
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

    // animations a spell's visual kits play directly (SpellVisualAnim
    // initial/loop anims, kit EffectType 6) — the largest animation source;
    // rendered as loose pills in the Animations column
    /** @type {Map<number, number[]>} spell id -> [animId] */
    const spellVisualAnims = new Map();
    /** @type {Map<number, number[]>} animId -> [spell id] */
    const visualAnimSpells = new Map();
    if (pack.spellVisualAnims) {
      const { spellIds, animIds } = pack.spellVisualAnims;
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
      const { spellIds, animIds } = pack.spellVehicleAnims;
      for (let i = 0; i < spellIds.length; i++) {
        const have = spellVisualAnims.get(spellIds[i]);
        if (have && have.includes(animIds[i])) continue;
        pushTo(spellVisualAnims, spellIds[i], animIds[i]);
        pushTo(visualAnimSpells, animIds[i], spellIds[i]);
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

    // vehicles (SET_VEHICLE_ID auras): the aura references a Vehicle.db2 id.
    // Each vehicle carries a seat count and one attachment name per seat, in
    // SeatID_0..7 order — where on the vehicle's model that seat sits. 0-seat
    // vehicles carry no pill (dropped at build). Corpus per vehicle is
    // "vehicle" + its attachment names, so fx:vehicle finds any and
    // fx:"vehicle base" finds one seated at Base; the seat COUNT is matched
    // numerically instead (fx:"vehicle >2"), so it stays out of the corpus.
    /** @type {Map<number, string[]>} vehicle id -> [attachment name per seat] */
    const vehicleSeats = new Map();
    if (pack.vehicleSeats) {
      const { vehicleIds, attachments } = pack.vehicleSeats;
      for (let i = 0; i < vehicleIds.length; i++) {
        pushTo(vehicleSeats, vehicleIds[i], attachments[i]);
      }
    }
    /** @type {Map<number, number[]>} spell id -> [vehicle id] */
    const spellVehicles = new Map();
    /** @type {Map<number, number[]>} vehicle id -> [spell id] */
    const vehicleSpells = new Map();
    /** @type {Map<number, string>} vehicle id -> lowercased search corpus */
    const vehicleSearchL = new Map();
    if (pack.spellVehicles) {
      const { spellIds, vehicleIds } = pack.spellVehicles;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellVehicles, spellIds[i], vehicleIds[i]);
        pushTo(vehicleSpells, vehicleIds[i], spellIds[i]);
      }
      for (const v of vehicleSpells.keys()) {
        const seats = vehicleSeats.get(v) || [];
        vehicleSearchL.set(v, `seat ${seats.join(" ")}`.toLowerCase());
      }
    }

    // invisibility / detection channels (pack format 26). Grouped by
    // invisibility TYPE, which is the pairing key: an invis spell links to the
    // detect spells sharing its type and vice versa. Per spell we keep the
    // (type, target mask) pills to render; per type we keep both membership
    // lists — their lengths are the counterpart counts shown on the pills, and
    // they back fx:invis / fx:detect searches. Only channels with an invis side
    // exist in the pack, so a detect pill's counterpart count is always ≥1.
    /** @type {Map<number, {type: number, mask: number}[]>} spell -> invis pills */
    const spellInvisTypes = new Map();
    /** @type {Map<number, {type: number, mask: number}[]>} spell -> detect pills */
    const spellDetectTypes = new Map();
    /** @type {Map<number, number[]>} invisibility type -> [invis spell id] */
    const invisTypeSpells = new Map();
    /** @type {Map<number, number[]>} invisibility type -> [detect spell id] */
    const detectTypeSpells = new Map();
    const loadChannels = (section, spellPills, typeSpells) => {
      if (!section) return;
      const {spellIds, types, targets} = section;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellPills, spellIds[i], {type: types[i], mask: targets[i]});
        pushTo(typeSpells, types[i], spellIds[i]);
      }
    };
    loadChannels(pack.spellInvis, spellInvisTypes, invisTypeSpells);
    loadChannels(pack.spellDetects, spellDetectTypes, detectTypeSpells);

    // the rider's own animations while entering/seated/exiting — their own
    // "passenger" group in the Animations column
    /** @type {Map<number, number[]>} spell id -> [animId] */
    const spellPassengerAnims = new Map();
    /** @type {Map<number, number[]>} animId -> [spell id] */
    const passengerAnimSpells = new Map();
    if (pack.spellPassengerAnims) {
      const { spellIds, animIds } = pack.spellPassengerAnims;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellPassengerAnims, spellIds[i], animIds[i]);
        pushTo(passengerAnimSpells, animIds[i], spellIds[i]);
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
      namesL, spellIndex, files, hasSyntheticFiles,
      spellModels, modelSpells, modelFids, attachmentNames,
      spellModelCats, modelCatSpells, modelCatFidSpells, modelCatNames,
      items, itemSearchL, itemSpells,
      spellSounds, soundSpells, soundFids, soundKitSpells, soundKitFiles,
      spellAnimKits, animKitSpells,
      animNames, animNamesL, animKitAnims, animAnimKits,
      spellFx, spellChainRows, fxSpells, fxChains, fxTextures, fxSearchL,
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
      spellVisualAnims, visualAnimSpells,
      targetNames, animKitTargets, visualAnimTargets, fxTargets,
      dissolveTargets, glowTargets, shadowyTargets, ghostMatTargets,
      morphTargets, summonTargets, vehicleTargets, shapeshiftTargets, screenTargets,
      spellMorphs, morphSpells, morphNames, morphDisplays, morphSearchL,
      spellShapeshifts, shapeshiftSpells, shapeshiftNames, shapeshiftDisplays,
      shapeshiftSearchL,
      spellSummons, summonNames, summonPairSpells, summonPairSearchL, summonControlNames,
      spellVehicles, vehicleSpells, vehicleSeats, vehicleSearchL,
      spellInvisTypes, spellDetectTypes, invisTypeSpells, detectTypeSpells,
      spellPassengerAnims, passengerAnimSpells,
      spellEffects, effectSpells, effectNames, effectNamesL,
      spellAuras, auraSpells, auraNames, auraNamesL,
    };
  }

  return { loadVersions, loadPack, buildIndexes };
})();
