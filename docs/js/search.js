/* Search engine: the field registry and group evaluation.
 *
 * A search is a list of groups {field, tokens: [{text}, ...]} — one group
 * per search-bar chip (plus one for the free text). Within a group, every
 * word must match the SAME entity (the same file name / spell name /
 * effect name). Groups AND together across the result sets, so two
 * model: chips mean "the spell uses a model matching chip 1 AND a model
 * matching chip 2" — not both words in one file. A group with not: true
 * excludes its matches instead. Free text (field "all") matches spell
 * names, model files, sound files, animation names and visual FX.
 *
 * Each field entry implements run(tokens, data, disabled) -> Set of
 * spell IDs. Adding a new searchable relation = adding one entry to
 * FIELDS (and, if it needs new data, extending build_data.py + data.js).
 */
"use strict";

window.EpsilookSearch = (() => {

  /* ------------------------------------------------------------ helpers */

  function textMatches(haystackL, tokens) {
    for (const t of tokens) {
      if (!haystackL.includes(t.text)) return false;
    }
    return true;
  }

  // Search file names within a scope of fids; return spells using the matches.
  function spellsByFile(tokens, data, fids, fileSpells) {
    const out = new Set();
    for (const fid of fids) {
      const file = data.files.get(fid);
      if (file && textMatches(file.searchL, tokens)) {
        for (const s of fileSpells.get(fid)) out.add(s);
      }
    }
    return out;
  }

  // Search model file names — with usage categories in the corpus: each
  // (category, file) pair matches like the fx corpora, so a token may hit
  // the category word instead of the path. model:missile alone = every
  // spell with a projectile model; model:"attached backpack01" = spells
  // with that file attached (one chip, fx:"chain shadowlaser"-style).
  // A stale cached pack has no categories: plain file-name search.
  function spellsByModel(tokens, data) {
    if (!data.modelCatFidSpells.size) {
      return spellsByFile(tokens, data, data.modelFids, data.modelSpells);
    }
    const out = new Set();
    for (const [cat, fidSpells] of data.modelCatFidSpells) {
      const catL = data.modelCatNames[cat] || "";
      for (const [fid, spells] of fidSpells) {
        const file = data.files.get(fid);
        const searchL = file ? file.searchL : "";
        if (tokens.every((t) => catL.includes(t.text) || searchL.includes(t.text))) {
          for (const s of spells) out.add(s);
        }
      }
    }
    return out;
  }

  function spellsByName(tokens, data) {
    const out = new Set();
    const { ids, namesL } = data;
    for (let i = 0; i < namesL.length; i++) {
      if (textMatches(namesL[i], tokens)) out.add(ids[i]);
    }
    return out;
  }

  // Search animation names; return spells whose AnimKits use the matches,
  // plus spells with a matching direct stand/walk anim (proc Type 7).
  function spellsByAnim(tokens, data) {
    const out = new Set();
    for (let a = 0; a < data.animNamesL.length; a++) {
      if (!textMatches(data.animNamesL[a], tokens)) continue;
      for (const kit of data.animAnimKits.get(a) || []) {
        for (const s of data.animKitSpells.get(kit) || []) out.add(s);
      }
      for (const s of data.animDirectSpells.get(a) || []) out.add(s);
    }
    return out;
  }

  // Search visual FX corpora: chains (category word + hue + tint hex +
  // textures), dissolves (category word + textures), color-only effects —
  // glows, ghosts (ShadowyEffect + material recolors) and model tints
  // (category word + hue + color hexes) — desaturates / transparencies
  // (category word + percent), freezes / camos (bare category word), morphs
  // (category word + creature id/name + display ids + model paths) and
  // summons (category word + creature id/name + control word).
  function spellsByFx(tokens, data) {
    const out = new Set();
    const scan = (searchLMap, spellsMap) => {
      for (const [id, searchL] of searchLMap) {
        if (!textMatches(searchL, tokens)) continue;
        for (const s of spellsMap.get(id) || []) out.add(s);
      }
    };
    scan(data.fxSearchL, data.fxSpells);
    scan(data.dissolveSearchL, data.dissolveSpells);
    scan(data.glowSearchL, data.glowSpells);
    scan(data.shadowySearchL, data.shadowySpells);
    scan(data.ghostMatSearchL, data.ghostMatSpells);
    scan(data.tintSearchL, data.tintSpells);
    scan(data.desatSearchL, data.desatSpells);
    scan(data.transpSearchL, data.transpSpells);
    if (textMatches("freeze", tokens)) for (const s of data.spellFreezes) out.add(s);
    if (textMatches("camo", tokens)) for (const s of data.spellCamos) out.add(s);
    scan(data.screenSearchL, data.screenSpells);
    scan(data.shapeshiftSearchL, data.shapeshiftSpells);
    scan(data.morphSearchL, data.morphSpells);
    scan(data.summonPairSearchL, data.summonPairSpells);
    return out;
  }

  // Exact numeric lookup against a Map of id -> [spell ids]. Multiple ids
  // union (OR) — used by id: chips and by kit-ID chips in sound:/anim:.
  function spellsByKitId(tokens, map) {
    const out = new Set();
    for (const t of tokens) {
      for (const s of map.get(Number(t.text)) || []) out.add(s);
    }
    return out;
  }

  function intersect(a, b) {
    if (a.size > b.size) [a, b] = [b, a];
    const out = new Set();
    for (const v of a) if (b.has(v)) out.add(v);
    return out;
  }

  /* ------------------------------------------------------ field registry */

  const FIELDS = {
    all: {
      label: "All", tab: false,
      run(tokens, data, disabled) {
        const out = spellsByName(tokens, data);
        if (!disabled.has("model")) {
          for (const s of spellsByModel(tokens, data)) out.add(s);
        }
        if (!disabled.has("sound")) {
          for (const s of spellsByFile(tokens, data, data.soundFids, data.soundSpells)) out.add(s);
        }
        if (!disabled.has("anim")) {
          for (const s of spellsByAnim(tokens, data)) out.add(s);
        }
        if (!disabled.has("fx")) {
          for (const s of spellsByFx(tokens, data)) out.add(s);
        }
        // a pure number also hits the exact spell ID
        if (tokens.length === 1 && /^\d+$/.test(tokens[0].text)
            && data.spellIndex.has(Number(tokens[0].text))) {
          out.add(Number(tokens[0].text));
        }
        return out;
      },
    },
    name: {
      label: "Name", tab: true,
      hint: "spell name, e.g. fire bolt", short: "spell name",
      run: (tokens, data) => spellsByName(tokens, data),
    },
    model: {
      label: "Model", tab: true,
      hint: "model file, e.g. 6dr statue", short: "model file",
      run: (tokens, data) => spellsByModel(tokens, data),
    },
    sound: {
      label: "Sound", tab: true,
      hint: "sound file or SoundKit ID, e.g. felreaver or 86835", short: "sound file / kit ID",
      // matches file names; an all-numbers chip is also an exact SoundKit ID
      // lookup (the old soundkit: field, folded in 2026-07-19) — several ids
      // in one chip union, like the old orGroups behavior
      run: (tokens, data) => {
        const out = spellsByFile(tokens, data, data.soundFids, data.soundSpells);
        if (tokens.every((t) => /^\d+$/.test(t.text))) {
          for (const s of spellsByKitId(tokens, data.soundKitSpells)) out.add(s);
        }
        return out;
      },
    },
    anim: {
      label: "Animation", tab: true,
      hint: "animation name or AnimKit ID, e.g. kneel or 13839", short: "animation / kit ID",
      // matches animation names; an all-numbers chip is also an exact
      // AnimKit ID lookup (the old animkit: field, folded in 2026-07-19)
      run: (tokens, data) => {
        const out = spellsByAnim(tokens, data);
        if (tokens.every((t) => /^\d+$/.test(t.text))) {
          for (const s of spellsByKitId(tokens, data.animKitSpells)) out.add(s);
        }
        return out;
      },
    },
    fx: {
      label: "Effect", tab: true,
      hint: "visual effect, e.g. chain red", short: "visual effect",
      run: (tokens, data) => spellsByFx(tokens, data),
    },
    mech: {
      label: "Mechanic", tab: true,
      hint: "spell mechanic, e.g. resurrect", short: "mechanic",
      run(tokens, data) {
        const out = new Set();
        for (const [effectId, nameL] of data.effectNamesL) {
          if (!textMatches(nameL, tokens)) continue;
          for (const s of data.effectSpells.get(effectId) || []) out.add(s);
        }
        for (const [auraId, nameL] of data.auraNamesL) {
          if (!textMatches(nameL, tokens)) continue;
          for (const s of data.auraSpells.get(auraId) || []) out.add(s);
        }
        return out;
      },
    },
    id: {
      label: "Spell ID", tab: true, orGroups: true,
      hint: "exact spell ID, e.g. 133", short: "spell ID",
      run(tokens, data) {
        const out = new Set();
        for (const t of tokens) {
          const id = Number(t.text);
          if (data.spellIndex.has(id)) out.add(id);
        }
        return out;
      },
    },
  };

  /* -------------------------------------------------------------- search */

  // groups: [{field, tokens: [{text}, ...], not}] with text lowercased
  // single words. One result set per group; positive groups intersect,
  // negative groups (not: true) subtract from the result. Exception:
  // groups of the same exact-ID field (orGroups — today only id:)
  // union together first, then that union intersects like one group — a
  // spell has only one ID, so ANDing two of them could never match.
  // (Kit IDs typed into sound:/anim: chips AND across chips like any
  // text field — a spell can carry two kits; ids inside ONE chip union.)
  // A query of only negative groups starts from all spells.
  // `disabledFields` (hidden columns) are skipped inside the "all" field;
  // explicit fields always run.
  function searchGroups(groups, data, disabledFields = new Set()) {
    const t0 = performance.now();

    let result = null;
    const negatives = [];
    const orUnions = new Map(); // field -> union of that field's group results
    for (const g of groups) {
      if (!g.tokens.length) continue;
      if (g.not) { negatives.push(g); continue; }
      const field = FIELDS[g.field] ? g.field : "all";
      const set = FIELDS[field].run(g.tokens, data, disabledFields);
      if (FIELDS[field].orGroups) {
        const u = orUnions.get(field);
        if (u) { for (const v of set) u.add(v); } else orUnions.set(field, set);
        continue;
      }
      result = result === null ? set : intersect(result, set);
      if (result.size === 0) break;
    }
    for (const set of orUnions.values()) {
      result = result === null ? set : intersect(result, set);
    }
    if (result === null) result = negatives.length ? new Set(data.ids) : new Set();

    for (const g of negatives) {
      if (result.size === 0) break;
      const field = FIELDS[g.field] ? g.field : "all";
      for (const id of FIELDS[field].run(g.tokens, data, disabledFields)) result.delete(id);
    }

    return { spellIds: [...result], ms: performance.now() - t0 };
  }

  /* Relevance sort for name searches: exact > starts-with > substring, then by ID. */
  function sortByRelevance(spellIds, rawQuery, data) {
    const q = rawQuery.toLowerCase().trim();
    const rank = (id) => {
      const nameL = data.names[data.spellIndex.get(id)].toLowerCase();
      if (nameL === q) return 0;
      if (nameL.startsWith(q)) return 1;
      if (nameL.includes(q)) return 2;
      return 3;
    };
    return spellIds.sort((a, b) => (rank(a) - rank(b)) || (a - b));
  }

  return { searchGroups, sortByRelevance, FIELDS };
})();
