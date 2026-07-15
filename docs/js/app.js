/* Epsilook UI: chip search bar, results table, tags, clipboard, scrolling. */
"use strict";

(() => {
  const CFG = window.EpsilookConfig;
  const Data = window.EpsilookData;
  const Search = window.EpsilookSearch;

  /* ------------------------------------------------------------- state */

  const state = {
    versions: [],       // manifest entries
    version: null,      // active manifest entry
    data: null,         // indexes for the active version

    // the search bar: committed chips + the chip being typed (activeField
    // + the input's text). Chips with field "all" are free-text chips.
    chips: [],          // [{field, text}]
    activeField: null,  // field of the chip currently being typed, or null

    tokens: [],         // tokens of the last search (for tag highlighting)
    lastQuery: "",      // serialized form of the last search (hash/export)
    results: [],        // spell ids matching the query
    display: [],        // results after filters + sort
    searchMs: 0,
    rendered: 0,        // rows currently in the table
    filters: { models: false, sounds: false, animkits: false },
    sort: { key: "auto", dir: 1 },
    // hidden columns (also excluded from All-mode search and from exports)
    hiddenCols: { models: false, sounds: false, animkits: false, effects: true, commands: false },
  };

  // column -> search fields it contributes
  const COL_FIELDS = {
    models: ["model"],
    sounds: ["sound", "soundkit"],
    animkits: ["animkit", "anim"],
    effects: ["effect"],
  };

  function disabledFields() {
    const out = new Set();
    for (const [col, fields] of Object.entries(COL_FIELDS)) {
      if (state.hiddenCols[col]) fields.forEach((f) => out.add(f));
    }
    return out;
  }

  // "9.2.7.45745" -> "9.2.7" (used for clean URLs)
  const shortVersion = (id) => id.split(".").slice(0, 3).join(".");

  const stripExt = (name) => name.replace(/\.[^.]+$/, "");

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /* --------------------------------------------------------- clipboard */

  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1400);
  }

  function copyText(text) {
    const done = () => toast(`Copied:  ${text}`);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = el("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("Copy failed"); }
    ta.remove();
  }

  const fillTemplate = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

  /* ------------------------------------------------- query <-> chips */

  function isChipField(f) {
    return f && f !== "all" && Search.FIELDS[f];
  }

  // canonical string form: model:"fel reaver" free words ...
  function serializeQuery() {
    const parts = state.chips.map((c) =>
      c.field === "all" ? c.text
        : `${c.field}:${/\s/.test(c.text) ? `"${c.text}"` : c.text}`);
    const inputText = $("#q").value.trim();
    if (inputText) {
      parts.push(state.activeField
        ? `${state.activeField}:${/\s/.test(inputText) ? `"${inputText}"` : inputText}`
        : inputText);
    } else if (state.activeField) {
      parts.push(`${state.activeField}:`);
    }
    return parts.join(" ");
  }

  // parse a canonical string back into chips + free input text
  function loadQueryString(str) {
    state.chips = [];
    state.activeField = null;
    const free = [];
    for (const m of (str || "").matchAll(/(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi)) {
      const field = (m[1] || "").toLowerCase();
      const text = (m[2] !== undefined ? m[2] : m[3] || "").trim();
      if (isChipField(field)) {
        if (text) state.chips.push({ field, text });
        ensureFieldVisible(field);
      } else if (m[1]) {
        free.push(`${m[1]}:${text}`); // unknown prefix stays literal
      } else if (text) {
        free.push(text);
      }
    }
    $("#q").value = free.join(" ");
    renderBar();
  }

  // token list for the engine: chip words + free input words
  function currentTokens() {
    const tokens = [];
    const add = (field, text) => {
      for (const w of text.toLowerCase().split(/\s+/)) {
        if (w) tokens.push({ field, text: w });
      }
    };
    for (const c of state.chips) add(c.field, c.text);
    add(state.activeField || "all", $("#q").value);
    return tokens;
  }

  /* ------------------------------------------------------- search bar */

  function renderBar() {
    const bar = $("#qbar");
    for (const chip of bar.querySelectorAll(".qchip")) chip.remove();
    const editwrap = $("#editwrap");

    state.chips.forEach((c, idx) => {
      const chip = el("span", `qchip f-${c.field}`);
      const label = el("span", "qchip-field", c.field === "all" ? "" : `${c.field}:`);
      if (c.field !== "all") chip.appendChild(label);
      chip.appendChild(el("span", "qchip-text", c.text));
      const x = el("button", "qchip-x", "×");
      x.title = "Remove";
      x.dataset.chipRemove = String(idx);
      chip.appendChild(x);
      chip.dataset.chipEdit = String(idx);
      bar.insertBefore(chip, editwrap);
    });

    editwrap.classList.toggle("editing", !!state.activeField);
    if (state.activeField) editwrap.dataset.field = state.activeField;
    else delete editwrap.dataset.field;
    $("#editlabel").textContent = state.activeField ? `${state.activeField}:` : "";
    $("#editlabel").hidden = !state.activeField;
    $("#q").placeholder = state.activeField
      ? Search.FIELDS[state.activeField].hint
      : (state.chips.length ? "" : "Search names, models and sounds — or type model: for a field tag");
    updateTabs();
  }

  function activateField(field, { keepInput = false } = {}) {
    commitActiveChip();
    ensureFieldVisible(field);
    const input = $("#q");
    if (!keepInput && input.value.trim()) {
      state.chips.push({ field: "all", text: input.value.trim() });
      input.value = "";
    }
    state.activeField = field;
    hideSuggest();
    renderBar();
    input.focus();
    scheduleSearch();
  }

  function commitActiveChip() {
    if (!state.activeField) return;
    const input = $("#q");
    const text = input.value.trim();
    if (text) state.chips.push({ field: state.activeField, text });
    state.activeField = null;
    input.value = "";
    renderBar();
  }

  /* ------------------------------------------------------ autocomplete */

  let suggestIndex = -1;

  function updateSuggest() {
    const input = $("#q");
    const box = $("#suggest");
    if (state.activeField) return hideSuggest();
    const word = input.value.split(/\s+/).pop().toLowerCase();
    if (word.length < 2) return hideSuggest();
    const matches = Object.entries(Search.FIELDS).filter(([key, f]) =>
      f.tab && !disabledFields().has(key) &&
      (key.startsWith(word) || f.label.toLowerCase().startsWith(word)) && key !== word);
    if (!matches.length) return hideSuggest();

    box.textContent = "";
    matches.forEach(([key, f]) => {
      const b = el("button", "suggest-item");
      b.appendChild(el("span", `suggest-field f-${key}`, `${key}:`));
      b.appendChild(el("span", "suggest-hint", f.hint));
      b.dataset.field = key;
      box.appendChild(b);
    });
    suggestIndex = -1;
    box.hidden = false;
  }

  function hideSuggest() {
    $("#suggest").hidden = true;
    suggestIndex = -1;
  }

  function selectSuggestion(field) {
    const input = $("#q");
    input.value = input.value.replace(/\S+$/, "").trimEnd();
    activateField(field);
  }

  /* ------------------------------------------------------------ search */

  let searchDebounce = null;
  function scheduleSearch() {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(), CFG.searchDebounceMs);
  }

  function runSearch({ push = false } = {}) {
    const data = state.data;
    if (!data) return;
    clearTimeout(searchDebounce);

    const raw = serializeQuery();
    state.lastQuery = raw;

    if (raw.replace(/[a-z]+:|"/gi, "").trim().length < CFG.minQueryLength) {
      state.results = [];
      state.tokens = [];
      state.searchMs = 0;
      applyFiltersAndSort();
      setStatus(raw ? `Type at least ${CFG.minQueryLength} characters` : "");
      stateToHash(push);
      return;
    }

    const tokens = currentTokens();
    const res = Search.searchTokens(tokens, data, disabledFields());
    state.results = res.spellIds;
    state.tokens = tokens;
    state.searchMs = res.ms;
    applyFiltersAndSort();
    stateToHash(push);
  }

  function applyFiltersAndSort() {
    const d = state.data;
    let list = state.results;

    const f = state.filters;
    if (f.models || f.sounds || f.animkits) {
      list = list.filter((id) =>
        (!f.models || d.spellModels.has(id)) &&
        (!f.sounds || d.spellSounds.has(id)) &&
        (!f.animkits || d.spellAnimKits.has(id)));
    } else {
      list = list.slice();
    }

    const { key, dir } = state.sort;
    if (key === "id") {
      list.sort((a, b) => (a - b) * dir);
    } else if (key === "name") {
      list.sort((a, b) =>
        d.names[d.spellIndex.get(a)].localeCompare(d.names[d.spellIndex.get(b)]) * dir || a - b);
    } else { // auto
      const nameTokens = state.tokens.filter((t) => t.field === "name" || t.field === "all");
      if (nameTokens.length) {
        Search.sortByRelevance(list, nameTokens.map((t) => t.text).join(" "), d);
      } else {
        list.sort((a, b) => a - b);
      }
    }

    state.display = list;
    renderResults();
  }

  function setStatus(text) {
    $("#status").textContent = text;
  }

  /* --------------------------------------------------------- rendering */

  function renderResults() {
    const tbody = $("#results tbody");
    tbody.textContent = "";
    state.rendered = 0;
    renderMore();

    const total = state.results.length;
    const shown = state.display.length;
    const hasQuery = state.tokens.length > 0;
    if (hasQuery) {
      const filtered = shown < total ? ` (${shown.toLocaleString()} after filters)` : "";
      setStatus(`${total.toLocaleString()} ${total === 1 ? "spell" : "spells"}${filtered} · ${state.searchMs.toFixed(0)} ms`);
    }
    $("#results").classList.toggle("empty", shown === 0);
    $("#empty-note").hidden = !(shown === 0 && hasQuery);
    $("#empty-state").hidden = hasQuery;
    updateSortHeaders();
  }

  function renderMore() {
    const tbody = $("#results tbody");
    const end = Math.min(state.rendered + CFG.scrollBatch, state.display.length);
    const frag = document.createDocumentFragment();
    for (let i = state.rendered; i < end; i++) frag.appendChild(buildRow(state.display[i]));
    tbody.appendChild(frag);
    state.rendered = end;
    $("#sentinel").hidden = state.rendered >= state.display.length;
  }

  function buildRow(spellId) {
    const d = state.data;
    const i = d.spellIndex.get(spellId);
    const tr = el("tr");

    // ID
    const tdId = el("td", "c-id");
    const idBtn = el("button", "id-copy", String(spellId));
    idBtn.title = "Copy spell ID";
    idBtn.dataset.copy = String(spellId);
    tdId.appendChild(idBtn);
    tr.appendChild(tdId);

    // Name — wowhead link (their widget adds the hover tooltip); the parts
    // matched by a name search are highlighted
    const tdName = el("td", "c-name");
    const nameDiv = el("div", "spell-name");
    const nameLink = el("a", "spell-name-link");
    nameLink.href = fillTemplate(CFG.wowheadSpellUrl, { id: spellId });
    nameLink.target = "_blank";
    nameLink.rel = "noopener";
    nameLink.appendChild(highlightMatches(d.names[i] || "(unnamed)"));
    nameDiv.appendChild(nameLink);
    tdName.appendChild(nameDiv);
    if (d.subtexts[i]) tdName.appendChild(el("div", "spell-sub", d.subtexts[i]));
    tr.appendChild(tdName);

    // Models — matched files first
    const modelFids = hitsFirst(d.spellModels.get(spellId) || [],
      (fid) => fileIsHit(d.files.get(fid), "model"));
    tr.appendChild(tagCell("c-models", modelFids.map((fid) => modelTag(fid))));

    // Sounds — grouped by SoundKit; kits containing a match come first
    tr.appendChild(soundsCell(d.spellSounds.get(spellId) || []));

    // Animations — AnimKits grouped with the animations they play
    tr.appendChild(animationsCell(d.spellAnimKits.get(spellId) || []));

    // Effects
    const effectIds = (d.spellEffects.get(spellId) || []).slice().sort((a, b) => a - b);
    tr.appendChild(tagCell("c-effects", effectIds.map((e) => effectTag(e))));

    // Commands — extra ones hide behind "+N more"
    const tdCmd = el("td", "c-cmds");
    let extraCount = 0;
    for (const cmd of CFG.spellCommands) {
      const b = el("button", "cmd", cmd.label);
      b.title = `${cmd.hint} — ${fillTemplate(cmd.template, { id: spellId })}`;
      b.dataset.copy = fillTemplate(cmd.template, { id: spellId });
      if (cmd.extra) { b.classList.add("overflow"); extraCount++; }
      tdCmd.appendChild(b);
    }
    tdCmd.appendChild(wowheadLink(fillTemplate(CFG.wowheadSpellUrl, { id: spellId }), "Open on Wowhead"));
    if (extraCount > 0) {
      const more = el("button", "more", `+${extraCount}`);
      more.title = "Show more commands";
      more.dataset.expand = "1";
      tdCmd.appendChild(more);
    }
    tr.appendChild(tdCmd);

    return tr;
  }

  /* Highlight the query-matched parts of a spell name; returns a fragment. */
  function highlightMatches(name) {
    const frag = document.createDocumentFragment();
    const tokens = tokensFor("name").map((t) => t.text);
    if (!tokens.length) {
      frag.appendChild(document.createTextNode(name));
      return frag;
    }
    const lower = name.toLowerCase();
    const ranges = [];
    for (const t of tokens) {
      let idx = 0;
      while (t && (idx = lower.indexOf(t, idx)) !== -1) {
        ranges.push([idx, idx + t.length]);
        idx += 1;
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    let pos = 0;
    for (const [s, e] of merged) {
      if (s > pos) frag.appendChild(document.createTextNode(name.slice(pos, s)));
      frag.appendChild(el("mark", "hl", name.slice(s, e)));
      pos = e;
    }
    if (pos < name.length) frag.appendChild(document.createTextNode(name.slice(pos)));
    return frag;
  }

  // stable partition: elements matching isHit come first, original order kept
  function hitsFirst(items, isHit) {
    if (!state.tokens.length) return items;
    const hits = [], rest = [];
    for (const it of items) (isHit(it) ? hits : rest).push(it);
    return hits.length ? hits.concat(rest) : rest;
  }

  function wowheadLink(url, title) {
    const a = el("a", "wowhead");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.title = title;
    const img = el("img");
    img.src = "https://wow.zamimg.com/images/logos/favicon-standard.png";
    img.alt = "WH";
    img.loading = "lazy";
    a.appendChild(img);
    return a;
  }

  // Collapsing 1-2 items would cost as much space as showing them, so a
  // cell only collapses when at least 3 items are hidden.
  const COLLAPSE_SLACK = 2;

  function tagCell(className, tags) {
    const td = el("td", className);
    if (tags.length === 0) {
      td.classList.add("empty");
      td.appendChild(el("span", "none", "—"));
      return td;
    }
    const limit = tags.length <= CFG.tagsCollapsedLimit + COLLAPSE_SLACK
      ? tags.length : CFG.tagsCollapsedLimit;
    tags.forEach((tag, idx) => {
      if (idx >= limit) tag.classList.add("overflow");
      td.appendChild(tag);
    });
    if (tags.length > limit) {
      const more = el("button", "more", `+${tags.length - limit} more`);
      more.dataset.expand = "1";
      td.appendChild(more);
    }
    return td;
  }

  /* One cell showing each SoundKit with the sound files it contains. */
  function soundsCell(soundEntries) {
    const td = el("td", "c-sounds");
    if (soundEntries.length === 0) {
      td.classList.add("empty");
      td.appendChild(el("span", "none", "—"));
      return td;
    }
    const d = state.data;

    const byKit = new Map(); // soundKitId -> [fid]
    for (const e of soundEntries) {
      const arr = byKit.get(e.soundKitId);
      if (arr) arr.push(e.fid); else byKit.set(e.soundKitId, [e.fid]);
    }

    const kitHasHit = (kitId) =>
      kitIsHit(kitId, "soundkit") ||
      byKit.get(kitId).some((fid) => fileIsHit(d.files.get(fid), "sound"));
    const kitIds = hitsFirst([...byKit.keys()].sort((a, b) => a - b), kitHasHit);

    buildKitGroups(td, kitIds, {
      headerTag: (kitId) => kitTag(kitId, "soundkit"),
      itemsOf: (kitId) => hitsFirst(byKit.get(kitId), (fid) => fileIsHit(d.files.get(fid), "sound")),
      itemTag: (fid) => soundTag(fid),
      itemLimit: CFG.kitFilesCollapsedLimit ?? CFG.tagsCollapsedLimit,
      groupNoun: "kit",
    });
    return td;
  }

  /* Animations cell: AnimKits grouped with the animations they play. */
  function animationsCell(animKitIds) {
    const td = el("td", "c-animkits");
    if (animKitIds.length === 0) {
      td.classList.add("empty");
      td.appendChild(el("span", "none", "—"));
      return td;
    }
    const d = state.data;
    const kitHasHit = (kitId) =>
      kitIsHit(kitId, "animkit") ||
      (d.animKitAnims.get(kitId) || []).some((a) => animIsHit(a));
    const kitIds = hitsFirst(animKitIds.slice().sort((a, b) => a - b), kitHasHit);

    buildKitGroups(td, kitIds, {
      headerTag: (kitId) => kitTag(kitId, "animkit"),
      itemsOf: (kitId) => hitsFirst((d.animKitAnims.get(kitId) || []).slice().sort((a, b) => a - b),
        (a) => animIsHit(a)),
      itemTag: (animId) => animTag(animId),
      itemLimit: CFG.kitFilesCollapsedLimit ?? CFG.tagsCollapsedLimit,
      groupNoun: "kit",
    });
    return td;
  }

  /* Shared group renderer: header tag + nested item tags per group,
   * collapsing only when it actually saves space. */
  function buildKitGroups(td, kitIds, opts) {
    const groupLimit = kitIds.length <= 2 + 1 ? kitIds.length : 2;
    let hiddenCount = 0;

    kitIds.forEach((kitId, gi) => {
      const group = el("div", "kit-group");
      if (gi >= groupLimit) group.classList.add("overflow");
      group.appendChild(opts.headerTag(kitId));

      const itemsDiv = el("div", "kit-files");
      const items = opts.itemsOf(kitId);
      const limit = items.length <= opts.itemLimit + COLLAPSE_SLACK ? items.length : opts.itemLimit;
      items.forEach((item, fi) => {
        const tag = opts.itemTag(item);
        if (gi >= groupLimit || fi >= limit) {
          tag.classList.add("overflow");
          hiddenCount++;
        }
        itemsDiv.appendChild(tag);
      });
      group.appendChild(itemsDiv);
      td.appendChild(group);
    });

    const hiddenGroups = Math.max(0, kitIds.length - groupLimit);
    if (hiddenGroups > 0 || hiddenCount > 0) {
      const label = hiddenGroups > 0
        ? `+${hiddenGroups} more ${hiddenGroups === 1 ? opts.groupNoun : opts.groupNoun + "s"}`
        : `+${hiddenCount} more`;
      const more = el("button", "more", label);
      more.dataset.expand = "1";
      td.appendChild(more);
    }
  }

  function tokensFor(field) {
    return state.tokens.filter((t) => t.field === field || t.field === "all");
  }

  function fileIsHit(file, field) {
    if (!file) return false;
    const tokens = tokensFor(field);
    if (!tokens.length) return false;
    return tokens.every((t) => file.searchL.includes(t.text));
  }

  function kitIsHit(kitId, field) {
    return tokensFor(field).some((t) => Number(t.text) === kitId);
  }

  function animIsHit(animId) {
    const tokens = tokensFor("anim");
    if (!tokens.length) return false;
    const nameL = state.data.animNamesL[animId];
    return tokens.every((t) => nameL.includes(t.text));
  }

  function effectIsHit(effectId) {
    const tokens = tokensFor("effect");
    if (!tokens.length) return false;
    const nameL = state.data.effectNamesL.get(effectId) || "";
    return tokens.every((t) => nameL.includes(t.text));
  }

  // small helper: a copy button inside a tag. "⧉" copies an ID; command
  // buttons are labeled after what they copy (".lo", "/", ".mod").
  function tagButton(glyph, title, copyValue) {
    const b = el("button", "tag-copy", glyph);
    b.title = title;
    b.dataset.copy = copyValue;
    return b;
  }

  function modelTag(fid) {
    const d = state.data;
    const file = d.files.get(fid) || { fid, path: "", base: "", searchL: "" };
    const tag = el("span", "tag model");
    tag.title = file.path || "(name unknown)";
    if (fileIsHit(file, "model")) tag.classList.add("hit");

    const txt = el("button", "tag-label", file.base ? stripExt(file.base) : `file #${fid}`);
    txt.title = `${file.path || "(name unknown)"}\nFileDataID ${fid}\nClick: find spells using this model`;
    txt.dataset.search = file.path ? `model:"${file.path}"` : "";
    tag.appendChild(txt);

    const cmd = fillTemplate(CFG.modelCopyTemplate,
      { base: stripExt(file.base), file: file.base, path: file.path, fid });
    tag.appendChild(tagButton(".lo", `Copy:  ${cmd}`, cmd));
    return tag;
  }

  function soundTag(fid) {
    const d = state.data;
    const file = d.files.get(fid) || { fid, path: "", base: "", searchL: "" };
    const tag = el("span", "tag sound");
    tag.title = file.path || "(name unknown)";
    if (fileIsHit(file, "sound")) tag.classList.add("hit");

    // sound extensions stay visible (.ogg/.mp3 differ, unlike models)
    const txt = el("button", "tag-label", file.base || `file #${fid}`);
    txt.title = `${file.path || "(name unknown)"}\nFileDataID ${fid}\nClick: find spells using this sound`;
    txt.dataset.search = file.path ? `sound:"${file.path}"` : "";
    tag.appendChild(txt);

    tag.appendChild(tagButton("⧉", `Copy FileDataID ${fid}`, String(fid)));
    return tag;
  }

  function kitTag(kitId, field) {
    const tag = el("span", `tag ${field}`);
    if (kitIsHit(kitId, field)) tag.classList.add("hit");

    const txt = el("button", "tag-label", String(kitId));
    txt.title = field === "soundkit"
      ? `SoundKit ${kitId}\nClick: find spells using this soundkit`
      : `AnimKit ${kitId}\nClick: find spells using this animkit`;
    txt.dataset.search = `${field}:${kitId}`;
    tag.appendChild(txt);

    const kind = field === "soundkit" ? "SoundKit" : "AnimKit";
    tag.appendChild(tagButton("⧉", `Copy ${kind} ID ${kitId}`, String(kitId)));

    const tpl = field === "soundkit" ? CFG.soundKitCopyTemplate : CFG.animKitCopyTemplate;
    const cmd = fillTemplate(tpl, { id: kitId });
    tag.appendChild(tagButton(field === "soundkit" ? "/" : ".mod", `Copy:  ${cmd}`, cmd));

    if (field === "soundkit") {
      tag.appendChild(wowheadLink(fillTemplate(CFG.wowheadSoundUrl, { id: kitId }), `SoundKit ${kitId} on Wowhead`));
    }
    return tag;
  }

  function animTag(animId) {
    const d = state.data;
    const name = d.animNames[animId];
    const tag = el("span", "tag anim");
    if (animIsHit(animId)) tag.classList.add("hit");

    const txt = el("button", "tag-label", name);
    txt.title = `Animation ${animId}: ${name}\nClick: find spells playing this animation`;
    txt.dataset.search = `anim:"${name}"`;
    tag.appendChild(txt);

    const cmd = fillTemplate(CFG.animCopyTemplate, { name, id: animId });
    tag.appendChild(tagButton(".lo", `Copy:  ${cmd}`, cmd));
    return tag;
  }

  function effectTag(effectId) {
    const d = state.data;
    const name = d.effectNames.get(effectId) || `EFFECT_${effectId}`;
    const tag = el("span", "tag effect");
    if (effectIsHit(effectId)) tag.classList.add("hit");
    const label = el("button", "tag-label", name);
    label.title = `Spell effect ${effectId}: SPELL_EFFECT_${name}\nClick: find spells with this effect`;
    label.dataset.search = `effect:"${name}"`;
    tag.appendChild(label);
    return tag;
  }

  /* ------------------------------------------------------------ export */

  // Hidden columns are excluded from exports.
  function exportRows() {
    const d = state.data;
    const hc = state.hiddenCols;
    const pathOf = (fid) => (d.files.get(fid) || {}).path || `#${fid}`;
    return state.display.map((id) => {
      const i = d.spellIndex.get(id);
      const row = { id, name: d.names[i], subtext: d.subtexts[i] };
      if (!hc.models) row.models = (d.spellModels.get(id) || []).map(pathOf);
      if (!hc.sounds) {
        const byKit = new Map();
        for (const e of d.spellSounds.get(id) || []) {
          if (!byKit.has(e.soundKitId)) byKit.set(e.soundKitId, []);
          byKit.get(e.soundKitId).push(pathOf(e.fid));
        }
        row.soundKits = [...byKit.keys()].sort((a, b) => a - b)
          .map((k) => ({ id: k, files: byKit.get(k) }));
      }
      if (!hc.animkits) {
        row.animKits = (d.spellAnimKits.get(id) || []).slice().sort((a, b) => a - b)
          .map((k) => ({ id: k, anims: (d.animKitAnims.get(k) || []).map((a) => d.animNames[a]) }));
      }
      if (!hc.effects) {
        row.effects = (d.spellEffects.get(id) || []).slice().sort((a, b) => a - b)
          .map((e) => d.effectNames.get(e) || `EFFECT_${e}`);
      }
      return row;
    });
  }

  function exportFilename(ext) {
    const q = state.lastQuery.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "results";
    return `epsilook-${q}.${ext}`;
  }

  function downloadFile(name, mime, content) {
    const a = el("a");
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${name}`);
  }

  function nothingToExport() {
    if (state.display.length === 0) { toast("Nothing to export — search first"); return true; }
    return false;
  }

  function exportCsv() {
    if (nothingToExport()) return;
    const hc = state.hiddenCols;
    const esc = (v) => {
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ["ID", "Name", "Subtext"];
    if (!hc.models) header.push("Models");
    if (!hc.sounds) header.push("SoundKits", "Sounds");
    if (!hc.animkits) header.push("AnimKits", "Animations");
    if (!hc.effects) header.push("Effects");
    const lines = [header.join(",")];
    for (const r of exportRows()) {
      const cols = [r.id, esc(r.name), esc(r.subtext)];
      if (!hc.models) cols.push(esc(r.models.join("; ")));
      if (!hc.sounds) {
        cols.push(esc(r.soundKits.map((k) => k.id).join("; ")));
        cols.push(esc(r.soundKits.map((k) => `${k.id}: ${k.files.join(" | ")}`).join("; ")));
      }
      if (!hc.animkits) {
        cols.push(esc(r.animKits.map((k) => k.id).join("; ")));
        cols.push(esc(r.animKits.map((k) => `${k.id}: ${k.anims.join(" | ")}`).join("; ")));
      }
      if (!hc.effects) cols.push(esc(r.effects.join("; ")));
      lines.push(cols.join(","));
    }
    downloadFile(exportFilename("csv"), "text/csv", lines.join("\r\n"));
  }

  function exportJson() {
    if (nothingToExport()) return;
    const payload = {
      app: "Epsilook",
      url: location.href,
      gameVersion: state.version.id,
      query: state.lastQuery,
      count: state.display.length,
      spells: exportRows(),
    };
    downloadFile(exportFilename("json"), "application/json", JSON.stringify(payload, null, 2));
  }

  function exportDiscord() {
    if (nothingToExport()) return;
    const rows = exportRows();
    const limit = CFG.discordExportRows;
    const shown = rows.slice(0, limit);
    const idWidth = Math.max(...shown.map((r) => String(r.id).length), 2);
    const lines = shown.map((r) =>
      `${String(r.id).padEnd(idWidth)}  ${r.name}${r.subtext ? ` (${r.subtext})` : ""}`);
    let text = `**Epsilook** — ${rows.length.toLocaleString()} ${rows.length === 1 ? "spell" : "spells"} for \`${state.lastQuery}\`\n`;
    text += `<${location.href}>\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
    if (rows.length > limit) text += `\n…and ${(rows.length - limit).toLocaleString()} more (full list: link above)`;
    copyText(text);
  }

  function updateSortHeaders() {
    for (const th of document.querySelectorAll("th[data-sort]")) {
      const active = state.sort.key === th.dataset.sort;
      th.classList.toggle("sorted", active);
      th.querySelector(".arrow").textContent = active ? (state.sort.dir === 1 ? "▲" : "▼") : "";
    }
  }

  /* ---------------------------------------------------------- URL hash */

  let suppressHashChange = false;

  function stateToHash(push) {
    const params = new URLSearchParams();
    if (state.version) params.set("v", shortVersion(state.version.id));
    if (state.lastQuery) params.set("q", state.lastQuery);
    const hash = "#" + params.toString();
    if (hash === location.hash) return;
    suppressHashChange = true;
    if (push) location.hash = hash;
    else history.replaceState(null, "", hash);
    // hashchange only fires for location.hash assignment
    if (!push) suppressHashChange = false;
  }

  function hashToState() {
    const params = new URLSearchParams(location.hash.slice(1));
    let q = params.get("q") || "";
    // legacy links carried a mode: fold it into the query as a field tag
    const legacyMode = params.get("m");
    if (legacyMode && isChipField(legacyMode) && q && !/[a-z]+:/i.test(q)) {
      q = `${legacyMode}:${/\s/.test(q) ? `"${q}"` : q}`;
    }
    return { v: params.get("v"), q };
  }

  // A shared link may search a field whose column is hidden here —
  // honor the link by un-hiding that column for this session.
  function ensureFieldVisible(field) {
    if (!Search.FIELDS[field] || !disabledFields().has(field)) return;
    for (const [col, fields] of Object.entries(COL_FIELDS)) {
      if (fields.includes(field)) state.hiddenCols[col] = false;
    }
    applyHiddenCols();
  }

  // accepts both full build ids and short "9.2.7" forms
  function findVersion(v) {
    if (!v) return undefined;
    return state.versions.find((e) => e.id === v) ||
           state.versions.findLast((e) => shortVersion(e.id) === v);
  }

  /* ------------------------------------------------------------ events */

  function crossSearch(query) {
    loadQueryString(query);
    runSearch({ push: true });
    window.scrollTo({ top: 0 });
  }

  function wireEvents() {
    const input = $("#q");

    input.addEventListener("input", () => {
      if (!state.activeField) {
        const m = input.value.match(/(^|\s)([a-z]+):$/i);
        if (m && isChipField(m[2].toLowerCase())) {
          const field = m[2].toLowerCase();
          input.value = input.value.slice(0, m.index + m[1].length);
          activateField(field);
          return;
        }
        updateSuggest();
      }
      scheduleSearch();
    });

    input.addEventListener("keydown", (e) => {
      const box = $("#suggest");
      if (!box.hidden) {
        const items = [...box.querySelectorAll(".suggest-item")];
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          suggestIndex = (suggestIndex + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items.forEach((it, i) => it.classList.toggle("selected", i === suggestIndex));
          return;
        }
        if ((e.key === "Enter" || e.key === "Tab") && suggestIndex >= 0) {
          e.preventDefault();
          selectSuggestion(items[suggestIndex].dataset.field);
          return;
        }
        if (e.key === "Escape") { hideSuggest(); return; }
      }

      if (e.key === "Enter") {
        commitActiveChip();
        runSearch({ push: true });
      } else if (e.key === "Tab" && state.activeField) {
        e.preventDefault();
        commitActiveChip();
        scheduleSearch();
      } else if (e.key === "Escape" && state.activeField) {
        commitActiveChip();
        scheduleSearch();
      } else if (e.key === "Backspace" && input.value === "") {
        e.preventDefault();
        if (state.activeField) {
          state.activeField = null;
          renderBar();
        } else if (state.chips.length) {
          const chip = state.chips.pop();
          if (chip.field === "all") {
            input.value = chip.text;
          } else {
            state.activeField = chip.field;
            input.value = chip.text;
          }
          renderBar();
        }
        input.focus();
        scheduleSearch();
      }
    });

    // chip clicks: × removes, body edits
    $("#qbar").addEventListener("click", (e) => {
      const x = e.target.closest("[data-chip-remove]");
      if (x) {
        state.chips.splice(Number(x.dataset.chipRemove), 1);
        renderBar();
        input.focus();
        scheduleSearch();
        return;
      }
      const chip = e.target.closest("[data-chip-edit]");
      if (chip) {
        commitActiveChip();
        const [edited] = state.chips.splice(Number(chip.dataset.chipEdit), 1);
        if (edited.field === "all") input.value = edited.text;
        else { state.activeField = edited.field; input.value = edited.text; }
        renderBar();
        input.focus();
        scheduleSearch();
        return;
      }
      input.focus();
    });

    // suggestions
    $("#suggest").addEventListener("mousedown", (e) => {
      const item = e.target.closest(".suggest-item");
      if (item) { e.preventDefault(); selectSuggestion(item.dataset.field); }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#qbar") && !e.target.closest("#suggest")) hideSuggest();
    });

    // field buttons: start a field tag in the search bar
    $("#tabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-field]");
      if (btn) activateField(btn.dataset.field);
    });

    // results: copy buttons / cross-search / expanders (event delegation)
    $("#results").addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.copy) copyText(t.dataset.copy);
      else if (t.dataset.search) crossSearch(t.dataset.search);
      else if (t.dataset.expand) {
        t.closest("td").classList.add("expanded");
        t.remove();
      }
    });

    // example searches on the empty-state panel
    $("#empty-state").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-search]");
      if (b) crossSearch(b.dataset.search);
    });

    // export
    $("#export-csv").addEventListener("click", exportCsv);
    $("#export-json").addEventListener("click", exportJson);
    $("#export-discord").addEventListener("click", exportDiscord);

    // filters
    for (const box of document.querySelectorAll("#filters input[type=checkbox]")) {
      box.addEventListener("change", () => {
        state.filters[box.dataset.filter] = box.checked;
        applyFiltersAndSort();
      });
    }

    // column visibility
    for (const box of document.querySelectorAll("#columns input[type=checkbox]")) {
      box.addEventListener("change", () => {
        state.hiddenCols[box.dataset.col] = !box.checked;
        try { localStorage.setItem("epsilook.hiddenCols.v3", JSON.stringify(state.hiddenCols)); } catch (e) {}
        applyHiddenCols();
        runSearch();
      });
    }

    // sorting: click cycles ascending -> descending -> back to automatic order
    for (const th of document.querySelectorAll("th[data-sort]")) {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sort.key !== key) state.sort = { key, dir: 1 };
        else if (state.sort.dir === 1) state.sort.dir = -1;
        else state.sort = { key: "auto", dir: 1 };
        applyFiltersAndSort();
      });
    }

    // help popover
    $("#help-btn").addEventListener("click", () => $("#help").toggleAttribute("hidden"));
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#help") && !e.target.closest("#help-btn")) $("#help").setAttribute("hidden", "");
    });

    // infinite scroll
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) renderMore();
    }, { rootMargin: "600px" }).observe($("#sentinel"));

    // back/forward
    window.addEventListener("hashchange", () => {
      if (suppressHashChange) { suppressHashChange = false; return; }
      applyHash({ push: false });
    });

    // version switch
    $("#version").addEventListener("change", async (e) => {
      const entry = state.versions.find((v) => v.id === e.target.value);
      if (entry) await activateVersion(entry, { push: true });
    });
  }

  function updateTabs() {
    for (const btn of document.querySelectorAll("#tabs button")) {
      btn.classList.toggle("active", btn.dataset.field === state.activeField);
    }
  }

  /* Hide table columns, their field buttons, their "Only spells with"
   * filters, and sync the checkboxes. */
  function applyHiddenCols() {
    const table = $("#results");
    const disabled = disabledFields();
    for (const [col, hidden] of Object.entries(state.hiddenCols)) {
      table.classList.toggle(`hide-${col}`, hidden);
    }
    for (const btn of document.querySelectorAll("#tabs button")) {
      btn.hidden = disabled.has(btn.dataset.field);
    }
    for (const box of document.querySelectorAll("#columns input[type=checkbox]")) {
      box.checked = !state.hiddenCols[box.dataset.col];
    }
    // a hidden column's filter makes no sense — hide it and switch it off
    for (const box of document.querySelectorAll("#filters input[type=checkbox]")) {
      const col = box.dataset.filter;
      const hidden = !!state.hiddenCols[col];
      box.closest("label").hidden = hidden;
      if (hidden && state.filters[col]) {
        state.filters[col] = false;
        box.checked = false;
      }
    }
  }

  /* ------------------------------------------------------------- boot */

  function buildTabs() {
    const tabs = $("#tabs");
    for (const [id, field] of Object.entries(Search.FIELDS)) {
      if (!field.tab) continue;
      const b = el("button", "", `${field.label}`);
      b.dataset.field = id;
      b.title = `Add a ${id}: tag — ${field.hint}`;
      tabs.appendChild(b);
    }
  }

  async function activateVersion(entry, { push = false } = {}) {
    const overlay = $("#loading");
    overlay.hidden = false;
    $("#load-error").hidden = true;
    try {
      const pack = await Data.loadPack(entry, (got, total) => {
        const pct = total ? Math.round((got / total) * 100) : 0;
        $("#load-bar").style.width = pct + "%";
        $("#load-text").textContent = total
          ? `Downloading spell data… ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
          : `Downloading spell data… ${(got / 1048576).toFixed(1)} MB`;
      });
      $("#load-text").textContent = "Building search indexes…";
      await new Promise((r) => setTimeout(r)); // let the text paint
      state.data = Data.buildIndexes(pack);
      state.version = entry;
      $("#version").value = entry.id;
      $("#meta-info").textContent =
        `${entry.label} (${entry.id}) · Listfile ${state.data.meta.listfileTag} · Built ${state.data.meta.built} · ` +
        `${state.data.meta.counts.spells.toLocaleString()} spells`;
      $("#es-count").textContent = state.data.meta.counts.spells.toLocaleString();
      overlay.hidden = true;
      runSearch({ push });
    } catch (err) {
      console.error(err);
      $("#load-text").textContent = "";
      $("#load-error").textContent = `Failed to load spell data: ${err.message}`;
      $("#load-error").hidden = false;
    }
  }

  function applyHash({ push }) {
    const h = hashToState();
    loadQueryString(h.q);
    const wanted = findVersion(h.v);
    if (wanted && (!state.version || wanted.id !== state.version.id)) {
      activateVersion(wanted, { push });
    } else {
      runSearch({ push });
    }
  }

  async function boot() {
    try {
      Object.assign(state.hiddenCols, JSON.parse(localStorage.getItem("epsilook.hiddenCols.v3") || "{}"));
    } catch (e) { /* corrupted storage — defaults apply */ }
    buildTabs();
    wireEvents();
    applyHiddenCols();
    try {
      state.versions = await Data.loadVersions();
    } catch (err) {
      $("#load-text").textContent = "";
      $("#load-error").textContent =
        `Failed to load data/versions.json: ${err.message}. ` +
        `If you opened index.html directly from disk, serve the folder over HTTP instead ` +
        `(e.g. "python -m http.server" in the docs folder).`;
      $("#load-error").hidden = false;
      return;
    }

    const sel = $("#version");
    for (const v of state.versions) {
      const opt = el("option", "", `${v.label} (${v.id})`);
      opt.value = v.id;
      sel.appendChild(opt);
    }
    $("#version-wrap").hidden = state.versions.length < 2;

    const h = hashToState();
    const entry = findVersion(h.v) || state.versions[state.versions.length - 1];
    loadQueryString(h.q);
    await activateVersion(entry);
    $("#q").focus();
  }

  boot();
})();
