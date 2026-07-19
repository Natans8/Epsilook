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

    // models — each (spell, fid) row carries a usage category
    // (attach/missile/area/trail/barrage) since pack format 15; a stale
    // cached pack has no cats and renders the old flat list
    const spellModels = new Map();     // spell id -> [fid] (deduped)
    const modelSpells = new Map();     // fid -> [spell id]
    const spellModelCats = new Map();  // spell id -> [{fid, cat}]
    const modelCatSpells = new Map();  // cat id -> Set(spell id)
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

    // visual FX: chain/beam effects (category word "chain" since
    // 2026-07-19). Each chain has a tint (0xFFFFFF = untinted), a hue word,
    // textures (fids into `files`), and a lowercase search corpus:
    // "chain" + hue + tint hex + texture paths.
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
        fxSearchL.set(c, ("chain " + info.hue + " " + hex + " " + tex).trim());
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

    // glows (EdgeGlowEffect rows): color-only, no texture or model.
    // Corpus: "glow" + hue + hex — fx:"glow red" / fx:#ff5800.
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
          ("glow " + g.hues[i] + " " + hexColor(g.colors[i])).trim());
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
        // category is "ghost" now, but keep "shadowy" searchable for the
        // ShadowyEffect rows so old fx:shadowy queries still resolve
        shadowySearchL.set(sh.ids[i],
          ("ghost shadowy " + sh.hues[i] + " " + hexColor(primary) + " " + hexColor(secondary)).trim());
      }
    }

    // ghost materials (SpellProceduralEffect Type 22): single-color material
    // recolors that share the "ghost" category with the ShadowyEffect rows.
    // Corpus: "ghost" + hue + hex.
    const spellGhostMats = new Map();   // spell id -> [ghostMatId]
    const ghostMatSpells = new Map();   // ghostMatId -> [spell id]
    const ghostMatColors = new Map();   // ghostMatId -> packed RGB
    const ghostMatSearchL = new Map();  // ghostMatId -> search corpus
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
    const spellDesaturates = new Map();  // spell id -> [percent]
    const desatSpells = new Map();       // percent -> [spell id]
    const desatSearchL = new Map();      // percent -> corpus
    if (pack.spellDesaturates) {
      const { spellIds, percents } = pack.spellDesaturates;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellDesaturates, spellIds[i], percents[i]);
        pushTo(desatSpells, percents[i], spellIds[i]);
        if (!desatSearchL.has(percents[i]))
          desatSearchL.set(percents[i], "desaturate " + percents[i] + "%");
      }
    }
    const spellTransps = new Map();   // spell id -> [percent]
    const transpSpells = new Map();   // percent -> [spell id]
    const transpSearchL = new Map();  // percent -> corpus
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
    const spellScreens = new Map();    // spell id -> [screenId]
    const screenSpells = new Map();    // screenId -> [spell id]
    const screenNames = new Map();     // screenId -> internal name
    const screenColors = new Map();    // screenId -> {fog, mul, add}
    const screenTextures = new Map();  // screenId -> [fid]
    const screenSearchL = new Map();   // screenId -> search corpus
    if (pack.spellScreens) {
      const { spellIds, screenIds } = pack.spellScreens;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellScreens, spellIds[i], screenIds[i]);
        pushTo(screenSpells, screenIds[i], spellIds[i]);
      }
      const st = pack.screenTextures;
      for (let i = 0; i < st.screenIds.length; i++) {
        pushTo(screenTextures, st.screenIds[i], st.fids[i]);
      }
      const sc = pack.screens;
      for (let i = 0; i < sc.ids.length; i++) {
        const id = sc.ids[i];
        screenNames.set(id, sc.names[i]);
        screenColors.set(id, { fog: sc.fogColors[i], mul: sc.mulColors[i], add: sc.addColors[i] });
        const hexes = [sc.fogColors[i], sc.mulColors[i], sc.addColors[i]]
          .filter((c) => c >= 0).map(hexColor).join(" ");
        const tex = (screenTextures.get(id) || [])
          .map((fid) => (files.get(fid) || { searchL: "" }).searchL).join(" ");
        screenSearchL.set(id, ("screen " + sc.names[i].toLowerCase() + " "
          + sc.hues[i] + " " + hexes + " " + tex).trim());
      }
    }

    // direct stand/walk anim ids (Type 7) — a second source for the
    // Animations column; matched via the anim field like animkit anims
    const spellAnims = new Map();       // spell id -> [animId]
    const animDirectSpells = new Map(); // animId -> [spell id]
    if (pack.spellAnims) {
      const { spellIds, animIds } = pack.spellAnims;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellAnims, spellIds[i], animIds[i]);
        pushTo(animDirectSpells, animIds[i], spellIds[i]);
      }
    }

    // model tints (SpellProceduralEffect Type 1 rows): color-only like
    // glows. Corpus: "tint" + hue + hex — fx:"tint red" / fx:#ff5800.
    const spellTints = new Map();   // spell id -> [tintId]
    const tintSpells = new Map();   // tintId -> [spell id]
    const tintColors = new Map();   // tintId -> packed RGB
    const tintSearchL = new Map();  // tintId -> search corpus
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

    // summons (SUMMON spell effects): the spell summons a CREATURE (NPC);
    // control (guardian/pet/...) is per spell-effect row, from its
    // SummonProperties — so the corpus lives per (creature, control) pair:
    // "summon" + creature id + NPC name + control word. fx:"summon argi",
    // fx:"summon 88807" and fx:"summon guardian" all work.
    const spellSummons = new Map();       // spell id -> [{creatureId, control}]
    const summonNames = new Map();        // creatureId -> NPC name ("" = unknown)
    const summonPairSpells = new Map();   // "creature:control" -> [spell id]
    const summonPairSearchL = new Map();  // "creature:control" -> search corpus
    const summonControlNames = pack.summonControlNames || {}; // control id -> word
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
      spellModelCats, modelCatSpells, modelCatNames,
      spellSounds, soundSpells, soundFids, soundKitSpells, soundKitFiles,
      spellAnimKits, animKitSpells,
      animNames, animNamesL, animKitAnims, animAnimKits,
      spellFx, fxSpells, fxChains, fxTextures, fxSearchL,
      spellDissolves, dissolveSpells, dissolveDurations, dissolveTextures, dissolveSearchL,
      spellGlows, glowSpells, glowColors, glowSearchL,
      spellShadowies, shadowySpells, shadowyColors, shadowySearchL,
      spellGhostMats, ghostMatSpells, ghostMatColors, ghostMatSearchL,
      spellTints, tintSpells, tintColors, tintSearchL,
      spellDesaturates, desatSpells, desatSearchL,
      spellTransps, transpSpells, transpSearchL,
      spellFreezes, spellCamos,
      spellScreens, screenSpells, screenNames, screenColors, screenTextures, screenSearchL,
      spellAnims, animDirectSpells,
      spellMorphs, morphSpells, morphNames, morphDisplays, morphSearchL,
      spellSummons, summonNames, summonPairSpells, summonPairSearchL, summonControlNames,
      spellEffects, effectSpells, effectNames, effectNamesL,
      spellAuras, auraSpells, auraNames, auraNamesL,
    };
  }

  return { loadVersions, loadPack, buildIndexes, basename };
})();
