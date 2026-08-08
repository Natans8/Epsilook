import {
    areaIsHit,
    camoIsHit,
    castTimeIsHit,
    channelIsHit,
    channeledIsHit,
    desatIsHit,
    dissolveIsHit,
    freezeIsHit,
    fxChainIsHit,
    ghostMatIsHit,
    glowIsHit,
    instantIsHit,
    keybindIsHit,
    morphIsHit,
    objectIsHit,
    scaleIsHit,
    screenIsHit,
    shadowyIsHit,
    shapeshiftIsHit,
    speedIsHit,
    summonIsHit,
    tintIsHit,
    tokensFor,
    transpIsHit,
    expansionIsHit,
    originIsHit,
    triggersIsHit,
    vehicleIsHit,
    isHitOf,
    wordIsNamed
} from "./hits";
import {ATTR_FLAGS} from "../pilltypes";
import {DELIVERY_BREAKS_ON_MOVE, DELIVERY_CHANNELLED, deliverySecs} from "../data";
import {setStatus} from "./run";
import type {DisplayRef, Expansion, SpellData, SpellLink} from "../data";
import {activeData, state, wowheadUrl} from "./state";
import {
    animSwapTag,
    animTag,
    areaTag,
    channelTag,
    colorFxTag,
    displayTag,
    dissolveTag,
    effectAttachNote,
    effectRegionName,
    fxHeadTag,
    fxTag,
    isDisplayCat,
    isItemCat,
    itemTag,
    keybindTag,
    kitTag,
    maskOf,
    mechanicPills,
    mechanicTag,
    modelCatHeadTag,
    modelTag,
    morphTag,
    mountTag,
    objectTag,
    percentFxTag,
    scaleTag,
    screenTag,
    shapeshiftTag,
    soundTag,
    speedTag,
    spellLinkTag,
    summonTag,
    travels,
    vehicleTag
} from "./tags";
import type {ModelCatEntry} from "./tags";
import * as P from "../pills";
import {CFG} from "../config";
import {$, $$, el, fillTemplate} from "../util";

/* --------------------------------------------------------- rendering */

export function renderResults(): void {
    const tbody = $("#results tbody");
    tbody.textContent = "";
    state.rendered = 0;
    renderMore();

    const total = state.results.length;
    const shown = state.display.length;
    // a purely negative query has no highlight tokens but is still a query
    const hasQuery = state.groups.length > 0;
    if (hasQuery) {
        const filtered = shown < total ? ` (${shown.toLocaleString()} after filters)` : "";
        setStatus(`${total.toLocaleString()} ${total === 1 ? "spell" : "spells"}${filtered} · ${state.searchMs.toFixed(0)} ms`);
    }
    $("#results").classList.toggle("empty", shown === 0);
    $("#empty-note").hidden = !(shown === 0 && hasQuery);
    $("#empty-state").hidden = hasQuery;
    updateSortHeaders();
}

export function renderMore(): void {
    const tbody = $("#results tbody");
    const start = state.rendered;
    const end = Math.min(state.rendered + CFG.scrollBatch, state.display.length);
    const frag = document.createDocumentFragment();
    for (let i = state.rendered; i < end; i++) frag.appendChild(buildRow(state.display[i], i));
    tbody.appendChild(frag);
    state.rendered = end;
    // the cells are in the DOM now, so their heights are known — collapse each
    // new row to the shared height budget (see the row-layout section)
    for (let i = start; i < end; i++) layoutRow(tbody.children[i] as HTMLElement);
    $("#sentinel").hidden = state.rendered >= state.display.length;
}

/* ------------------------------------------------- row layout (collapse)
   *
   * Every multi-value cell renders all its pills; here we hide whatever
   * overflows a shared HEIGHT budget behind one "+N more". The budget belongs
   * to the ROW: it starts at CFG.collapsedRowHeight and grows to fit any cell
   * the user has expanded (td.dataset.expanded), so expanding one column lets
   * the others reveal more to fill the now-taller row — progressively, until
   * everything shows. Expansion is one-way (until the next search). Because a
   * cell's content flows top-to-bottom in DOM order (inline pills wrap, kit
   * groups stack), leaf bottoms are monotonic, so a leading prefix is exactly
   * "what fits". */

/* One renderable unit of a cell: a loose pill, or a whole group (a head with
   * its items). `named` ranks it above the merely-matched (the query spelled its
   * category word — see hitsFirst). Whether it
   * holds a search hit is NOT a field — it is read off `el` by P.holdsHit, so a
   * block cannot claim one thing while its pills show another. `named` is the
   * second rank and is a real field, because "the query spelled this category
   * word" is not something the DOM records. */
interface CellBlock {
    named?: boolean;
    el: HTMLElement;
}

const COLLAPSE_COLS = ".c-models, .c-sounds, .c-animations, .c-fx, .c-mechanics";

/** A cell's content pills in DOM order (group heads are structural). */
function cellLeaves(td: HTMLElement): HTMLElement[] {
    return [...td.querySelectorAll<HTMLElement>(".tag")].filter((t) => !t.closest(".kit-head"));
}

/** Un-collapse a cell: show every pill/group, drop its "+N more". */
function revealCell(td: HTMLElement): void {
    for (const o of td.querySelectorAll(".overflow")) o.classList.remove("overflow");
    const more = td.querySelector(":scope > .more");
    if (more) more.remove();
}

/** Natural height (px) of a fully-revealed cell's content. */
function cellFullHeight(td: HTMLElement): number {
    const top = td.getBoundingClientRect().top;
    let bottom = top;
    for (const c of td.children) bottom = Math.max(bottom, c.getBoundingClientRect().bottom);
    return bottom - top;
}

/* Hide the pills that overflow `budget`, add a "+N more". The cell must be
   * revealed first (layoutRow does that). Always leaves at least one pill. */
function clampCell(td: HTMLElement, budget: number): void {
    const leaves = cellLeaves(td);
    if (!leaves.length) return;
    const top = td.getBoundingClientRect().top;
    const extent = (elm: Element) => elm.getBoundingClientRect().bottom - top;
    // largest leading run of pills whose bottoms fit the budget
    let shown = 1;
    for (let i = 0; i < leaves.length; i++) {
        if (extent(leaves[i]) <= budget) shown = i + 1; else break;
    }
    const apply = () => {
        leaves.forEach((lf, i) => lf.classList.toggle("overflow", i >= shown));
        // hide a whole group once every pill inside it is hidden (no empty head)
        for (const g of td.querySelectorAll(".kit-group")) {
            const gl = [...g.querySelectorAll(".tag")].filter((t) => !t.closest(".kit-head"));
            g.classList.toggle("overflow",
                gl.length > 0 && gl.every((x) => x.classList.contains("overflow")));
        }
    };
    apply();
    const more = el("button", "more");
    more.dataset.expand = "1";
    td.appendChild(more);
    const relabel = () => {
        more.textContent = `+${leaves.length - shown} more`;
    };
    relabel();
    // if the button itself spilled past the budget, drop pills until it fits —
    // stops the "+N more" from eating the very space it is supposed to save
    let guard = leaves.length;
    while (shown > 1 && extent(more) > budget && guard-- > 0) {
        shown--;
        apply();
        relabel();
    }
}

/* Collapse a row's cells to a shared height budget grown by any expanded
   * cell. Called on every freshly rendered row, on expand, and on resize. */
export function layoutRow(tr: HTMLElement): void {
    const cells = [...tr.querySelectorAll<HTMLElement>(COLLAPSE_COLS)];
    for (const td of cells) revealCell(td);            // one write pass, then reads
    let budget = CFG.collapsedRowHeight;
    const full = new Map<HTMLElement, number>();
    for (const td of cells) {
        const h = cellFullHeight(td);
        full.set(td, h);
        if (td.dataset.expanded === "1") budget = Math.max(budget, h);
    }
    for (const td of cells) {
        if (td.dataset.expanded === "1") continue;       // fully shown, no button
        if (full.get(td)! <= budget) continue;           // already fits
        clampCell(td, budget);
    }
}

/** ms as the number Wowhead prints: "2", "1.75", "1.8" — no trailing zeros.
 *  The rounding is data.ts's own, shared with the numeric search axis, so the
 *  number this line shows is exactly the one `mech:"casttime 1.75"` matches. */
const secs = (ms: number): string => String(deliverySecs(ms));

/**
 * The delivery line: how the spell is cast, in words, under its name.
 *
 * NOT A PILL, deliberately — delivery is inherent to every spell, "in the same
 * weight category as the spell name or ID" (the user), so it is identity rather
 * than payload and carries no content colour. See docs/PILLS.md.
 *
 * TWO SEGMENTS, because a spell can cast AND THEN channel — 3,148 on 9.2.7 do,
 * verified in game. The old three-way partition printed one and threw the other
 * number away.
 *
 * THE SLOT ORDER IS `<value> <label>` AND IT NEVER FLIPS (the user's rule), so
 * it is `unlimited channel`, never `channel, no limit` — and Wowhead's own
 * `Channeled (5 sec cast)` parenthetical is deliberately NOT copied, since it
 * puts the label first. The vocabulary is Wowhead's ("Match the wowhead
 * convention"); only the ordering is ours.
 *
 * EACH SEGMENT LIGHTS WHEN IT IS WHAT WAS ASKED FOR, through the pill registry's
 * own matcher (hits.ts) rather than a test re-derived here — so `mech:"casttime
 * >3"` golds the cast half of a cast-then-channel row and leaves the channel
 * half alone. It is the Name cell's existing highlight idiom, the one
 * `mark.hl` uses on the name itself two lines up, because a cell should not
 * have two ways of saying "this is your match". The one segment that cannot
 * light is `breaks on move`: no word selects it yet.
 */
function deliveryLine(spellId: number): HTMLElement {
    const d = activeData();
    const dl = d.spellDelivery.get(spellId);
    const line = el("div", "delivery");
    const seg = (value: string, label: string, hit = false) => {
        if (line.childElementCount) line.appendChild(el("span", "d-sep", "·"));
        const s = el("span", "d-seg");
        if (hit) s.classList.add("hit");
        if (value) {
            s.appendChild(el("span", "d-v", value));
            // a REAL space, not just the css margin: the line is selectable
            // text and "1.8 seccast" is what a copy would otherwise produce
            s.appendChild(document.createTextNode(" "));
        }
        s.appendChild(el("span", "d-l", label));
        line.appendChild(s);
    };
    // no row at all = neither a cast bar nor a channel. That is also how the
    // 1,846 spells with no SpellMisc row read, which is correct rather than a
    // fallback: nothing about them says otherwise.
    if (!dl) {
        seg("", "Instant", instantIsHit());
        return line;
    }
    if (dl.castMs > 0) seg(`${secs(dl.castMs)} sec`, "cast", castTimeIsHit(dl.castMs));
    if (dl.flags & DELIVERY_CHANNELLED) {
        // durMs -1 = runs until something stops it; 0 = the spell is flagged as
        // a channel but ships no duration row (674 on 9.2.7). Those two are NOT
        // folded together: one in-game test showed a no-duration channel doing
        // nothing at all, which is not what "unlimited" looks like, but it was
        // inconclusive — see docs/DECISIONS.md before merging them.
        //
        // All three key on durMs, so the hit follows whichever shape rendered:
        // `mech:"channeled unlimited"` golds the -1 line and only that one.
        const hit = channeledIsHit(dl.durMs);
        if (dl.durMs > 0) seg(`${secs(dl.durMs)} sec`, "channel", hit);
        else if (dl.durMs < 0) seg("", "unlimited channel", hit);
        else seg("", "channel", hit);
    }
    if (dl.flags & DELIVERY_BREAKS_ON_MOVE) seg("", "breaks on move");
    return line;
}

/** The expansion's inline art — a self-hosted file under site/, so it is a plain
 *  lazy <img> with nothing to decode and no request off-origin. Keyed by the
 *  `major` the pack ships, so nothing here knows which expansion is which. */
const eraArtSrc = (xp: Expansion): string => CFG.expansionArt?.[xp.major] ?? "";

function buildRow(spellId: number, displayIndex: number): HTMLTableRowElement {
    const d = activeData();
    const i = d.spellIndex.get(spellId)!;
    const tr = el("tr");

    // result index
    tr.appendChild(el("td", "c-idx", String(displayIndex + 1)));

    // ID — a pill whose label is the id and whose one note is the expansion that
    // introduced it, the same way an attachment point is a note on a model pill.
    // The expansion is provenance, not payload, so it is a SUB-TAG of the
    // identity rather than a line or a column of its own; the css keeps it out
    // of the resting page and shows it on row hover or when it is a hit.
    const eraIdx = d.spellEra.get(spellId);
    const xp = eraIdx === undefined ? null : d.expansions[eraIdx];
    const tdId = el("td", "c-id");
    tdId.appendChild(P.pill({
        cls: "spellid",
        segments: [
            // the expansion leads, so the ids stay a straight column to read down
            xp && P.imageOf("note", {src: eraArtSrc(xp), alt: xp.short}, {
                cls: "era",
                hit: expansionIsHit(xp.index),
                title: xp.caveat
                    ? `Added in ${xp.label} — ${xp.caveat}`
                    : `Added in ${xp.label}`,
                search: `id:${xp.key}`,
                finds: `spells added in ${xp.label}`,
            }),
            P.copy(String(spellId), `Copy spell ID ${spellId}`, String(spellId), "id-copy"),
        ],
    }));
    tr.appendChild(tdId);

    // Name — wowhead link (their widget adds the hover tooltip); the parts
    // matched by a name search are highlighted. The Epsilon command strip
    // rides under the name rather than in a column of its own: a command is
    // ABOUT the spell, and beside the name it can never be pushed off the
    // right edge by however many pills the visual columns happen to carry.
    const tdName = el("td", "c-name");
    const nameDiv = el("div", "spell-name");
    const nameLink = el("a", "spell-name-link");
    nameLink.href = wowheadUrl(CFG.wowheadSpellUrl, {id: spellId});
    nameLink.target = "_blank";
    nameLink.rel = "noopener";
    if (CFG.spellIconUrl && d.icons[i]) {
        const icon = el("img", "spell-icon");
        icon.src = fillTemplate(CFG.spellIconUrl, {icon: d.icons[i]});
        icon.alt = "";
        icon.loading = "lazy";
        icon.addEventListener("error", () => icon.remove(), {once: true});
        nameLink.appendChild(icon);
    }
    nameLink.appendChild(highlightMatches(d.names[i] || "(unnamed)"));
    nameDiv.appendChild(nameLink);
    tdName.appendChild(nameDiv);
    if (d.subtexts[i]) tdName.appendChild(el("div", "spell-sub", d.subtexts[i]));
    tdName.appendChild(deliveryLine(spellId));
    tdName.appendChild(commandStrip(spellId));
    tr.appendChild(tdName);

    // Effects — visual FX (beams, morphs, summons), grouped by category.
    // The same pass produces the Mechanics column's non-visual categories
    // (seat, invis, detect, keybind, speed), which used to live here — so it
    // stays ONE call feeding two cells, whatever order they end up in.
    const effects = effectCells(spellId);
    // Mechanics — one pill per SpellEffect (what it does + who it targets),
    // then the non-visual category blocks. Both go in as blocks so the cell
    // ranks them against each other (see mechanicsCell); an enum pill can
    // never be a "named" hit, since its corpus is enum names, not keywords.
    const mechBlocks: CellBlock[] = mechanicPills(d.spellMechanics.get(spellId) || [])
        .map((p) => ({el: mechanicTag(p)}));

    /* THE PAYLOAD CELLS ARE BUILT BY NAME AND APPENDED BY ORDER. Every cell is
     * built either way — they are the row's content, not a layout choice — so
     * this costs nothing and leaves `state.colOrder` as the single statement of
     * where each one goes, shared with the <th> row (events.ts applyColOrder).
     * The three leading columns (#, ID, Name) are fixed and stay above. */
    const cells: Record<string, HTMLElement> = {
        // grouped by how each model is used (attach/missile/area/...)
        models: modelsCell(spellId),
        // grouped by SoundKit; kits containing a match come first
        sounds: soundsCell(d.spellSounds.get(spellId) || []),
        // loose kit-played anims first, then AnimKits grouped with the
        // animations they play, then the headless groups (passenger, replace)
        animations: animationsCell(d.spellAnimKits.get(spellId) || [],
            d.spellVisualAnims.get(spellId) || [], spellId),
        fx: effects.fx,
        mechanics: mechanicsCell(mechBlocks.concat(effects.mechBlocks)),
    };
    for (const col of state.colOrder) tr.appendChild(cells[col]);

    return tr;
}

/**
 * The Epsilon command strip for one spell — a copy button per configured
 * command, then the Wowhead link. One nowrap line, so it sets the name
 * column's minimum width (see .c-name) instead of ever wrapping to two.
 */
function commandStrip(spellId: number): HTMLElement {
    const row = el("div", "cmd-row");
    for (const cmd of CFG.spellCommands) {
        const b = el("button", "cmd");
        b.type = "button";
        // The leading "." is Epsilon chat syntax, not decoration, so it is
        // its own span and carries the accent. That mark is what makes the
        // strip read as commands, which is what lets the buttons drop their
        // borders at rest. A label with no dot just renders plain.
        const dot = cmd.label.startsWith(".") ? "." : "";
        if (dot) b.appendChild(el("span", "cmd-dot", dot));
        b.appendChild(document.createTextNode(cmd.label.slice(dot.length)));
        b.title = `${cmd.hint} — ${fillTemplate(cmd.template, {id: spellId})}\nShift-click: copy wrapped in \`backticks\``;
        b.setAttribute("aria-label", `${cmd.hint} (${cmd.label})`);
        b.dataset.copy = fillTemplate(cmd.template, {id: spellId});
        row.appendChild(b);
    }
    // the same favicon link the pills use, on the row's command strip
    const wh = P.renderSegment(P.link(
        wowheadUrl(CFG.wowheadSpellUrl, {id: spellId}), "Open on Wowhead"));
    wh.classList.add("wh-cmd");
    row.appendChild(wh);
    return row;
}

/**
 * Highlight the query-matched parts of a spell name.
 */
function highlightMatches(name: string): DocumentFragment {
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

/**
 * Stable rank-partition of a cell's contents: things the query NAMED first,
 * then everything else it merely matched, then the rest. Original order is
 * kept inside each band, so a cell's deliberate layout survives.
 *
 * The middle band exists because a category word is also ordinary text.
 * `mech:speed` selects the spells with a movement-speed pill AND every spell
 * whose effect enum happens to read MOD_SPEED_SLOW_ALL — both are honest
 * hits, but only one is what was asked for, and burying it under a dozen
 * enum names (or clamping it away behind "+N more") reads as a bug. Same
 * story for `fx:glow` against a texture called beam_webglowwhite.
 *
 * `isKeyword` is optional: a cell whose contents carry no category word (the
 * sound kits) simply has no first band.
 */
function hitsFirst<T>(items: T[], isHit: (it: T) => boolean,
                      isKeyword: ((it: T) => boolean) | null = null): T[] {
    if (!state.tokens.length) return items;
    const named: T[] = [], hits: T[] = [], rest: T[] = [];
    for (const it of items) {
        if (!isHit(it)) rest.push(it);
        else (isKeyword && isKeyword(it) ? named : hits).push(it);
    }
    return named.concat(hits, rest);
}

function tagCell(className: string, tags: HTMLElement[]): HTMLElement {
    const td = el("td", className);
    if (tags.length === 0) {
        td.classList.add("empty");
        td.appendChild(el("span", "none", "—"));
        return td;
    }
    // render every tag; the height-based collapse happens after layout, in
    // layoutRow — see the "row layout" section below
    for (const tag of tags) td.appendChild(tag);
    return td;
}

/**
 * The Mechanics cell: loose SpellEffect pills, then the non-visual category
 * blocks built alongside the fx column (seat, invis, detect, keybind,
 * speed).
 *
 * The enum pills come FIRST because they describe the effect itself, and
 * the categories qualify it — but the two halves are ONE ranked list, not
 * two appended ones, because that resting order is exactly wrong under a
 * query that names a category. `mech:speed` matches the speed pill outright
 * and every SPELL_AURA_MOD_SPEED_* enum by substring; handing the enums the
 * whole top of the cell buries the pill that was asked for. renderBlocks
 * ranks them together, so a named category rises past them and an unnamed
 * one keeps its place below.
 *
 * The cell only reads as empty when neither half has anything — a spell
 * with a speed aura but no SpellEffect rows still shows the speed pill.
 */
function mechanicsCell(blocks: CellBlock[]): HTMLElement {
    const td = el("td", "c-mechanics");
    if (!blocks.length) {
        td.classList.add("empty");
        td.appendChild(el("span", "none", "—"));
        return td;
    }
    renderBlocks(td, blocks);
    return td;
}

/* Models cell: grouped by how each model is used — "attached" (to the
   * caster/target), "missile" (projectile), "area" (ground/area model),
   * "trail" (weapon trail), "barrage" (volley) — fx-cell conventions:
   * clickable heads searching model:<category>, pills inside. A stale
   * cached pack carries no categories: flat-list fallback. */
function modelsCell(spellId: number): HTMLElement {
    const d = activeData();
    const entries = d.spellModelCats.get(spellId);
    // mounts live outside the model graph (Mount.db2, keyed by display id),
    // so a spell can have mounts and no model rows at all — read them before
    // the no-categories fallback, which would otherwise drop them
    const mountIds = d.spellMounts.get(spellId) || [];
    if (!entries && !mountIds.length) {
        const pills = (d.spellModels.get(spellId) || []).map((fid) => modelTag(fid));
        return tagCell("c-models", hitsFirst(pills, P.holdsHit));
    }
    const td = el("td", "c-models");
    const byCat = new Map<number, ModelCatEntry[]>();
    for (const e of entries || []) {
        const arr = byCat.get(e.cat);
        if (arr) arr.push(e); else byCat.set(e.cat, [e]);
    }
    // a category with no word (attach models) has nothing a group head could
    // usefully say — which unit the model plays on is the target icon's job
    // now — so those render as loose pills, like the loose animation pills
    const loose: ModelCatEntry[] = [];
    const cats: { name: string; items: ModelCatEntry[] }[] = [];
    for (const c of [...byCat.keys()].sort((a, b) => a - b)) {
        const name = d.modelCatNames[c] || "";
        const items = byCat.get(c)!;
        if (!name) {
            loose.push(...items);
            continue;
        }
        cats.push({name, items});
    }
    // Loose (uncategorized attach) pills come first, then the category
    // groups — but renderBlocks floats whichever hold the search hit above
    // the rest, so a matched category is not stranded below a pile of
    // non-matching attach splits (nor clamped away behind "+N more").
    const blocks: CellBlock[] = [];
    for (const e of loose) {
        blocks.push({el: modelTag(e.fid, "", e.targets, e.src, e.dst, travels(e.cat), e.motion)});
    }
    for (const c of cats) {
        blocks.push(groupBlock({
            named: wordIsNamed("model", c.name),
            head: (hit) => modelCatHeadTag(c.name, hit),
            items: c.items.map((e) => (isDisplayCat(e.cat) ? displayTag(e, spellId)
                : isItemCat(e.cat) ? itemTag(e)
                    : modelTag(e.fid, c.name, e.targets, e.src, e.dst, travels(e.cat), e.motion))),
        }));
    }
    // mounts: their own group, keyed on display ids rather than model files.
    // No target icons — a mount is always the caster's own.
    if (mountIds.length) {
        blocks.push(groupBlock({
            named: wordIsNamed("model", "mount"),
            head: (hit) => modelCatHeadTag("mount", hit),
            items: mountIds.slice().sort((a, b) => a - b).map((m) => mountTag(m, spellId)),
        }));
    }
    renderBlocks(td, blocks);
    return td;
}

/* One cell showing each SoundKit with the sound files it contains. */
function soundsCell(soundEntries: { soundKitId: number; fid: number; targets: number }[]): HTMLElement {
    const td = el("td", "c-sounds");
    if (soundEntries.length === 0) {
        td.classList.add("empty");
        td.appendChild(el("span", "none", "—"));
        return td;
    }
    const byKit = new Map<number, number[]>(); // soundKitId -> [fid]
    const kitMask = new Map<number, number>(); // soundKitId -> union of its rows' target masks
    for (const e of soundEntries) {
        const arr = byKit.get(e.soundKitId);
        if (arr) arr.push(e.fid); else byKit.set(e.soundKitId, [e.fid]);
        kitMask.set(e.soundKitId, (kitMask.get(e.soundKitId) || 0) | (e.targets || 0));
    }

    // one block per SoundKit (numeric order); renderBlocks floats the hit
    // kits up. The icon rides the kit head — every file in a kit plays
    // together, so the whole kit shares one target type. The head lights
    // itself (kitTag asks kitIsHit), so nothing here declares a hit.
    renderBlocks(td, [...byKit.keys()].sort((a, b) => a - b).map((kitId) => groupBlock({
        head: () => kitTag(kitId, "soundkit", kitMask.get(kitId)),
        items: byKit.get(kitId)!.map((fid) => soundTag(fid)),
    })));
    return td;
}

/* Animations cell, in render order: loose pills for the animations the
   * spell's visual kits play directly (SpellVisualAnim — nothing to group
   * them under, joined by a vehicle's own anims), AnimKits grouped with the
   * animations they play, then the headless category groups — "passenger"
   * for what a rider plays in a vehicle seat (VehicleSeat), and "replace"
   * for the animations a spell swaps out. Those use the same anim pills,
   * with a category word where a kit id would head the group. Loose pills
   * never collapse (99%+ of spells have ≤3). */
/* Sentinel "kit ids" for animation groups that have no AnimKit to head
   * them: they head on a category word instead. Adding another headless
   * category is one entry here plus one in ANIM_CAT_TITLES — nothing below
   * branches on which group it is. */
const PASSENGER_GROUP = -2;
const ANIM_GROUPS: {
    id: number; word: string;
    animsOf(d: SpellData, s: number): number[] | undefined
}[] = [
    {id: PASSENGER_GROUP, word: "passenger", animsOf: (d, s) => d.spellPassengerAnims.get(s)},
];

function animationsCell(animKitIds: number[], looseAnimIds: number[],
                        spellId: number): HTMLElement {
    const groupAnims = new Map<number, number[]>();
    for (const g of ANIM_GROUPS) {
        const anims = g.animsOf(activeData(), spellId) || [];
        if (anims.length) groupAnims.set(g.id, anims);
    }
    // animation replacements (proc Type 7 + aura 312, merged). Their items
    // are PAIRS, not single anim ids, so they sit outside ANIM_GROUPS; the
    // build already unioned both sources and deduped, so this is a plain read.
    const swaps = activeData().spellReplaceAnims.get(spellId) || [];
    // Attribute flags that render here (anim:pose). They count toward the
    // emptiness test below: a spell whose ONLY animation fact is the flag is
    // exactly the case this feature exists for — before it, those rows looked
    // empty and were not.
    const animFlags = ATTR_FLAGS.filter(
        (f) => f.field === "anim" && f.draw
            && (activeData().spellAttrs.get(f.handler)?.has(spellId) ?? false));
    const td = el("td", "c-animations");
    if (animKitIds.length === 0 && groupAnims.size === 0
        && swaps.length === 0
        && animFlags.length === 0
        && looseAnimIds.length === 0) {
        td.classList.add("empty");
        td.appendChild(el("span", "none", "—"));
        return td;
    }
    const d = activeData();
    const looseMasks = d.visualAnimTargets.get(spellId);
    const animsOf = (kitId: number) =>
        groupAnims.get(kitId) || d.animKitAnims.get(kitId) || [];
    // a headless group's anims match through its category word too
    const wordOf = (kitId: number) =>
        (ANIM_GROUPS.find((g) => g.id === kitId) || {word: ""}).word;
    // Expand a kit's anims into pill ENTRIES: one per specific boneset region
    // an anim (segment) animates, so two regions are two pills (never merged),
    // and an anim with no region is its plain pill. Bonesets ride real
    // AnimKits only — a headless group (passenger) has none.
    const animEntries = (kitId: number) => {
        const bones = groupAnims.has(kitId) ? null : d.animKitAnimBoneset.get(kitId);
        const out: { animId: number; region: string | null }[] = [];
        for (const animId of animsOf(kitId).slice().sort((a, b) => a - b)) {
            const regions = bones && bones.get(animId);
            if (regions && regions.length) {
                for (const r of regions) out.push({animId, region: r});
            } else {
                out.push({animId, region: null});
            }
        }
        return out;
    };
    const groups = animKitIds.slice().sort((a, b) => a - b);
    for (const g of ANIM_GROUPS) if (groupAnims.has(g.id)) groups.push(g.id);

    // loose visual-anim pills first, then the kit / passenger groups
    // (replace follows below); renderBlocks floats whichever hold the hit
    // to the top.
    const blocks: CellBlock[] = [];
    for (const a of looseAnimIds.slice().sort((x, y) => x - y)) {
        blocks.push({el: animTag(a, "", looseMasks ? looseMasks.get(a) || 0 : 0)});
    }
    for (const kitId of groups) {
        blocks.push(groupBlock({
            named: wordIsNamed("anim", wordOf(kitId)),
            // a headless group's rows carry no target mask of their own, so its
            // head shows no icon and takes the derived hit; a real animkit's
            // head lights itself (kitTag asks kitIsHit) and carries its mask
            head: (hit) => (groupAnims.has(kitId)
                ? animCatHeadTag(wordOf(kitId), hit)
                : kitTag(kitId, "animkit", maskOf(d.animKitTargets, spellId, [kitId]))),
            items: animEntries(kitId).map((e) => animTag(e.animId, wordOf(kitId), 0,
                e.region ? [e.region] : null)),
        }));
    }
    if (swaps.length) {
        blocks.push(groupBlock({
            named: wordIsNamed("anim", "replace"),
            head: (hit) => animCatHeadTag("replace", hit),
            items: swaps.map((sw) => animSwapTag(sw.src, sw.dst)),
        }));
    }
    // valueless, so the category head IS the pill — the same shape freeze and
    // camo take in the fx column.
    for (const f of animFlags) {
        blocks.push({el: animCatHeadTag(f.word, isHitOf(f.key)())});
    }
    renderBlocks(td, blocks);
    return td;
}

/* Head of a headless animation group (passenger, replace) — a category word
   * like the model/fx heads: clicking searches the whole group via that word,
   * e.g. anim:replace. */

function animCatHeadTag(word: string, hit: boolean): HTMLElement {
    return P.pill({
        cls: "animkit", hit, segments: [
            P.label(word, {
                title: P.hintFor("anim", word),
                search: P.query("anim", word),
                finds: `all spells with a ${word} animation`,
            }),
        ]
    });
}

/* Shared group renderer: each kit is a small box — the kit tag as a
   * tinted head segment, its items flowing (and wrapping) beside it. Every
   * group and every item is rendered; the height-based clamp (layoutRow) hides
   * whatever overflows the row budget behind the cell's single "+N more".
   * Groups rendering ≤1 item for THIS row collapse to an inline pill — see
   * P.group, which decides that for every column alike. */

/* Render a cell's BLOCKS with search hits floated to the top.
   *
   * A block is one renderable unit of a cell — a loose pill, or a whole group
   * (a head with its items). Each carries whether it holds a hit and the
   * element to append. Under an active query the hit blocks come first (stable
   * partition via hitsFirst, so the deliberate order is otherwise untouched —
   * e.g. loose model pills still precede their category groups); with no query
   * nothing moves.
   *
   * Floating hits up is also what keeps them on screen: clampCell hides leaves
   * from the BOTTOM, so the pill you searched for stays visible instead of
   * disappearing behind "+N more". Every pill-bearing cell renders through here
   * so that one rule holds for all of them — the models, sounds, animations and
   * fx cells all build a `blocks` array and hand it over.
   *
   * `named` is the block's second rank: it was matched because the query spelled
   * its category word, not because some file name contained the same letters
   * (see hitsFirst). A block with no category word simply never sets it.
   *
   * WHETHER A BLOCK HOLDS A HIT IS READ OFF THE PILLS IT BUILT (P.holdsHit),
   * never re-derived here. Every pill and group head already sets its own `hit`
   * — including a segment's, which is the part a predicate beside the cell kept
   * missing — so the DOM is the one place both answers agree. */
function renderBlocks(td: HTMLElement, blocks: CellBlock[]): void {
    for (const b of hitsFirst(blocks, (x) => P.holdsHit(x.el), (x) => !!x.named)) {
        td.appendChild(b.el);
    }
}

/**
 * A group as a cell block, ranked and headed by the pills it actually built.
 *
 * Items are built BEFORE the head — hence `head` being a callback — because
 * both of the group's answers come from them: the items are ordered by which
 * hold a hit, and the head is told whether ANY of them does, so a lit pill
 * always sits inside a lit head. That is the whole reason this is one helper
 * instead of three lines at each call site; getting it right per column is what
 * the two attach/motion regressions were.
 *
 * `hit` is for a head that matches on its OWN account and cannot be derived
 * from items: an fx category with no entries at all, whose clickable head IS
 * the whole pill (freeze, camo). It ORs in rather than replacing.
 */
function groupBlock(spec: {
    items: HTMLElement[];
    head: (hit: boolean) => HTMLElement;
    hit?: boolean;
    named?: boolean;
}): CellBlock {
    const items = hitsFirst(spec.items, P.holdsHit);
    const hit = !!spec.hit || items.some((it) => P.holdsHit(it));
    return {named: spec.named, el: P.group({head: spec.head(hit), items})};
}

/* Effects cell: visual FX grouped by category — "chain" (beam/chain effects),
   * "dissolve" (dissolve effects), "glow" / "ghost" / "tint" (color-only
   * effects), "desaturate" / "transparency" (percent-only), "freeze" /
   * "camo" (valueless), "screen" (full-screen effects), "morph" (transform
   * auras) and "summon" (summon effects). Chain pills carry a tint dot per
   * texture. */
/**
 * Builds the Effects cell AND the pill half of the Mechanics cell.
 *
 * One function because the two columns share every piece of machinery a
 * category needs — target-icon splitting, hit-floating, the group shape —
 * and differ only in which column a category was declared for. Returns the
 * fx `<td>` plus the mech-side blocks for mechanicsCell to render after its
 * enum pills.
 */
function effectCells(spellId: number): { fx: HTMLElement; mechBlocks: CellBlock[] } {
    const d = activeData();
    const chainIds = d.spellFx.get(spellId) || [];
    const dissolveIds = d.spellDissolves.get(spellId) || [];
    const glowIds = d.spellGlows.get(spellId) || [];
    const shadowyIds = d.spellShadowies.get(spellId) || [];
    const ghostMatIds = d.spellGhostMats.get(spellId) || [];
    const tintIds = d.spellTints.get(spellId) || [];
    const desatPcts = d.spellDesaturates.get(spellId) || [];
    const transpPcts = d.spellTransps.get(spellId) || [];
    const hasFreeze = d.spellFreezes.has(spellId);
    const hasCamo = d.spellCamos.has(spellId);
    const screenIds = d.spellScreens.get(spellId) || [];
    const morphIds = d.spellMorphs.get(spellId) || [];
    const formIds = d.spellShapeshifts.get(spellId) || [];
    const summonEntries = d.spellSummons.get(spellId) || [];
    const objectIds = d.spellObjects.get(spellId) || [];
    const vehicleIds = d.spellVehicles.get(spellId) || [];
    const invisPills = (d.spellInvisTypes.get(spellId) || []).slice().sort((a, b) => a.type - b.type);
    const detectPills = (d.spellDetectTypes.get(spellId) || []).slice().sort((a, b) => a.type - b.type);
    const keybindIds = d.spellKeybinds.get(spellId) || [];
    const speedMods = d.spellSpeedMods.get(spellId) || [];
    const scaleMods = d.spellScaleMods.get(spellId) || [];
    const td = el("td", "c-fx");
    // No combined emptiness check up front: the categories below now feed
    // TWO columns, so "this spell has no content at all" is not the question
    // either cell is asking. Each is judged on its own blocks at the end —
    // a spell with only a speed aura has an empty fx cell and a populated
    // mechanics one, which the old single test could not express.
    const cats: {
        name: string; col: string; hit: boolean; mask: number;
        finds?: string; label?: string; items: (() => HTMLElement)[]
    }[] = [];
    /* Where a category's target icons go. One icon on the HEAD when every
 * row of the category agrees — the common case, and far less noisy than
 * repeating it on each pill. When they disagree, the head would have to
 * show a union that no individual row actually has (measured on 9.2.7:
 * 44 chain spells and 51 glow spells hit exactly that), so the icons
 * drop to the pills, which are the things that really carry a type. */
    const targetSplit = (masks: number[]) => {
        const first = masks.length ? masks[0] : 0;
        const uniform = masks.every((m) => m === first);
        return {
            /** the mask the category HEAD carries (0 = the head shows none) */
            head: uniform ? first : 0,
            /** a row's own mask, shown only when the head could not speak for it */
            pill: (mask: number) => (uniform ? 0 : mask),
        };
    };

    /**
     * Push one fx category onto `cats` in the shape every category shares:
     * the head-vs-pill icon split above, hit-floating, and the
     * {name, hit, mask, items} envelope the renderer at the end consumes.
     * A category with no rows pushes nothing, so callers need no `if`.
     *
     * Two levels are deliberately distinct, because most categories collapse
     * or expand between them:
     *   - SOURCE ROWS (`rows`) are what the spell actually has in this
     *     category. They decide the category's hit state and, through
     *     `targetSplit`, whether the target icon can ride the head.
     *   - ENTRIES are what become pills. `entries` maps rows to them: chain
     *     and glow DEDUPE (rows drawing the same texture become one pill and
     *     union their masks), morph and shapeshift EXPAND (one creature with
     *     three displays becomes three pills). Omit it when rows are pills.
     *
     * The row/entry slots are deliberately untyped (`any`): every category's
     * rows have a different shape, and each pushCat call site below is the
     * one place that knows its own — the same reason the pill-type registry's
     * id slot is untyped.
     */
    interface CatSpec {
        /** category word — the head label, and the key into the owning
         *  column's search vocabulary */
        name: string;
        /** which column renders it — "fx" (default) or "mech". The only
         *  thing that differs between the two. */
        col?: "fx" | "mech";
        /** what the HEAD's click finds, when "a <word> effect" does not read
         *  as English (the link words are verbs). Default: that phrase. */
        finds?: string;
        /** what the head PRINTS, when that differs from the word it searches.
         *  Only `location` uses it (it prints "only in"); see fxHeadTag. */
        label?: string;
        /** source rows (see above) */
        rows: any[];

        /** does a source row match the query */
        isHit(row: any): boolean;

        /** build one pill. Omitted only by valueless categories, whose head
         *  IS the whole pill and which therefore produce no entries for it
         *  to be called on. */
        render?(entry: any, mask: number): HTMLElement;

        /** a source row's target mask. Default: no icons anywhere — for
         *  categories with no target data. */
        mask?(row: any): number;

        /** rows -> pills. Default: identity. */
        entries?(rows: any[]): any[];

        /** Default: `isHit`, which is correct whenever entries and rows are
         *  the same thing. */
        /** Default: `mask`. */
        entryMask?(entry: any): number;

        /** which masks decide whether the icon can ride the head. Defaults to
         *  the source rows'. Override only where a row's own mask is not what
         *  a pill shows — `keybind` merges rows by label, so a merged pill
         *  carries their union. */
        headMasks?(rows: any[], entries: any[]): number[];
    }

    const pushCat = ({
                         name, rows, isHit, col = "fx", finds, label,
                         render = () => el("span"),
                         mask = () => 0,
                         entries = (rs) => rs,
                         entryMask = mask,
                         headMasks = (rs) => rs.map(mask),
                     }: CatSpec) => {
        if (!rows.length) return;
        const pills = entries(rows);
        const t = targetSplit(headMasks(rows, pills));
        // `hit` is the category's OWN match, kept because a valueless category
        // (freeze, camo) has no entries for groupBlock to derive one from — its
        // head IS the pill. Item order is not decided here: groupBlock ranks the
        // built pills by P.holdsHit, so each renderer's own hit is what counts.
        cats.push({
            name, col, finds, label,
            hit: rows.some(isHit),
            mask: t.head,
            items: pills.map((e) => () => render(e, t.pill(entryMask(e)))),
        });
    };

    const chainMask = (c: number) => maskOf(d.fxTargets, spellId, [c]);
    pushCat({
        name: "chain",
        rows: chainIds,
        mask: chainMask,
        isHit: (c) => fxChainIsHit(c),
        // one entry per distinct (texture, tint); untextured chains still show.
        // The drawing beam's attach points are part of the key, so one chain
        // drawn by two beams from different points stays two pills.
        entries: (ids) => {
            const byKey = new Map();
            const rows = (d.spellChainRows.get(spellId)
                || ids.map((c) => ({chain: c, src: -1, dst: -1})))
                .slice().sort((a, b) => a.chain - b.chain);
            for (const {chain: c, src, dst} of rows) {
                const color = (d.fxChains.get(c) || {}).color ?? 0xffffff;
                for (const fid of d.fxTextures.get(c) || [0]) {
                    const key = fid + ":" + color + ":" + src + ":" + dst;
                    const prev = byKey.get(key);
                    if (prev) {
                        prev.mask |= chainMask(c);
                        continue;
                    }
                    byKey.set(key, {chainId: c, fid, color, src, dst, mask: chainMask(c)});
                }
            }
            return [...byKey.values()];
        },
        entryMask: (e) => e.mask,
        render: (e, m) => fxTag(e, m),
    });

    const dissolveMask = (id: number) => maskOf(d.dissolveTargets, spellId, [id]);
    pushCat({
        name: "dissolve",
        rows: dissolveIds,
        mask: dissolveMask,
        isHit: (id) => dissolveIsHit(id),
        // one pill per distinct texture; textureless rows still show
        entries: (ids) => {
            const byKey = new Map();
            for (const id of ids.slice().sort((a, b) => a - b)) {
                for (const fid of d.dissolveTextures.get(id) || [0]) {
                    const prev = byKey.get(fid);
                    if (prev) {
                        prev.mask |= dissolveMask(id);
                        continue;
                    }
                    byKey.set(fid, {dissolveId: id, fid, mask: dissolveMask(id)});
                }
            }
            return [...byKey.values()];
        },
        entryMask: (e) => e.mask,
        render: (e, m) => dissolveTag(e, m),
    });

    const glowMask = (id: number) => maskOf(d.glowTargets, spellId, [id]);
    pushCat({
        name: "glow",
        rows: glowIds,
        mask: glowMask,
        isHit: (id) => glowIsHit(id),
        // one pill per distinct color (no texture — the color is the payload)
        entries: (ids) => {
            const byKey = new Map();
            for (const id of ids.slice().sort((a, b) => a - b)) {
                const color = d.glowColors.get(id) ?? 0;
                const prev = byKey.get(color);
                if (prev) {
                    prev.mask |= glowMask(id);
                    continue;
                }
                byKey.set(color, {
                    glowId: id, color, alpha: d.glowAlphas.get(id), mask: glowMask(id),
                });
            }
            return [...byKey.values()];
        },
        entryMask: (e) => e.mask,
        render: (e, m) => colorFxTag("glow", e.color, glowIsHit(e.glowId), e.alpha, m),
    });
    // "ghost" merges ShadowyEffect rows (two colors each) and Type-22 material
    // recolors (one color each). Its rows are tagged with which source they
    // came from, so one category can mix both; sorted and shadowy-first, since
    // the dedup below keeps the first row to claim a color.
    const ghostRows = [
        ...shadowyIds.slice().sort((a, b) => a - b).map((id) => ({id, mat: false})),
        ...ghostMatIds.slice().sort((a, b) => a - b).map((id) => ({id, mat: true})),
    ];
    pushCat({
        name: "ghost",
        rows: ghostRows,
        mask: (r) => maskOf(r.mat ? d.ghostMatTargets : d.shadowyTargets, spellId, [r.id]),
        isHit: (r) => (r.mat ? ghostMatIsHit : shadowyIsHit)(r.id),
        // one pill per distinct color; each pill carries its own isHit, because
        // which source a color came from decides how it matches the query
        entries: (rows) => {
            const byColor = new Map();
            for (const r of rows) {
                const rowMask = maskOf(r.mat ? d.ghostMatTargets : d.shadowyTargets,
                    spellId, [r.id]);
                // Type-22 material recolors carry one color and no attach point;
                // ShadowyEffect rows carry two colors and a body region
                const colors = r.mat
                    ? [d.ghostMatColors.get(r.id) ?? 0]
                    : (({primary, secondary}) => [primary, secondary])(
                        d.shadowyColors.get(r.id) || {primary: 0, secondary: 0});
                const region = r.mat ? "" : effectRegionName(d.shadowyAttach.get(r.id));
                const hit = () => (r.mat ? ghostMatIsHit : shadowyIsHit)(r.id);
                for (const color of colors) {
                    const prev = byColor.get(color);
                    if (prev) {
                        prev.mask |= rowMask;
                        if (region) prev.regions.add(region);
                        continue;
                    }
                    byColor.set(color, {
                        color, hit, mask: rowMask,
                        regions: new Set(region ? [region] : [])
                    });
                }
            }
            return [...byColor.values()];
        },
        entryMask: (e) => e.mask,
        render: (e, m) => colorFxTag("ghost", e.color, e.hit(), undefined, m,
            effectAttachNote([...e.regions], "ghost")),
    });

    pushCat({
        name: "tint",
        rows: tintIds,
        isHit: (id) => tintIsHit(id),
        // one pill per distinct color (no texture — the color is the payload)
        entries: (ids) => {
            const byColor = new Map();
            for (const id of ids.slice().sort((a, b) => a - b)) {
                const color = d.tintColors.get(id) ?? 0;
                if (!byColor.has(color)) byColor.set(color, {tintId: id, color});
            }
            return [...byColor.values()];
        },
        render: (e) => colorFxTag("tint", e.color, tintIsHit(e.tintId)),
    });

    // one pill per distinct percent — the strength is the whole payload.
    // (desaturate keys a computed grey swatch off it; transparency does not.)
    const uniqueSorted = (pcts: number[]) => [...new Set(pcts)].sort((a, b) => a - b);
    for (const [name, pcts, pctIsHit] of ([
        ["desaturate", desatPcts, desatIsHit],
        ["transparency", transpPcts, transpIsHit],
    ] as [string, number[], (p: number) => boolean][])) {
        pushCat({
            name,
            rows: pcts,
            isHit: pctIsHit,
            entries: uniqueSorted,
            render: (p) => percentFxTag(name, p, pctIsHit(p)),
        });
    }

    // valueless: the clickable category head IS the whole pill, so these have
    // one nominal row (to exist at all) and no entries
    for (const [name, present, isHit] of ([
        ["freeze", hasFreeze, freezeIsHit],
        ["camo", hasCamo, camoIsHit],
    ] as [string, boolean, () => boolean][])) {
        pushCat({
            name,
            rows: present ? [null] : [],
            isHit,
            entries: () => [],
        });
    }

    // Attribute flags in the mechanics column — the same valueless shape, read
    // from the registry's own list so a flag cannot be searchable and invisible.
    for (const f of ATTR_FLAGS) {
        // Both columns this function feeds. The flag's own `field` picks which,
        // so routing a flag by its SUBJECT (the user's rule) is a one-word edit
        // in the registry rather than a move between two render loops.
        if (f.field !== "mech" && f.field !== "fx") continue;
        // the delivery flags are searchable but never drawn here — the Name
        // cell's delivery line already states them, once
        if (!f.draw) continue;
        pushCat({
            name: f.word,
            col: f.field,
            rows: (d.spellAttrs.get(f.handler)?.has(spellId) ?? false) ? [null] : [],
            isHit: isHitOf(f.key),
            entries: () => [],
        });
    }

    const screenMask = (id: number) => maskOf(d.screenTargets, spellId, [id]);
    pushCat({
        name: "screen",
        rows: screenIds,
        mask: screenMask,
        isHit: (id) => screenIsHit(id),
        // one pill per ScreenEffect row, labeled with its internal name.
        // ImplicitTarget icon (pack format 25): usually the caster's own view
        entries: (ids) => ids.slice().sort((a, b) => a - b),
        render: (id, m) => screenTag(id, m),
    });
    // shapeshift and morph share a shape: one pill per (row, display), with a
    // single fallback pill for rows that have no display at all.
    const withDisplays = (displays: Map<number, DisplayRef[]>) => (ids: number[]) =>
        ids.slice().sort((a, b) => a - b)
            .flatMap((id) => (displays.get(id) || [{displayId: 0, fid: 0}])
                .map((e) => ({id, displayId: e.displayId, fid: e.fid})));

    const formMask = (f: number) => maskOf(d.shapeshiftTargets, spellId, [f]);
    pushCat({
        name: "shapeshift",
        rows: formIds,
        mask: formMask,
        isHit: (f) => shapeshiftIsHit(f),
        // a form with no display (Battle Stance, Shadowform, Stealth — 11 of
        // the 29 used forms) gets one name-only pill
        entries: withDisplays(d.shapeshiftDisplays),
        entryMask: (e) => formMask(e.id),
        render: (e, m) => shapeshiftTag({formId: e.id, displayId: e.displayId, fid: e.fid},
            m, spellId),
    });

    // who the morph lands on — the target for polymorph, the caster for
    // self-transforms (ImplicitTarget, pack format 25)
    const morphMask = (c: number) => maskOf(d.morphTargets, spellId, [c]);
    pushCat({
        name: "morph",
        rows: morphIds,
        mask: morphMask,
        isHit: (c) => morphIsHit(c),
        // creatures without TDB displays still get a single fallback pill
        entries: withDisplays(d.morphDisplays),
        entryMask: (e) => morphMask(e.id),
        render: (e, m) => morphTag({creatureId: e.id, displayId: e.displayId, fid: e.fid},
            m, spellId),
    });

    const summonMask = (e: { creatureId: number }) => maskOf(d.summonTargets, spellId, [e.creatureId]);
    pushCat({
        name: "summon",
        rows: summonEntries,
        mask: summonMask,
        isHit: (e) => summonIsHit(e.creatureId, e.control),
        // one pill per (creature, control) pair; ImplicitTarget icon shows where
        // the summon lands (usually a ground point → area)
        entries: (es) => es.slice().sort(
            (a, b) => (a.creatureId - b.creatureId) || (a.control - b.control)),
        render: (e, m) => summonTag(e, m),
    });

    const objMask = (o: number) => maskOf(d.objectTargets, spellId, [o]);
    pushCat({
        name: "object",
        rows: objectIds,
        mask: objMask,
        isHit: (o) => objectIsHit(o),
        // one pill per gameobject the spell places. Same shape as summon —
        // the ImplicitTarget icon says where it lands (usually a ground point)
        entries: (ids) => ids.slice().sort((a, b) => a - b),
        render: (o, m) => objectTag(o, m),
    });

    // one pill per SEAT, in SeatID order, labeled with its attachment point —
    // de-duped, because 38% of multi-seat vehicles put every seat on the same
    // attachment and would otherwise repeat one pill 8 times. The mask comes
    // from the SET_VEHICLE_ID aura's ImplicitTarget (pack format 25) — caster
    // when the caster becomes the vehicle, target when a unit is turned into
    // one. It is per-VEHICLE, not per-seat, so every pill in the category
    // carries the same union of the spell's vehicles rather than its own mask.
    const vehMask = (v: number) => maskOf(d.vehicleTargets, spellId, [v]);
    const seatCount = vehicleIds.reduce(
        (n, v) => Math.max(n, (d.vehicleSeats.get(v) || []).length), 0);
    pushCat({
        name: "seat", col: "mech",
        rows: vehicleIds,
        mask: vehMask,
        // a vehicle is "hit" through the attachment points of its seats
        isHit: (v) => (d.vehicleSeats.get(v) || []).some((p) => vehicleIsHit(p, seatCount)),
        entries: (vs) => [...new Set(vs.flatMap((v) => d.vehicleSeats.get(v) || []))],
        entryMask: () => vehicleIds.reduce((m, v) => m | vehMask(v), 0),
        render: (p, m) => vehicleTag(p, seatCount, m),
    });
    // invisibility / detection channels. Counterpart count = the other side of
    // the same type; it drives the pill label AND the numeric hit test.
    const channels: Array<[string, { type: number, mask: number }[], Map<number, number[]>]> = [
        ["invis", invisPills, d.detectTypeSpells],
        ["detect", detectPills, d.invisTypeSpells]];
    for (const [side, pills, countMap] of channels) {
        const countOf = (type: number) => (countMap.get(type) || []).length;
        pushCat({
            name: side, col: "mech",
            rows: pills,
            mask: (e) => e.mask,
            isHit: (e) => channelIsHit(side, e.type),
            render: (e, m) => channelTag(side, e.type, countOf(e.type), m),
        });
    }

    // keybound overrides: one pill per KEY the spell's aura overrides. Two
    // overrides on one spell can name the same key and differ only in the
    // replacement spell — which is not shown — so they would render as
    // duplicate pills; pills are keyed on what they actually display and their
    // masks union, the same de-duping vehicle seat attachments get.
    const kbMask = (o: number) => maskOf(d.keybindTargets, spellId, [o]);
    pushCat({
        name: "keybind", col: "mech",
        // an override with no keybind row displays nothing, so it is not a row
        rows: keybindIds.filter((o) => d.keybinds.has(o)),
        mask: kbMask,
        isHit: keybindIsHit,
        entries: (ids) => {
            const byLabel: Map<string, { label: string, fn: string, ids: number[], mask: number }> = new Map();
            for (const o of ids) {
                const row = d.keybinds.get(o)!; // rows filtered on d.keybinds.has
                const label = row.when ? `${row.fn} ${row.when}` : row.fn;
                const prev = byLabel.get(label);
                if (prev) {
                    prev.ids.push(o);
                    prev.mask |= kbMask(o);
                    continue;
                }
                byLabel.set(label, {label, fn: row.fn, ids: [o], mask: kbMask(o)});
            }
            return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
        },
        entryMask: (p) => p.mask,
        // a merged pill shows its members' union, so the union is what the head
        // has to agree with — see `headMasks` on pushCat
        headMasks: (_rows, pills) => pills.map((p) => p.mask),
        render: (p, m) => keybindTag(p, m),
    });

    // movement-speed modifiers: one pill per (movement, percent) the spell
    // sets. The pack has already collapsed the auras that share a movement,
    // so two pills here are two genuinely different statements.
    pushCat({
        name: "speed", col: "mech",
        rows: speedMods,
        mask: (p) => p.mask,
        isHit: (p) => speedIsHit(p.key),
        render: (p, m) => speedTag(p, m),
    });

    // object-scale modifiers: one pill per distinct percent, the three scale
    // auras having already collapsed into it in the pack
    pushCat({
        name: "scale",
        rows: scaleMods,
        mask: (p) => p.mask,
        isHit: (p) => scaleIsHit(p.pct),
        render: (p, m) => scaleTag(p, m),
    });

    // Spell -> spell links, one category per DIRECTION. Rows are already the
    // pills (data.ts merged a pair joined two ways into one entry). The mask is
    // the edge's own ImplicitTarget: a link IS a SpellEffect row, so it says who
    // the triggering effect is aimed at exactly like every category above (pack
    // format 36 — 0 on an older pack, which simply draws no icons).
    //
    // Sorted by name so a row with several links reads alphabetically rather
    // than in pack order; renderBlocks then floats the matched one anyway.
    const byName = (a: SpellLink, b: SpellLink) => {
        const i = d.spellIndex.get(a.spell), j = d.spellIndex.get(b.spell);
        return (i === undefined ? "" : d.names[i])
            .localeCompare(j === undefined ? "" : d.names[j]);
    };
    pushCat({
        name: "triggers", col: "mech",
        finds: "all spells that reach another spell",
        rows: (d.spellTriggers.get(spellId) || []).slice().sort(byName),
        mask: (l: SpellLink) => l.mask,
        isHit: (l: SpellLink) => triggersIsHit(l.spell),
        render: (l: SpellLink, m) => spellLinkTag(l, "triggers", m),
    });
    pushCat({
        name: "origin", col: "mech",
        finds: "all spells another spell reaches",
        rows: (d.spellOrigins.get(spellId) || []).slice().sort(byName),
        mask: (l: SpellLink) => l.mask,
        isHit: (l: SpellLink) => originIsHit(l.spell),
        render: (l: SpellLink, m) => spellLinkTag(l, "origin", m),
    });

    // The area gate — where the spell REFUSES to cast. A group like every
    // category here, which is what made the head carry the restriction: `P.group`
    // already collapses a one-item group inline, so the 65% of gated spells
    // naming a single area read `only in ( Suramar )` and the rest render a
    // strip, with no second renderer and no caller predicting which.
    //
    // No mask: a gate is a property of the SPELL, not of a target, so there are
    // no target icons to draw. Sorted by name — the pack ships area ids in
    // ascending order, which is not an order anyone reads in.
    // Two areas can share a NAME and a ROOT — Eye of Azshara is 7578 and 8373,
    // both rooted on 7578 with the same map — and such a pair renders byte for
    // byte the same pill: same label, same Wowhead href, same `.lo tele`. Drop
    // the repeat, keeping whichever variant carries a map so the button
    // survives. 818 of 39,807 rows on 9.2.7, across 508 spells.
    //
    // MERGING ON THE NAME ALONE WOULD BE WRONG, and it is tempting because it
    // is 7.5% rather than 2.1%. Same-named areas with DIFFERENT roots are
    // different places, not duplicates: `zone=7334` is the Azsuna zone and
    // `zone=8625` is the scenario "Turn Back the Tides: Azsuna" — both are real
    // Wowhead pages with different content (verified by hand). So a spell
    // legitimately shows `Azsuna · Azsuna`, and collapsing them would throw one
    // destination away. 230 of the 292 repeated names are this case.
    const areaRows: number[] = [];
    {
        const seen = new Map<string, number>(); // name+root -> index into areaRows
        for (const a of d.spellAreas.get(spellId) || []) {
            const key = (d.areaNames.get(a) || "") + "\u0000" + (d.areaRoots.get(a) || 0);
            const at = seen.get(key);
            if (at === undefined) {
                seen.set(key, areaRows.length);
                areaRows.push(a);
            } else if (!d.areaMapIds.has(areaRows[at]) && d.areaMapIds.has(a)) {
                areaRows[at] = a;
            }
        }
        // by name: the pack ships area ids ascending, which is not an order
        // anyone reads in. renderBlocks still floats the matched one above it.
        areaRows.sort((a, b) =>
            (d.areaNames.get(a) || "").localeCompare(d.areaNames.get(b) || ""));
    }
    pushCat({
        name: "location", col: "mech", label: "only in",
        finds: "all spells restricted to an area",
        rows: areaRows,
        isHit: (areaId: number) => areaIsHit(areaId),
        render: (areaId: number) => areaTag(areaId),
    });

    // one block per category, in the order pushed above; renderBlocks
    // floats the matched category to the top. The icon rides the category
    // head, unioned over this spell's rows in the category — only where the
    // distribution isn't degenerate (a category that is always the same type
    // says nothing per pill).
    //
    // `col` splits the categories between the two cells this builds. The
    // pushes above are one list on purpose: a category's SHAPE is the same
    // wherever it lands, so which column owns it is one field on the spec
    // rather than a second copy of this machinery.
    const blocksFor = (c: string) => cats.filter((cat) => cat.col === c).map((cat) => groupBlock({
        hit: cat.hit,
        named: wordIsNamed(c, cat.name),
        head: (hit) => fxHeadTag(cat.name, hit, cat.mask, cat.col, cat.finds, cat.label),
        items: cat.items.map((make) => make()),
    }));
    const fxBlocks = blocksFor("fx");
    if (fxBlocks.length) renderBlocks(td, fxBlocks);
    else {
        td.classList.add("empty");
        td.appendChild(el("span", "none", "—"));
    }
    return {fx: td, mechBlocks: blocksFor("mech")};
}

function updateSortHeaders(): void {
    for (const th of $$("th[data-sort]")) {
        const active = state.sort.key === th.dataset.sort;
        th.classList.toggle("sorted", active);
        th.setAttribute("aria-sort", active ? (state.sort.dir === 1 ? "ascending" : "descending") : "none");
        th.querySelector(".arrow")!.textContent = active ? (state.sort.dir === 1 ? "▲" : "▼") : "";
    }
}
