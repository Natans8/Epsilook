/* Search engine: the field registry and group evaluation.
 *
 * A search is a list of groups {field, tokens: [{text}, ...]} — one group
 * per search-bar chip (plus one for the free text). Within a group, every
 * word must match the SAME entity (the same file name / spell name /
 * effect name). Groups AND together across the result sets, so two
 * model: chips mean "the spell uses a model matching chip 1 AND a model
 * matching chip 2" — not both words in one file. A group with not: true
 * excludes its matches instead. Free text (field "all") matches spell
 * names, model files and sound files.
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

  function spellsByName(tokens, data) {
    const out = new Set();
    const { ids, namesL } = data;
    for (let i = 0; i < namesL.length; i++) {
      if (textMatches(namesL[i], tokens)) out.add(ids[i]);
    }
    return out;
  }

  // Exact numeric lookup against a Map of id -> [spell ids].
  function spellsByKitId(tokens, map) {
    let result = null;
    for (const t of tokens) {
      const spells = new Set(map.get(Number(t.text)) || []);
      result = result === null ? spells : intersect(result, spells);
    }
    return result ?? new Set();
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
          for (const s of spellsByFile(tokens, data, data.modelFids, data.modelSpells)) out.add(s);
        }
        if (!disabled.has("sound")) {
          for (const s of spellsByFile(tokens, data, data.soundFids, data.soundSpells)) out.add(s);
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
      hint: "spell name, e.g. fire bolt",
      run: (tokens, data) => spellsByName(tokens, data),
    },
    model: {
      label: "Model", tab: true,
      hint: "model file, e.g. 6dr statue",
      run: (tokens, data) => spellsByFile(tokens, data, data.modelFids, data.modelSpells),
    },
    sound: {
      label: "Sound", tab: true,
      hint: "sound file, e.g. felreaver",
      run: (tokens, data) => spellsByFile(tokens, data, data.soundFids, data.soundSpells),
    },
    soundkit: {
      label: "SoundKit", tab: true,
      hint: "SoundKit ID, e.g. 86835",
      run: (tokens, data) => spellsByKitId(tokens, data.soundKitSpells),
    },
    animkit: {
      label: "AnimKit", tab: true,
      hint: "AnimKit ID, e.g. 13839",
      run: (tokens, data) => spellsByKitId(tokens, data.animKitSpells),
    },
    anim: {
      label: "Animation", tab: true,
      hint: "animation name, e.g. kneel",
      run(tokens, data) {
        const out = new Set();
        for (let a = 0; a < data.animNamesL.length; a++) {
          if (!textMatches(data.animNamesL[a], tokens)) continue;
          for (const kit of data.animAnimKits.get(a) || []) {
            for (const s of data.animKitSpells.get(kit) || []) out.add(s);
          }
        }
        return out;
      },
    },
    effect: {
      label: "Effect", tab: true,
      hint: "spell effect, e.g. resurrect",
      run(tokens, data) {
        const out = new Set();
        for (const [effectId, nameL] of data.effectNamesL) {
          if (!textMatches(nameL, tokens)) continue;
          for (const s of data.effectSpells.get(effectId) || []) out.add(s);
        }
        return out;
      },
    },
    id: {
      label: "Spell ID", tab: true,
      hint: "exact spell ID, e.g. 133",
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
  // negative groups (not: true) subtract from the result. A query of only
  // negative groups starts from all spells. `disabledFields` (hidden
  // columns) are skipped inside the "all" field; explicit fields always run.
  function searchGroups(groups, data, disabledFields = new Set()) {
    const t0 = performance.now();

    let result = null;
    const negatives = [];
    for (const g of groups) {
      if (!g.tokens.length) continue;
      if (g.not) { negatives.push(g); continue; }
      const field = FIELDS[g.field] ? g.field : "all";
      const set = FIELDS[field].run(g.tokens, data, disabledFields);
      result = result === null ? set : intersect(result, set);
      if (result.size === 0) break;
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
