// @ts-check
/* Search engine: the field registry and group evaluation.
 *
 * A search is a list of groups {field, tokens: [{text}, ...]} — one group
 * per search-bar chip (plus one for the free text). Within a group, every
 * word must match the SAME entity (the same file name / spell name /
 * effect name). Groups AND together across the result sets, so two
 * model: chips mean "the spell uses a model matching chip 1 AND a model
 * matching chip 2" — not both words in one file. A group with not: true
 * excludes its matches instead. Free text (field "all") matches spell
 * names, model files, sound files, animation names and visual FX.
 *
 * Each field entry implements run(tokens, data, disabled) -> Set of
 * spell IDs. Adding a new searchable relation = adding one entry to
 * FIELDS (and, if it needs new data, extending build_data.py + data.js).
 *
 * Types (QueryToken, QueryGroup, SearchFieldSpec, SpellData) are declared
 * in types.d.ts.
 */
"use strict";

window.EpsilookSearch = (() => {

    // the pill-type registry: what each kind of fx content is called and how a
    // token matches it. Shared with app.js's hit-highlighting.
    const Pills = window.EpsilookPills;

    /* ------------------------------------------------------------ helpers */

    /**
     * Every token must appear in the (lowercased) haystack — substring match.
     * @param {string} haystackL
     * @param {QueryToken[]} tokens
     * @returns {boolean}
     */
    function textMatches(haystackL, tokens) {
        for (const t of tokens) {
            if (!haystackL.includes(t.text)) return false;
        }
        return true;
    }

    /* --------------------------------------------------- numeric tokens */

    /**
     * Parse a numeric-comparison token — "4", ">2", "<5", ">=8", "<=3", "=1"
     * — into a predicate (n) => boolean, or null when the token is not one.
     *
     * This is the single home for operator parsing: the fx column's numeric
     * categories (today just vehicle seat count, the first of what will be
     * several numeric pills) match through it, and app.js hit-highlighting
     * calls matchNumeric so a pill lights up under exactly the query that
     * selects it. A bare number means equality.
     *
     * The bound may be negative or fractional, because the values are: a
     * movement-speed change is signed (`fx:"speed <-50"`) and a handful of them
     * are fractional. Counts never are, and a count simply matches nothing
     * against a bound it cannot reach.
     * @param {string} text
     * @returns {((n: number) => boolean) | null}
     */
    function numericPredicate(text) {
        const m = /^(<=|>=|<|>|=)?(-?\d+(?:\.\d+)?)$/.exec(text);
        if (!m) return null;
        const v = Number(m[2]);
        switch (m[1]) {
            case "<":
                return (n) => n < v;
            case ">":
                return (n) => n > v;
            case "<=":
                return (n) => n <= v;
            case ">=":
                return (n) => n >= v;
            default:
                return (n) => n === v; // "=" or a bare number
        }
    }

    /**
     * True when `text` is a numeric-comparison token satisfied by `n`.
     * @param {string} text
     * @param {number} n
     * @returns {boolean}
     */
    function matchNumeric(text, n) {
        const p = numericPredicate(text);
        return p ? p(n) : false;
    }

    /**
     * True when a token carries a comparison operator (<, >, <=, >=, =) — i.e. it
     * asks for a numeric match rather than a value/word match. A bare number is
     * NOT an operator (it keeps its per-field literal meaning), per the search
     * convention that numeric comparison is opt-in via an operator.
     * @param {string} text
     * @returns {boolean}
     */
    function hasOperator(text) {
        return /^[<>=]/.test(text);
    }

    /* ------------------------------------------------------ count queries */

    /**
     * How many items a column renders for one spell. Adding a countable column
     * is one entry here — nothing else branches on the field.
     * @type {Record<string, (data: SpellData, spellId: number) => number>}
     */
    const COUNT_SOURCES = {
        model: (d, s) => (d.spellModelCats.size
            ? (d.spellModelCats.get(s) || []).length
            : (d.spellModels.get(s) || []).length),
        sound: (d, s) => (d.spellSounds.get(s) || []).length,
        // every animation pill: the loose ones, those inside each AnimKit, and
        // the headless "stance" / "passenger" groups
        anim: (d, s) => (d.spellVisualAnims.get(s) || []).length
            + (d.spellAnims.get(s) || []).length
            + (d.spellPassengerAnims.get(s) || []).length
            + (d.spellAnimKits.get(s) || [])
                .reduce((n, k) => n + (d.animKitAnims.get(k) || []).length, 0),
    };

    /**
     * A count query is a field chip holding exactly ONE token that is a numeric
     * comparison WITH an operator — `model:>4`, `anim:=3`, `sound:>=2`.
     *
     * Both halves of that rule carry weight. The operator is required because a
     * bare number already means a substring match (`model:2` finds
     * `cfx_fire_02.m2`) and that must keep working. Being alone in the chip is
     * required because `fx:"seat >2"` already reads its numeric as a seat
     * count — a second token means the field's own parser owns it.
     *
     * Returns null when the group is not a count query, so the caller falls
     * through to the normal field search.
     * @param {QueryToken[]} tokens
     * @param {string} field
     * @param {SpellData} data
     * @returns {Set<number> | null}
     */
    function spellsByCount(tokens, field, data) {
        const counter = COUNT_SOURCES[field];
        if (!counter || tokens.length !== 1) return null;
        const text = tokens[0].text;
        if (!/^(<=|>=|<|>|=)\d+$/.test(text)) return null;
        const pred = numericPredicate(text);
        if (!pred) return null;
        const out = new Set();
        for (const s of data.ids) {
            if (pred(counter(data, s))) out.add(s);
        }
        return out;
    }

    /* ------------------------------------------------ attachment points */

    /**
     * Attachment points are a META axis, addressed by the `attach` keyword —
     * `model:"attach chest"`, `fx:"attach spelllefthand fireball"` — never by
     * bare name (the point NAMES are data values, deliberately kept out of the
     * corpus and the autocomplete). The keyword lives INSIDE model:/fx: chips
     * so an attach point still narrows the SAME row as its file/category words:
     * a fireball model attached at the chest is one row, not "a fireball
     * somewhere and a chest attachment somewhere". `attach` consumes the token
     * that FOLLOWS it as the point name (whitespace, no colon), so two points
     * are `attach spelllefthand attach chest`.
     */
    const ATTACH_WORD = "attach";

    /**
     * The lowercased attachment names of one row, as a single haystack.
     * @param {number} src
     * @param {number} dst
     * @param {SpellData} data
     * @returns {string}
     */
    function attachmentWords(src, dst, data) {
        const a = src >= 0 ? (data.attachmentNames[src] || "") : "";
        const b = dst >= 0 ? (data.attachmentNames[dst] || "") : "";
        return (a && b ? `${a} ${b}` : a || b).toLowerCase();
    }

    /**
     * Split a group's tokens into the plain ones and the attachment-point
     * values — each `attach` keyword consumes the token after it as a point.
     * A trailing `attach` with nothing after it (still being typed) is dropped,
     * so it never constrains the row.
     * @param {QueryToken[]} tokens
     * @returns {{text: QueryToken[], attaches: string[]}}
     */
    function splitAttachTokens(tokens) {
        const text = [], attaches = [];
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].text === ATTACH_WORD) {
                const next = tokens[i + 1];
                if (next) {
                    attaches.push(next.text);
                    i++;
                }
            } else {
                text.push(tokens[i]);
            }
        }
        return {text, attaches};
    }

    /**
     * Every attachment value must appear in the row's attachment haystack — the
     * same substring convention the corpora use (`attach chest` hits Chest,
     * ChestBloodBack and ChestBloodFront).
     * @param {string[]} attaches
     * @param {string} attachL
     * @returns {boolean}
     */
    const attachesMatch = (attaches, attachL) => attaches.every((a) => attachL.includes(a));

    /* ------------------------------------------------- target-type words */

    /**
     * "Who does this play on" as query words, tested against a row's target
     * mask (TARGET_BITS in build_data.py) rather than matched as text.
     *
     * They have to be bit tests, not corpus words, for two reasons: the mask
     * lives on the ROW, so `model:"caster fireball"` must mean one row that is
     * both — not a spell that happens to have a caster row and a fireball row
     * — and "both" is a combination no single bit spells. "target" covers the
     * never-caster bit too: it keeps its own bit (and its own icon color) but
     * nobody searches for it by another name.
     *
     * Note the normal corpus path still substring-matches file names that
     * contain these words (beamtarget_onground) — the same accepted overlap as
     * fx:glow, which categoryRanker sorts out.
     */
    const TARGET_TESTS = {
        caster: (/** @type {number} */ m) => (m & 1) !== 0,
        target: (/** @type {number} */ m) => (m & (2 | 8)) !== 0,
        area: (/** @type {number} */ m) => (m & (4 | 16)) !== 0,
        both: (/** @type {number} */ m) => (m & 1) !== 0 && (m & 2) !== 0,
    };

    /** The words themselves, for autocomplete and the ranker. */
    const TARGET_WORDS = Object.keys(TARGET_TESTS);

    /**
     * Split a group's tokens into text tokens and target-mask tests.
     * A field with no masks simply never gets tests back.
     * @param {QueryToken[]} tokens
     * @returns {{text: QueryToken[], tests: ((mask: number) => boolean)[]}}
     */
    function splitTargetTokens(tokens) {
        const text = [], tests = [];
        for (const t of tokens) {
            const test = TARGET_TESTS[t.text];
            if (test) tests.push(test); else text.push(t);
        }
        return {text, tests};
    }

    /**
     * @param {((mask: number) => boolean)[]} tests
     * @param {number} mask
     */
    const maskMatches = (tests, mask) => tests.every((fn) => fn(mask));

    /**
     * Search file names within a scope of fids; return spells using the matches.
     * @param {QueryToken[]} tokens
     * @param {SpellData} data
     * @param {number[]} fids - the fids to scan (data.modelFids / data.soundFids)
     * @param {Map<number, number[]>} fileSpells - fid -> spell ids using it
     * @returns {Set<number>}
     */
    function spellsByFile(tokens, data, fids, fileSpells) {
        const out = new Set();
        for (const fid of fids) {
            const file = data.files.get(fid);
            if (file && textMatches(file.searchL, tokens)) {
                for (const s of fileSpells.get(fid)) out.add(s);
            }
        }
        return out;
    }

    /**
     * Search model file names — with usage categories in the corpus: each
     * (category, file) pair matches like the fx corpora, so a token may hit
     * the category word instead of the path. model:missile alone = every
     * spell with a projectile model; model:"attached backpack01" = spells
     * with that file attached (one chip, fx:"chain shadowlaser"-style).
     * A stale cached pack has no categories: plain file-name search.
     * @param {QueryToken[]} tokens
     * @param {SpellData} data
     * @returns {Set<number>}
     */
    function spellsByModel(tokens, data) {
        if (!data.modelCatFidSpells.size) {
            return spellsByFile(tokens, data, data.modelFids, data.modelSpells);
        }
        const out = new Set();
        const {text: withTests, attaches} = splitAttachTokens(tokens);
        const {text, tests} = splitTargetTokens(withTests);
        // Attachment points and the target mask both live on the ROW; the
        // (cat, fid) index below has neither, being shared across spells. Either
        // one in the query therefore forces the row walk.
        const itemL = (e) => (e.ref ? (data.itemSearchL.get(e.ref) || "") : "");
        if (tests.length || attaches.length) {
            for (const [s, entries] of data.spellModelCats) {
                for (const e of entries) {
                    if (tests.length && !maskMatches(tests, e.targets)) continue;
                    if (attaches.length && !attachesMatch(attaches, attachmentWords(e.src, e.dst, data))) continue;
                    const catL = data.modelCatNames[e.cat] || "";
                    const file = data.files.get(e.fid);
                    const searchL = file ? file.searchL : "";
                    // item rows also match on the item corpus (name / quality / id)
                    const item = itemL(e);
                    if (text.every((t) => catL.includes(t.text) || searchL.includes(t.text)
                        || (item && item.includes(t.text)))) {
                        out.add(s);
                        break;
                    }
                }
            }
            return out;
        }
        for (const [cat, fidSpells] of data.modelCatFidSpells) {
            const catL = data.modelCatNames[cat] || "";
            for (const [fid, spells] of fidSpells) {
                const file = data.files.get(fid);
                const searchL = file ? file.searchL : "";
                if (tokens.every((t) => catL.includes(t.text) || searchL.includes(t.text))) {
                    for (const s of spells) out.add(s);
                }
            }
        }
        // items add a NAME/quality dimension the (cat, fid) index above can't carry
        // (the same fid backs many differently-named items), so match the item
        // corpus directly — model:"item sickle axe" reaches spells by item name
        if (data.itemSpells && data.itemSpells.size) {
            for (const [itemId, spells] of data.itemSpells) {
                const corpus = data.itemSearchL.get(itemId) || "";
                if (corpus && tokens.every((t) => corpus.includes(t.text))) {
                    for (const s of spells) out.add(s);
                }
            }
        }
        return out;
    }

    /**
     * Search sound file names, honouring target words. The mask lives on the
     * (spell, kit, file) row, so a target word turns this into a row walk the
     * way it does for models.
     * @param {QueryToken[]} tokens
     * @param {SpellData} data
     * @returns {Set<number>}
     */
    function spellsBySound(tokens, data) {
        const {text, tests} = splitTargetTokens(tokens);
        if (!tests.length) {
            return spellsByFile(tokens, data, data.soundFids, data.soundSpells);
        }
        const out = new Set();
        for (const [s, entries] of data.spellSounds) {
            for (const e of entries) {
                if (!maskMatches(tests, e.targets)) continue;
                const file = data.files.get(e.fid);
                if (textMatches(file ? file.searchL : "", text)) {
                    out.add(s);
                    break;
                }
            }
        }
        return out;
    }

    /**
     * Search spell names (incl. subtexts and hidden override names).
     * @param {QueryToken[]} tokens
     * @param {SpellData} data
     * @returns {Set<number>}
     */
    function spellsByName(tokens, data) {
        const out = new Set();
        const {ids, namesL} = data;
        for (let i = 0; i < namesL.length; i++) {
            if (textMatches(namesL[i], tokens)) out.add(ids[i]);
        }
        return out;
    }

    /**
     * Search animation names; return spells whose AnimKits use the matches,
     * spells whose visual kits play a matching animation directly
     * (SpellVisualAnim — the loose pills), plus spells with a matching direct
     * stand/walk anim (proc Type 7). Stance anims render under a "stance"
     * group head, and that word joins their corpus — a token may hit "stance"
     * instead of the anim name (fx-corpus semantics), so anim:stance alone
     * finds every override and anim:"stance walk" scopes to walk overrides.
     * @param {QueryToken[]} tokens
     * @param {SpellData} data
     * @returns {Set<number>}
     */
    function spellsByAnim(tokens, data) {
        const out = new Set();
        const {text, tests} = splitTargetTokens(tokens);
        if (tests.length) {
            // per-row again: loose animations carry their own mask, animkit
            // animations inherit the kit's. Stance overrides have no mask.
            for (const [s, byAnim] of data.visualAnimTargets) {
                for (const [a, mask] of byAnim) {
                    if (maskMatches(tests, mask) && textMatches(data.animNamesL[a] || "", text)) {
                        out.add(s);
                        break;
                    }
                }
            }
            for (const [s, byKit] of data.animKitTargets) {
                for (const [kit, mask] of byKit) {
                    if (!maskMatches(tests, mask)) continue;
                    const anims = data.animKitAnims.get(kit) || [];
                    if (anims.some((a) => textMatches(data.animNamesL[a] || "", text))) {
                        out.add(s);
                        break;
                    }
                }
            }
            return out;
        }
        for (let a = 0; a < data.animNamesL.length; a++) {
            const nameL = data.animNamesL[a];
            if (textMatches(nameL, tokens)) {
                for (const kit of data.animAnimKits.get(a) || []) {
                    for (const s of data.animKitSpells.get(kit) || []) out.add(s);
                }
                for (const s of data.visualAnimSpells.get(a) || []) out.add(s);
            }
            if (tokens.every((t) => "stance".includes(t.text) || nameL.includes(t.text))) {
                for (const s of data.animDirectSpells.get(a) || []) out.add(s);
            }
            // passenger anims group under a "passenger" head, so that word joins
            // their corpus the same way "stance" does
            if (tokens.every((t) => "passenger".includes(t.text) || nameL.includes(t.text))) {
                for (const s of data.passengerAnimSpells.get(a) || []) out.add(s);
            }
        }
        return out;
    }

    /**
     * Search the visual FX column.
     *
     * Every fx type — chains, dissolves, colour effects, percents, morphs,
     * summons, the invisibility channels, keybinds — is a record in the pill-type
     * registry (docs/js/pilltypes.js) saying which corpus to read and which
     * numeric axes it answers to. Scanning them is therefore one loop, and the
     * app's hit-highlighting runs the SAME matcher on a single id, so a pill can
     * never light up under a query that did not select its spell.
     *
     * The one thing the registry cannot express is below: a chain's attachment
     * points live on the (spell, chain) ROW rather than on the chain, so they
     * cannot be baked into a per-id corpus.
     * @param {QueryToken[]} tokens
     * @param {SpellData} data
     * @returns {Set<number>}
     */
    function spellsByFx(tokens, data) {
        const out = new Set();
        for (const type of Pills.typesFor("fx")) Pills.scanType(type, data, tokens, out);

        // An `attach <point>` matches its points on the SAME row as any chain
        // corpus words — "a fireball beam launched from the left hand", not "a
        // fireball beam somewhere and a left-hand attachment somewhere".
        const {text: fxText, attaches} = splitAttachTokens(tokens);
        if (attaches.length) {
            for (const [s, rows] of data.spellChainRows) {
                for (const r of rows) {
                    if (!attachesMatch(attaches, attachmentWords(r.src, r.dst, data))) continue;
                    if (textMatches(data.fxSearchL.get(r.chain) || "", fxText)) {
                        out.add(s);
                        break;
                    }
                }
            }
        }
        return out;
    }

    /**
     * Exact numeric lookup against a Map of id -> [spell ids]. Multiple ids
     * union (OR) — used by id: chips and by kit-ID chips in sound:/anim:.
     * @param {QueryToken[]} tokens
     * @param {Map<number, number[]>} map
     * @returns {Set<number>}
     */
    function spellsByKitId(tokens, map) {
        const out = new Set();
        for (const t of tokens) {
            for (const s of map.get(Number(t.text)) || []) out.add(s);
        }
        return out;
    }

    /**
     * Set intersection (iterates the smaller set).
     * @param {Set<number>} a
     * @param {Set<number>} b
     * @returns {Set<number>}
     */
    function intersect(a, b) {
        if (a.size > b.size) [a, b] = [b, a];
        const out = new Set();
        for (const v of a) if (b.has(v)) out.add(v);
        return out;
    }

    /* ------------------------------------------------------ field registry */

    /** @type {Record<string, SearchFieldSpec>} */
    const FIELDS = {
        all: {
            label: "All", tab: false,
            run(tokens, data, disabled) {
                const out = spellsByName(tokens, data);
                if (!disabled.has("model")) {
                    for (const s of spellsByModel(tokens, data)) out.add(s);
                }
                if (!disabled.has("sound")) {
                    for (const s of spellsBySound(tokens, data)) out.add(s);
                }
                if (!disabled.has("anim")) {
                    for (const s of spellsByAnim(tokens, data)) out.add(s);
                }
                if (!disabled.has("fx")) {
                    for (const s of spellsByFx(tokens, data)) out.add(s);
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
            hint: "spell name, e.g. fire bolt", short: "spell name",
            run: (tokens, data) => spellsByName(tokens, data),
        },
        model: {
            label: "Model", tab: true,
            hint: "model file, e.g. 6dr statue", short: "model file",
            run: (tokens, data) => spellsByModel(tokens, data),
        },
        sound: {
            label: "Sound", tab: true,
            hint: "sound file or SoundKit ID, e.g. felreaver or 86835", short: "sound file / kit ID",
            // matches file names; an all-numbers chip is also an exact SoundKit ID
            // lookup (the old soundkit: field, folded in 2026-07-19) — several ids
            // in one chip union, like the old orGroups behavior
            run: (tokens, data) => {
                const out = spellsBySound(tokens, data);
                if (tokens.every((t) => /^\d+$/.test(t.text))) {
                    for (const s of spellsByKitId(tokens, data.soundKitSpells)) out.add(s);
                }
                return out;
            },
        },
        anim: {
            label: "Animation", tab: true,
            hint: "animation name or AnimKit ID, e.g. kneel or 13839", short: "animation / kit ID",
            // matches animation names; an all-numbers chip is also an exact
            // AnimKit ID lookup (the old animkit: field, folded in 2026-07-19)
            run: (tokens, data) => {
                const out = spellsByAnim(tokens, data);
                if (tokens.every((t) => /^\d+$/.test(t.text))) {
                    for (const s of spellsByKitId(tokens, data.animKitSpells)) out.add(s);
                }
                return out;
            },
        },
        fx: {
            label: "Effect", tab: true,
            hint: "visual effect, e.g. chain red", short: "visual effect",
            run: (tokens, data) => spellsByFx(tokens, data),
        },
        mech: {
            label: "Mechanic", tab: true,
            hint: "spell mechanic or target, e.g. resurrect", short: "mechanic / target",
            // The column's three name spaces share one field: what the effect does
            // (SPELL_EFFECT_*), what aura it applies (SPELL_AURA_*) and who it is
            // aimed at (TARGET_*, prefix stripped).
            //
            // Tokens are tested against a ROW, not against one name, so
            // mech:"school_damage unit_target_enemy" means "one effect that is both"
            // — the whole reason the targets are paired onto the effect rather than
            // pooled per spell. Matching that literally would mean building a corpus
            // string per row (372k of them on 9.2.7), so it is done on ids instead:
            // resolve each token to the id sets whose NAME contains it (~980 names
            // to scan), then a row matches when every token is satisfied by one of
            // the four ids the row carries.
            run(tokens, data) {
                const out = new Set();
                const idsFor = (/** @type {Map<number, string>} */ namesL,
                                /** @type {QueryToken} */ t) => {
                    const hits = new Set();
                    for (const [id, nameL] of namesL) if (nameL.includes(t.text)) hits.add(id);
                    return hits;
                };
                const per = tokens.map((t) => ({
                    effects: idsFor(data.effectNamesL, t),
                    auras: idsFor(data.auraNamesL, t),
                    targets: idsFor(data.implicitTargetNamesL, t),
                }));
                // a token matching no name anywhere can never be satisfied
                if (per.some((p) => !p.effects.size && !p.auras.size && !p.targets.size)) return out;
                // Sweep the rows as flat parallel arrays rather than the per-spell
                // Map of row objects — same rows, ~4x faster over 372k of them.
                // 0 means "no effect" / "no aura" / "target unset" on a row, so it
                // never counts as a match: SPELL_AURA_NONE really is named NONE, and
                // without that guard mech:none would return every aura-less row.
                const {spellIds, effects, auras, targetsA, targetsB} = data.mechanicCols;
                const nTokens = per.length;
                for (let i = 0; i < spellIds.length; i++) {
                    const e = effects[i], a = auras[i], tA = targetsA[i], tB = targetsB[i];
                    let ok = true;
                    for (let j = 0; j < nTokens; j++) {
                        const p = per[j];
                        if ((e && p.effects.has(e)) || (a && p.auras.has(a))
                            || (tA && p.targets.has(tA)) || (tB && p.targets.has(tB))) continue;
                        ok = false;
                        break;
                    }
                    if (ok) out.add(spellIds[i]);
                }
                return out;
            },
        },
        id: {
            label: "Spell ID", tab: true, orGroups: true,
            hint: "exact spell ID, e.g. 133", short: "spell ID",
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

    // groups: [{field, tokens: [{text}, ...], not}] with text lowercased
    // single words. One result set per group; positive groups intersect,
    // negative groups (not: true) subtract from the result. Exception:
    // groups of the same exact-ID field (orGroups — today only id:)
    // union together first, then that union intersects like one group — a
    // spell has only one ID, so ANDing two of them could never match.
    // (Kit IDs typed into sound:/anim: chips AND across chips like any
    // text field — a spell can carry two kits; ids inside ONE chip union.)
    // A query of only negative groups starts from all spells.
    // `disabledFields` (hidden columns) are skipped inside the "all" field;
    // explicit fields always run.
    /**
     * @param {QueryGroup[]} groups
     * @param {SpellData} data
     * @param {Set<string>} [disabledFields]
     * @returns {{spellIds: number[], ms: number}} matches + evaluation time
     */
    function searchGroups(groups, data, disabledFields = new Set()) {
        const t0 = performance.now();

        /** @type {Set<number> | null} */
        let result = null;
        /** @type {QueryGroup[]} */
        const negatives = [];
        /** @type {Map<string, Set<number>>} field -> union of that field's group results */
        const orUnions = new Map();
        for (const g of groups) {
            if (!g.tokens.length) continue;
            if (g.not) {
                negatives.push(g);
                continue;
            }
            const field = FIELDS[g.field] ? g.field : "all";
            const set = spellsByCount(g.tokens, field, data)
                || FIELDS[field].run(g.tokens, data, disabledFields);
            if (FIELDS[field].orGroups) {
                const u = orUnions.get(field);
                if (u) {
                    for (const v of set) u.add(v);
                } else orUnions.set(field, set);
                continue;
            }
            result = result === null ? set : intersect(result, set);
            if (result.size === 0) break;
        }
        for (const set of orUnions.values()) {
            result = result === null ? set : intersect(result, set);
        }
        if (result === null) result = negatives.length ? new Set(data.ids) : new Set();

        for (const g of negatives) {
            if (result.size === 0) break;
            const field = FIELDS[g.field] ? g.field : "all";
            const set = spellsByCount(g.tokens, field, data)
                || FIELDS[field].run(g.tokens, data, disabledFields);
            for (const id of set) result.delete(id);
        }

        return {spellIds: [...result], ms: performance.now() - t0};
    }

    /**
     * Relevance sort (in place) for name searches: exact > starts-with >
     * substring, then by ID.
     * @param {number[]} spellIds
     * @param {string} rawQuery
     * @param {SpellData} data
     * @returns {number[]} the same array, sorted
     */
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

    return {searchGroups, sortByRelevance, FIELDS, TARGET_WORDS, matchNumeric, hasOperator};
})();
