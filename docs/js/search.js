/* Search engine: query parsing + the field registry.
 *
 * A query is whitespace-separated tokens. Every token must match (AND).
 * A token may carry a field prefix (model:fire) and may be quoted for an
 * exact match (model:"spells/cfx_mage_fireball_impact.m2").
 * Unprefixed tokens search the field selected by the active mode tab.
 *
 * Each field entry implements run(tokens, data) -> Set of spell IDs.
 * Adding a new searchable relation = adding one entry to FIELDS
 * (and, if it needs new data, extending build_data.py + data.js).
 */
"use strict";

window.EpsilookSearch = (() => {

  /* ---------------------------------------------------------- tokenizing */

  // token: (field:)? ( "quoted" | bare )
  const TOKEN_RE = /(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;

  function parseQuery(raw, defaultField) {
    const tokens = [];
    for (const m of raw.matchAll(TOKEN_RE)) {
      const field = (m[1] || defaultField).toLowerCase();
      const exact = m[2] !== undefined;
      const text = (exact ? m[2] : m[3] || "").toLowerCase();
      if (text) tokens.push({ field: FIELDS[field] ? field : defaultField, text, exact });
    }
    return tokens;
  }

  /* ------------------------------------------------------------ helpers */

  // Do all tokens match this string? (substring for plain tokens,
  // equality-with-basename-or-path for exact ones)
  function fileMatches(file, tokens) {
    for (const t of tokens) {
      if (t.exact) {
        if (file.searchL !== t.text && file.base.toLowerCase() !== t.text) return false;
      } else if (!file.searchL.includes(t.text)) {
        return false;
      }
    }
    return true;
  }

  // Search file names within a scope of fids; return spells using the matches.
  function spellsByFile(tokens, data, fids, fileSpells) {
    const out = new Set();
    for (const fid of fids) {
      const file = data.files.get(fid);
      if (file && fileMatches(file, tokens)) {
        for (const s of fileSpells.get(fid)) out.add(s);
      }
    }
    return out;
  }

  function spellsByName(tokens, data) {
    const out = new Set();
    const { ids, namesL } = data;
    outer:
    for (let i = 0; i < namesL.length; i++) {
      const nameL = namesL[i];
      for (const t of tokens) {
        if (t.exact ? nameL !== t.text : !nameL.includes(t.text)) continue outer;
      }
      out.add(ids[i]);
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
      label: "All", tab: true,
      placeholder: "Search spell names, model files and sound files…",
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
      placeholder: 'Spell name — e.g. "fire bolt" finds Firebolt and Bolt of Fire',
      run: (tokens, data) => spellsByName(tokens, data),
    },
    model: {
      label: "Model", tab: true,
      placeholder: "Model file name — e.g. 6dr statue (any part, any order)",
      run: (tokens, data) => spellsByFile(tokens, data, data.modelFids, data.modelSpells),
    },
    sound: {
      label: "Sound", tab: true,
      placeholder: "Sound file name — e.g. fireball impact",
      run: (tokens, data) => spellsByFile(tokens, data, data.soundFids, data.soundSpells),
    },
    soundkit: {
      label: "SoundKit", tab: true,
      placeholder: "SoundKit ID — e.g. 86835",
      run: (tokens, data) => spellsByKitId(tokens, data.soundKitSpells),
    },
    animkit: {
      label: "AnimKit", tab: true,
      placeholder: "AnimKit ID — e.g. 13839",
      run: (tokens, data) => spellsByKitId(tokens, data.animKitSpells),
    },
    anim: {
      label: "Animation", tab: true,
      placeholder: "Animation name — e.g. SpellCastDirected or fly mount",
      run(tokens, data) {
        const out = new Set();
        for (let a = 0; a < data.animNamesL.length; a++) {
          const nameL = data.animNamesL[a];
          const ok = tokens.every((t) => (t.exact ? nameL === t.text : nameL.includes(t.text)));
          if (!ok) continue;
          for (const kit of data.animAnimKits.get(a) || []) {
            for (const s of data.animKitSpells.get(kit) || []) out.add(s);
          }
        }
        return out;
      },
    },
    id: {
      label: "Spell ID", tab: true,
      placeholder: "Exact spell ID — e.g. 133",
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

  // Returns {spellIds: number[], total, ms} — AND across fields,
  // token semantics per field as above. `disabledFields` (from hidden
  // columns) are skipped inside the All field; explicit prefixes for
  // them still work.
  function search(raw, mode, data, disabledFields = new Set()) {
    const t0 = performance.now();
    const tokens = parseQuery(raw, mode);

    // group tokens by field, run each field once, intersect the results
    const byField = new Map();
    for (const t of tokens) {
      if (!byField.has(t.field)) byField.set(t.field, []);
      byField.get(t.field).push(t);
    }

    let result = null;
    for (const [field, fieldTokens] of byField) {
      const set = FIELDS[field].run(fieldTokens, data, disabledFields);
      result = result === null ? set : intersect(result, set);
      if (result.size === 0) break;
    }
    if (result === null) result = new Set();

    return { spellIds: [...result], ms: performance.now() - t0, tokens };
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

  return { search, parseQuery, sortByRelevance, FIELDS };
})();
