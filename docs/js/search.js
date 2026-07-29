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
 * Each field entry implements run(tokens, data) -> Set of spell IDs.
 * Adding a new searchable relation = adding one entry to FIELDS (and, if
 * it needs new data, extending build_data.py + data.js).
 *
 * Nothing here reads UI state. Which columns are on screen is a display
 * preference and must never reach a result set — see FIELDS.all.
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
    /** The reserved word for a column's own size — one meaning in every field. */
    const COUNT_AXIS = "count";

    const COUNT_SOURCES = {
        model: (d, s) => (d.spellModelCats.size
            ? (d.spellModelCats.get(s) || []).length
            : (d.spellModels.get(s) || []).length),
        sound: (d, s) => (d.spellSounds.get(s) || []).length,
        // every animation pill: the loose ones, those inside each AnimKit, and
        // the headless "replace" / "passenger" groups
        anim: (d, s) => (d.spellVisualAnims.get(s) || []).length
            + (d.spellReplaceAnims.get(s) || []).length
            + (d.spellPassengerAnims.get(s) || []).length
            + (d.spellAnimKits.get(s) || [])
                .reduce((n, k) => n + (d.animKitAnims.get(k) || []).length, 0),
    };

    /**
     * `count` is the size of the column itself, and it is written the way every
     * other value is: the word, then its comparison.
     *
     *   model:"count >4"   sound:"count =0"   fx:"chain count >2"
     *
     * A LONE comparison is its shorthand, which is what that chip has always
     * meant: `model:>4` is `model:"count >4"`. The operator is required either
     * way, because a bare `model:2` is still a substring search for "2".
     *
     * Being a word rather than a private form is what makes it commutative with
     * the chip's other tokens — the same rule as `seat >2` one column over.
     *
     * NOTE the count is the WHOLE column's, not the count of the rows matching
     * the chip's other tokens: `model:"caster count >4"` reads as "a caster
     * model, and more than four models in all". Narrowing it to the matching
     * rows needs the column matchers rebuilt as per-spell entry iterators, which
     * is its own pass.
     * @param {QueryToken[]} tokens
     * @param {boolean} countable does this field have anything to count?
     * @returns {{text: QueryToken[], counts: ((n: number) => boolean)[]}}
     */
    function splitCountTokens(tokens, countable) {
        if (!countable) return {text: tokens, counts: []};
        const text = [], counts = [];
        const isCmp = (t) => t && /^(<=|>=|<|>|=)-?\d+(?:\.\d+)?$/.test(t.text);
        // the shorthand: one comparison, alone, with no word in front of it
        const lone = tokens.length === 1 && isCmp(tokens[0]);
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].text === COUNT_AXIS && isCmp(tokens[i + 1])) {
                counts.push(numericPredicate(tokens[i + 1].text));
                i++;
                continue;
            }
            if (lone) {
                counts.push(numericPredicate(tokens[i].text));
                continue;
            }
            text.push(tokens[i]);
        }
        return {text, counts};
    }

    /**
     * One chip's spells: its cardinality constraints intersected with whatever
     * its remaining tokens select. A chip with no count token is just the
     * field's own search, which is the common case and costs nothing extra.
     * @param {QueryToken[]} tokens
     * @param {string} field
     * @param {SpellData} data
     * @returns {Set<number>}
     */
    function spellsForChip(tokens, field, data) {
        const counter = COUNT_SOURCES[field];
        const {text, counts} = splitCountTokens(tokens, !!counter);
        if (!counts.length) return FIELDS[field].run(tokens, data);
        const base = text.length ? FIELDS[field].run(text, data) : data.ids;
        const out = new Set();
        for (const s of base) {
            const n = counter(data, s);
            if (counts.every((p) => p(n))) out.add(s);
        }
        return out;
    }

    /* --------------------------------------------------- meta keywords */

    /**
     * A META keyword addresses a PLACE rather than content — where on the model
     * something plays, which body region an animation moves. It is written as
     * the keyword followed by its value, space-separated like every other value
     * in the language:
     *
     *   model:"attach chest"   fx:"chain attach spelllefthand"
     *   anim:"boneset upper body"
     *
     * HOW MANY WORDS THE VALUE TAKES IS DECIDED BY THE DATA, not by a per-
     * keyword arity: the keyword consumes the LONGEST following run of words
     * that still names something real. `boneset upper body` takes two words
     * because a region is called that; `boneset head kneel` takes one, because
     * nothing is called "head kneel", which leaves `kneel` to match the
     * animation as usual.
     *
     * QUOTES OVERRIDE IT. `attach "right hand"` takes exactly those two words
     * whatever the data would have taken on its own, and `boneset "head" kneel`
     * takes exactly one. That is the escape hatch the data rule needs: without
     * it the extent is something you can only observe, never state, and the two
     * keywords behave differently for reasons the user cannot see. Quotes here
     * GROUP (they mark where the value ends) rather than demand an exact
     * phrase — the same job they do around a whole tag value.
     *
     * That one rule replaced `attach` taking exactly one word while `boneset`
     * swallowed the whole rest of the chip — an arity you could not see and had
     * to know. It is also what the search bar DRAWS: the capsule around a
     * keyword and its value covers exactly the words consumed here, so the
     * arity is on screen instead of in someone's head.
     *
     * The keyword lives INSIDE the field chip so its value still narrows the
     * SAME row as the chip's file/category words: a fireball model attached at
     * the chest is one row, not "a fireball somewhere and a chest attachment
     * somewhere". Two points are two keywords —
     * `attach spelllefthand attach chest`.
     *
     * The point/region NAMES stay data values: never in a corpus, never offered
     * by autocomplete. Only the keyword itself is vocabulary.
     * @type {Record<string, {fields: string[], value: string, example: string,
     *                        names: (d: SpellData) => string[]}>}
     */
    const META_KEYWORDS = {
        attach: {
            fields: ["model", "fx"],
            value: "attachment point",
            example: 'model:"attach chest"',
            names: (d) => Object.values(d.attachmentNames || {}),
        },
        boneset: {
            fields: ["anim"],
            value: "body region",
            example: 'anim:"boneset upper body"',
            names: (d) => d.bonesetNames || [],
        },
    };

    const ATTACH_WORD = "attach";
    const BONESET_WORD = "boneset";

    /** The keywords one field can carry. */
    const keywordsIn = (field) =>
        Object.keys(META_KEYWORDS).filter((w) => META_KEYWORDS[w].fields.includes(field));

    /* The name pool a keyword's value is measured against, lowercased once per
     * pack — `knows` runs per candidate run, per token, per chip. */
    const poolCache = new WeakMap();

    function namePool(word, data) {
        let byWord = poolCache.get(data);
        if (!byWord) poolCache.set(data, byWord = new Map());
        let pool = byWord.get(word);
        if (!pool) {
            pool = (META_KEYWORDS[word].names(data) || [])
                .filter(Boolean).map((n) => n.toLowerCase());
            byWord.set(word, pool);
        }
        return pool;
    }

    /**
     * Does one name answer to one keyword value? EVERY WORD of the value must
     * appear in the name — separately, in any order — rather than the value
     * having to be a substring of it whole.
     *
     * Word-wise is the only rule that works for both name pools, and getting it
     * wrong is what made the two keywords look like different features. Body
     * regions are written as words ("Upper Body"), so a phrase test reads them
     * fine; M2 attachment points are jammed together ("HandRight",
     * "SpellLeftHand"), so a phrase test could never take more than one word —
     * `attach right hand` silently kept `hand` as a FILE-name search and gave
     * 26,000 results. Word-wise, both take two words and mean it.
     *
     * Each word is still a substring of the name, like every other match in the
     * app: `attach ch` reaches Chest while it is still being typed.
     * @param {string} nameL a lowercased name from the pool
     * @param {string} value one keyword value ("right hand")
     * @returns {boolean}
     */
    function nameHasValue(nameL, value) {
        for (const w of value.split(" ")) {
            if (w && !nameL.includes(w)) return false;
        }
        return true;
    }

    /**
     * Every value must be answered by SOME ONE name. Per name, not against the
     * names joined together: a row attached at HandRight and ShoulderLeft is
     * not a "right shoulder" attachment, and a spell animating Left Hand and
     * Right Arm does not animate a "left arm".
     * @param {string[]} values
     * @param {string[]} namesL lowercased names the row/spell carries
     * @returns {boolean}
     */
    const matchesNames = (values, namesL) =>
        values.every((v) => namesL.some((n) => nameHasValue(n, v)));

    /**
     * How many tokens after `tokens[i]` the keyword there takes as its value.
     * 0 = it names nothing real, so it is not acting as a keyword at all and
     * falls through to being ordinary text.
     *
     * A QUOTED token is taken whole and unconditionally — that is the user
     * saying where the value ends, and it has to hold even while the value is
     * half-typed and names nothing yet.
     *
     * An alternation counts when ANY of its alternatives names something
     * (`attach right|left`), because that is what the engine will ask once
     * expandAlts has distributed it.
     * @param {{text: string, quoted?: boolean}[]} tokens
     * @param {number} i index of the keyword token
     * @param {SpellData} data
     * @returns {number}
     */
    function keywordRun(tokens, i, data) {
        if (tokens[i + 1] && tokens[i + 1].quoted) return 1;
        const pool = namePool(tokens[i].text, data);
        const knows = (s) => s.split("|").filter(Boolean)
            .some((alt) => pool.some((n) => nameHasValue(n, alt)));
        let taken = 0, run = "";
        for (let n = 1; i + n < tokens.length; n++) {
            // a quoted token further along is its own thing (a phrase, or
            // another keyword's stated value) and never gets swallowed
            if (tokens[i + n].quoted) break;
            const cand = run ? run + " " + tokens[i + n].text : tokens[i + n].text;
            if (!knows(cand)) break;
            run = cand;
            taken = n;
        }
        return taken;
    }

    /**
     * Split a chip's tokens into the plain ones and one keyword's values.
     * A keyword with nothing usable after it stays in `text` — an unrecognised
     * phrase is a plain text search, never an error.
     * @param {QueryToken[]} tokens
     * @param {string} word
     * @param {SpellData} data
     * @returns {{text: QueryToken[], values: string[]}}
     */
    function splitKeyword(tokens, word, data) {
        if (!META_KEYWORDS[word]) return {text: tokens, values: []};
        const text = [], values = [];
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].text !== word) {
                text.push(tokens[i]);
                continue;
            }
            const taken = keywordRun(tokens, i, data);
            if (!taken) {
                text.push(tokens[i]);
                continue;
            }
            values.push(tokens.slice(i + 1, i + 1 + taken).map((t) => t.text).join(" "));
            i += taken;
        }
        return {text, values};
    }

    /**
     * The lowercased attachment names one row carries — one entry per point, so
     * `attach right hand` is measured against HandRight on its own rather than
     * against it and the row's other point run together.
     * @param {number} src
     * @param {number} dst
     * @param {SpellData} data
     * @returns {string[]}
     */
    function attachmentNamesOf(src, dst, data) {
        const out = [];
        for (const a of [src, dst]) {
            const n = a >= 0 ? (data.attachmentNames[a] || "") : "";
            if (n) out.push(n.toLowerCase());
        }
        return out;
    }

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
        const {text: withTests, values: attaches} = splitKeyword(tokens, ATTACH_WORD, data);
        const {text, tests} = splitTargetTokens(withTests);
        // everything below reads `text`, never the raw tokens, so a keyword and
        // its value are accounted for exactly once
        tokens = text;
        // Attachment points and the target mask both live on the ROW; the
        // (cat, fid) index below has neither, being shared across spells. Either
        // one in the query therefore forces the row walk.
        const itemL = (e) => (e.ref ? (data.itemSearchL.get(e.ref) || "") : "");
        if (tests.length || attaches.length) {
            for (const [s, entries] of data.spellModelCats) {
                for (const e of entries) {
                    if (tests.length && !maskMatches(tests, e.targets)) continue;
                    if (attaches.length && !matchesNames(attaches, attachmentNamesOf(e.src, e.dst, data))) continue;
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
        // model-column types that carry their own corpus rather than riding the
        // (category, file) index — mounts today. The registry drives them, so a
        // future one needs no line here; the file-based categories declare no
        // `spells` and scanType skips them.
        for (const type of Pills.typesFor("model")) Pills.scanType(type, data, tokens, out);
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

        // bonesets: `boneset upper body` matches spells whose AnimKits animate
        // that region. The keyword takes as many following words as still name a
        // real region and no more (keywordRun), so `boneset head kneel` is the
        // head region AND a kneel animation — it used to be a search for a
        // region called "head kneel", which nothing is. Whatever is left is
        // ordinary anim text and still has to match, so the two intersect.
        const bones = splitKeyword(tokens, BONESET_WORD, data);
        tokens = bones.text;
        if (bones.values.length) {
            for (const [s, names] of data.spellBonesets) {
                if (matchesNames(bones.values, names)) out.add(s);
            }
            if (tokens.length) {
                const animMatch = spellsByAnim(tokens, data);
                for (const s of [...out]) if (!animMatch.has(s)) out.delete(s);
            }
            return out;
        }

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
            // animation replacements group under a "replace" head; that word, or
            // an anim name on either side of a swap, joins their corpus
            if (tokens.every((t) => "replace".includes(t.text) || nameL.includes(t.text))) {
                for (const s of data.replaceSpells.get(a) || []) out.add(s);
            }
            // passenger anims group under a "passenger" head, so that word joins
            // their corpus the same way "replace" does
            if (tokens.every((t) => "passenger".includes(t.text) || nameL.includes(t.text))) {
                for (const s of data.passengerAnimSpells.get(a) || []) out.add(s);
            }
        }
        // anim-column types that carry their own `spells` corpus (none today —
        // replace/stance/passenger are headless, matched in the loop above); kept
        // as the extension point for a future one, like the model side.
        for (const type of Pills.typesFor("anim")) Pills.scanType(type, data, tokens, out);
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
        const {text: fxText, values: attaches} = splitKeyword(tokens, ATTACH_WORD, data);
        if (attaches.length) {
            for (const [s, rows] of data.spellChainRows) {
                for (const r of rows) {
                    if (!matchesNames(attaches, attachmentNamesOf(r.src, r.dst, data))) continue;
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

    /* ---------------------------------------------------------- alternation */

    /**
     * Expand a chip's tokens into every combination of their alternatives:
     * `model:"fire|frost missile"` becomes `model:"fire missile"` and
     * `model:"frost missile"`, which the caller unions.
     *
     * DISTRIBUTING HERE is the whole design. The alternative — teaching each
     * matcher to loop over alternatives — would mean spelling `|` into the text
     * axis, the numeric axis, the attachment-point walk, the target-mask tests
     * and the kit-id lookup separately, and again into every axis added later.
     * Instead every matcher keeps its single-token code path and gets `|` for
     * free, which is what makes the operator mean the same thing in every chip.
     *
     * It also preserves the same-row invariant exactly: each combination is an
     * ordinary chip, so "a fire missile OR a frost missile" never degrades into
     * "something fiery somewhere and a missile somewhere".
     *
     * Cost is the product of the alternative counts. Real chips are one or two
     * tokens with two or three alternatives, so this is a handful of scans; a
     * pathological chip is correspondingly slow, which is the honest trade.
     * @param {QueryToken[]} tokens
     * @returns {QueryToken[][]}
     */
    function expandAlts(tokens) {
        /** @type {QueryToken[][]} */
        let combos = [[]];
        for (const t of tokens) {
            const alts = (t.alts && t.alts.length) ? t.alts : [t.text];
            /** @type {QueryToken[][]} */
            const next = [];
            // `quoted` has to survive the distribution: it is what tells
            // keywordRun the user stated this value's extent, and splitKeyword
            // runs downstream of here
            for (const c of combos) for (const a of alts) next.push(c.concat([{text: a, quoted: t.quoted}]));
            combos = next;
        }
        return combos;
    }

    /** A group's combinations, computed once and cached on the group. */
    function combosOf(group) {
        if (!group.combos) group.combos = expandAlts(group.tokens);
        return group.combos;
    }

    /**
     * One chip's result set: the union over its alternation combinations.
     * @param {QueryGroup} g
     * @param {SpellData} data
     * @returns {Set<number>}
     */
    function runGroup(g, data) {
        const field = FIELDS[g.field] ? g.field : "all";
        const combos = combosOf(g);
        const one = (/** @type {QueryToken[]} */ tokens) =>
            spellsForChip(tokens, field, data);
        if (combos.length === 1) return one(combos[0]);
        const out = new Set();
        for (const tokens of combos) for (const s of one(tokens)) out.add(s);
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
            // Chipless search reads the same five content fields every time, and
            // never consults which columns are on screen: hiding a column is a
            // display preference (persisted per browser in localStorage, absent
            // from the URL), so letting it narrow the result set made one shared
            // link return different spells — and different exports — to different
            // people, with nothing in the link to explain why. Display is display.
            //
            // `mech` is the one field deliberately NOT here (it never was): its
            // corpus is enum names — SPELL_EFFECT_SCHOOL_DAMAGE, UNIT_TARGET_ENEMY
            // — so free text like "damage" or "enemy" would drag in most of the
            // game. It stays reachable only through an explicit mech: chip.
            run(tokens, data) {
                const out = spellsByName(tokens, data);
                for (const s of spellsByModel(tokens, data)) out.add(s);
                for (const s of spellsBySound(tokens, data)) out.add(s);
                for (const s of spellsByAnim(tokens, data)) out.add(s);
                for (const s of spellsByFx(tokens, data)) out.add(s);
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
                // Pill types declared for this column — the non-visual half of
                // what used to be fx (seat, invis, detect, keybind, speed).
                // Mirrors the identical loop in spellsByFx: the registry says
                // which column owns a type, so moving one between columns needs
                // no change here. Their spells UNION with the enum rows below.
                for (const type of Pills.typesFor("mech")) Pills.scanType(type, data, tokens, out);
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
    // The result set is a function of the QUERY ALONE — no display state feeds
    // in (see FIELDS.all), so the same URL yields the same spells everywhere.
    /**
     * @param {QueryGroup[]} groups
     * @param {SpellData} data
     * @returns {{spellIds: number[], ms: number}} matches + evaluation time
     */
    function searchGroups(groups, data) {
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
            const set = runGroup(g, data);
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
            for (const id of runGroup(g, data)) result.delete(id);
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

    return {
        searchGroups, sortByRelevance, expandAlts, combosOf,
        FIELDS, TARGET_WORDS, matchNumeric, hasOperator,
        META_KEYWORDS, keywordsIn, keywordRun, splitKeyword, matchesNames,
        COUNT_AXIS, COUNT_SOURCES,
    };
})();
