// @ts-check
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
 * rather than imported, because they are owned by app.js: `state` is a live
 * object (read, never written here) and targetWordsOf/maskOf/toast/copyText
 * are its helpers.
 */
window.EpsilookExport = (() => {
    "use strict";

    const CFG = window.EpsilookConfig;
    const {el, hexColor} = window.EpsilookUtil;

    /** @type {EpsilookExportState} */ let state;
    /** @type {(mask: number) => string[]} */ let targetWordsOf;
    /** @type {(index: any, spellId: number, itemIds: number[]) => number} */ let maskOf;
    /** @type {(msg: string) => void} */ let toast;
    /** @type {(text: string, wrapTicks?: boolean, message?: string) => void} */ let copyText;
    /** @type {ScreenColors} */ let NO_SCREEN_COLORS;

    /** @param {EpsilookExportDeps} deps */
    function init(deps) {
        ({state, targetWordsOf, maskOf, toast, copyText, NO_SCREEN_COLORS} = deps);
    }

    /* ------------------------------------------------------------ export */

    // Hidden columns are excluded from exports.
    function exportRows() {
        const d = state.data;
        const hc = state.hiddenCols;
        const pathOf = (fid) => (d.files.get(fid) || {}).path || `#${fid}`;
        /**
         * A spell's id list in ascending order — a copy, since the index's own
         * arrays must not be reordered. Missing (an absent route) reads as empty.
         * @param {number[]} [ids]
         * @returns {number[]}
         */
        const sorted = (ids = []) => ids.slice().sort((a, b) => a - b);
        /**
         * Same, deduped — the percent routes (desaturate, transparency) can
         * carry the same value on several of a spell's rows.
         * @param {number[]} [vals]
         * @returns {number[]}
         */
        const uniqSorted = (vals = []) => sorted([...new Set(vals)]);
        return state.display.map((id) => {
            const i = d.spellIndex.get(id);
            const row = {id, name: d.names[i], subtext: d.subtexts[i]};
            if (!hc.models) {
                // grouped by usage category (soundKits-style shape); a stale pack
                // without categories exports the old flat path list
                const cats = d.spellModelCats.get(id);
                if (cats) {
                    const byCat = new Map();
                    for (const e of cats) {
                        if (!byCat.has(e.cat)) byCat.set(e.cat, []);
                        // each file carries who it plays on — the export's form of the icons
                        byCat.get(e.cat).push({path: pathOf(e.fid), targets: targetWordsOf(e.targets)});
                    }
                    row.models = [...byCat.keys()].sort((a, b) => a - b).map((c) => ({
                        // the wordless attach category renders as loose pills in the UI,
                        // but an export still needs a name for it
                        category: d.modelCatNames[c] || (c === 0 ? "attached" : `cat ${c}`),
                        files: byCat.get(c),
                    }));
                } else {
                    row.models = (d.spellModels.get(id) || []).map(pathOf);
                }
            }
            if (!hc.sounds) {
                const byKit = new Map();
                const kitMask = new Map();
                for (const e of d.spellSounds.get(id) || []) {
                    if (!byKit.has(e.soundKitId)) byKit.set(e.soundKitId, []);
                    byKit.get(e.soundKitId).push(pathOf(e.fid));
                    kitMask.set(e.soundKitId, (kitMask.get(e.soundKitId) || 0) | (e.targets || 0));
                }
                row.soundKits = [...byKit.keys()].sort((a, b) => a - b).map((k) => ({
                    id: k, files: byKit.get(k), targets: targetWordsOf(kitMask.get(k) || 0),
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
                /** @type {ExportFxEntry[]} */
                const chains = sorted(d.spellFx.get(id)).map((c) => {
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
                ).concat(sorted(d.spellScreens.get(id)).map((sc) => {
                    const c = d.screenColors.get(sc) || NO_SCREEN_COLORS;
                    /** @param {number} v -1 = the row has no such color. */
                    const hx = (v) => v >= 0 ? hexColor(v) : null;
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
        a.href = URL.createObjectURL(new Blob([content], {type: mime}));
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
        toast(`Exported ${name}`);
    }

    function nothingToExport() {
        if (state.display.length === 0) {
            toast("Nothing to export — search first");
            return true;
        }
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
        if (!hc.animations) header.push("AnimKits", "Animations");
        if (!hc.fx) header.push("Effects");
        if (!hc.mechanics) header.push("Mechanics");
        // CSV has no icons, so a row's target types ride its text: "file [caster+target]"
        const withTargets = (e) =>
            (e.targets && e.targets.length ? `${e.path} [${e.targets.join("+")}]` : `${e.path}`);
        const lines = [header.join(",")];
        for (const r of exportRows()) {
            const cols = [r.id, esc(r.name), esc(r.subtext)];
            if (!hc.models) {
                cols.push(esc(r.models.map((m) => (m.files
                    ? `${m.category}: ${m.files.map(withTargets).join(" | ")}`
                    : m)).join("; ")));
            }
            if (!hc.sounds) {
                cols.push(esc(r.soundKits.map((k) => k.id).join("; ")));
                cols.push(esc(r.soundKits.map(
                    (k) => `${withTargets({path: k.id, targets: k.targets})}: ${k.files.join(" | ")}`)
                    .join("; ")));
            }
            if (!hc.animations) {
                cols.push(esc(r.animKits.map((k) => k.id).join("; ")));
                // the replacement pairs, as words: "from → to"
                const swaps = /** @type {string[]} */ ((r.replaceAnims || [])
                    .map((sw) => `${sw.from} → ${sw.to}`));
                cols.push(esc((r.anims || []).map((a) => withTargets({path: a.name, targets: a.targets}))
                    .concat(r.animKits.map(
                        (k) => `${withTargets({path: k.id, targets: k.targets})}: ${k.anims.join(" | ")}`))
                    .concat(swaps.length ? [`replace: ${swaps.join(" | ")}`] : [])
                    .join("; ")));
            }
            if (!hc.fx) {
                cols.push(esc(r.fx.map((e) => {
                    if (e.type === "morph") {
                        return `morph: ${e.creature || "?"} (creature ${e.creatureId}): `
                            + (e.displays.map((disp) => `${disp.displayId}=${disp.model || "?"}`).join(" | ") || "?");
                    }
                    // a form with no display is name-only — no ": …" tail
                    if (e.type === "shapeshift") {
                        const disp = e.displays
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
                            + `${e.percent > 0 ? "+" : ""}${e.percent}%`;
                    }
                    if (e.percent !== undefined) // percent-only fx (desaturate / transparency)
                        return `${e.type}: ${e.percent}%`;
                    if (e.type === "freeze" || e.type === "camo") // valueless fx
                        return e.type;
                    if (e.type === "screen") { // named + optional colors/textures
                        const tex = e.overlays.concat(e.masks);
                        return `screen: ${e.name || e.screenId}`
                            + (e.fogTint ? ` (${e.fogTint})` : "")
                            + (tex.length ? `: ${tex.join(" | ")}` : "");
                    }
                    if (e.color || e.colors) // color-only fx (glow / ghost / tint)
                        return `${e.type}: ${e.color || e.colors.join(" | ")}`;
                    return `${e.type}: ${e.textures.join(" | ") || "(untextured)"}`
                        + (e.tint ? ` (${e.tint})` : "") + (e.duration ? ` (${e.duration}s)` : "");
                }).join("; ")));
            }
            if (!hc.mechanics) cols.push(esc(r.mechanics.join("; ")));
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
        const idWidth = Math.max(...rows.map((r) => String(r.id).length), 2);
        const header = `**Epsilook** — ${rows.length.toLocaleString()} ${rows.length === 1 ? "spell" : "spells"} for \`${state.lastQuery}\`\n<${location.href}>\n\`\`\`\n`;
        const closer = "\n```";
        const footer = (remaining) => `\n…and ${remaining.toLocaleString()} more (full list: link above)`;
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

    return {init, rows: exportRows, csv: exportCsv, json: exportJson, discord: exportDiscord};
})();
