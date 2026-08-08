/* Export: the current result set as CSV, JSON or a Discord-ready code block.
 *
 * A leaf - nothing in the app reads from here, the three toolbar buttons and
 * the ?export= URL parameter only call in. It is a second renderer of the same
 * data the result cells draw: `rows()` walks the pack indexes once and returns
 * a plain serialisable shape, and the three formatters project that.
 *
 * Hidden columns are excluded from every format, so an export matches what the
 * table is showing.
 *
 * The app state and the few app helpers this needs are injected by init()
 * rather than imported, because they are owned by the app: `state` is a live
 * object (read, never written here) and targetWordsOf/maskOf/toast/copyText
 * are its helpers. Keeping the contract this narrow — and explicit — is the
 * point; widening it should be a visible change.
 */
import {CFG} from "./config";
import {DELIVERY_BREAKS_ON_MOVE, DELIVERY_CHANNELLED} from "./data";
import type {ScreenColors, SpellData} from "./data";
import {ATTR_FLAGS} from "./pilltypes";
import {el, hexColor} from "./util";

/** The slice of app state this module reads. Deliberately narrow. */
export interface ExportState {
    /** The active pack's indexes. */
    readonly data: SpellData;
    /** Columns switched off in the UI, omitted from every export. */
    readonly hiddenCols: Record<string, boolean>;
    /** Spell ids currently listed, in display order. */
    readonly display: number[];
    readonly lastQuery: string;
    readonly version: { id: string };
}

/** What the app lends this module — see init(). */
export interface ExportDeps {
    /** Live and read-only to the export module. */
    state: ExportState;

    targetWordsOf(mask: number): string[];

    maskOf(index: Map<number, Map<number, number>>, spellId: number, itemIds: number[]): number;

    toast(msg: string): void;

    copyText(text: string, wrapTicks?: boolean, message?: string): void;

    /** Stand-in for a ScreenEffect row carrying no colour payload. */
    NO_SCREEN_COLORS: ScreenColors;
}

/**
 * One entry of an exported row's `fx` list — one pill of the Effects column.
 * The shape varies by category (a chain has textures, a glow has a color, a
 * freeze has nothing but its type), so everything past `type` is optional;
 * see exportRows for which fields each category fills. Fields that can be
 * explicitly absent export as null rather than being omitted.
 */
export interface ExportFxEntry {
    /** Category word: "chain", "dissolve", "glow", "ghost", "tint", … */
    type: string;
    textures?: string[];
    /** Chain tint, null when the chain uses the texture's own color. */
    tint?: string | null;
    /** Dissolve length in seconds, null when unspecified. */
    duration?: number | null;
    color?: string;
    /** Ghost/shadowy primary + secondary. */
    colors?: string[];
    /** desaturate / transparency strength; also the signed speed / scale change. */
    percent?: number;
    screenId?: number;
    name?: string | null;
    fogTint?: string | null;
    fogAlpha?: number | null;
    colorMultiply?: string | null;
    colorAddition?: string | null;
    overlays?: string[];
    masks?: string[];
    formId?: number;
    form?: string | null;
    creatureId?: number;
    creature?: string | null;
    control?: string | null;
    /** Morph / shapeshift creature displays. */
    displays?: { displayId: number; model: string | null }[];
    /** Movement speed: which movement is scaled, and the signed percent. */
    movement?: string;
}

/** A model file in an export, with who it plays on. */
interface ExportModelFile {
    path: string;
    targets: string[];
}

/** One exported spell row. Hidden columns leave their fields absent. */
export interface ExportRow {
    id: number;
    name: string;
    subtext: string;
    /** The expansion that introduced the spell ID; absent when no rung claims
     *  it, which is Classic-re-release content that reached no retail client. */
    expansion?: string;
    /** Grouped by usage category; a stale pack without categories exports
     *  the old flat path list instead. */
    models?: ({ category: string; files: ExportModelFile[] } | string)[];
    soundKits?: { id: number; files: string[]; targets: string[] }[];
    anims?: { name: string; targets: string[] }[];
    animKits?: { id: number; anims: string[]; targets: string[] }[];
    replaceAnims?: { from: string; to: string }[];
    fx?: ExportFxEntry[];
    mechanics?: string[];
    /** Areas the spell is gated to, by name, absent when it is gated to none.
     *  Names only: an area's name is both what a reader needs and what
     *  `.lookup tele` takes, and the pill's other two affordances (a Wowhead
     *  href, a map id) are buttons with nothing to press in a file. */
    areas?: string[];
    /** How the spell is delivered. Always present — every spell has an answer,
     *  `instant` being the one for a spell with neither a cast nor a channel.
     *  `castMs`/`durMs` are omitted when they do not apply rather than sent as
     *  0, so a consumer never has to know which zero means "none". */
    delivery?: {
        instant: boolean;
        castMs?: number;
        channel?: boolean;
        /** Omitted for an unlimited channel and for one with no duration row;
         *  `unlimited` tells the two apart. */
        durMs?: number;
        unlimited?: boolean;
        breaksOnMove?: boolean;
    };
}

/* Injected by init() — the app calls it at boot, before any export runs. */
let state!: ExportDeps["state"];
let targetWordsOf!: ExportDeps["targetWordsOf"];
let maskOf!: ExportDeps["maskOf"];
let toast!: ExportDeps["toast"];
let copyText!: ExportDeps["copyText"];
let NO_SCREEN_COLORS!: ScreenColors;

export function init(deps: ExportDeps): void {
    ({state, targetWordsOf, maskOf, toast, copyText, NO_SCREEN_COLORS} = deps);
}

/* ------------------------------------------------------------ export */

// Hidden columns are excluded from exports.
function exportRows(): ExportRow[] {
    const d = state.data;
    const hc = state.hiddenCols;
    const pathOf = (fid: number) => d.files.get(fid)?.path || `#${fid}`;
    /**
     * A spell's id list in ascending order — a copy, since the index's own
     * arrays must not be reordered. Missing (an absent route) reads as empty.
     */
    const sorted = (ids: number[] = []) => ids.slice().sort((a, b) => a - b);
    /**
     * Same, deduped — the percent routes (desaturate, transparency) can
     * carry the same value on several of a spell's rows.
     */
    const uniqSorted = (vals: number[] = []) => sorted([...new Set(vals)]);
    return state.display.map((id) => {
        const i = d.spellIndex.get(id)!;
        const row: ExportRow = {id, name: d.names[i], subtext: d.subtexts[i]};
        // Provenance rides with the ID, not with a column, so like delivery it
        // is exported unconditionally — there is no column to hide it with.
        const era = d.spellEra.get(id);
        if (era !== undefined) row.expansion = d.expansions[era].label;
        // Delivery rides with the NAME, not with a column, so it is exported
        // unconditionally — there is no "delivery column" to hide it with.
        const dl = d.spellDelivery.get(id);
        if (!dl) {
            row.delivery = {instant: true};
        } else {
            row.delivery = {instant: false};
            if (dl.castMs > 0) row.delivery.castMs = dl.castMs;
            if (dl.flags & DELIVERY_CHANNELLED) {
                row.delivery.channel = true;
                if (dl.durMs > 0) row.delivery.durMs = dl.durMs;
                else if (dl.durMs < 0) row.delivery.unlimited = true;
            }
            if (dl.flags & DELIVERY_BREAKS_ON_MOVE) row.delivery.breaksOnMove = true;
        }
        if (!hc.models) {
            // grouped by usage category (soundKits-style shape); a stale pack
            // without categories exports the old flat path list
            const cats = d.spellModelCats.get(id);
            if (cats) {
                const byCat = new Map<number, ExportModelFile[]>();
                for (const e of cats) {
                    if (!byCat.has(e.cat)) byCat.set(e.cat, []);
                    // each file carries who it plays on — the export's form of the icons
                    byCat.get(e.cat)!.push({path: pathOf(e.fid), targets: targetWordsOf(e.targets)});
                }
                row.models = [...byCat.keys()].sort((a, b) => a - b).map((c) => ({
                    // the wordless attach category renders as loose pills in the UI,
                    // but an export still needs a name for it
                    category: d.modelCatNames[c] || (c === 0 ? "attached" : `cat ${c}`),
                    files: byCat.get(c)!,
                }));
            } else {
                row.models = (d.spellModels.get(id) || []).map(pathOf);
            }
        }
        if (!hc.sounds) {
            const byKit = new Map<number, string[]>();
            const kitMask = new Map<number, number>();
            for (const e of d.spellSounds.get(id) || []) {
                if (!byKit.has(e.soundKitId)) byKit.set(e.soundKitId, []);
                byKit.get(e.soundKitId)!.push(pathOf(e.fid));
                kitMask.set(e.soundKitId, (kitMask.get(e.soundKitId) || 0) | (e.targets || 0));
            }
            row.soundKits = [...byKit.keys()].sort((a, b) => a - b).map((k) => ({
                id: k,
                // omitted rather than empty when the kit has no name — only
                // kits named on or before 8.3.0 have one
                ...(d.soundKitName.get(k) ? {name: d.soundKitName.get(k)!} : {}),
                files: byKit.get(k)!, targets: targetWordsOf(kitMask.get(k) || 0),
            }));
        }
        if (!hc.animations) {
            const loose = sorted(d.spellVisualAnims.get(id));
            const looseMasks = d.visualAnimTargets.get(id);
            if (loose.length) {
                row.anims = loose.map((a) => ({
                    name: d.animNames[a],
                    targets: targetWordsOf(looseMasks ? looseMasks.get(a) || 0 : 0),
                }));
            }
            row.animKits = sorted(d.spellAnimKits.get(id))
                .map((k) => ({
                    id: k,
                    anims: (d.animKitAnims.get(k) || []).map((a) => d.animNames[a]),
                    targets: targetWordsOf(maskOf(d.animKitTargets, id, [k])),
                }));
            const swaps = d.spellReplaceAnims.get(id) || [];
            if (swaps.length) {
                row.replaceAnims = swaps.map((sw) => ({
                    from: d.animNames[sw.src], to: d.animNames[sw.dst],
                }));
            }
        }
        if (!hc.fx) {
            // one entry per pill, in the cell's category order; the shapes differ
            // per category, hence the shared loose ExportFxEntry
            const chains: ExportFxEntry[] = sorted(d.spellFx.get(id)).map((c) => {
                const info = d.fxChains.get(c) || {color: 0xffffff, hue: ""};
                return {
                    type: "chain",
                    textures: (d.fxTextures.get(c) || []).map(pathOf),
                    tint: info.color === 0xffffff ? null : hexColor(info.color),
                };
            });
            row.fx = chains.concat(sorted(d.spellDissolves.get(id)).map((c) => ({
                type: "dissolve",
                textures: (d.dissolveTextures.get(c) || []).map(pathOf),
                duration: d.dissolveDurations.get(c) || null,
            }))).concat(sorted(d.spellGlows.get(id)).map((c) => ({
                type: "glow",
                color: hexColor(d.glowColors.get(c) || 0),
            }))).concat(sorted(d.spellShadowies.get(id)).map((c) => {
                const sh = d.shadowyColors.get(c) || {primary: 0, secondary: 0};
                return {
                    type: "ghost",
                    colors: [sh.primary, sh.secondary].map(hexColor),
                };
            })).concat(sorted(d.spellGhostMats.get(id)).map((c) => ({
                type: "ghost",
                color: hexColor(d.ghostMatColors.get(c) || 0),
            }))).concat(sorted(d.spellTints.get(id)).map((c) => ({
                type: "tint",
                color: hexColor(d.tintColors.get(c) || 0),
            }))).concat(uniqSorted(d.spellDesaturates.get(id))
                .map((p) => ({type: "desaturate", percent: p}))
            ).concat(uniqSorted(d.spellTransps.get(id))
                .map((p) => ({type: "transparency", percent: p}))
            ).concat(d.spellFreezes.has(id) ? [{type: "freeze"}] : []
            ).concat(d.spellCamos.has(id) ? [{type: "camo"}] : []
                // Attribute flags, from the registry's own list rather than a
                // second one here: a flag added there exports without touching
                // this file. Valueless, so the word IS the payload.
            ).concat(ATTR_FLAGS
                // `draw: false` flags are the delivery ones — they get their
                // own structured field below rather than a bare word here
                .filter((f) => f.draw && (d.spellAttrs.get(f.handler)?.has(id) ?? false))
                .map((f) => ({type: f.word}))
            ).concat(sorted(d.spellScreens.get(id)).map((sc) => {
                const c = d.screenColors.get(sc) || NO_SCREEN_COLORS;
                // -1 = the row has no such color
                const hx = (v: number) => v >= 0 ? hexColor(v) : null;
                return {
                    type: "screen",
                    screenId: sc,
                    name: d.screenNames.get(sc) || null,
                    fogTint: hx(c.fog),
                    fogAlpha: c.fogAlpha >= 0 ? c.fogAlpha : null,
                    colorMultiply: hx(c.mul),
                    colorAddition: hx(c.add),
                    // overlays are finished art; masks are painted by the colors
                    overlays: (d.screenTextures.get(sc) || [])
                        .filter((t) => !t.mask).map((t) => pathOf(t.fid)),
                    masks: (d.screenTextures.get(sc) || [])
                        .filter((t) => t.mask).map((t) => pathOf(t.fid)),
                };
            })).concat(sorted(d.spellShapeshifts.get(id))
                .map((f) => ({
                    type: "shapeshift",
                    formId: f,
                    form: d.shapeshiftNames.get(f) || null,
                    displays: (d.shapeshiftDisplays.get(f) || []).map((e) => ({
                        displayId: e.displayId,
                        model: e.fid ? pathOf(e.fid) : null,
                    })),
                }))).concat(sorted(d.spellMorphs.get(id)).map((c) => ({
                type: "morph",
                creatureId: c,
                creature: d.morphNames.get(c) || null,
                displays: (d.morphDisplays.get(c) || []).map((e) => ({
                    displayId: e.displayId,
                    model: e.fid ? pathOf(e.fid) : null,
                })),
            }))).concat((d.spellSummons.get(id) || []).slice()
                .sort((a, b) => (a.creatureId - b.creatureId) || (a.control - b.control))
                .map((e) => ({
                    type: "summon",
                    creatureId: e.creatureId,
                    creature: d.summonNames.get(e.creatureId) || null,
                    control: d.summonControlNames[e.control] || null,
                }))).concat((d.spellSpeedMods.get(id) || []).slice()
                .sort((a, b) => a.move.localeCompare(b.move) || a.pct - b.pct)
                .map((e) => ({
                    type: "speed",
                    movement: e.move,
                    // signed, as the pill shows it — see speedTag for why the
                    // change and not the resulting speed
                    percent: e.pct,
                }))).concat((d.spellScaleMods.get(id) || []).slice()
                .sort((a, b) => a.pct - b.pct)
                .map((e) => ({type: "scale", percent: e.pct})));
        }
        if (!hc.mechanics) {
            // one entry per effect, mirroring the pills — aura first, then the
            // effect carrying it. An export is read without tooltips or icons, so
            // unlike the pill it spells the implicit targets out:
            // "PERIODIC_DAMAGE / APPLY_AURA -> TARGET_UNIT_CASTER"
            row.mechanics = (d.spellMechanics.get(id) || []).map((m) => {
                const does = [
                    m.aura ? (d.auraNames.get(m.aura) || `AURA_${m.aura}`) : "",
                    m.effect ? (d.effectNames.get(m.effect) || `EFFECT_${m.effect}`) : "",
                ].filter(Boolean).join(" / ");
                const at = [m.targetA, m.targetB].filter(Boolean)
                    .map((t) => `TARGET_${d.implicitTargetNames.get(t) || t}`).join(" + ");
                return at ? `${does} -> ${at}` : does;
            });
            // The area gate rides the Mechanics column, so it hides with it.
            // Sorted by name, matching the pill order rather than pack order.
            //
            // Deduped by NAME, which is a wider merge than the pill's (that one
            // keeps same-name/different-root areas apart because their Wowhead
            // links differ). Here the name IS the whole entry — no link, no
            // command — so two areas sharing one are indistinguishable to a
            // reader, and "Azsuna; Azsuna" says nothing the single name does not.
            const areas = [...new Set((d.spellAreas.get(id) || [])
                .map((a) => d.areaNames.get(a) || `area #${a}`))].sort();
            if (areas.length) row.areas = areas;
        }
        return row;
    });
}

function exportFilename(ext: string): string {
    const q = state.lastQuery.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "results";
    return `epsilook-${q}.${ext}`;
}

function downloadFile(name: string, mime: string, content: string): void {
    const a = el("a");
    a.href = URL.createObjectURL(new Blob([content], {type: mime}));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${name}`);
}

function nothingToExport(): boolean {
    if (state.display.length === 0) {
        toast("Nothing to export — search first");
        return true;
    }
    return false;
}

function exportCsv(): void {
    if (nothingToExport()) return;
    const hc = state.hiddenCols;
    const esc = (v: string | number) => {
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ["ID", "Name", "Subtext", "Expansion"];
    if (!hc.models) header.push("Models");
    if (!hc.sounds) header.push("SoundKits", "Sounds");
    if (!hc.animations) header.push("AnimKits", "Animations");
    if (!hc.fx) header.push("Effects");
    // Its own column rather than folded into Mechanics: that cell is a list of
    // effect/aura rows, and a place name buried among
    // "PERIODIC_DAMAGE / APPLY_AURA -> TARGET_UNIT_CASTER" reads as one of them.
    if (!hc.mechanics) header.push("Mechanics", "Areas");
    // CSV has no icons, so a row's target types ride its text: "file [caster+target]"
    const withTargets = (e: { path: string | number; targets?: string[] }) =>
        (e.targets && e.targets.length ? `${e.path} [${e.targets.join("+")}]` : `${e.path}`);
    const lines = [header.join(",")];
    for (const r of exportRows()) {
        const cols = [String(r.id), esc(r.name), esc(r.subtext), esc(r.expansion ?? "")];
        if (!hc.models) {
            cols.push(esc((r.models ?? []).map((m) => (typeof m === "string"
                ? m
                : `${m.category}: ${m.files.map(withTargets).join(" | ")}`)).join("; ")));
        }
        if (!hc.sounds) {
            const kits = r.soundKits ?? [];
            cols.push(esc(kits.map((k) => k.id).join("; ")));
            cols.push(esc(kits.map(
                (k) => `${withTargets({path: k.id, targets: k.targets})}: ${k.files.join(" | ")}`)
                .join("; ")));
        }
        if (!hc.animations) {
            const animKits = r.animKits ?? [];
            cols.push(esc(animKits.map((k) => k.id).join("; ")));
            // the replacement pairs, as words: "from → to"
            const swaps = (r.replaceAnims || []).map((sw) => `${sw.from} → ${sw.to}`);
            cols.push(esc((r.anims || []).map((a) => withTargets({path: a.name, targets: a.targets}))
                .concat(animKits.map(
                    (k) => `${withTargets({path: k.id, targets: k.targets})}: ${k.anims.join(" | ")}`))
                .concat(swaps.length ? [`replace: ${swaps.join(" | ")}`] : [])
                .join("; ")));
        }
        if (!hc.fx) {
            cols.push(esc((r.fx ?? []).map((e) => {
                if (e.type === "morph") {
                    return `morph: ${e.creature || "?"} (creature ${e.creatureId}): `
                        + ((e.displays ?? []).map((disp) => `${disp.displayId}=${disp.model || "?"}`).join(" | ") || "?");
                }
                // a form with no display is name-only — no ": …" tail
                if (e.type === "shapeshift") {
                    const disp = (e.displays ?? [])
                        .map((x) => `${x.displayId}=${x.model || "?"}`).join(" | ");
                    return `shapeshift: ${e.form || `form ${e.formId}`}`
                        + (disp ? `: ${disp}` : "");
                }
                if (e.type === "summon") {
                    return `summon: ${e.creature || "?"} (creature ${e.creatureId})`
                        + (e.control ? ` [${e.control}]` : "");
                }
                // signed percent changes: the sign is half the meaning, and
                // for speed the movement word is the other half
                if (e.type === "speed" || e.type === "scale") {
                    return `${e.type}: ${e.movement ? e.movement + " " : ""}`
                        + `${e.percent! > 0 ? "+" : ""}${e.percent}%`;
                }
                if (e.percent !== undefined) // percent-only fx (desaturate / transparency)
                    return `${e.type}: ${e.percent}%`;
                if (e.type === "freeze" || e.type === "camo") // valueless fx
                    return e.type;
                if (e.type === "screen") { // named + optional colors/textures
                    const tex = (e.overlays ?? []).concat(e.masks ?? []);
                    return `screen: ${e.name || e.screenId}`
                        + (e.fogTint ? ` (${e.fogTint})` : "")
                        + (tex.length ? `: ${tex.join(" | ")}` : "");
                }
                if (e.color || e.colors) // color-only fx (glow / ghost / tint)
                    return `${e.type}: ${e.color || e.colors!.join(" | ")}`;
                return `${e.type}: ${(e.textures ?? []).join(" | ") || "(untextured)"}`
                    + (e.tint ? ` (${e.tint})` : "") + (e.duration ? ` (${e.duration}s)` : "");
            }).join("; ")));
        }
        if (!hc.mechanics) {
            cols.push(esc((r.mechanics ?? []).join("; ")));
            cols.push(esc((r.areas ?? []).join("; ")));
        }
        lines.push(cols.join(","));
    }
    downloadFile(exportFilename("csv"), "text/csv", lines.join("\r\n"));
}

function exportJson(): void {
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

function exportDiscord(): void {
    if (nothingToExport()) return;
    const rows = exportRows();
    const idWidth = Math.max(...rows.map((r) => String(r.id).length), 2);
    const header = `**Epsilook** — ${rows.length.toLocaleString()} ${rows.length === 1 ? "spell" : "spells"} for \`${state.lastQuery}\`\n<${location.href}>\n\`\`\`\n`;
    const closer = "\n```";
    const footer = (remaining: number) => `\n…and ${remaining.toLocaleString()} more (full list: link above)`;
    const reserve = closer.length + footer(rows.length).length; // worst-case footer length

    let body = "";
    let shown = 0;
    for (const r of rows) {
        const line = `${String(r.id).padEnd(idWidth)}  ${r.name}${r.subtext ? ` (${r.subtext})` : ""}`;
        const candidate = body + (shown ? "\n" : "") + line;
        if (shown > 0 && header.length + candidate.length + reserve > CFG.discordCharLimit) break;
        body = candidate;
        shown++;
    }

    let text = header + body + closer;
    if (shown < rows.length) text += footer(rows.length - shown);
    const summary = shown < rows.length
        ? `Copied ${shown.toLocaleString()} of ${rows.length.toLocaleString()} spells to clipboard`
        : `Copied ${shown.toLocaleString()} ${shown === 1 ? "spell" : "spells"} to clipboard`;
    copyText(text, false, summary);
}

export {exportRows as rows, exportCsv as csv, exportJson as json, exportDiscord as discord};
