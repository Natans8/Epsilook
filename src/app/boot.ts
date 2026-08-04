import {renderBar} from "./bar";
import {applyHiddenCols, wireEvents} from "./events";
import {decorateExamples} from "./highlight";
import {loadQueryString} from "./query";
import {runSearch} from "./run";
import {toast, copyText} from "./clipboard";
import {maskOf, targetWordsOf, NO_SCREEN_COLORS} from "./tags";
import {activeData, qInput, state, versionLabel} from "./state";
import {initTooltips} from "./tooltip";
import {defaultVersion, filtersFromUrl, findVersion, setHelp, sortFromUrl, stateToUrl, urlToState} from "./url";
import * as Data from "../data";
import type {VersionEntry} from "../data";
import * as Export from "../export";
import * as Search from "../search";
import * as Texture from "../texture";
import * as Theme from "../theme";
import {CFG} from "../config";
import {$, el} from "../util";

/* ------------------------------------------------------------- boot */

function buildTabs() {
    const tabs = $("#tabs");
    for (const [id, field] of Object.entries(Search.FIELDS)) {
        if (!field.tab) continue;
        // split pill: "+ Label" includes, the "−" half excludes
        const wrap = el("span", "tab");
        wrap.dataset.field = id;
        const inc = el("button", "tab-inc", `${field.label}`);
        inc.dataset.field = id;
        inc.title = `Add a ${id}: tag — ${field.hint}`;
        const exc = el("button", "tab-exc", "−");
        exc.dataset.field = id;
        exc.dataset.not = "1";
        exc.title = `Exclude ${id}: matches (-${id}:)`;
        wrap.append(inc, exc);
        tabs.appendChild(wrap);
    }
}

/**
 * Point the version dropdown at the active pack.
 *
 * A hidden pack has no option until it is activated — whoever passed its
 * ?v= has asked for it by name, and a select left showing a blank value
 * would just be lying about what is loaded.
 */
function showVersionOption(entry: VersionEntry) {
    const sel = ($("#version") as HTMLSelectElement);
    if (![...sel.options].some((o) => o.value === entry.id)) {
        const opt = el("option", "", versionLabel(entry));
        opt.value = entry.id;
        sel.appendChild(opt);
    }
    sel.value = entry.id;
    $("#version-wrap").hidden = sel.options.length < 2;
}

/**
 * Show the active version's expansion logo beside the selector.
 *
 * The art is a game texture, so it comes from the same version-pinned CASC
 * API (and the same in-browser BLP decoder) the texture previews use — one
 * small image per version switch. Anything unknown or unfetchable just
 * leaves the slot empty rather than showing a broken image.
 */
async function showVersionLogo(entry: VersionEntry) {
    const slot = $("#version-logo");
    if (!slot) return;
    const major = Number(entry.id.split(".")[0]);
    const logo = CFG.expansionLogos && CFG.expansionLogos[major];
    slot.replaceChildren();
    slot.title = "";
    if (!logo) return;
    const canvas = await Texture.load(logo.fid);
    // a slow fetch can land after the user has switched again
    if (!canvas || state.version !== entry) return;
    canvas.style.height = CFG.expansionLogoHeight + "px";
    canvas.style.width = "auto";
    slot.title = logo.name;
    slot.replaceChildren(canvas);
}

export async function activateVersion(entry: VersionEntry, {push = false} = {}): Promise<void> {
    const overlay = $("#loading");
    const loadText = $("#load-text");
    const loadError = $("#load-error");
    overlay.hidden = false;
    loadError.hidden = true;
    try {
        const pack = await Data.loadPack(entry, (got, total) => {
            const pct = total ? Math.round((got / total) * 100) : 0;
            $("#load-bar").style.width = pct + "%";
            loadText.textContent = total
                ? `Downloading spell data… ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
                : `Downloading spell data… ${(got / 1048576).toFixed(1)} MB`;
        });
        loadText.textContent = "Building search indexes…";
        await new Promise((r) => setTimeout(r)); // let the text paint
        state.data = Data.buildIndexes(pack);
        state.version = entry;
        showVersionOption(entry);
        void showVersionLogo(entry);  // fire-and-forget: failure just hides it
        $("#meta-info").textContent =
            `${entry.label} (${entry.id}) · Listfile ${state.data.meta.listfileTag} · Built ${state.data.meta.built} · ` +
            `${state.data.meta.counts.spells.toLocaleString()} spells`;
        $("#es-count").textContent = state.data.meta.counts.spells.toLocaleString();
        overlay.hidden = true;
        // the bar's marking is a property of the PACK — a word only
        // highlights where the loaded version carries that content — and the
        // bar was drawn from the URL before any of this existed. Repaint it
        // here rather than at the ten call sites that can change the pack.
        renderBar();
        decorateExamples();
        runSearch({push});
    } catch (err) {
        console.error(err);
        loadText.textContent = "";
        loadError.textContent = `Failed to load spell data: ${err instanceof Error ? err.message : err}`;
        loadError.hidden = false;
    }
}

export function applyUrl({push}: { push: boolean }): void {
    const h = urlToState();
    loadQueryString(h.q);
    filtersFromUrl(h.only, h.without);
    sortFromUrl(h.sort);
    setHelp(!!h.help, false); // back/forward opens and closes it too
    // no v= in the URL means the default version, not "keep the current
    // one" — back/forward must return from an explicitly-chosen pack
    const wanted = findVersion(h.v) || defaultVersion();
    if (wanted && (!state.version || wanted.id !== state.version.id)) {
        // fire-and-forget: activateVersion reports its own load failures
        void activateVersion(wanted, {push});
    } else {
        runSearch({push});
    }
}

async function boot() {
    // hand the leaf modules what app.js owns, before anything can call them.
    // versionId is a getter, not a value — the active pack changes underneath.
    Texture.init({versionId: () => state.version?.id ?? ""});
    // a live read-only view: the export contract wants a loaded pack, which
    // the getters assert per read instead of freezing a snapshot at boot
    Export.init({
        state: {
            get data() {
                return activeData();
            },
            get hiddenCols() {
                return state.hiddenCols;
            },
            get display() {
                return state.display;
            },
            get lastQuery() {
                return state.lastQuery;
            },
            get version() {
                return state.version ?? {id: ""};
            },
        },
        targetWordsOf, maskOf, toast, copyText, NO_SCREEN_COLORS,
    });
    // owns no app state — it only needs to run before the header is seen
    Theme.init();
    try {
        // Take only keys we still have a column for. A retired column
        // (Commands) otherwise survives in a returning user's storage and
        // toggles a `hide-*` class that no longer matches anything — and
        // reading through the defaults keeps the storage key stable, so
        // retiring a column costs nobody their other column choices.
        const saved = JSON.parse(localStorage.getItem("epsilook.hiddenCols.v5") || "{}");
        for (const col of Object.keys(state.hiddenCols)) {
            if (typeof saved[col] === "boolean") state.hiddenCols[col] = saved[col];
        }
    } catch { /* corrupted storage — defaults apply */
    }
    buildTabs();
    wireEvents();
    Texture.initHoverPreview();
    // delegated from the document, so it covers markup that does not exist yet
    initTooltips();
    applyHiddenCols();
    try {
        state.versions = await Data.loadVersions();
    } catch (err) {
        const loadError = $("#load-error");
        $("#load-text").textContent = "";
        loadError.textContent =
            `Failed to load data/versions.json: ${err instanceof Error ? err.message : err}. ` +
            `If you opened index.html directly from disk, serve the folder over HTTP instead ` +
            `(e.g. "python -m http.server" in the site folder).`;
        loadError.hidden = false;
        return;
    }

    const sel = ($("#version") as HTMLSelectElement);
    for (const v of state.versions) {
        if (v.hidden) continue;  // URL-only pack: activateVersion adds it if asked for
        const opt = el("option", "", versionLabel(v));
        opt.value = v.id;
        sel.appendChild(opt);
    }
    $("#version-wrap").hidden = sel.options.length < 2;

    const h = urlToState();
    // ?export=json|csv downloads the query's results as soon as they're
    // ready. Read it before activateVersion — the first search rewrites the
    // URL (stateToUrl keeps only v/q), so refresh/back won't re-download.
    const autoExport = (new URLSearchParams(location.search).get("export") || "").toLowerCase();
    const entry = findVersion(h.v) || defaultVersion();
    loadQueryString(h.q);
    filtersFromUrl(h.only, h.without);
    sortFromUrl(h.sort);
    if (!entry) return; // an empty manifest has nothing to load
    await activateVersion(entry);
    if (autoExport === "json") Export.json();
    else if (autoExport === "csv") Export.csv();
    // after the pack, so the examples inside it are drawn with a vocabulary.
    // The first search has already rewritten the URL by now (and dropped the
    // flag, the dialog not being open yet), so put it back.
    if (h.help) {
        setHelp(true, false);
        stateToUrl(false);
    } else qInput.focus();
}

void boot(); // nothing to await it — boot renders its own load errors
