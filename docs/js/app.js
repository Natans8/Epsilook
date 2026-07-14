/* Epsilook UI: search bar, results table, tags, clipboard, infinite scroll. */
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
    mode: "all",
    query: "",
    results: [],        // spell ids matching the query
    display: [],        // results after filters + sort
    tokens: [],         // parsed tokens of the last search (for tag highlighting)
    searchMs: 0,
    rendered: 0,        // rows currently in the table
    filters: { models: false, sounds: false, animkits: false },
    sort: { key: "auto", dir: 1 },
  };

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

  /* ---------------------------------------------------------- URL hash */

  let suppressHashChange = false;

  function stateToHash(push) {
    const params = new URLSearchParams();
    if (state.version) params.set("v", state.version.id);
    if (state.mode !== "all") params.set("m", state.mode);
    if (state.query) params.set("q", state.query);
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
    return {
      v: params.get("v"),
      m: params.get("m") || "all",
      q: params.get("q") || "",
    };
  }

  /* ------------------------------------------------------------ search */

  function runSearch({ push = false } = {}) {
    const data = state.data;
    if (!data) return;
    const raw = state.query.trim();

    if (raw.length < CFG.minQueryLength) {
      state.results = [];
      state.tokens = [];
      state.searchMs = 0;
      applyFiltersAndSort();
      setStatus(raw.length ? `Type at least ${CFG.minQueryLength} characters` : "");
      stateToHash(push);
      return;
    }

    const res = Search.search(raw, state.mode, data);
    state.results = res.spellIds;
    state.tokens = res.tokens;
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
      const nameTokens = state.tokens.some((t) => t.field === "name" || t.field === "all");
      if (nameTokens && state.query) Search.sortByRelevance(list, stripPrefixes(state.query), state.data);
      else list.sort((a, b) => a - b);
    }

    state.display = list;
    renderResults();
  }

  // for relevance ranking, compare names against the unprefixed/name part of the query
  function stripPrefixes(raw) {
    return raw.replace(/\b[a-z]+:/gi, "").replace(/"/g, "").trim();
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
    if (state.query.trim().length >= CFG.minQueryLength) {
      const filtered = shown < total ? ` (${shown.toLocaleString()} after filters)` : "";
      setStatus(`${total.toLocaleString()} ${total === 1 ? "spell" : "spells"}${filtered} · ${state.searchMs.toFixed(0)} ms`);
    }
    $("#results").classList.toggle("empty", shown === 0);
    $("#empty-note").hidden = !(shown === 0 && state.query.trim().length >= CFG.minQueryLength);
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

    // Name — description shows in a styled tooltip on hover
    const tdName = el("td", "c-name");
    const nameDiv = el("div", "spell-name", d.names[i] || "(unnamed)");
    if (d.descriptions[i]) {
      nameDiv.classList.add("has-desc");
      nameDiv.dataset.desc = d.descriptions[i];
    }
    tdName.appendChild(nameDiv);
    if (d.subtexts[i]) tdName.appendChild(el("div", "spell-sub", d.subtexts[i]));
    tr.appendChild(tdName);

    // Models — matched files first
    const modelFids = hitsFirst(d.spellModels.get(spellId) || [],
      (fid) => fileIsHit(d.files.get(fid), "model"));
    tr.appendChild(tagCell("c-models", modelFids.map((fid) => modelTag(fid))));

    // Sounds (unique files) — matched files first
    const soundEntries = d.spellSounds.get(spellId) || [];
    const soundFids = hitsFirst([...new Set(soundEntries.map((e) => e.fid))],
      (fid) => fileIsHit(d.files.get(fid), "sound"));
    tr.appendChild(tagCell("c-sounds", soundFids.map((fid) => soundTag(fid))));

    // SoundKits (unique kits) — matched kits first
    const kitIds = hitsFirst(
      [...new Set(soundEntries.map((e) => e.soundKitId))].sort((a, b) => a - b),
      (k) => kitIsHit(k, "soundkit"));
    tr.appendChild(tagCell("c-soundkits", kitIds.map((k) => kitTag(k, "soundkit"))));

    // AnimKits — matched kits first
    const animIds = hitsFirst(
      (d.spellAnimKits.get(spellId) || []).slice().sort((a, b) => a - b),
      (k) => kitIsHit(k, "animkit"));
    tr.appendChild(tagCell("c-animkits", animIds.map((k) => kitTag(k, "animkit"))));

    // Commands
    const tdCmd = el("td", "c-cmds");
    for (const cmd of CFG.spellCommands) {
      const b = el("button", "cmd", cmd.label);
      b.title = `${cmd.hint} — ${fillTemplate(cmd.template, { id: spellId })}`;
      b.dataset.copy = fillTemplate(cmd.template, { id: spellId });
      tdCmd.appendChild(b);
    }
    tdCmd.appendChild(wowheadLink(fillTemplate(CFG.wowheadSpellUrl, { id: spellId }), "Open on Wowhead"));
    tr.appendChild(tdCmd);

    return tr;
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

  function tagCell(className, tags) {
    const td = el("td", className);
    if (tags.length === 0) {
      td.appendChild(el("span", "none", "—"));
      return td;
    }
    const limit = CFG.tagsCollapsedLimit;
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

  function tokensFor(field) {
    return state.tokens.filter((t) => t.field === field || t.field === "all");
  }

  function fileIsHit(file, field) {
    if (!file) return false;
    const tokens = tokensFor(field);
    if (!tokens.length) return false;
    return tokens.every((t) =>
      t.exact ? (file.searchL === t.text || file.base.toLowerCase() === t.text)
              : file.searchL.includes(t.text));
  }

  function kitIsHit(kitId, field) {
    return tokensFor(field).some((t) => Number(t.text) === kitId);
  }

  function modelTag(fid) {
    const d = state.data;
    const file = d.files.get(fid) || { fid, path: "", base: "", searchL: "" };
    const label = file.base || `file #${fid}`;
    const tag = el("span", "tag model");
    if (fileIsHit(file, "model")) tag.classList.add("hit");

    const txt = el("button", "tag-label", label);
    txt.title = `${file.path || "(name unknown)"}\nFileDataID ${fid}\nClick: find spells using this model`;
    txt.dataset.search = file.path ? `model:"${file.path}"` : "";
    tag.appendChild(txt);

    const noExt = file.base.replace(/\.[^.]+$/, "");
    const copy = el("button", "tag-copy", "⧉");
    copy.title = fillTemplate(CFG.modelCopyTemplate, { base: noExt, file: file.base, path: file.path, fid });
    copy.dataset.copy = copy.title;
    tag.appendChild(copy);
    return tag;
  }

  function soundTag(fid) {
    const d = state.data;
    const file = d.files.get(fid) || { fid, path: "", base: "", searchL: "" };
    const label = file.base || `file #${fid}`;
    const tag = el("span", "tag sound");
    if (fileIsHit(file, "sound")) tag.classList.add("hit");

    const txt = el("button", "tag-label", label);
    txt.title = `${file.path || "(name unknown)"}\nFileDataID ${fid}\nClick: find spells using this sound`;
    txt.dataset.search = file.path ? `sound:"${file.path}"` : "";
    tag.appendChild(txt);
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

    const tpl = field === "soundkit" ? CFG.soundKitCopyTemplate : CFG.animKitCopyTemplate;
    const copy = el("button", "tag-copy", "⧉");
    copy.title = `Copy:  ${fillTemplate(tpl, { id: kitId })}`;
    copy.dataset.copy = fillTemplate(tpl, { id: kitId });
    tag.appendChild(copy);

    if (field === "soundkit") {
      tag.appendChild(wowheadLink(fillTemplate(CFG.wowheadSoundUrl, { id: kitId }), `SoundKit ${kitId} on Wowhead`));
    }
    return tag;
  }

  /* ----------------------------------------------------------- tooltip */

  function showTooltip(anchor) {
    const tip = $("#tooltip");
    tip.textContent = anchor.dataset.desc;
    tip.hidden = false;
    const r = anchor.getBoundingClientRect();
    tip.style.left = Math.min(r.left, window.innerWidth - tip.offsetWidth - 12) + "px";
    if (r.bottom + tip.offsetHeight + 10 < window.innerHeight) {
      tip.style.top = r.bottom + 6 + "px";
    } else {
      tip.style.top = Math.max(6, r.top - tip.offsetHeight - 6) + "px";
    }
  }

  function hideTooltip() {
    $("#tooltip").hidden = true;
  }

  /* ------------------------------------------------------------ export */

  function exportRows() {
    const d = state.data;
    const pathOf = (fid) => (d.files.get(fid) || {}).path || `#${fid}`;
    return state.display.map((id) => {
      const i = d.spellIndex.get(id);
      const sounds = d.spellSounds.get(id) || [];
      return {
        id,
        name: d.names[i],
        subtext: d.subtexts[i],
        models: (d.spellModels.get(id) || []).map(pathOf),
        sounds: [...new Set(sounds.map((e) => e.fid))].map(pathOf),
        soundKits: [...new Set(sounds.map((e) => e.soundKitId))].sort((a, b) => a - b),
        animKits: (d.spellAnimKits.get(id) || []).slice().sort((a, b) => a - b),
      };
    });
  }

  function exportFilename(ext) {
    const q = state.query.trim().replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "results";
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
    const esc = (v) => {
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = ["ID,Name,Subtext,Models,Sounds,SoundKits,AnimKits"];
    for (const r of exportRows()) {
      lines.push([
        r.id, esc(r.name), esc(r.subtext),
        esc(r.models.join("; ")), esc(r.sounds.join("; ")),
        esc(r.soundKits.join("; ")), esc(r.animKits.join("; ")),
      ].join(","));
    }
    downloadFile(exportFilename("csv"), "text/csv", lines.join("\r\n"));
  }

  function exportJson() {
    if (nothingToExport()) return;
    const payload = {
      app: "Epsilook",
      url: location.href,
      gameVersion: state.version.id,
      query: state.query.trim(),
      mode: state.mode,
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
    let text = `**Epsilook** — ${rows.length.toLocaleString()} ${rows.length === 1 ? "spell" : "spells"} for \`${state.query.trim()}\`\n`;
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

  /* ------------------------------------------------------------ events */

  function crossSearch(query) {
    state.query = query;
    state.mode = "all";
    $("#q").value = query;
    updateTabs();
    runSearch({ push: true });
    window.scrollTo({ top: 0 });
  }

  function wireEvents() {
    const input = $("#q");
    let debounce = null;
    input.addEventListener("input", () => {
      state.query = input.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => runSearch(), CFG.searchDebounceMs);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        clearTimeout(debounce);
        state.query = input.value;
        runSearch({ push: true });
      }
    });

    // mode tabs
    $("#tabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      state.mode = btn.dataset.mode;
      updateTabs();
      runSearch({ push: true });
      input.focus();
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

    // spell description tooltip
    $("#results").addEventListener("mouseover", (e) => {
      const n = e.target.closest(".spell-name.has-desc");
      if (n) showTooltip(n);
    });
    $("#results").addEventListener("mouseout", (e) => {
      if (e.target.closest(".spell-name.has-desc")) hideTooltip();
    });
    document.addEventListener("scroll", hideTooltip, { passive: true });

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
      btn.classList.toggle("active", btn.dataset.mode === state.mode);
    }
    $("#q").placeholder = Search.FIELDS[state.mode].placeholder;
  }

  /* ------------------------------------------------------------- boot */

  function buildTabs() {
    const tabs = $("#tabs");
    for (const [id, field] of Object.entries(Search.FIELDS)) {
      if (!field.tab) continue;
      const b = el("button", id === state.mode ? "active" : "", field.label);
      b.dataset.mode = id;
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
        `${entry.label} (${entry.id}) · listfile ${state.data.meta.listfileTag} · built ${state.data.meta.built} · ` +
        `${state.data.meta.counts.spells.toLocaleString()} spells`;
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
    state.mode = Search.FIELDS[h.m] ? h.m : "all";
    state.query = h.q;
    $("#q").value = h.q;
    updateTabs();
    const wanted = state.versions.find((v) => v.id === h.v);
    if (wanted && (!state.version || wanted.id !== state.version.id)) {
      activateVersion(wanted, { push });
    } else {
      runSearch({ push });
    }
  }

  async function boot() {
    buildTabs();
    wireEvents();
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
    const entry = state.versions.find((v) => v.id === h.v) || state.versions[state.versions.length - 1];
    state.mode = Search.FIELDS[h.m] ? h.m : "all";
    state.query = h.q;
    $("#q").value = h.q;
    updateTabs();
    await activateVersion(entry);
    $("#q").focus();
  }

  boot();
})();
