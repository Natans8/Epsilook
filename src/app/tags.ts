import {
    animIsHit,
    anyGroup,
    areaIsHit,
    channelIsHit,
    dissolveIsHit,
    fileIsHit,
    fxChainIsHit,
    keybindIsHit,
    kitIsHit,
    kitNameIsHit,
    mechanicIsHit,
    morphIsHit,
    mountIsHit,
    objectIsHit,
    replaceAnimHit,
    scaleIsHit,
    screenIsHit,
    shapeshiftIsHit,
    speedIsHit,
    summonIsHit,
    originIsHit,
    triggersIsHit,
    vehicleIsHit
} from "./hits";
import type {FileEntry, MechanicRow, ScreenColors, SpellLink} from "../data";
import {activeData, stripExt, wowheadUrl} from "./state";
import type {Segment, SegmentOpts} from "../pills";
import * as P from "../pills";
import * as PR from "./pillrender";
import * as Search from "../search";
import {CFG} from "../config";
import {fillTemplate, hexColor} from "../util";
/* --- target-type icons ------------------------------------------------
   *
   * Who a piece of content plays on, from SpellVisualEvent.TargetType (see
   * TARGET_BITS in build_data.py). The bit vocabulary and the glyphs live in
   * pills.js (P.targets(mask) is the segment); only the two things that need
   * the loaded pack — the export words and the group-mask union — are here.
   */
const {
    TARGET_CASTER, TARGET_TARGET, TARGET_AREA,
    TARGET_NOT_CASTER, TARGET_MISSILE_DEST
} = P;

/**
 * A mask's search words, deduped and in bit order — what the exports say
 * instead of drawing icons. Reads the pack's own bit -> word map, so the
 * two never drift apart.
 */
export function targetWordsOf(mask: number): string[] {
    const names = activeData().targetNames;
    const words: string[] = [];
    for (const bit of [TARGET_CASTER, TARGET_TARGET, TARGET_AREA,
        TARGET_NOT_CASTER, TARGET_MISSILE_DEST]) {
        const w = names[bit];
        if ((mask & bit) && w && !words.includes(w)) words.push(w);
    }
    return words;
}

/** Union the target masks of a spell's rows for one group of item ids. */
export function maskOf(index: Map<number, Map<number, number>>, spellId: number,
                       itemIds: number[]): number {
    const byItem = index.get(spellId);
    if (!byItem) return 0;
    let mask = 0;
    for (const id of itemIds) mask |= byItem.get(id) || 0;
    return mask;
}

/* Model-category head ("missile", "area", ...) — the fx-head pattern:
   * clicking searches the whole category via the model field. */

export function modelCatHeadTag(category: string, hit: boolean): HTMLElement {
    return PR.pill({
        cls: "model-head", hit, segments: [
            P.label(category, {
                title: P.hintFor("model", category),
                search: P.query("model", category),
                finds: `all spells with a ${category} model`,
            }),
        ]
    });
}

// model pills can be hit through their usage-category word too —
// model:"attached backpack01" lights that attached pill (and its group
// head, via the group hit). Mirrors spellsByModel's token test.
function modelFileIsHit(file: FileEntry | undefined, catName: string): boolean {
    const searchL = file ? file.searchL : "";
    return anyGroup("model", (ts) =>
        ts.every((t) => catName.includes(t.text) || searchL.includes(t.text)));
}

/**
 * The file behind a pill, with the fallback every one of them needs.
 *
 * Every pill that shows a file asks the same things of it — the path for
 * the tooltip, the base name, and the base without its extension for the
 * label and the `.lookup` command — and every one has to survive a fid the
 * listfile does not know, or no fid at all (0 where the slot is optional).
 * A NEGATIVE fid is a real lookup, not a miss: the fileless model sentinels
 * ship their slot name as the path, which is what lets them label and search
 * themselves through the ordinary filename route.
 *
 * This was written out nine times in two slightly different shapes, which is
 * how `searchL` came to be present in some of them and absent from others.
 * The result is a whole FileEntry, so it can go straight to fileIsHit /
 * modelFileIsHit: an unknown file has an empty corpus and so matches no
 * token, which is the same answer `undefined` gets there.
 */
function fileOf(fid: number): FileEntry & { name: string } {
    const file = fid ? activeData().files.get(fid) : undefined;
    const base = file?.base || "";
    return {
        fid,
        path: file?.path || "",
        base,
        name: base ? stripExt(base) : "",
        searchL: file?.searchL || "",
        gob: file?.gob || 0,
    };
}

/**
 * Where on the model a row plays, as a clickable pill segment.
 *
 * Two shapes, and they must not be confused. Attached models are a
 * SINGLE-point route — `dst` is unused by construction — and render the
 * bare point ("Chest"). Missiles and beams genuinely span two points and
 * render "Source → Dest"; when only one end is known they say "from X" /
 * "to Y" rather than leaving an arrow pointing at nothing. `twoPoint` is
 * what tells them apart, since "src set, dst unset" looks identical in the
 * data either way.
 *
 * These are raw M2 attachment slots, so the names are the game's own and
 * can read oddly — the tooltip says as much. Returns null when nothing is
 * set, the common case (34% of model rows on 9.2.7).
 * `field` is the search field to emit ("model" / "fx"); `twoPoint` is true
 * for routes that travel (missiles, beams). */
/* Model categories whose rows TRAVEL between two attachment points, rather
   * than sitting at one. Only missiles do today; if another travelling route
   * is ever added, naming it here is the whole change. Matched by category
   * word so it survives the numeric ids shifting. */
const TRAVELLING_MODEL_CATS = new Set(["missile"]);

export const travels = (cat: number): boolean =>
    TRAVELLING_MODEL_CATS.has((activeData().modelCatNames || {})[cat] || "");

/* The one model category resolved from a CreatureDisplayID rather than a
   * FileDataID: its pills carry the displayId and render morph-style (Wowhead
   * model viewer, copy displayId, .morph, .lo) instead of the plain model
   * treatment. Matched by category word so it survives the numeric id shifting,
   * same rule as TRAVELLING_MODEL_CATS. */
const MODEL_CAT_DISPLAY_WORD = "display";
// the category resolved from an Item::ID (SpellVisualEffectName Type 1): its
// pills render item-style (Wowhead item page, item icon, quality-coloured
// name, .add / .lo) instead of the plain model treatment. Same match-by-word
// rule as the display category.
const MODEL_CAT_ITEM_WORD = "item";

export const isDisplayCat = (cat: number): boolean =>
    ((activeData().modelCatNames || {})[cat] || "") === MODEL_CAT_DISPLAY_WORD;
export const isItemCat = (cat: number): boolean =>
    ((activeData().modelCatNames || {})[cat] || "") === MODEL_CAT_ITEM_WORD;

/**
 * Who a row plays on, as the target icons — LIT when the query named a target
 * type this row's mask carries.
 *
 * Without this a target query lit NOTHING, so the cell had nothing to float:
 * `model:caster` selected 101,307 spells and every Models cell kept its resting
 * order, which is the same complaint `attach` and `motion` produced by a
 * different route (see the ranking entry in PILLS.md §4-bis).
 *
 * The icons are the one segment whose COLOUR already carries the meaning —
 * caster dim, target mech-tone, area fx-tone, never-caster danger — so a hit
 * must not recolour them. `.ticons.hit` puts the gold BEHIND the group and the
 * glyphs keep their hues, exactly as `.tag.hit` washes a pill without touching
 * its label. Recolouring to gold would trade a type distinction for a state
 * one, which is the trap the command strip already documents.
 *
 * `field` is the search field whose chips can name a target ("model", "sound",
 * "anim", "fx", "mech") — the same one the pill's own segments search in.
 */
function targetSeg(field: string, mask: number): Segment | null {
    return P.targets(mask, !!mask && anyGroup(field, (ts) => Search.maskIsNamed(ts, mask)));
}

function attachSegment(src: number, dst: number, field: string, twoPoint: boolean): Segment | null {
    const d = activeData();
    const nameOf = (a: number) => (a >= 0 ? (d.attachmentNames[a] || "") : "");
    const s = nameOf(src);
    const t = twoPoint ? nameOf(dst) : "";
    if (!s && !t) return null;
    // The label already shows the slot name, so the tooltip only has to say
    // what the pill does WITH it. It used to append "an M2 attachment slot,
    // not a description" to every one of these — 42 characters of the same
    // caveat on every attachment pill on screen.
    let label, why;
    if (s && t) {
        label = `${s} → ${t}`;
        why = `Travels from ${s} to ${t}`;
    } else if (!twoPoint) {
        label = s;
        why = `Plays at ${s}`;
    } else {
        label = s ? `from ${s}` : `to ${t}`;
        why = s ? `Launches from ${s}` : `Lands on ${t}`;
    }
    const words = [s, t].filter(Boolean);
    // one `attach <point>` per point, so two points AND rather than running
    // together into one unreadable value (Search.keywordValue quotes if the
    // name ever gains a space)
    return P.note(label, {
        hit: attachIsHit(field, words),
        title: why,
        search: P.quoted(field, words.map((w) => Search.keywordValue(Search.ATTACH_WORD, w)).join(" ")),
        finds: `spells using ${words.length > 1 ? "these points" : "this point"}`,
    });
}

/**
 * The values a chip gives one meta keyword — the engine's own splitter, so
 * a pill can only light up under a query that really selected its spell,
 * and the arity a hit test assumes is the arity the search used.
 */
const keywordValues = (tokens: { text: string }[], word: string) =>
    Search.splitKeyword(tokens, word).values;

/* An attachment segment lights when a positive attach query in its field (or
   * free text) names points this row carries; a boneset pill when a `boneset`
   * query names one of its regions. Both defer to Search.matchesNames — the
   * engine's own value test — so a pill can only light up under a query that
   * really selected its spell. */
const lowered = (names: string[]) => names.map((n) => n.toLowerCase());

function attachIsHit(field: string, names: string[]): boolean {
    const namesL = lowered(names);
    return anyGroup(field, (ts) => {
        const attaches = keywordValues(ts, Search.ATTACH_WORD);
        return attaches.length > 0 && Search.matchesNames(attaches, namesL);
    });
}

function bonesetIsHit(names: string[]): boolean {
    const namesL = lowered(names);
    return anyGroup("anim", (ts) => {
        const words = keywordValues(ts, Search.BONESET_WORD);
        return words.length > 0 && Search.matchesNames(words, namesL);
    });
}

/* A boneset segment: the body region(s) an AnimKit — or one of its anims —
   * animates ("Upper Body", "Head · Right Hand"). Reads as a dim qualifier on
   * the pill, searchable via the `boneset` keyword. Built exactly like its twin
   * attachSegment — ONE keyword per region, each quoted if its name is spaced
   * ("Upper Body") — so the two twins produce the same shape of query. Shown on
   * the AnimKit head when the whole kit shares one region, on the anim pill when
   * its anims differ. */
function bonesetSegment(names: string[] | null): Segment | null {
    if (!names || !names.length) return null;
    return P.note(names.join(" · "), {
        hit: bonesetIsHit(names),
        title: `Animates ${names.join(", ")}`,
        search: P.quoted("anim", names.map((n) => Search.keywordValue(Search.BONESET_WORD, n)).join(" ")),
        finds: `spells animating ${names.length > 1 ? "these regions" : "this region"}`,
    });
}

/* A raw M2 attach id an EFFECT (Shadowy/Dissolve) carries -> its region
   * word. -1, the common value, is the WHOLE body ("full body") rather than a
   * missing point; anything else names the M2 attachment slot. */
export const effectRegionName = (a: number | undefined): string =>
    a == null ? "" : (a < 0 ? "full body" : (activeData().attachmentNames[a] || ""));

/* Where on the model a Shadowy/Dissolve effect is anchored, as a dim note
   * segment. Searchable through the effect's own fx corpus (`category`), so it
   * needs no new keyword — the attach word rides the same corpus as the hue or
   * texture words. `regionNames` may hold several when a merged pill (one ghost
   * colour drawn by effects at different points) spans more than one. */
export function effectAttachNote(regionNames: string[], category: string): Segment | null {
    const names = [...new Set(regionNames.filter(Boolean))];
    if (!names.length) return null;
    const full = names.length === 1 && names[0] === "full body";
    return P.note(names.join(" · "), {
        title: full ? "Anchored to the whole body"
            : `Anchored at the ${names.join(", ")} attachment point`,
        search: P.catQuery("fx", category, names[0]),
        finds: full ? "effects on the full body" : "effects at this attachment point",
    });
}

/**
 * The arc a projectile flies (SpellMissileMotion), as a note segment.
 *
 * Sits between the label and the attachment point, which is the order the
 * convention asks for and also the order it reads in: what it is, how it
 * flies, where it lands. Missile rows only — every other category ships "".
 *
 * The names come in two families and both are the client's own: geometry
 * ("Parabola (High)", "Boomerang") and per-spell scripts
 * ("Mage - Fire - Fireball"). The script family is effectively a second,
 * Blizzard-authored name for the spell, which is why they are worth showing
 * rather than reducing to a geometry enum. They also run long — the label is
 * clamped by CSS and the full name rides the tooltip, so a 35-character
 * motion cannot push the copy button out of the cell.
 */
function motionSegment(motion: string): Segment | null {
    if (!motion) return null;
    return P.motion(motion, {
        hit: motionIsHit(motion),
        title: `Flies a "${motion}" path`,
        search: P.quoted("model", Search.keywordValue(Search.MOTION_WORD, motion)),
        finds: "spells whose missile flies this path",
    });
}

/* Lights when a positive `motion` query in the model field names this row's
   * flight path — same shape as attachIsHit, deferring to the engine's own
   * value test so a pill can only light under a query that selected its spell. */
function motionIsHit(motion: string): boolean {
    const namesL = [motion.toLowerCase()];
    return anyGroup("model", (ts) => {
        const values = keywordValues(ts, Search.MOTION_WORD);
        return values.length > 0 && Search.matchesNames(values, namesL);
    });
}

export function modelTag(fid: number, catName = "", mask = 0, src = -1, dst = -1,
                         twoPoint = false, motion = ""): HTMLElement {
    const file = fileOf(fid);
    // A negative fid is a fileless SENTINEL (SYNTHETIC_MODEL_FILES in
    // build_data): a weapon the caster already has, which has no fixed model in
    // the data — the pack ships the slot name ("equipped off hand") as the
    // file path, so the pill labels and searches itself through the ordinary
    // filename route. It keeps its category (attached vs thrown missile),
    // attachment point and target icon, and drops only what needs a real file:
    // the 3D preview and the .lookup command.
    const synthetic = fid < 0;
    // the sentinel's synthetic path IS its label, so both cases read it the
    // same way — only the tooltip differs (a slot name has no fid to report)
    const labelText = file.base ? stripExt(file.base) : `file #${fid}`;
    return PR.pill({
        cls: "model" + (synthetic ? " synthetic" : ""),
        // with "" for the category (the stale-pack flat list) this reduces to
        // the plain fileIsHit test
        hit: modelFileIsHit(file, catName || ""),
        title: file.path || "(name unknown)",
        segments: [
            !synthetic && CFG.modelViewerUrl && P.view(
                fillTemplate(CFG.modelViewerUrl, {fid}),
                `Preview ${file.base || `file #${fid}`} in the WoW.tools model viewer (new tab)`),
            targetSeg("model", mask),
            P.label(labelText, {
                title: synthetic
                    ? "No fixed model — the game fills this in from the caster's own gear at"
                    + " cast time (SpellVisualEffectName Type 3–10)"
                    : file.path || "(name unknown)",
                detail: [!synthetic && `FileDataID ${fid}`],
                search: file.base ? P.quoted("model", file.base) : "",
                finds: "spells using this model",
            }),
            motionSegment(motion),
            attachSegment(src, dst, "model", twoPoint),
            // fileless sentinels have no fid to look up / copy — the marker is the pill
            !synthetic && P.cmd(".lo", CFG.modelCopyTemplate,
                {base: stripExt(file.base), file: file.base, path: file.path, fid}),
        ],
    });
}

/** One (spell, model, category) row - the shape spellModelCats stores. */
export interface ModelCatEntry {
    fid: number;
    cat: number;
    targets: number;
    src: number;
    dst: number;
    ref: number;
    /** Flight path name; "" on every non-missile row. */
    motion: string;
}

/* Display pill (MODELS column): a model reached through a CreatureDisplayID
   * (SpellVisualEffectName Type 2) rather than a raw file. Sits in the Models
   * column but wears the morph pill's buttons — the Wowhead model viewer opens
   * the creature skin composited, and .morph / display-id copies are what you
   * actually want for a creature. It still carries its attachment point like
   * any other attached model. Label is the model's base filename (no TDB
   * needed); the displayId drives the buttons. */
export function displayTag(e: ModelCatEntry, spellId: number): HTMLElement {
    const {fid, ref: displayId, targets: mask} = e;
    const file = fileOf(fid), base = file.name;
    return PR.pill({
        cls: "model",
        hit: modelFileIsHit(file, MODEL_CAT_DISPLAY_WORD),
        segments: [
            displayId && CFG.wowheadMorphUrl && P.link(
                fillTemplate(CFG.wowheadMorphUrl, {id: displayId, spell: spellId}),
                `View DisplayID ${displayId} in Wowhead's model viewer`),
            targetSeg("model", mask),
            P.label(base || `display #${displayId}`, {
                title: file.path || "(model name unknown)",
                detail: [`DisplayID ${displayId}`],
                search: base ? P.quoted("model", file.base) : "",
                finds: "spells using this model",
            }),
            // single-point route (dst unused), like an ordinary attached model
            attachSegment(e.src, e.dst, "model", false),
            displayId && [
                P.copy("⧉", `Copy display ID: ${displayId}`, String(displayId)),
                P.cmd(".morph", CFG.morphCopyTemplate, {id: displayId}),
            ],
            file.base && P.cmd(".lo", CFG.morphLookupTemplate, {id: displayId, file: file.base}),
        ],
    });
}

/* Item pill (MODELS column): a model reached through an Item::ID
   * (SpellVisualEffectName Type 1). Two shapes share one renderer, differing
   * only by whether the item has a NAME:
   *   named    ( [wh] | {target}{icon}{ItemName} | attach | [copy] | [.add] | [.lo] )
   *   nameless ( [3d] | {target}{icon}{fileName} | attach | [.lo] )
   * The item icon always sits directly against the label. A named item's Wowhead
   * item page (opened on its model view) carries the tooltip, mirrored onto the
   * icon and the label via data-wowhead so hovering either raises it while the
   * label keeps its click-to-search. A nameless item has no item page and no
   * item id worth copying, so it drops [wh], [copy] and [.add] and takes the 3D
   * cube instead; .lookup item then falls back to the model's base filename. */
export function itemTag(e: ModelCatEntry): HTMLElement {
    const d = activeData();
    const {fid, ref: itemId, targets: mask} = e;
    const info = d.items.get(itemId) || {name: "", quality: "", icon: ""};
    const file = fileOf(fid);
    const named = !!info.name;
    const base = file.name;
    // .lookup item accepts the item name OR the model base name (no extension)
    const lookupName = info.name || base;

    const itemHref = named && CFG.wowheadItemUrl
        ? wowheadUrl(CFG.wowheadItemUrl, {id: itemId}) : "";
    return PR.pill({
        cls: "model item" + (info.quality ? ` q-${info.quality}` : ""),
        hit: itemIsHit(e),
        segments: [
            // leading action: Wowhead item page for named, 3D model viewer for nameless
            itemHref && P.link(itemHref, `Open ${info.name} on Wowhead`),
            !named && CFG.modelViewerUrl && fid && P.view(
                fillTemplate(CFG.modelViewerUrl, {fid}),
                `Preview ${base || `file #${fid}`} in the WoW.tools model viewer (new tab)`),
            targetSeg("model", mask),
            // icon, then label, with nothing between them so they read as one unit.
            // On a named item the icon is a Wowhead item link, the same mechanism the
            // name link / [wh] button use — that anchor+href is what the app's tooltips
            // ride on (data-wowhead alone is unproven here), so hovering the icon raises
            // the same tooltip and clicking it opens the item. Nameless items have no
            // item page, so their icon is a plain img.
            info.icon && P.icon(fillTemplate(CFG.spellIconUrl, {icon: info.icon}), {
                href: itemHref || undefined,
                title: itemHref ? `Open ${info.name} on Wowhead` : undefined,
                data: itemHref ? {wowhead: `item=${itemId}`} : undefined,
            }),
            P.label(named ? info.name : base || `item #${itemId}`, {
                title: named ? `${info.name} (item ${itemId})`
                    : file.path || "(model name unknown)",
                detail: [!named && `Item ${itemId} (no name)`],
                // named items search the item corpus (name/quality); nameless by filename
                search: named ? P.catQuery("model", MODEL_CAT_ITEM_WORD, info.name)
                    : (base ? P.quoted("model", file.base) : ""),
                finds: named ? "spells using this item" : "spells using this model",
                data: named ? {wowhead: `item=${itemId}`} : undefined, // tooltip on the name too
            }),
            attachSegment(e.src, e.dst, "model", false),
            named && [
                P.copy("⧉", `Copy item ID: ${itemId}`, String(itemId)),
                P.cmd(".add", CFG.itemAddTemplate, {id: itemId}),
            ],
            lookupName && P.cmd(".lo", CFG.itemLookupTemplate, {id: itemId, name: lookupName}),
        ],
    });
}

// an item pill lights when a positive model chip is satisfied by the item's
// corpus (name / quality / id / the category word "item") OR its model file —
// the same shape as modelFileIsHit, with the item corpus folded in so
// model:"item sickle axe" matches on the NAME, not just the filename.
function itemIsHit(e: ModelCatEntry): boolean {
    const d = activeData();
    const searchL = fileOf(e.fid).searchL;
    // safe to read `ref` as an Item::ID without gating on the category: itemTag
    // is the only caller and it renders item rows only. Anywhere the category
    // is NOT already known, gate on data.itemCat — `ref` is a per-category id
    // space and the spaces collide (see itemL in search.ts).
    const corpus = d.itemSearchL.get(e.ref) || "";
    return anyGroup("model", (ts) => ts.every((t) =>
        MODEL_CAT_ITEM_WORD.includes(t.text) || searchL.includes(t.text) || corpus.includes(t.text)));
}

export function soundTag(fid: number): HTMLElement {
    const file = fileOf(fid);
    return PR.pill({
        cls: "sound",
        hit: fileIsHit(file, "sound"),
        title: file.path || "(name unknown)",
        segments: [
            CFG.soundPlayUrl && P.play(
                fillTemplate(CFG.soundPlayUrl, {
                    fid,
                    bucket: fid % 256,
                    base: encodeURIComponent(stripExt(file.base) || String(fid)),
                }),
                `Play ${file.base || `file #${fid}`} (streamed from Wowhead)`),
            // sound extensions stay visible (.ogg/.mp3 differ, unlike models)
            P.label(file.base || `file #${fid}`, {
                title: file.path || "(name unknown)",
                detail: [`FileDataID ${fid}`],
                search: file.base ? P.quoted("sound", file.base) : "",
                finds: "spells using this sound",
            }),
            P.copy("⧉", `Copy FileDataID ${fid}`, String(fid)),
        ],
    });
}

export function kitTag(kitId: number, field: "soundkit" | "animkit", mask = 0): HTMLElement {
    const sound = field === "soundkit";
    const kind = sound ? "SoundKit" : "AnimKit";
    // Blizzard's own name for the kit, where one exists. Absent for every
    // AnimKit and for the 35.6% of SoundKits added after 8.3.0, which is the
    // last build that ships a name for anything (see SOUNDKITNAME_BUILD).
    const name = sound ? activeData().soundKitName.get(kitId) : undefined;
    return PR.pill({
        cls: field,
        hit: kitIsHit(kitId, field) || (sound && kitNameIsHit(kitId)),
        segments: [
            targetSeg(sound ? "sound" : "anim", mask),
            // THE NAME IS THE IDENTITY WHERE THERE IS ONE, AND THEN THE ID IS
            // NOT PRINTED AT ALL (user's call, 2026-08-06, tightened 08-08).
            // A named kit spends its label on the name and keeps only the bare
            // copy button — the id is still one click away and still on that
            // button's tooltip, but it is not competing with the name for the
            // width. An UNNAMED kit keeps the id as its label, because then the
            // id is the only thing it has. There is deliberately no derived
            // fallback name — see docs/DECISIONS.md, "No fallback name for an
            // unnamed sound kit".
            //
            // hit is per-SEGMENT, not inherited from the pill: the name golds
            // only when the NAME is what matched, so a kit found by id stays
            // plain. Same rule as the delivery line's per-segment highlight.
            name
                ? P.label(name, {
                    // the full name on the tooltip, because .tag-label
                    // ellipsises at 24rem and these run to 91 characters
                    title: name,
                    detail: [`${kind} ${kitId} — Blizzard's own name for it`],
                    // the `kit` keyword, not the bare name: clicking the name
                    // asks for kits NAMED this, never a sound file that
                    // happens to spell it
                    search: P.quoted("sound", Search.keywordValue(Search.SOUNDKIT_WORD, name)),
                    finds: "spells using a sound kit with this name",
                    hit: kitNameIsHit(kitId),
                })
                : P.label(String(kitId), {
                    title: `${kind} ${kitId}`,
                    search: P.query(sound ? "sound" : "anim", kitId),
                    finds: `spells using this ${field}`,
                }),
            P.copy("⧉", `Copy ${kind} ID ${kitId}`, String(kitId)),
            P.cmd(sound ? "/" : ".mod",
                sound ? CFG.soundKitCopyTemplate : CFG.animKitCopyTemplate, {id: kitId}),
            sound && P.link(wowheadUrl(CFG.wowheadSoundUrl, {id: kitId}),
                `SoundKit ${kitId} on Wowhead`),
        ],
    });
}

/**
 * One anim-replacement swap pill: "Stand → StealthStand".
 *
 * Both sides are searchable, because both are questions worth asking — the
 * base animation being overridden, and the one played instead. Reads as a
 * pair rather than two pills because neither half means anything alone.
 */
export function animSwapTag(src: number, dst: number): HTMLElement {
    const d = activeData();
    const srcName = d.animNames[src] || `#${src}`;
    const dstName = d.animNames[dst] || `#${dst}`;
    const srcHit = replaceAnimHit(src);
    const dstHit = replaceAnimHit(dst);
    // both halves are equally prominent labels (neither is "the qualifier"),
    // joined by an inert arrow — the replacement is as real as the original
    return PR.pill({
        cls: "anim",
        hit: srcHit || dstHit,
        segments: [
            P.label(srcName, {
                hit: srcHit,
                title: `Base animation replaced: ${srcName} (${src})`,
                search: P.catQuery("anim", "replace", srcName),
                finds: `spells replacing ${srcName}`,
            }),
            P.label("→", {cls: "swap-arrow"}),
            P.label(dstName, {
                hit: dstHit,
                title: `Played instead: ${dstName} (${dst})`,
                search: P.catQuery("anim", "replace", dstName),
                finds: `spells replacing into ${dstName}`,
            }),
            P.cmd(".lo", CFG.animCopyTemplate, {name: dstName, id: dst}),
        ],
    });
}

export function animTag(animId: number, groupWord = "", mask = 0,
                        boneset: string[] | null = null): HTMLElement {
    const d = activeData();
    const name = d.animNames[animId];
    return PR.pill({
        cls: "anim",
        hit: animIsHit(animId, groupWord),
        segments: [
            targetSeg("anim", mask),
            P.label(name, {
                title: `Animation ${animId}: ${name}`,
                search: P.quoted("anim", name),
                finds: "spells playing this animation",
            }),
            // per-anim boneset: only when this kit's anims animate different
            // regions (a uniform kit carries it on the head instead)
            bonesetSegment(boneset),
            P.cmd(".lo", CFG.animCopyTemplate, {name, id: animId}),
        ],
    });
}

/* One Mechanics pill = one SpellEffect. The SPECIFIC thing the effect does
   * leads the pill; the effect that carries it trails as a qualifier —
   *
   *   ( 👤 SCHOOL_DAMAGE )               a plain effect
   *   ( 👤 PERIODIC_DAMAGE | APPLY_AURA )  an aura-applying effect
   *
   * so the aura name — the part that actually says what the spell does — is
   * the headline, and the near-universal APPLY_AURA reads as the boilerplate
   * it is. Both segments search their own name.
   *
   * WHO it lands on is shown ONLY as the caster/target/area icons every other
   * column uses (user's call, 2026-07-23): the enum names are long, would
   * dominate the pill and repeat down the column. The exact implicit targets
   * stay in the tooltip and stay searchable through mech: — the icons cannot
   * tell UNIT_TARGET_ENEMY from UNIT_TARGET_ALLY, so the words still earn
   * their place in the corpus. */
export function mechanicTag(pill: MechanicPill): HTMLElement {
    const d = activeData();
    const effectName = pill.effect
        ? (d.effectNames.get(pill.effect) || `EFFECT_${pill.effect}`) : "";
    const auraName = pill.aura ? (d.auraNames.get(pill.aura) || `AURA_${pill.aura}`) : "";
    // Each row contributes its own targets, and a row setting both is one
    // rule with two anchors (SRC_CASTER + UNIT_SRC_AREA_ENEMY = "enemies
    // around me") — so rows join with "or", the pair inside a row with "+".
    const aims = pill.rows
        .map((r) => [r.targetA, r.targetB].filter(Boolean)
            .map((t) => `TARGET_${d.implicitTargetNames.get(t) || t}`).join(" + "))
        .filter(Boolean);
    const aimedAt = aims.length ? `Aimed at ${[...new Set(aims)].join(" or ")}` : "";

    /** Both segments carry the same shape; only which kind leads differs. */
    const seg = (make: (text: string, opts?: SegmentOpts) => Segment,
                 text: string, title: string) => make(text, {
        title, detail: [aimedAt],
        search: P.quoted("mech", text),
        finds: "spells with this mechanic",
    });
    return PR.pill({
        cls: "mechanic" + (pill.aura ? " aura" : ""),
        hit: pill.rows.some(mechanicIsHit),
        segments: [
            targetSeg("mech", pill.mask),
            // the aura leads when there is one, else the effect does
            auraName && seg(P.label, auraName, `Aura ${pill.aura}: SPELL_AURA_${auraName}`),
            effectName && seg(auraName ? P.note : P.label, effectName,
                `Spell effect ${pill.effect}: SPELL_EFFECT_${effectName}`),
        ],
    });
}

/* Collapse a spell's mechanic rows to what the pills actually render.
   * Rows differing only in their implicit target now look identical (the
   * target is icons-only), so Soulstone's two DUMMY effects — one aimed at
   * CORPSE_TARGET_ALLY, one at UNIT_TARGET_ALLY, both "on the target" — would
   * come out as two indistinguishable pills. Key on (effect, aura, icon mask)
   * and keep every merged row: the rows drive the tooltip's target list and
   * the hit test, so nothing is lost, it just stops repeating itself. */

/**
 * One rendered Mechanics pill: the rows that look alike, merged. `rows` holds
 * every row behind it — they differ only in implicit target, which the pill
 * shows as icons, so they feed the tooltip and the hit test instead.
 */
export interface MechanicPill {
    effect: number;
    aura: number;
    mask: number;
    rows: MechanicRow[];
}

export function mechanicPills(rows: MechanicRow[]): MechanicPill[] {
    const byLook = new Map<string, MechanicPill>();
    for (const r of rows) {
        const key = `${r.effect}:${r.aura}:${r.mask}`;
        const prev = byLook.get(key);
        if (prev) {
            prev.rows.push(r);
            continue;
        }
        byLook.set(key, {effect: r.effect, aura: r.aura, mask: r.mask, rows: [r]});
    }
    return [...byLook.values()];
}

/* Visual FX tags: the category head ("chain") and one pill per texture,
   * with a dot showing the chain's tint (hidden when untinted). Clicking
   * the head searches the whole category (fx:chain). */

// `field` is which column owns the category, so a head clicked in the
// Mechanics column searches mech:seat rather than fx:seat — the head's
// query has to be the one that would actually select its own pills.
// `finds` is overridable because "a <word> effect" is not grammatical for every
// category: the link words are verbs, so `triggers` would read "all spells with
// a triggers effect". A category that needs its own phrase passes one (see
// CatSpec.finds); everything else keeps the default it always had.
//
// `label` lets a head PRINT something other than the word it searches, and only
// `location` uses it: it prints `only in`, because a bare `location` reads as
// "this spell is associated with Suramar" — the exact misreading that got the
// first draft rejected — while the restriction is the whole point. The word
// stays reachable everywhere else (this head's click, autocomplete, help).
// Do this only when the head has a job the word cannot do; matching is the
// default and every other category keeps it.
export function fxHeadTag(category: string, hit: boolean, mask = 0, field = "fx",
                          finds = `all spells with a ${category} effect`,
                          label = category): HTMLElement {
    return PR.pill({
        cls: "fx-head", hit, segments: [
            targetSeg(field, mask),
            P.label(label, {
                title: P.hintFor(field, category),
                search: P.query(field, category),
                finds,
            }),
        ]
    });
}

/**
 * One chain (beam) pill: optional tint swatch + texture name.
 */
export function fxTag(entry: { chainId: number; fid: number; color: number; src?: number; dst?: number },
                      mask = 0): HTMLElement {
    const d = activeData();
    const file = fileOf(entry.fid);
    const info = d.fxChains.get(entry.chainId) || {color: 0xffffff, hue: ""};
    const tinted = entry.color !== 0xffffff;
    const hex = hexColor(entry.color);
    const base = file.name;
    return PR.pill({
        cls: "fx",
        hit: fxChainIsHit(entry.chainId),
        segments: [
            targetSeg("fx", mask),
            tinted && P.swatch(hex, {
                title: `Tint ${hex}` + (info.hue ? ` (${info.hue})` : ""),
                info: "chain tint",
            }),
            P.label(base || "(untextured)", {
                title: file.path || "(no texture)",
                // category word + texture: the query stays scoped to chains once more
                // fx categories exist ("fx:chain lightning" style)
                search: file.base ? P.catQuery("fx", "chain", file.base) : "",
                finds: "spells with this chain texture",
                // the hover preview multiplies the texture by the chain's tint
                data: entry.fid
                    ? {texFid: entry.fid, texTint: tinted ? hex : undefined}
                    : undefined,
            }),
            // a beam attaches at both ends — caster's hand to the target's chest
            attachSegment(entry.src ?? -1, entry.dst ?? -1, "fx", true),
            base && P.copy("⧉", `Copy texture name: ${base}`, base),
        ],
    });
}

/** Color-only fx pill (glow / ghost / tint): swatch + hex label — these
 * effects have no texture or model, the color is the whole payload.
 * Clicking searches the category + hex; ⧉ copies the hex.
 *   the icons ride the pills instead of the category head.
 *   anchor) to ride in the pill when present.
 */
export function colorFxTag(category: string, color: number, hit: boolean, alpha?: number,
                           mask = 0, extra: Segment | null = null): HTMLElement {
    const hex = hexColor(color);
    const colorData = {
        color: hex, colorInfo: category, alpha: alpha !== undefined && alpha >= 0 ? alpha : undefined,
    };
    return PR.pill({
        cls: "fx",
        hit,
        segments: [
            targetSeg("fx", mask),
            P.swatch(hex, {info: category, alpha}),
            P.label(hex, {
                title: P.hintFor("fx", category),
                detail: [`Color ${hex}`],
                search: P.catQuery("fx", category, hex),
                finds: `spells with this ${category} color`,
                // the hex text is the color too — hovering it shows the same big patch
                data: colorData,
            }),
            // an effect anchor (Shadowy attach point) rides here when present
            extra,
            P.copy("⧉", `Copy color: ${hex}`, hex),
        ],
    });
}

/* Percent-only fx pill (desaturate / transparency): the strength is the
   * whole payload. Desaturate gets a decorative grey swatch keyed to the
   * strength; transparency has no swatch. Clicking searches category + %. */
export function percentFxTag(category: string, percent: number, hit: boolean): HTMLElement {
    const grey = Math.round(255 * (1 - percent / 200)); // 100% -> mid grey
    return PR.pill({
        cls: "fx",
        hit,
        segments: [
            category === "desaturate" && P.swatch(`rgb(${grey}, ${grey}, ${grey})`),
            P.label(`${percent}%`, {
                title: P.hintFor("fx", category),
                detail: [`${percent}%`],
                search: P.catQuery("fx", category, `${percent}%`),
                finds: `spells with this ${category} strength`,
            }),
        ],
    });
}

/* Vehicle seat pill: one per seat of the vehicle the aura turns the caster
   * into, labeled with the M2 attachment point that seat sits at. The names
   * are the game's own and read oddly as seat positions ("Breath",
   * "ChestBloodBack") because artists reuse generic attachment slots as seat
   * anchors — the tooltip says so, since otherwise it reads as a bug. The
   * Vehicle.db2 id says nothing to a user, so it is neither shown nor
   * copyable. Clicking finds every spell with a seat at the same point. */
export function vehicleTag(attachment: string, seats: number, mask = 0): HTMLElement {
    const label = attachment || "seat";
    return PR.pill({
        cls: "fx",
        hit: vehicleIsHit(attachment, seats),
        segments: [
            targetSeg("mech", mask),
            P.label(label, {
                title: P.hintFor("mech", "seat"),
                detail: [`Seat at the ${label} attachment point`,
                    "(an M2 attachment slot, not a description of the seat)"],
                search: P.catQuery("mech", "seat", label),
                finds: "spells with a seat there",
            }),
        ],
    });
}

/* Invisibility-channel pill (MOD_INVISIBILITY[_DETECT]). One per invisibility
   * TYPE the spell touches; the type is the pairing key, so the pill navigates
   * to the OTHER side of that channel — an invis pill searches fx:detect <type>
   * (the spells that reveal it), a detect pill searches fx:invis <type> (the
   * ones it reveals). The counterpart count rides the label. An invisibility
   * nothing detects (count 0) is the priceless case: it still shows — that is
   * the whole point — but it is highlighted and non-clickable, since there is
   * nothing to navigate to. Detect pills never reach 0 (channels without an
   * invis side are not built). */
export function channelTag(side: string, type: number, count: number, mask = 0): HTMLElement {
    const invis = side === "invis";
    const priceless = invis && count === 0;
    const verb = invis ? (priceless ? "unseen" : `seen by ${count}`) : `reveals ${count}`;
    const other = invis ? "detect" : "invis";
    const plural = count === 1 ? "" : "s";
    // a priceless channel has no counterpart to navigate to, so it drops the
    // action entirely — both segments render inert (no search, no click line)
    const nav = priceless ? {} : {
        search: P.catQuery("mech", other, type),
        click: `show the ${count} counterpart${plural} (mech:${other} ${type})`,
    };
    const detail = [`${invis ? "Invisibility" : "Detection"} channel ${type}`,
        invis
            ? (priceless ? "Nothing detects this — nothing can reveal it (priceless)"
                : `Detected by ${count} spell${plural}`)
            : `Reveals ${count} invisibility spell${plural}`];
    // two divider-separated segments — (id | count), mirroring the model pill's
    // (name | attach) grammar. Both carry the same navigation.
    return PR.pill({
        cls: "fx" + (priceless ? " priceless" : ""),
        hit: channelIsHit(side, type),
        segments: [
            targetSeg("mech", mask),
            P.label(String(type), {detail, ...nav}),
            P.note(verb, {detail, ...nav}),
        ],
    });
}

/* What each movement word means, for the pill's tooltip. The words come
   * from the pack (SPEED_AURAS in build_data), so a word with no line here
   * still renders — it simply says nothing extra. */
const SPEED_MOVEMENT_NOTES: Record<string, string> = {
    run: "On foot",
    mounted: "On a ground mount",
    swim: "Swimming",
    // six auras share this word: which one applies depends on whether you
    // are mounted or in a vehicle, not on a different kind of movement
    flight: "Flying, mounted or otherwise",
    all: "Running, mounted, swimming and flying alike",
};

/**
 * What a percent change LEAVES YOU AT, as a multiple of normal — the reading
 * of the number that a percentage change does not give you directly. Shared
 * by the two routes whose payload is a signed percent, movement speed and
 * object scale, because the arithmetic and the reasoning are the same one.
 *
 * The PILL deliberately shows the change rather than this: the change is
 * what SpellEffect stores (the server applies it with AddPct), what the
 * game's own tooltip prints ("Increases your movement speed by 70%"), and
 * the only form that survives the whole range — 10 speed rows on 9.2.7 are
 * below -100%, which as a resulting speed would be negative. So the
 * multiplier rides the tooltip, where it can simply be absent when it says
 * nothing: below -100% there is nothing meaningful left to name, and -100%
 * itself is the floor `bottom` describes.
 */
function changeMultiplier(pct: number, noun: string, bottom: string): string {
    const mult = 1 + pct / 100;
    if (mult < 0) return "";
    if (mult === 0) return bottom;
    if (mult === 1) return "";  // a 0% change: the "+0%" already said it
    return `${mult.toFixed(2)}× normal ${noun}`;
}

/* Movement-speed pill (SPEED_AURAS in build_data): what the aura scales and
   * by how much —
   *
   *   ( run | +70% )      ( all | -50% )      ( swim | +100% )
   *
   * The movement is the label because it is the identity of the pill; the
   * percent qualifies it, the way an attachment point qualifies a model. Both
   * are clickable and they ask different questions: the movement finds every
   * spell that changes that movement, the percent narrows it to this exact
   * amount.
   *
   * "all" is the one aura that reaches every movement type at once
   * (MOD_DECREASE_SPEED — every snare in the game), so it is a value like the
   * others rather than a collapse the renderer performs: no spell's separate
   * auras ever add up to full coverage (checked on 9.2.7 — the widest reaches
   * four of the five and never swim).
   *
   * The sign is the whole story of faster-vs-slower and the aura NAME is not:
   * "MOD_DECREASE_SPEED" carries a positive amount on 187 rows of 9.2.7. So the
   * pill prints what the data says and never translates it into a verb. */
export function speedTag(pill: { move: string; pct: number; amount: string; key: string },
                         mask = 0): HTMLElement {
    const detail = [`Movement speed ${pill.amount}`,
        changeMultiplier(pill.pct, "speed", "Brings movement to a stop"),
        SPEED_MOVEMENT_NOTES[pill.move] || ""];
    return PR.pill({
        cls: "fx",
        hit: speedIsHit(pill.key),
        segments: [
            targetSeg("mech", mask),
            P.label(pill.move, {
                title: P.hintFor("mech", "speed"),
                detail,
                search: P.catQuery("mech", "speed", pill.move),
                finds: `spells changing ${pill.move === "all" ? "every movement" : pill.move} speed`,
            }),
            P.note(pill.amount, {
                title: P.hintFor("mech", "speed"),
                detail,
                search: P.catQuery("mech", "speed", `${pill.move} ${pill.amount}`),
                finds: "spells changing it by exactly this much",
            }),
        ],
    });
}

/* Object-scale pill (SCALE_AURAS in build_data): how much bigger or smaller
   * the aura makes its target —
   *
   *   ( scale ( +30% ) )      ( scale ( -50% ) )
   *
   * Movement speed's twin, one axis shorter. There is only one thing these
   * auras scale, so there is no word to put beside the number and the percent
   * is the whole pill — which means the group head ("scale") carries the
   * identity and this renders as a single label, the shape desaturate and
   * transparency already have.
   *
   * Below -100% the unit does not turn inside out: the server floors the result
   * (0.1 for players, 0.01 otherwise), which is what the fourteen rows down to
   * -999% on 9.2.7 really mean. The pill still shows the change, for the same
   * reason speed does — it is what the game stores and prints. */
export function scaleTag(pill: { pct: number; amount: string }, mask = 0): HTMLElement {
    return PR.pill({
        cls: "fx",
        hit: scaleIsHit(pill.pct),
        segments: [
            targetSeg("fx", mask),
            P.label(pill.amount, {
                title: P.hintFor("fx", "scale"),
                detail: [`Size ${pill.amount}`,
                    changeMultiplier(pill.pct, "size", "Shrinks it to nothing")],
                search: P.catQuery("fx", "scale", pill.amount),
                finds: "spells resizing by exactly this much",
            }),
        ],
    });
}

/* Keybound-override pill (aura 406): while the aura holds, this key stops
   * working. One segment — the key, plus the timing word when it only applies
   * airborne:
   *
   *   ( JUMP )        ( JUMP mid-air )        ( TOGGLEWORLDMAP )
   *
   * The retail client casts a replacement spell (SpellKeyboundOverride.Data),
   * and the pack carries it — but Epsilon does NOT cast it, it only disables
   * the key, so naming the spell here would promise something users cannot
   * get. Deliberate omission, not an oversight (user's call, 2026-07-23).
   *
   * The timing word rides the key segment rather than taking its own: it says
   * WHEN that same key is overridden, so it reads as part of the key, and the
   * ordinary press stays bare so the common case is uncluttered. */
export function keybindTag(pill: { label: string; fn: string; ids: number[] },
                           mask = 0): HTMLElement {
    return PR.pill({
        cls: "fx",
        hit: pill.ids.some(keybindIsHit),
        segments: [
            targetSeg("mech", mask),
            P.label(pill.label, {
                title: `${pill.fn} is overridden while this aura holds`,
                detail: ["On Epsilon the key is simply disabled"],
                search: P.catQuery("mech", "keybind", pill.fn),
                finds: "spells overriding this key",
            }),
        ],
    });
}

/** Stand-in for a ScreenEffect row with no color payload at all (-1 = the
 *  row has no such color; maskSize 0 = no FullScreenEffect row). */
export const NO_SCREEN_COLORS: ScreenColors = {
    fog: -1, fogAlpha: -1, mul: -1, add: -1,
    maskOffsetY: 0, maskSize: 0, maskPower: 0,
};

/* Screen-effect pill: the whole screen tints/overlays while the aura
   * holds. Label = the ScreenEffect row's internal name; swatch dots show
   * the fog tint and the FullScreenEffect multiply/addition screen colors
   * when present; rows with textures get the hover preview on the first one
   * (shown untinted — in game the colors grade the world, they're not baked
   * into the overlay image). ⧉ copies the ScreenEffect ID. */
export function screenTag(screenId: number, mask = 0): HTMLElement {
    const d = activeData();
    const name = d.screenNames.get(screenId) || "";
    const colors = d.screenColors.get(screenId) || NO_SCREEN_COLORS;
    const texFids = d.screenTextures.get(screenId) || [];

    // only the fog color has an opacity byte; mul/add are pure grade factors
    const swatches: Segment[] = ((
        [["fog tint", colors.fog, colors.fogAlpha],
            ["multiply", colors.mul, -1],
            ["addition", colors.add, -1]] as [string, number, number][]))
        .filter(([, c]) => c >= 0)
        .map(([what, c, a]) => P.swatch(hexColor(c), {
            title: `Screen ${what} ${hexColor(c)}`, info: `screen ${what}`, alpha: a,
        }));

    const texPaths: string[] = texFids.map((t) => (fileOf(t.fid).path || `#${t.fid}`)
        + (t.mask ? " (mask)" : ""));
    // Preview the overlay texture with the effect's color multiplied in —
    // the same treatment chain pills get. Overlays sort first, so [0] is the
    // finished art when the row has any. The color matters: 9.0 Arcane's
    // overlay is a cyan texture that reads magenta in game, because
    // ColorMultiply (#ff00f7) tints it.
    //
    // Compositing the full effect (grade + blend-set masks + radial Mask*
    // vignette) was tried and abandoned — see the batch 5/6 notes in
    // CLAUDE.md. None of the candidate models matched in game closely enough
    // to be worth the complexity, so this shows the art and its color, and
    // claims nothing more.
    return PR.pill({
        cls: "fx",
        hit: screenIsHit(screenId),
        segments: [
            targetSeg("fx", mask),
            swatches,
            P.label(name || `screen #${screenId}`, {
                title: `${name || "(unnamed)"} — ScreenEffect ${screenId}`,
                detail: texPaths,
                // quotes inside a name would break the tag value; substring match
                // doesn't need them (catQuery strips them)
                search: P.catQuery("fx", "screen", name || screenId),
                finds: "spells with this screen effect",
                data: texFids.length ? {
                    texFid: texFids[0].fid,
                    texTint: colors.mul >= 0 ? hexColor(colors.mul) : undefined,
                } : undefined,
            }),
        ],
    });
}

/* Dissolve pill: one per texture of the row's TextureBlendSet (mask +
   * material textures); tooltip carries the dissolve duration. */
export function dissolveTag(entry: { dissolveId: number; fid: number }, mask = 0): HTMLElement {
    const d = activeData();
    const file = fileOf(entry.fid);
    const duration = d.dissolveDurations.get(entry.dissolveId) || 0;
    const base = file.name;
    return PR.pill({
        cls: "fx",
        hit: dissolveIsHit(entry.dissolveId),
        segments: [
            targetSeg("fx", mask),
            P.label(base || "(untextured)", {
                title: file.path || "(no texture)",
                detail: [duration && `Duration ${duration}s`],
                search: file.base ? P.catQuery("fx", "dissolve", file.base) : "",
                finds: "spells with this dissolve texture",
                data: entry.fid ? {texFid: entry.fid} : undefined,
            }),
            effectAttachNote([effectRegionName(d.dissolveAttach.get(entry.dissolveId))], "dissolve"),
            base && P.copy("⧉", `Copy texture name: ${base}`, base),
        ],
    });
}

/* Morph pill: one per (creature, display). Label = the creature model's
   * file name; tooltip names the NPC the spell morphs
   * into; ⧉ copies the display ID, .morph / .lo the ready-to-paste
   * commands; the Wowhead icon on the left opens their model viewer on the
   * display. Creatures without TDB data get an inert "creature #id" pill. */

/* Shapeshift pill: one per (form, display). Label is the model basename
   * where the form has a display, otherwise the form name itself — Battle
   * Stance and Shadowform are real forms with no model at all, and a
   * name-only pill is the honest rendering. */
export function shapeshiftTag(entry: { formId: number; displayId: number; fid: number },
                              mask: number, spellId: number): HTMLElement {
    const d = activeData();
    const {formId, displayId, fid} = entry;
    const name = d.shapeshiftNames.get(formId) || "";
    const file = fileOf(fid), base = file.name;
    return PR.pill({
        cls: "fx",
        hit: shapeshiftIsHit(formId),
        segments: [
            displayId && CFG.wowheadMorphUrl && P.link(
                fillTemplate(CFG.wowheadMorphUrl, {id: displayId, spell: spellId}),
                `View DisplayID ${displayId} in Wowhead's model viewer`),
            targetSeg("fx", mask),
            P.label(base || name || `form #${formId}`, {
                title: `${name || "(unnamed form)"} — SpellShapeshiftForm ${formId}`,
                detail: [displayId ? `DisplayID ${displayId}`
                    : "(this form has no creature display)", file.path],
                // search by the form NAME, which is stable and readable, unlike the model
                search: P.catQuery("fx", "shapeshift", name || formId),
                finds: "spells with this form",
            }),
            displayId && [
                P.copy("⧉", `Copy display ID: ${displayId}`, String(displayId)),
                P.cmd(".morph", CFG.morphCopyTemplate, {id: displayId}),
            ],
            file.base && P.cmd(".lo", CFG.morphLookupTemplate, {id: displayId, file: file.base}),
        ],
    });
}

export function morphTag(entry: { creatureId: number; displayId: number; fid: number },
                         mask: number, spellId: number): HTMLElement {
    const d = activeData();
    const {creatureId, displayId, fid} = entry;
    const name = d.morphNames.get(creatureId) || "";
    const file = fileOf(fid), base = file.name;
    return PR.pill({
        cls: "fx",
        hit: morphIsHit(creatureId),
        segments: [
            displayId && CFG.wowheadMorphUrl && P.link(
                fillTemplate(CFG.wowheadMorphUrl, {id: displayId, spell: spellId}),
                `View DisplayID ${displayId} in Wowhead's model viewer`),
            targetSeg("fx", mask),
            P.label(base || (displayId ? `#${displayId}` : `creature #${creatureId}`), {
                title: `${name || "(unknown creature)"} — creature ${creatureId}`,
                detail: [displayId ? `DisplayID ${displayId}`
                    : "(no display known — creature not in TDB)",
                    file.path || "(model unknown)"],
                search: P.catQuery("fx", "morph", base || creatureId),
                finds: "spells with this morph",
            }),
            displayId && [
                P.copy("⧉", `Copy display ID: ${displayId}`, String(displayId)),
                P.cmd(".morph", CFG.morphCopyTemplate, {id: displayId}),
            ],
            file.base && P.cmd(".lo", CFG.morphLookupTemplate, {id: displayId, file: file.base}),
        ],
    });
}

/* Summon pill: one per (creature, control). Label = the NPC name with the
   * SummonProperties control word dimmed beside it (uncontrolled summons
   * show no word) — the control word is its own button searching all
   * summons of that control type; ⧉ copies the creature ID, .lo / .npc the
   * ready-to-paste commands; the Wowhead icon on the left opens the NPC's
   * Wowhead page. Creatures missing from TDB show an inert "creature #id"
   * pill. */

/**
 * One gameobject-spawn pill — summon's sibling, in the same column.
 *
 * Entries the world dump does not know are dropped at build, so every pill
 * here resolved something. The LABEL prefers the object's name and falls back
 * to the model's base filename; `.lookup object` always takes the MODEL file
 * regardless, and `.gobject spawn` always takes the entry.
 */
/**
 * Does Wowhead have a page for this gameobject? Keyed on GAMEOBJECT_TYPE,
 * not on whether we resolved a name — see CFG.wowheadObjectTypes for the
 * evidence. A pack with no types (older format) links nothing rather than
 * guessing, since a wrong link 404s.
 */
function hasWowheadPage(objectId: number): boolean {
    const t = activeData().objectTypes.get(objectId);
    return t !== undefined && (CFG.wowheadObjectTypes || []).includes(t);
}

export function objectTag(objectId: number, mask = 0): HTMLElement {
    const d = activeData();
    const name = d.objectNames.get(objectId) || "";
    const fid = d.objectFids.get(objectId) || 0;
    const file = fileOf(fid), base = file.name;
    // .lookup object ALWAYS takes the MODEL file name, never the object's
    // display name (user's call, 2026-07-24 — the name form was a bad match
    // for how Epsilon's lookup actually behaves). No model, no button.
    const lookup = file.base || "";
    return PR.pill({
        cls: "fx",
        hit: objectIsHit(objectId),
        segments: [
            // Wowhead only has pages for PLAYER-FACING object types — a door,
            // trap, spell-focus or ritual object has none, and linking one
            // 404s. The type decides it (CFG.wowheadObjectTypes); the name
            // does not, which is why a named GENERIC object still gets no link.
            // Those fall back to the ordinary 3D model viewer, the same
            // either/or the item route uses for a nameless item.
            hasWowheadPage(objectId) && CFG.wowheadObjectUrl && P.link(
                wowheadUrl(CFG.wowheadObjectUrl, {id: objectId}),
                `Open object ${objectId} on Wowhead`),
            !hasWowheadPage(objectId) && CFG.modelViewerUrl && fid && P.view(
                fillTemplate(CFG.modelViewerUrl, {fid}),
                `Preview ${file.base || `object #${objectId}`} in the WoW.tools model viewer (new tab)`),
            targetSeg("fx", mask),
            P.label(name || base || `object #${objectId}`, {
                title: `${name || "(unnamed object)"} — gameobject ${objectId}`,
                detail: [file.path || "(model unknown)"],
                search: P.catQuery("fx", "object", name || base || objectId),
                finds: "spells placing this object",
            }),
            P.copy("⧉", `Copy object ID: ${objectId}`, String(objectId)),
            lookup && P.cmd(".lo", CFG.objectLookupTemplate, {name: lookup, id: objectId}),
            P.cmd(".gob", CFG.objectSpawnTemplate, {id: objectId}),
        ],
    });
}

/**
 * One mount pill (Models column). A display-id pill like morphTag's, but the
 * display is what you RIDE, so the command is `.modify mount` rather than
 * `.morph`. Mount.db2 names every mount it ships, so the label is normally
 * the mount's name with the model file behind it in the tooltip; a nameless
 * display falls back to the model base, then to the bare id.
 */
export function mountTag(displayId: number, spellId: number): HTMLElement {
    const d = activeData();
    const name = d.mountNames.get(displayId) || "";
    const fid = d.mountFids.get(displayId) || 0;
    const file = fileOf(fid), base = file.name;
    return PR.pill({
        cls: "model",
        hit: mountIsHit(displayId),
        segments: [
            CFG.wowheadMorphUrl && P.link(
                fillTemplate(CFG.wowheadMorphUrl, {id: displayId, spell: spellId}),
                `View DisplayID ${displayId} in Wowhead's model viewer`),
            P.label(name || base || `#${displayId}`, {
                title: `${name || "(unnamed mount)"} — display ${displayId}`,
                detail: [file.path || "(model unknown)"],
                search: P.catQuery("model", "mount", name || base || displayId),
                finds: "spells granting this mount",
            }),
            P.copy("⧉", `Copy display ID: ${displayId}`, String(displayId)),
            P.cmd(".mod", CFG.mountModifyTemplate, {id: displayId}),
            file.base && P.cmd(".lo", CFG.morphLookupTemplate,
                {id: displayId, file: file.base}),
        ],
    });
}

/**
 * One spell-link chip (Mechanics column) — the only pill in the app whose
 * subject is another SPELL ROW, which is what shapes every choice in it.
 *
 * `word` is the direction ("triggers" / "origin"), which is also the group head
 * above it; `link.kinds` are the ways the two spells are joined and ride the
 * note, so the head says WHICH WAY and the note says HOW. That split is
 * load-bearing: `removes` is 14% of the graph and is emphatically not a
 * trigger, so the mechanism can never be inferred from the direction alone.
 *
 * THE ICON CARRIES WOWHEAD, THE TEXT CARRIES THE SEARCH (user's call). An
 * anchor with a wowhead href is what their tooltips.js binds to, so hovering
 * the icon raises the real spell tooltip — the same mechanism the Name column's
 * link uses — while clicking the name filters to that spell's own row, which is
 * this chip's primary job. There is no separate leading [wh] action: the chip
 * lives inside a group and two wowhead affordances would spend width twice.
 *
 * THE ID IS THE COPY BUTTON, not a label beside one. The chip has to show the
 * id (it is what `.cast` takes and what the user pastes into Epsilon) and it
 * has to offer copying it — and those are one control, exactly as the Name
 * column's own id already is. A `⧉` next to a printed id would spend width
 * saying the same thing twice.
 *
 * WIDTH IS THE STANDING CONSTRAINT HERE. A link chip is the widest thing the
 * Mechanics column holds, so the two variable-length parts (the spell name and
 * the joining words) are clamped with an ellipsis and the full text rides the
 * tooltip — the `motion` precedent, PILLS.md §5 — and the commands wear
 * Epsilon's own abbreviations. The budgets live in app.css, not here.
 */
export function spellLinkTag(link: SpellLink, word: string, mask = 0): HTMLElement {
    const d = activeData();
    const id = link.spell;
    const i = d.spellIndex.get(id);
    // A link whose target this pack does not name is dropped at BUILD time, so
    // an absent index here means a pack/format mismatch rather than bad data.
    const name = (i === undefined ? "" : d.names[i]) || `spell #${id}`;
    const icon = i === undefined ? "" : d.icons[i];
    const href = wowheadUrl(CFG.wowheadSpellUrl, {id});
    const kinds = link.kinds.filter(Boolean);
    const hit = word === "triggers" ? triggersIsHit(id) : originIsHit(id);
    // "Fireball triggers this" vs "this triggers Fireball" — the tooltip says
    // which, because a chip read out of context is ambiguous and the group head
    // scrolls out of view inside a clamped cell.
    const way = word === "triggers" ? "This spell reaches" : "Reached by";
    return PR.pill({
        cls: "mech link",
        hit,
        segments: [
            // The id LEADS (user's call, 2026-07-30). It is the chip's key —
            // what `.cast` takes and what gets pasted into Epsilon — and a
            // column of chips reading their ids down a common left edge is
            // scannable in a way a ragged right-hand id is not. It also keeps
            // the icon fused to the name it belongs to, rather than splitting
            // that pair around it.
            P.copy(String(id), `Copy spell ID: ${id}`, String(id), "pill-id"),
            // icon then label, nothing between them: they read as one unit and
            // the icon is the wowhead affordance (see above)
            icon && CFG.spellIconUrl && P.icon(fillTemplate(CFG.spellIconUrl, {icon}), {
                href, title: `Open ${name} on Wowhead`, data: {wowhead: `spell=${id}`},
            }),
            P.label(name, {
                cls: "link-name",
                title: `${way} ${name} — spell ${id}`,
                detail: [kinds.length ? `How: ${kinds.join(", ")}` : ""],
                // filter to the LINKED SPELL'S OWN ROW, not to other spells
                // linking the same way — "show me that spell" is the question a
                // chip pointing at a row is asking. id: bypasses the
                // min-length gate, so it lands however short the id is.
                search: `id:${id}`,
                finds: `spell ${id}`,
                data: {wowhead: `spell=${id}`}, // tooltip on the name too
            }),
            // who the triggering effect is aimed at — the same icons, from the
            // same mask, as every other pill in the column (pack format 36)
            targetSeg("mech", mask),
            kinds.length && P.note(kinds.join(" · "), {
                cls: "link-kind",
                title: `Joined by: ${kinds.join(", ")}`,
                search: P.catQuery("mech", word, kinds[0]),
                finds: `${word === "triggers" ? "links" : "back-links"} of this kind`,
            }),
            // .c / .au / .lo, from the row strip's own templates
            // (CFG.linkCommands), abbreviated by each command's own `short`
            ...CFG.spellCommands
                .filter((c) => CFG.linkCommands.includes(c.label))
                .map((c) => P.cmd(c.short || c.label, c.template, {id})),
        ],
    });
}

/**
 * One area-gate pill (Mechanics column) — a place the spell WILL cast, under a
 * group head reading `only in`.
 *
 * THE THREE AFFORDANCES ARE THREE DIFFERENT QUESTIONS, which is why this chip
 * has actions at both edges rather than one: the Wowhead link asks *what is this
 * place*, `.lo tele` asks *how do I get there*, and the map command asks *where
 * is it*. None substitutes for another.
 *
 * THE NAME IS THE AREA'S OWN, NEVER ITS PARENT ZONE'S. Rolling a multi-area
 * group up to its parent collapses 86% of these spells to one pretty name and is
 * wrong — 98.6% of such groups cover only PART of the parent, so "only in
 * Suramar" would be false on almost every pill it was printed on. The root is
 * used for the Wowhead href and nothing else, where naming the containing zone
 * is exactly right (Wowhead has no page for a subzone).
 *
 * The map button is DROPPED rather than guessed when the area resolved no map:
 * an area also reaches a continent map and a neighbouring zone's, and opening
 * the wrong map is worse than offering no button. See DATA_ROUTES §3t.
 */
export function areaTag(areaId: number): HTMLElement {
    const d = activeData();
    const name = d.areaNames.get(areaId) || `area #${areaId}`;
    // `.lookup tele` is a LOOSE FRAGMENT SEARCH, not a substring match (user,
    // 2026-08-05) — it splits the argument on whitespace and finds tele names
    // containing the fragments. So punctuation is replaced by a SPACE rather
    // than deleted: `.lo tele Nesingwary s Expedition` really does find
    // `NesingwarysExpedition`, and the stray "s" costs nothing.
    //
    // That the tele names themselves are run together (`ZulGurub`,
    // `AcherusTheEbonHold` — they are hand-maintained, and a minority keep
    // spaces) is therefore NOT a reason to run the argument together too. The
    // fragments match either style; a deleted space only helps if the matcher
    // is a substring one, and it is not.
    //
    // 644 of 3,147 areas on 9.2.7 carry a mark, 591 of them an apostrophe.
    // Unicode-aware, because the name is a localized string.
    const lookupName = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim() || name;
    const root = d.areaRoots.get(areaId) || areaId;
    const mapId = d.areaMapIds.get(areaId);
    return PR.pill({
        cls: "mech area",
        hit: areaIsHit(areaId),
        segments: [
            CFG.wowheadZoneUrl && P.link(wowheadUrl(CFG.wowheadZoneUrl, {id: root}),
                `Open ${d.areaNames.get(root) || `zone ${root}`} on Wowhead`),
            P.label(name, {
                cls: "area-name",
                title: `${name} — the spell casts here and refuses elsewhere`,
                search: P.catQuery("mech", "location", name),
                finds: "all spells gated to this area",
            }),
            P.cmd(".lo", CFG.areaLookupTemplate, {name: lookupName}),
            mapId && P.cmd("map", CFG.areaMapTemplate, {id: mapId}),
        ],
    });
}

export function summonTag(entry: { creatureId: number; control: number }, mask = 0): HTMLElement {
    const d = activeData();
    const {creatureId, control} = entry;
    const name = d.summonNames.get(creatureId) || "";
    const ctrl = d.summonControlNames[control] || "";
    return PR.pill({
        cls: "fx",
        hit: summonIsHit(creatureId, control),
        segments: [
            CFG.wowheadNpcUrl && P.link(wowheadUrl(CFG.wowheadNpcUrl, {id: creatureId}),
                `Open NPC ${creatureId} on Wowhead`),
            targetSeg("fx", mask),
            P.label(name || `creature #${creatureId}`, {
                title: `${name || "(unknown creature)"} — creature ${creatureId}`,
                detail: [ctrl && `Control: ${ctrl}`],
                search: P.catQuery("fx", "summon", name || creatureId),
                finds: "spells summoning this creature",
            }),
            ctrl && P.aside(ctrl, {
                title: `Control: ${ctrl}`,
                search: P.catQuery("fx", "summon", ctrl),
                finds: `all ${ctrl} summons`,
            }),
            P.copy("⧉", `Copy creature ID: ${creatureId}`, String(creatureId)),
            name && P.cmd(".lo", CFG.summonLookupTemplate, {name, id: creatureId}),
            P.cmd(".npc", CFG.summonSpawnTemplate, {id: creatureId, name}),
        ],
    });
}
