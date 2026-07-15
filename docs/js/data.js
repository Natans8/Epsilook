/* Data loading: fetch the gzipped JSON pack for a game version and build
 * the in-memory indexes every search runs against. No query engine —
 * plain arrays and Maps. */
"use strict";

window.EpsilookData = (() => {

  async function loadVersions() {
    const resp = await fetch("data/versions.json");
    if (!resp.ok) throw new Error(`versions.json: HTTP ${resp.status}`);
    return resp.json();
  }

  /* Fetch + gunzip + parse one version's pack, reporting download progress. */
  async function loadPack(versionEntry, onProgress) {
    const resp = await fetch(versionEntry.file);
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

    // spell effects (enum id -> name without the SPELL_EFFECT_ prefix)
    const spellEffects = new Map(); // spell id -> [effect enum id]
    {
      const { spellIds, effects } = pack.spellEffects;
      for (let i = 0; i < spellIds.length; i++) {
        pushTo(spellEffects, spellIds[i], effects[i]);
      }
    }
    const effectNames = new Map(
      Object.entries(pack.effectNames).map(([k, v]) => [Number(k), v]));

    // fids referenced as models / as sounds (search scopes)
    const modelFids = [...modelSpells.keys()];
    const soundFids = [...soundSpells.keys()];

    console.info(`Epsilook: indexes built in ${(performance.now() - t0).toFixed(0)} ms`);
    return {
      meta: pack.meta,
      ids: sp.ids, names: sp.names, subtexts: sp.subtexts,
      namesL, spellIndex, files,
      spellModels, modelSpells, modelFids,
      spellSounds, soundSpells, soundFids, soundKitSpells, soundKitFiles,
      spellAnimKits, animKitSpells,
      animNames, animNamesL, animKitAnims, animAnimKits,
      spellEffects, effectNames,
    };
  }

  return { loadVersions, loadPack, buildIndexes, basename };
})();
