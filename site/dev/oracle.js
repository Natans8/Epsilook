/* Epsilook measurement oracle - a dev tool, never loaded by the app.
 *
 * Load it on a running page (local server OR the live site) with one line:
 *
 *   s = document.createElement("script"); s.src = "dev/oracle.js"; document.head.append(s)
 *
 * then call Oracle.help(). Nothing here is referenced by index.html, so it
 * ships as dead weight of a few kilobytes and costs a page nothing.
 *
 * WHY IT IS A FILE AND NOT A PASTE. Every measurement in this project's
 * history - search counts across a query battery, the contrast walk per
 * palette, the pill DOM snapshot before and after a refactor - was retyped
 * each time it was needed, which is both expensive and how a subtly different
 * measurement gets compared against yesterday's number. These are the versions
 * that were actually used; keep them here and the comparison stays honest.
 *
 * THREE TRAPS ARE BUILT IN, because all three have been fallen into:
 *
 *   - every pushed URL keeps v=. Omit it and the app silently falls back to
 *     the default pack, so you measure 9.2.7 believing you measured another.
 *   - the query battery is SYNCHRONOUS. Search is sync, and an async loop over
 *     it times the driving tool out at 30 seconds for no benefit.
 *   - contrast is measured on a REAL page load per theme. Flipping data-theme
 *     on a rendered table makes Chrome serve stale computed colours for
 *     elements already on screen, which has produced convincing false
 *     failures. Oracle.theme() reloads rather than repainting, on purpose.
 */

window.Oracle = (() => {
    "use strict";

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    /* ------------------------------------------------------------ queries */

    /** The pack the page is actually showing, so a pushed URL can keep it. */
    function version() {
        const sel = /** @type {HTMLSelectElement} */ ($("#version"));
        return (sel && sel.value) || new URLSearchParams(location.search).get("v") || "";
    }

    /** `16,373 spells (1,200 after filters) · 12 ms` -> {total, shown, ms}. */
    function readStatus() {
        const text = ($("#status") || {}).textContent || "";
        const total = /^([\d,]+)\s+spells?/.exec(text);
        const shown = /\(([\d,]+)\s+after filters\)/.exec(text);
        const ms = /·\s*([\d.]+)\s*ms/.exec(text);
        const num = (m, i) => (m ? Number(m[i].replace(/,/g, "")) : null);
        return {
            total: num(total, 1),
            shown: shown ? num(shown, 1) : num(total, 1),
            ms: num(ms, 1),
            text: text,
        };
    }

    /**
     * Run one query in place - no reload, no navigation.
     * @param {string} query
     * @param {string} [v] pack id; defaults to the one on screen
     */
    function one(query, v) {
        const pack = v || version();
        const url = `?v=${encodeURIComponent(pack)}&q=${encodeURIComponent(query)}`;
        history.pushState(null, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
        const st = readStatus();
        return {q: query, v: pack, n: st.total, shown: st.shown, ms: st.ms, status: st.text};
    }

    /**
     * A whole battery, synchronously. Returns rows; also console.table's them.
     * @param {string[]} queries
     * @param {{v?: string, quiet?: boolean}} [opts]
     */
    function q(queries, opts = {}) {
        const list = Array.isArray(queries) ? queries : [queries];
        const rows = list.map((query) => one(query, opts.v));
        if (!opts.quiet) console.table(rows.map((r) => ({query: r.q, spells: r.n, ms: r.ms})));
        return rows;
    }

    /**
     * Assert a set of queries agree. Each entry is [label, ...queries] - every
     * query in the entry must return the same count. This is the shape almost
     * every grammar check takes ("the worded form equals the shorthand"), and
     * writing it as an assertion means the answer is PASS/FAIL rather than a
     * table someone still has to compare by eye.
     * @param {Array<Array<string>>} groups
     */
    function same(groups, opts = {}) {
        const out = groups.map((group) => {
            const [label, ...queries] = group;
            const counts = queries.map((query) => one(query, opts.v).n);
            const agreed = counts.every((n) => n === counts[0]);
            return {label, ok: agreed, counts: counts.join(" = "), queries: queries.length};
        });
        console.table(out);
        const bad = out.filter((r) => !r.ok);
        console.log(bad.length ? `%c${bad.length} of ${out.length} DISAGREE` : `%call ${out.length} agree`,
                    `color:${bad.length ? "#e66" : "#6c6"};font-weight:600`);
        return out;
    }

    /* ----------------------------------------------------------- contrast */

    const parseRgb = (s) => {
        const m = /rgba?\(([^)]+)\)/.exec(s || "");
        if (!m) return null;
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return {r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1};
    };

    /* src-over composite, alpha included.
     *
     * The alpha is the whole point and it used to be hardcoded to 1, which
     * made the walk below stop at the FIRST pair of layers it composited and
     * treat the result as the finished surface. Two translucent fills are
     * exactly what this tool exists to catch, so it was wrong precisely where
     * it mattered: a 10% white capsule over a 5% white chip came out pure
     * WHITE instead of the near-black the dark theme actually paints
     * (r=255 against the true r=56), and reported two convincing AA failures
     * for text that passes comfortably. */
    const over = (fg, bg) => {
        const a = fg.a + bg.a * (1 - fg.a);
        if (!a) return {r: 0, g: 0, b: 0, a: 0};
        const mix = (f, b) => (f * fg.a + b * bg.a * (1 - fg.a)) / a;
        return {r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a};
    };

    function luminance(c) {
        const ch = [c.r, c.g, c.b].map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    }

    const ratio = (a, b) => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    };

    /** Composite every ancestor background down to one opaque colour. */
    function effectiveBg(el) {
        let acc = null;
        for (let node = el; node; node = node.parentElement) {
            const bg = parseRgb(getComputedStyle(node).backgroundColor);
            if (!bg || bg.a === 0) continue;
            acc = acc ? over(acc, bg) : bg;
            if (acc.a >= 1) return acc;
        }
        const root = parseRgb(getComputedStyle(document.documentElement).backgroundColor);
        const canvas = root && root.a >= 1 ? root : {r: 255, g: 255, b: 255, a: 1};
        return acc ? over(acc, canvas) : canvas;
    }

    /**
     * Walk every element with visible text and measure it against the surface
     * it really sits on. Reports only what fails.
     * @param {{root?: string, min?: number, all?: boolean}} [opts]
     */
    function contrast(opts = {}) {
        const root = $(opts.root || "body");
        const rows = [];
        for (const el of $$("*", root)) {
            const own = Array.from(el.childNodes)
                .filter((n) => n.nodeType === 3 && n.textContent.trim())
                .map((n) => n.textContent.trim()).join(" ");
            if (!own) continue;
            const box = el.getBoundingClientRect();
            if (!box.width || !box.height) continue;           // not rendered

            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.opacity === "0") continue;
            const bg = effectiveBg(el);
            const fgRaw = parseRgb(cs.color);
            if (!fgRaw) continue;
            const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;

            const px = parseFloat(cs.fontSize);
            const bold = Number(cs.fontWeight) >= 700;
            // WCAG large text: 24px, or 18.66px when bold
            const large = px >= 24 || (bold && px >= 18.66);
            const need = opts.min || (large ? 3 : 4.5);
            const got = ratio(fg, bg);
            if (opts.all || got < need) {
                rows.push({
                    text: own.slice(0, 40), ratio: Number(got.toFixed(2)), need,
                    px: Number(px.toFixed(1)), sel: selectorFor(el),
                    fg: cs.color, bg: `rgb(${[bg.r, bg.g, bg.b].map(Math.round).join(",")})`,
                });
            }
        }
        rows.sort((a, b) => a.ratio - b.ratio);
        const theme = document.documentElement.getAttribute("data-theme") || "dark";
        console.log(`%ccontrast · theme=${theme} · ${rows.length} ${opts.all ? "nodes" : "FAILURES"}`,
                    `color:${rows.length && !opts.all ? "#e66" : "#6c6"};font-weight:600`);
        console.table(rows.slice(0, 40));
        if (!opts.all && rows.length) {
            console.log("%cremember: this is only trustworthy on a real page load — " +
                        "use Oracle.theme(id) to switch, never setAttribute", "color:#ca6");
        }
        return rows;
    }

    /** Switch palette the only honest way: write the choice, then reload. */
    function theme(id) {
        localStorage.setItem("epsilook.theme", id);
        location.reload();
    }

    /* -------------------------------------------------------- pill snapshot */

    const CELLS = [".c-name", ".c-models", ".c-sounds", ".c-animations", ".c-fx", ".c-mechanics"];

    /** A stable path, so a diff points at something findable. */
    function selectorFor(el) {
        const parts = [];
        for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) {
            const cls = (n.className || "").toString().trim().split(/\s+/).filter(Boolean);
            parts.unshift(n.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : ""));
        }
        return parts.join(" > ");
    }

    /**
     * Canonical text of one subtree: tag, sorted attributes, text. Attribute
     * ORDER is an artifact of construction, so sorting is what makes a
     * refactor that reorders appendChild calls compare equal.
     */
    function canonical(node, depth = 0) {
        if (node.nodeType === 3) {
            const t = node.textContent.trim();
            return t ? `${"  ".repeat(depth)}"${t}"` : "";
        }
        if (node.nodeType !== 1) return "";
        const attrs = Array.from(node.attributes)
            .map((a) => `${a.name}=${JSON.stringify(a.value)}`).sort().join(" ");
        const head = `${"  ".repeat(depth)}<${node.tagName.toLowerCase()}${attrs ? " " + attrs : ""}>`;
        const kids = Array.from(node.childNodes)
            .map((k) => canonical(k, depth + 1)).filter(Boolean);
        return [head, ...kids].join("\n");
    }

    function hash(str) {                     // FNV-1a, enough to spot a change
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16).padStart(8, "0");
    }

    /**
     * Snapshot every pill-bearing cell across a query battery. Run it before a
     * refactor and after; identical `total` means nothing that renders moved.
     * The full text is left on Oracle.last so a differing hash can be chased.
     * @param {string[]} queries
     * @param {{rows?: number, v?: string}} [opts]
     */
    function pills(queries, opts = {}) {
        const rows = opts.rows || 4;
        const out = [];
        const dump = [];
        for (const query of (Array.isArray(queries) ? queries : [queries])) {
            one(query, opts.v);
            const trs = $$("#results tbody tr").slice(0, rows);
            const chunks = [];
            for (const tr of trs) {
                for (const sel of CELLS) {
                    const cell = $(sel, tr);
                    if (cell) chunks.push(`${query} ${sel}\n${canonical(cell)}`);
                }
            }
            const text = chunks.join("\n---\n");
            dump.push(text);
            out.push({query, cells: chunks.length, pills: $$("#results tbody .tag").length,
                      hash: hash(text)});
        }
        const text = dump.join("\n===\n");
        const total = hash(text);
        console.table(out);
        console.log(`%ctotal ${total}%c  ${out.length} queries · ` +
                    `${out.reduce((n, r) => n + r.cells, 0)} cells · ${text.length.toLocaleString()} chars`,
                    "font-weight:600", "color:#888");
        api.last = {total, rows: out, text};
        return {total, rows: out};
    }

    /* ---------------------------------------------------------------- misc */

    function help() {
        console.log(`%cOracle%c  measurement helpers · pack ${version() || "(none)"}
%cOracle.q(["fire", "model:>4"])            counts for a battery, synchronous
Oracle.q([...], {v: "11.2.7.65299"})      ... against another pack
Oracle.same([["count", 'model:"count >4"', "model:>4"]])
                                          assert queries agree - PASS/FAIL
Oracle.contrast()                         WCAG walk, failures only
Oracle.contrast({all: true})              ... every text node
Oracle.theme("moonwell")                  switch palette by RELOAD (see above)
Oracle.pills(["fire", "model:missile"])   canonical DOM snapshot + hash
Oracle.last.text                          the snapshot body, for diffing
Oracle.status()                           parse #status right now`,
            "font-weight:600;color:#c9a227", "color:#888", "color:inherit");
    }

    const api = {q, one, same, contrast, theme, pills, help, status: readStatus, version, last: null};
    console.log("%cOracle loaded%c — Oracle.help()", "color:#c9a227;font-weight:600", "color:#888");
    return api;
})();
