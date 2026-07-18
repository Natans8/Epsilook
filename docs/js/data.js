/* Data loading: fetch the gzipped JSON pack for a game version and build
 * the in-memory indexes every search runs against. No query engine —
 * plain arrays and Maps. */
"use strict";

window.EpsilookData = (() => {

  async function loadVersions() {
    // no-cache = always revalidate (tiny file, 304 when unchanged), so a
    // fresh deploy is picked up immediately instead of after cache expiry
    const resp = await fetch("data/versions.json", { cache: "no-cache" });
    if (!resp.ok) throw new Error(`versions.json: HTTP ${resp.status}`);
    return resp.json();
  }

  /* Fetch + gunzip + parse one version's pack, reporting download progress. */
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

  function basename(path) {
    const i = path.lastIndexOf("/");
    return i >= 0 ? path.slice(i + 1) : path;
  }

  /* Turn the column-oriented pack into fast lookup structures. */
  function buildIndexes(pack) {
    const t0 = performance.now();
    const sp = pack.spells;
    const n = sp.ids.length;

    const spellIndex = new Map(); // spell id -> array index
    const namesL = new Array(n);
    for (let i = 0; i < n; i++) {
      spellIndex.set(sp.ids[i], i);
      namesL[i] = sp.subtexts[i]
        ? (sp.names[i] + " " + sp.subtexts[i]).toLowerCase()
        : sp.names[i].toLowerCase();
    }

    // spell icon names ("" = none); older packs have no icon data
    const iconNames = pack.iconNames || [];
    const icons = new Array(n);
    for (let i = 0; i < n; i++) {
      const idx = sp.icons ? sp.icons[i] : 0;
      icons[i] = idx ? iconNames[idx - 1] : "";
    }

    // files: fid -> {path, base, searchL}
    const files = new Map();
    const fp = pack.files;
    for (let i = 0; i < fp.fids.length; i++) {
      const fid = fp.fids[i];
      const path = fp.paths[i];
      const base = path ? basename(path) : "";
      files.set(fid, { fid, path, base, searchL: path.toLowerCase() });
    }

    const pushTo = (map, key, value) => {
      const arr = map.get(key);
      if (arr) arr.push(value); else map.set(key, [value]);
    };

    // models
    const spellModels = new Map();   // spell id -> [fid]
    const modelSpells = new Map();   // fid -> [spell id]
    {
      const { spellIds, fids } = pack.spellModels;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellModels, spellIds[i], fids[i]);
        pushTo(modelSpells, fids[i], spellIds[i]);
      }
    }

    // sounds
    const spellSounds = new Map();     // spell id -> [{soundKitId, fid}]
    const soundSpells = new Map();     // fid -> [spell id]
    const soundKitSpells = new Map();  // soundKitId -> [spell id]
    const soundKitFiles = new Map();   // soundKitId -> Set(fid)
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
        spellSounds.set(s, arr.filter(e => {
          const key = e.soundKitId + ":" + e.fid;
          return seen.has(key) ? false : (seen.add(key), true);
        }));
      }
    }

    // animkits
    const spellAnimKits = new Map(); // spell id -> [animKitId]
    const animKitSpells = new Map(); // animKitId -> [spell id]
    {
      const { spellIds, animKitIds } = pack.spellAnimKits;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellAnimKits, spellIds[i], animKitIds[i]);
        pushTo(animKitSpells, animKitIds[i], spellIds[i]);
      }
    }

    // animations contained in animkits (names indexed by AnimID)
    const animNames = pack.animNames;
    const animNamesL = animNames.map((n) => n.toLowerCase());
    const animKitAnims = new Map(); // animKitId -> [animId]
    const animAnimKits = new Map(); // animId -> [animKitId]
    {
      const { animKitIds, animIds } = pack.animKitAnims;
      for (let i = 0; i < animKitIds.length; i++) {
        pushTo(animKitAnims, animKitIds[i], animIds[i]);
        pushTo(animAnimKits, animIds[i], animKitIds[i]);
      }
    }

    // packed RGB -> "#rrggbb" (the form fx corpora carry, so hex queries
    // like fx:#ff5800 — or just a hex prefix — match by substring)
    const hexColor = (c) => "#" + c.toString(16).padStart(6, "0");

    // visual FX: chain/beam effects. Each chain has a tint (0xFFFFFF =
    // untinted), a hue word, textures (fids into `files`), and a lowercase
    // search corpus: "beam" + hue + tint hex + texture paths.
    const spellFx = new Map();     // spell id -> [chainId]
    const fxSpells = new Map();    // chainId -> [spell id]
    const fxChains = new Map();    // chainId -> {color, hue}
    const fxTextures = new Map();  // chainId -> [fid]
    const fxSearchL = new Map();   // chainId -> search corpus
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
        fxSearchL.set(c, ("beam " + info.hue + " " + hex + " " + tex).trim());
      }
    }

    // dissolves (DissolveEffect rows): duration + TextureBlendSet textures;
    // corpus: "dissolve" + texture paths — fx:"dissolve arcane_wisps" style.
    const spellDissolves = new Map();    // spell id -> [dissolveId]
    const dissolveSpells = new Map();    // dissolveId -> [spell id]
    const dissolveDurations = new Map(); // dissolveId -> seconds (0 = unspecified)
    const dissolveTextures = new Map();  // dissolveId -> [fid]
    const dissolveSearchL = new Map();   // dissolveId -> search corpus
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

    // edge glows (EdgeGlowEffect rows): color-only, no texture or model.
    // Corpus: "edge glow" + hue + hex — fx:"edge glow red" / fx:#ff5800.
    const spellGlows = new Map();   // spell id -> [glowId]
    const glowSpells = new Map();   // glowId -> [spell id]
    const glowColors = new Map();   // glowId -> packed RGB
    const glowSearchL = new Map();  // glowId -> search corpus
    {
      const { spellIds, glowIds } = pack.spellGlows;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellGlows, spellIds[i], glowIds[i]);
        pushTo(glowSpells, glowIds[i], spellIds[i]);
      }
      const g = pack.glows;
      for (let i = 0; i < g.ids.length; i++) {
        glowColors.set(g.ids[i], g.colors[i]);
        glowSearchL.set(g.ids[i],
          ("edge glow " + g.hues[i] + " " + hexColor(g.colors[i])).trim());
      }
    }

    // shadowy effects (ShadowyEffect rows): two colors per row, no texture.
    // Corpus: "shadowy" + hue words + both hexes.
    const spellShadowies = new Map();  // spell id -> [shadowyId]
    const shadowySpells = new Map();   // shadowyId -> [spell id]
    const shadowyColors = new Map();   // shadowyId -> {primary, secondary}
    const shadowySearchL = new Map();  // shadowyId -> search corpus
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
        shadowySearchL.set(sh.ids[i],
          ("shadowy " + sh.hues[i] + " " + hexColor(primary) + " " + hexColor(secondary)).trim());
      }
    }

    // spell effects (enum id -> name without the SPELL_EFFECT_ prefix)
    const spellEffects = new Map();  // spell id -> [effect enum id]
    const effectSpells = new Map();  // effect enum id -> [spell id]
    {
      const { spellIds, effects } = pack.spellEffects;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellEffects, spellIds[i], effects[i]);
        pushTo(effectSpells, effects[i], spellIds[i]);
      }
    }
    const effectNames = new Map(
      Object.entries(pack.effectNames).map(([k, v]) => [Number(k), v]));
    const effectNamesL = new Map(
      [...effectNames].map(([k, v]) => [k, v.toLowerCase()]));

    // morphs (transform auras): the spell references a CREATURE (NPC), the
    // creature has display ids (TDB creature_template_model), each display
    // resolves to a model file. Corpus per creature: "morph" + creature id
    // + NPC name + display ids + model paths — fx:"morph sheep", fx:"morph
    // 856" and fx:"morph 16372" all work.
    const spellMorphs = new Map();    // spell id -> [creatureId]
    const morphSpells = new Map();    // creatureId -> [spell id]
    const morphNames = new Map();     // creatureId -> NPC name ("" = unknown)
    const morphDisplays = new Map();  // creatureId -> [{displayId, fid}]
    const morphSearchL = new Map();   // creatureId -> search corpus
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

    // aura mechanics (SpellEffectAura enum id -> name without SPELL_AURA_)
    const spellAuras = new Map();  // spell id -> [aura enum id]
    const auraSpells = new Map();  // aura enum id -> [spell id]
    {
      const { spellIds, auras } = pack.spellAuras;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellAuras, spellIds[i], auras[i]);
        pushTo(auraSpells, auras[i], spellIds[i]);
      }
    }
    const auraNames = new Map(
      Object.entries(pack.auraNames).map(([k, v]) => [Number(k), v]));
    const auraNamesL = new Map(
      [...auraNames].map(([k, v]) => [k, v.toLowerCase()]));

    // fids referenced as models / as sounds (search scopes)
    const modelFids = [...modelSpells.keys()];
    const soundFids = [...soundSpells.keys()];

    console.info(`Epsilook: indexes built in ${(performance.now() - t0).toFixed(0)} ms`);
    return {
      meta: pack.meta,
      ids: sp.ids, names: sp.names, subtexts: sp.subtexts, icons,
      namesL, spellIndex, files,
      spellModels, modelSpells, modelFids,
      spellSounds, soundSpells, soundFids, soundKitSpells, soundKitFiles,
      spellAnimKits, animKitSpells,
      animNames, animNamesL, animKitAnims, animAnimKits,
      spellFx, fxSpells, fxChains, fxTextures, fxSearchL,
      spellDissolves, dissolveSpells, dissolveDurations, dissolveTextures, dissolveSearchL,
      spellGlows, glowSpells, glowColors, glowSearchL,
      spellShadowies, shadowySpells, shadowyColors, shadowySearchL,
      spellMorphs, morphSpells, morphNames, morphDisplays, morphSearchL,
      spellEffects, effectSpells, effectNames, effectNamesL,
      spellAuras, auraSpells, auraNames, auraNamesL,
    };
  }

  return { loadVersions, loadPack, buildIndexes, basename };
})();
