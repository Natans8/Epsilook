/* Textures: turning a fileDataID into a canvas, and the hover previews built
 * on it.
 *
 * Two things live here because they are the same subject, not the same
 * feature:
 *   - `load(fid)` fetches a raw .blp from wago.tools' CASC API (version-pinned
 *     by config) and decodes it with the vendored js-blp + bufo. Session-cached
 *     per fid. Used by the hover preview AND by the expansion logos in the
 *     header, which is why it is public rather than private to the preview.
 *   - `initHoverPreview()` wires the results table so pills carrying
 *     data-tex-fid (and colour swatches carrying data-color) show a floating
 *     panel after a hover-intent delay.
 *
 * House rule (see CLAUDE.md): fetch on explicit hover only - never preload,
 * never bulk-download. Failures, all-zero (encrypted) files and decode errors
 * all cache as null and stay silent.
 *
 * Note: the cache is keyed on fid alone while the URL is version-pinned, so a
 * fid fetched under one pack is reused after switching packs. Preserved from
 * the pre-split code deliberately: fileDataIDs are globally unique in WoW, so
 * the same id is the same texture across versions.
 */
import BLPFile from "./vendor/js-blp.js";
import {CFG} from "./config";
import {$, el, targetClosest} from "./dom";
import {fillTemplate} from "./util";

/** The pack textures are fetched against. Set by init(). */
let versionId: () => string = () => "";

/** Supply the pack textures are fetched against. Call before any load(). */
export function init(deps: { versionId: () => string }): void {
    versionId = deps.versionId;
}

/* --------------------------------------------- texture hover preview */

// Pills with data-tex-fid show the texture on hover: the raw .blp comes
// from wago.tools (version-pinned), decoded onto a canvas by the vendored
// js-blp + bufo libs (the same decoder wago.tools' own file viewer uses).
// Fetched only after a short hover-intent delay, cached per session
// (a failed fid caches as null and stays silent).
const texCache = new Map<number, Promise<HTMLCanvasElement | null>>(); // untinted base
let texHoverKey = ""; // fid|tint of the pill being hovered
let texHoverTimer = 0;

/**
 * Fetch + decode one .blp to a canvas, or null if it is missing, encrypted
 * or undecodable. Session-cached per fid; never throws.
 */
export function load(fid: number): Promise<HTMLCanvasElement | null> {
    let p = texCache.get(fid);
    if (!p) {
        const url = fillTemplate(CFG.texturePreviewUrl, {fid, version: versionId()});
        p = fetch(url)
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.arrayBuffer();
            })
            .then((buf) => {
                // encrypted CASC files come back as all-zero bytes — no preview
                if (!new Uint8Array(buf).some((b) => b !== 0)) return null;
                const blp = new BLPFile(buf);
                const cv = document.createElement("canvas");
                cv.width = blp.width;
                cv.height = blp.height;
                blp.getPixels(0, cv); // decodes mip 0 straight into the canvas
                return cv;
            })
            .catch(() => null);
        texCache.set(fid, p);
    }
    return p;
}

function texPanel(): HTMLElement {
    let panel = $("#texpreview");
    if (!panel) {
        panel = el("div", "");
        panel.id = "texpreview";
        panel.append(el("div", "tex-img"), el("div", "tex-dims"));
        document.body.appendChild(panel);
    }
    return panel;
}

function hideTexPreview(): void {
    texHoverKey = "";
    clearTimeout(texHoverTimer);
    const panel = $("#texpreview");
    if (panel) panel.style.display = "none";
}

export {hideTexPreview as hideHoverPreview};

// beam tint: texture.rgb × tint.rgb (how the game colors chain textures),
// keeping the texture's own alpha
function tintedCanvas(base: HTMLCanvasElement, tint: string): HTMLCanvasElement {
    const cv = document.createElement("canvas");
    cv.width = base.width;
    cv.height = base.height;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(base, 0, 0);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(base, 0, 0); // multiply fills alpha — restore the base's
    return cv;
}

// place the panel above its anchor (native title tooltips pop below the
// cursor), measured invisibly first; fall back to below at the viewport top
function placeTexPanel(panel: HTMLElement, anchor: Element): void {
    panel.style.visibility = "hidden";
    panel.style.display = "block";
    const r = anchor.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const x = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8));
    let y = r.top - pr.height - 6;
    if (y < 8) y = r.bottom + 6;
    panel.style.left = x + "px";
    panel.style.top = y + "px";
    panel.style.visibility = "";
}

function showTexPreview(label: HTMLElement, baseCanvas: HTMLCanvasElement): void {
    const tint = label.dataset.texTint || "";
    const canvas = tint ? tintedCanvas(baseCanvas, tint) : baseCanvas;
    const note = tint ? ` · tint ${tint}` : "";
    const max = CFG.texturePreviewMax || 256;
    const scale = Math.min(1, max / canvas.width, max / canvas.height);
    canvas.style.width = Math.round(canvas.width * scale) + "px";
    canvas.style.height = Math.round(canvas.height * scale) + "px";

    const panel = texPanel();
    panel.firstElementChild!.replaceChildren(canvas);
    panel.lastChild!.textContent = `${canvas.width}×${canvas.height}` + note;
    placeTexPanel(panel, label);
}

// same panel for color swatches: a large patch of the color, captioned with
// the hex, the channel values, the hue word and which effect it belongs to
// (data-color-info). Alpha only where the source actually carries one
// (data-alpha): screen fog opacity and EdgeGlowEffect.GlowAlpha.
function showColorPreview(swatch: HTMLElement): void {
    const hex = swatch.dataset.color!;
    const alpha = swatch.dataset.alpha;
    const patch = el("div", "tex-color");
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    // a translucent color shows the panel's checkerboard through it
    patch.style.background = alpha === undefined
        ? hex : `rgba(${r}, ${g}, ${b}, ${(Number(alpha) / 255).toFixed(3)})`;
    const panel = texPanel();
    panel.firstElementChild!.replaceChildren(patch);
    const hue = hueWordOf(hex);
    const rgb = alpha === undefined
        ? `rgb(${r}, ${g}, ${b})`
        // show alpha both as the raw byte and the 0..1 the tables store
        : `rgba(${r}, ${g}, ${b}, ${(Number(alpha) / 255).toFixed(2)})`;
    panel.lastChild!.textContent = `${hex} · ${rgb}`
        + (alpha === undefined ? "" : ` · alpha ${alpha}/255`)
        + (hue ? ` · ${hue}` : "")
        + (swatch.dataset.colorInfo ? ` · ${swatch.dataset.colorInfo}` : "");
    placeTexPanel(panel, swatch);
}

// coarse hue word for the caption — the same buckets build_data.py bakes
// into the search corpora, so the word shown is the word that searches
function hueWordOf(hex: string): string {
    const c = parseInt(hex.slice(1), 16);
    const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max ? (max - min) / max : 0;
    if (sat < 0.15 || max < 0.08) return ""; // white / grey / near-black
    const d = max - min;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    let deg = h * 60;
    if (deg < 0) deg += 360;
    for (const [limit, name] of [
        [15, "red"], [45, "orange"], [70, "yellow"], [160, "green"],
        [200, "cyan"], [255, "blue"], [290, "purple"], [330, "pink"],
        [361, "red"]] as [number, string][]) {
        if (deg < limit) return name;
    }
    return "";
}

/** Wire the results table for texture and colour hover previews. */
export function initHoverPreview(): void {
    if (!window.matchMedia("(hover: hover)").matches) return;
    const results = $("#results");
    results.addEventListener("mouseover", (e) => {
        // color swatches first — no fetch involved, same intent delay
        const swatch = targetClosest(e, "[data-color]");
        if (swatch) {
            const key = "color|" + swatch.dataset.color + "|" + (swatch.dataset.colorInfo || "")
                + "|" + (swatch.dataset.alpha || "");
            if (key === texHoverKey) return;
            hideTexPreview();
            texHoverKey = key;
            texHoverTimer = setTimeout(() => {
                if (texHoverKey === key && swatch.isConnected) showColorPreview(swatch);
            }, 150);
            return;
        }
        if (!CFG.texturePreviewUrl) return;
        const label = targetClosest(e, "[data-tex-fid]");
        if (!label) return;
        const fid = Number(label.dataset.texFid);
        // the tint joins the key: two pills can share a texture but tint it
        // differently, and the cache is per-fid untinted
        const key = fid + "|" + (label.dataset.texTint || "");
        if (key === texHoverKey) return;
        hideTexPreview();
        texHoverKey = key;
        texHoverTimer = setTimeout(async () => {
            const canvas = await load(fid);
            if (canvas && texHoverKey === key && label.isConnected) showTexPreview(label, canvas);
        }, 150);
    });
    results.addEventListener("mouseout", (e) => {
        const label = targetClosest(e, "[data-tex-fid], [data-color]");
        if (label && !label.contains(e.relatedTarget as Node | null)) hideTexPreview();
    });
    window.addEventListener("scroll", hideTexPreview, {passive: true});
}
