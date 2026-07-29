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
 * it needs new data, extending build_data.py + data.ts).
 *
 * Nothing here reads UI state. Which columns are on screen is a display
 * preference and must never reach a result set — see FIELDS.all.
 */
import type {SpellData} from "./data";
// the pill-type registry: what each kind of fx content is called and how a
// token matches it. Shared with the app's hit-highlighting.
import * as Pills from "./pills";

/* -------------------------------------------------------------- types */

/** One search word (or exact "quoted phrase", spaces preserved). */
export interface QueryToken {
    text: string;
    /**
     * The values any one of which satisfies this token — `fire|frost` has two.
     * A plain token has one (or none, when a token is synthesised by
     * expandAlts, which has already resolved the choice).
     */
    alts?: string[];
}

/**
 * One search group = one bar chip (or the free text). Within a group every
 * token must match the same entity; groups AND together across spells.
 */
export interface QueryGroup {
    /** A FIELDS key; unknown fields fall back to "all". */
    field: string;
    tokens: QueryToken[];
    /** true = the group excludes its matches instead. */
    not?: boolean;
    /**
     * The token combinations this group expands to once alternation is
     * distributed (see expandAlts). Cached by combosOf on first use; both
     * selection and hit-highlighting read it, which is what keeps them
     * agreeing about what `|` selected.
     */
    combos?: QueryToken[][];
}

/** One entry of the FIELDS registry — a search prefix + its field button. */
export interface SearchFieldSpec {
    /** Button label ("Model"). */
    label: string;
    /** Whether the field gets a button in the tab strip. */
    tab: boolean;
    /** Longer example hint shown in autocomplete. */
    hint?: string;
    /** Short placeholder text while the chip is being typed. */
    short?: string;
    /** Exact-ID field: multiple groups of it union (OR) before ANDing. */
    orGroups?: boolean;

    /** Evaluate one group. Takes no UI state: a result set is a function of
     *  the query alone (hidden columns are display-only). */
    run(tokens: QueryToken[], data: SpellData): Set<number>;
}

/* ------------------------------------------------------------ helpers */

/** Every token must appear in the (lowercased) haystack — substring match. */
function textMatches(haystackL: string, tokens: QueryToken[]): boolean {
    for (const t of tokens) {
        if (!haystackL.includes(t.text)) return false;
    }
    return true;
}

/* --------------------------------------------------- numeric tokens */

/* The numeric grammar — VALUE_RE, numericTest, hasOperator, matchNumeric —
 * lives in pills.ts and is reached through `Pills.` from here. It used to be
 * spelled again in this file, once as a byte-identical copy of numericTest
 * under another name; a comment above it claimed to be its single home and
 * was wrong. The bound may be negative or fractional, because the values
 * are: a movement-speed change is signed (`mech:"speed <-50"`) and a handful
 * of them are fractional. Counts never are, and a count simply matches
 * nothing against a bound it cannot reach. */

/* ------------------------------------------------------ count queries */

/** The reserved word for a column's own size — one meaning in every field. */
export const COUNT_AXIS = "count";

/**
 * How many items a column renders for one spell. Adding a countable column
 * is one entry here — nothing else branches on the field.
 */
export const COUNT_SOURCES: Record<string, (data: SpellData, spellId: number) => number> = {
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
 *   model:"count >4"   sound:"count =0"   fx:"chain count >2"   anim:"count 3"
 *
 * A LONE comparison is its shorthand, which is what that chip has always
 * meant: `model:>4` is `model:"count >4"`. THE SHORTHAND STILL NEEDS ITS
 * OPERATOR, and only the shorthand does: written against the word a bare
 * number is the word's argument and means `=` (`count 3` is `count =3`,
 * like every other numeric word), but standing alone it is nothing of the
 * sort — a bare `model:2` is a substring search for "2" and always has been.
 *
 * Being a word rather than a private form is what makes it commutative with
 * the chip's other tokens — the same rule as `seat >2` one column over.
 *
 * NOTE the count is the WHOLE column's, not the count of the rows matching
 * the chip's other tokens: `model:"caster count >4"` reads as "a caster
 * model, and more than four models in all". Narrowing it to the matching
 * rows needs the column matchers rebuilt as per-spell entry iterators, which
 * is its own pass.
 */
function splitCountTokens(tokens: QueryToken[], countable: boolean):
    { text: QueryToken[]; counts: ((n: number) => boolean)[] } {
    if (!countable) return {text: tokens, counts: []};
    const text: QueryToken[] = [], counts: ((n: number) => boolean)[] = [];
    // an argument of the word — a comparison, or the bare number that means "="
    const isValue = (t: QueryToken | undefined) => !!t && Pills.isValue(t.text);
    // a comparison that WROTE its operator, which only the shorthand needs
    const isCmp = (t: QueryToken | undefined) => isValue(t) && Pills.hasOperator(t!.text);
    // the shorthand: one comparison, alone, with no word in front of it
    const lone = tokens.length === 1 && isCmp(tokens[0]);
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].text === COUNT_AXIS && isValue(tokens[i + 1])) {
            counts.push(Pills.numericTest(tokens[i + 1].text)!);
            i++;
            continue;
        }
        if (lone) {
            counts.push(Pills.numericTest(tokens[i].text)!);
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
 */
function spellsForChip(tokens: QueryToken[], field: string, data: SpellData): Set<number> {
    const counter = COUNT_SOURCES[field];
    const {text, counts} = splitCountTokens(tokens, !!counter);
    if (!counts.length) return FIELDS[field].run(tokens, data);
    const base: Iterable<number> = text.length ? FIELDS[field].run(text, data) : data.ids;
    const out = new Set<number>();
    for (const s of base) {
        const n = counter(data, s);
        if (counts.every((p) => p(n))) out.add(s);
    }
    return out;
}

/* --------------------------------------------------- meta keywords */

/**
 * A META keyword addresses a PLACE rather than content — where on the model
 * something plays, which body region an animation moves.
 *
 * ONE RULE, AND IT NEVER VARIES: **the keyword takes the single token after
 * it.** A "quoted phrase" is one token, so that is also how a value with a
 * space in it is written:
 *
 *   model:"attach chest"          fx:"chain attach spelllefthand"
 *   model:(attach "right hand")   anim:(boneset "upper body")
 *
 * So the scope is always visible and always the same size: you go IN at the
 * keyword and OUT one token later, wherever you are and whatever the value
 * says. Everything after that token is an ordinary search word again —
 * `attach chest fire` is "attached at the chest" AND "fire" in the file
 * name, and the capsule the bar draws shows exactly that split.
 *
 * THIS REPLACED AN ARITY DECIDED BY THE DATA — the keyword used to eat the
 * longest following run of words that still named something real. It could
 * not be predicted or seen: `attach back left` took one word (leaking `left`
 * into a file-name search) while `attach spell left hand` took three, and
 * nothing on screen said which had happened. Do NOT reintroduce a variable
 * arity, however clever the rule; a scope you cannot count is worse than one
 * that occasionally needs quotes.
 *
 * The keyword lives INSIDE the field chip so its value still narrows the
 * SAME row as the chip's file/category words: a fireball model attached at
 * the chest is one row, not "a fireball somewhere and a chest attachment
 * somewhere". Two points are two keywords —
 * `attach spelllefthand attach chest`.
 *
 * The point/region NAMES stay data values: never in a corpus, never offered
 * by autocomplete. Only the keyword itself is vocabulary — which is why this
 * record carries no name list: nothing consults the data to parse a value.
 */
export const META_KEYWORDS: Record<string, {
    fields: string[]; hint: string;
    when?(d: SpellData): boolean;
}> = {
    attach: {
        fields: ["model", "fx"],
        hint: 'Attachment point — attach chest, attach "right hand"',
        when: (d) => Object.keys(d.attachmentNames || {}).length > 0,
    },
    boneset: {
        fields: ["anim"],
        hint: 'Body region — boneset head, boneset "upper body"',
        when: (d) => (d.bonesetNames || []).length > 0,
    },
};

/* The two meta keywords by name, for the code that has to spell one rather
 * than iterate them — this module's own matchers, and the pill builders that
 * write a keyword search back out. They are the record's own keys, so they
 * live with it: a second copy sat in app/autocomplete.ts, exported for no
 * reason other than that the pills imported it from there. */
export const ATTACH_WORD = "attach";
export const BONESET_WORD = "boneset";

/**
 * The keywords one field can carry, minus any the loaded pack has no data
 * for. Autocomplete and the bar's highlighter both read this, so a keyword
 * can never be suggested in a pack where it would match nothing.
 */
export const keywordsIn = (field: string, data?: SpellData): string[] =>
    Object.keys(META_KEYWORDS).filter((w) => META_KEYWORDS[w].fields.includes(field)
        && (!data || !META_KEYWORDS[w].when || META_KEYWORDS[w].when!(data)));

/**
 * A keyword and its value written back as query text — quoted exactly when
 * the value would otherwise be more than one token. Every pill that offers a
 * keyword search builds its query here, so what a click produces is always
 * something the parser reads back the same way.
 */
export const keywordValue = (word: string, value: string): string =>
    `${word} ${/\s/.test(value) ? `"${value}"` : value}`;

/**
 * Does one name answer to one keyword value? EVERY WORD of the value must
 * appear in the name — separately, in any order — rather than the value
 * having to be a substring of it whole.
 *
 * Word-wise is what lets ONE spelling reach both pools, which otherwise
 * write the same idea two ways: body regions are spaced ("Upper Body"),
 * M2 attachment points are jammed together ("HandRight", "SpellLeftHand").
 * A whole-string test would find `"upper body"` and miss `"right hand"`, so
 * the two keywords would need different values for the same-shaped question.
 *
 * Each word is still a substring of the name, like every other match in the
 * app: `attach ch` reaches Chest while it is still being typed.
 */
function nameHasValue(nameL: string, value: string): boolean {
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
 */
export const matchesNames = (values: string[], namesL: string[]): boolean =>
    values.every((v) => namesL.some((n) => nameHasValue(n, v)));

/**
 * How many tokens after `tokens[i]` the keyword there takes as its value:
 * ONE, or none when the keyword is the chip's last token (a keyword with
 * nothing after it is just a word, and searches as one).
 *
 * Trivial on purpose, and still a function: the bar's capsule is drawn from
 * this exact call, so what the highlighter covers and what the matcher
 * consumes cannot drift apart.
 */
export const keywordRun = (tokens: { text: string }[], i: number): number =>
    (tokens[i + 1] ? 1 : 0);

/**
 * Split a chip's tokens into the plain ones and one keyword's values.
 * A trailing keyword with nothing after it stays in `text` — an
 * unrecognised phrase is a plain text search, never an error.
 */
export function splitKeyword(tokens: QueryToken[], word: string):
    { text: QueryToken[]; values: string[] } {
    if (!META_KEYWORDS[word]) return {text: tokens, values: []};
    const text: QueryToken[] = [], values: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].text === word && keywordRun(tokens, i)) {
            values.push(tokens[i + 1].text);
            i++;
            continue;
        }
        text.push(tokens[i]);
    }
    return {text, values};
}

/**
 * The lowercased attachment names one row carries — one entry per point, so
 * `attach right hand` is measured against HandRight on its own rather than
 * against it and the row's other point run together.
 */
function attachmentNamesOf(src: number, dst: number, data: SpellData): string[] {
    const out: string[] = [];
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
const TARGET_TESTS: Record<string, (m: number) => boolean> = {
    caster: (m) => (m & 1) !== 0,
    target: (m) => (m & (2 | 8)) !== 0,
    area: (m) => (m & (4 | 16)) !== 0,
    both: (m) => (m & 1) !== 0 && (m & 2) !== 0,
};

/** The words themselves, for autocomplete and the ranker. */
export const TARGET_WORDS = Object.keys(TARGET_TESTS);

/* Their descriptions, beside the tests they describe. They read to the user
 * as categories even though they are mask bit tests rather than corpus
 * words, so every column that shows the icons offers them — but one record
 * states both halves, which is what stops a word being testable and
 * undescribed (or the reverse). */
export const TARGET_WORD_TITLES: Record<string, string> = {
    caster: "Plays on the caster",
    target: "Plays on the target",
    area: "Plays where the spell lands",
    both: "Plays on the caster and the target",
};

/**
 * Split a group's tokens into text tokens and target-mask tests.
 * A field with no masks simply never gets tests back.
 */
function splitTargetTokens(tokens: QueryToken[]):
    { text: QueryToken[]; tests: ((mask: number) => boolean)[] } {
    const text: QueryToken[] = [], tests: ((mask: number) => boolean)[] = [];
    for (const t of tokens) {
        const test = TARGET_TESTS[t.text];
        if (test) tests.push(test); else text.push(t);
    }
    return {text, tests};
}

const maskMatches = (tests: ((mask: number) => boolean)[], mask: number): boolean =>
    tests.every((fn) => fn(mask));

/**
 * Search file names within a scope of fids; return spells using the matches.
 * `fids` is the scope to scan (data.modelFids / data.soundFids); `fileSpells`
 * maps fid -> spell ids using it.
 */
function spellsByFile(tokens: QueryToken[], data: SpellData, fids: number[],
                      fileSpells: Map<number, number[]>): Set<number> {
    const out = new Set<number>();
    for (const fid of fids) {
        const file = data.files.get(fid);
        if (file && textMatches(file.searchL, tokens)) {
            for (const s of fileSpells.get(fid) ?? []) out.add(s);
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
 */
function spellsByModel(tokens: QueryToken[], data: SpellData): Set<number> {
    if (!data.modelCatFidSpells.size) {
        return spellsByFile(tokens, data, data.modelFids, data.modelSpells);
    }
    const out = new Set<number>();
    const {text: withTests, values: attaches} = splitKeyword(tokens, ATTACH_WORD);
    const {text, tests} = splitTargetTokens(withTests);
    // EVERYTHING below reads `text`, never `tokens` — the keyword, its value
    // and the target words have all been taken out of it, so each is
    // accounted for exactly once. (This used to rebind `tokens = text` and
    // then use both names for the same array, which was correct only by
    // accident and would stop being so the moment a line moved.)
    // Attachment points and the target mask both live on the ROW; the
    // (cat, fid) index below has neither, being shared across spells. Either
    // one in the query therefore forces the row walk.
    const itemL = (e: { ref: number }) => (e.ref ? (data.itemSearchL.get(e.ref) || "") : "");
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
            if (text.every((t) => catL.includes(t.text) || searchL.includes(t.text))) {
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
            if (corpus && text.every((t) => corpus.includes(t.text))) {
                for (const s of spells) out.add(s);
            }
        }
    }
    // model-column types that carry their own corpus rather than riding the
    // (category, file) index — mounts today. The registry drives them, so a
    // future one needs no line here; the file-based categories declare no
    // `spells` and scanType skips them.
    for (const type of Pills.typesFor("model")) Pills.scanType(type, data, text, out);
    return out;
}

/**
 * Search sound file names, honouring target words. The mask lives on the
 * (spell, kit, file) row, so a target word turns this into a row walk the
 * way it does for models.
 */
function spellsBySound(tokens: QueryToken[], data: SpellData): Set<number> {
    const {text, tests} = splitTargetTokens(tokens);
    if (!tests.length) {
        return spellsByFile(tokens, data, data.soundFids, data.soundSpells);
    }
    const out = new Set<number>();
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

/** Search spell names (incl. subtexts and hidden override names). */
function spellsByName(tokens: QueryToken[], data: SpellData): Set<number> {
    const out = new Set<number>();
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
 * stand/walk anim (proc Type 7, merged with aura 312). Those render under a
 * "replace" group head, and that word joins their corpus — a token may hit
 * "replace" instead of the anim name (fx-corpus semantics), so anim:replace
 * alone finds every swap and anim:"replace walk" scopes to walk swaps.
 */
function spellsByAnim(tokens: QueryToken[], data: SpellData): Set<number> {
    const out = new Set<number>();

    // bonesets: `boneset "upper body"` matches spells whose AnimKits animate
    // that region. The keyword takes exactly the one token after it, so
    // `boneset head kneel` is the head region AND a kneel animation, and a
    // region whose name has a space in it is quoted. Whatever is left over
    // is ordinary anim text and still has to match, so the two intersect.
    const bones = splitKeyword(tokens, BONESET_WORD);
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
        // animations inherit the kit's. Replacement swaps have no mask.
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
    // replace and passenger are headless, matched in the loop above); kept
    // as the extension point for a future one, like the model side.
    for (const type of Pills.typesFor("anim")) Pills.scanType(type, data, tokens, out);
    return out;
}

/**
 * Search the visual FX column.
 *
 * Every fx type — chains, dissolves, colour effects, percents, morphs,
 * summons, the invisibility channels, keybinds — is a record in the
 * pill-type registry (pilltypes.ts) saying which corpus to read and which
 * numeric axes it answers to. Scanning them is therefore one loop, and the
 * app's hit-highlighting runs the SAME matcher on a single id, so a pill can
 * never light up under a query that did not select its spell.
 *
 * The one thing the registry cannot express is below: a chain's attachment
 * points live on the (spell, chain) ROW rather than on the chain, so they
 * cannot be baked into a per-id corpus.
 */
function spellsByFx(tokens: QueryToken[], data: SpellData): Set<number> {
    const out = new Set<number>();
    // A chain's attachment points live on the (spell, chain) ROW rather than
    // on the chain, so they cannot be baked into a per-id corpus: a chip
    // carrying `attach` is answered ENTIRELY by the row walk, exactly as the
    // same keyword forces the row walk in spellsByModel.
    //
    // It used to scan the registry with the RAW tokens and then union the row
    // walk in — so the keyword and its value were also offered to every fx
    // corpus as ordinary words, and a keyword widened the result instead of
    // narrowing it. Both halves now read `text`, so the keyword and its value
    // are accounted for exactly once.
    const {text, values: attaches} = splitKeyword(tokens, ATTACH_WORD);
    if (attaches.length) {
        // the points match on the SAME row as any chain corpus words — "a
        // fireball beam launched from the left hand", not "a fireball beam
        // somewhere and a left-hand attachment somewhere"
        for (const [s, rows] of data.spellChainRows) {
            for (const r of rows) {
                if (!matchesNames(attaches, attachmentNamesOf(r.src, r.dst, data))) continue;
                if (textMatches(data.fxSearchL.get(r.chain) || "", text)) {
                    out.add(s);
                    break;
                }
            }
        }
        return out;
    }
    for (const type of Pills.typesFor("fx")) Pills.scanType(type, data, tokens, out);
    return out;
}

/**
 * Exact numeric lookup against a Map of id -> [spell ids]. Multiple ids
 * union (OR) — used by id: chips and by kit-ID chips in sound:/anim:.
 */
function spellsByKitId(tokens: QueryToken[], map: Map<number, number[]>): Set<number> {
    const out = new Set<number>();
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
 */
export function expandAlts(tokens: QueryToken[]): QueryToken[][] {
    let combos: QueryToken[][] = [[]];
    for (const t of tokens) {
        const alts = (t.alts && t.alts.length) ? t.alts : [t.text];
        const next: QueryToken[][] = [];
        for (const c of combos) for (const a of alts) next.push(c.concat([{text: a}]));
        combos = next;
    }
    return combos;
}

/** A group's combinations, computed once and cached on the group. */
export function combosOf(group: QueryGroup): QueryToken[][] {
    if (!group.combos) group.combos = expandAlts(group.tokens);
    return group.combos;
}

/** One chip's result set: the union over its alternation combinations. */
function runGroup(g: QueryGroup, data: SpellData): Set<number> {
    const field = FIELDS[g.field] ? g.field : "all";
    const combos = combosOf(g);
    const one = (tokens: QueryToken[]) => spellsForChip(tokens, field, data);
    if (combos.length === 1) return one(combos[0]);
    const out = new Set<number>();
    for (const tokens of combos) for (const s of one(tokens)) out.add(s);
    return out;
}

/** Set intersection (iterates the smaller set). */
function intersect(a: Set<number>, b: Set<number>): Set<number> {
    if (a.size > b.size) [a, b] = [b, a];
    const out = new Set<number>();
    for (const v of a) if (b.has(v)) out.add(v);
    return out;
}

/* ------------------------------------------------------ field registry */

export const FIELDS: Record<string, SearchFieldSpec> = {
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
            const out = new Set<number>();
            // Pill types declared for this column — the non-visual half of
            // what used to be fx (seat, invis, detect, keybind, speed).
            // Mirrors the identical loop in spellsByFx: the registry says
            // which column owns a type, so moving one between columns needs
            // no change here. Their spells UNION with the enum rows below.
            for (const type of Pills.typesFor("mech")) Pills.scanType(type, data, tokens, out);
            const idsFor = (namesL: Map<number, string>, t: QueryToken) => {
                const hits = new Set<number>();
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
            const out = new Set<number>();
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
export function searchGroups(groups: QueryGroup[], data: SpellData):
    { spellIds: number[]; ms: number } {
    const t0 = performance.now();

    let result: Set<number> | null = null;
    const negatives: QueryGroup[] = [];
    // field -> union of that field's group results
    const orUnions = new Map<string, Set<number>>();
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
 * substring, then by ID. Returns the same array, sorted.
 */
export function sortByRelevance(spellIds: number[], rawQuery: string, data: SpellData): number[] {
    const q = rawQuery.toLowerCase().trim();
    const rank = (id: number) => {
        const nameL = data.names[data.spellIndex.get(id)!].toLowerCase();
        if (nameL === q) return 0;
        if (nameL.startsWith(q)) return 1;
        if (nameL.includes(q)) return 2;
        return 3;
    };
    return spellIds.sort((a, b) => (rank(a) - rank(b)) || (a - b));
}
