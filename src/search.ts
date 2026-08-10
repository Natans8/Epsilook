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

/**
 * The same substring match, but case-insensitive AT THE COMPARISON rather than
 * by having been handed a pre-folded haystack.
 *
 * Every other corpus in the app ships a lowercase twin (namesL, fxSearchL,
 * animNamesL …) because they are small and searched constantly. The cooked
 * description corpus is neither: it is 7 MB, the largest thing in the pack,
 * and only a `desc` keyword ever reads it. Measured on the real 9.2.7 pack, a
 * folded regex over the deduped pool answers in 4 ms where a precomputed
 * lowercase twin answers in 7 ms and costs ~9 MB of resident heap for the
 * whole session — so folding at the comparison is both cheaper and faster,
 * and the twin would be pure waste.
 *
 * Tokens are compiled ONCE per query, never per string: building a RegExp
 * inside the scan is what would make this slow.
 */
export const foldedMatchers = (tokens: QueryToken[]): RegExp[] =>
    tokens.map((t) => new RegExp(t.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

const matchesFolded = (haystack: string, res: RegExp[]): boolean =>
    res.every((re) => re.test(haystack));

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
    const isCmp = (t: QueryToken | undefined) => !!t && Pills.isComparison(t.text);
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
    // The SoundKit's own name. The sound column has TWO name spaces — file
    // paths and kit names — and a bare word reads both by design; the keyword
    // is the only way to say which one you meant. Absent from packs older than
    // format 41 and, like every keyword, unsuggested where it would match
    // nothing.
    kit: {
        fields: ["sound"],
        hint: 'SoundKit name — kit frostbolt, kit "restoration impact"',
        when: (d) => d.soundKitName.size > 0,
    },
    motion: {
        fields: ["model"],
        hint: 'Missile flight path — motion parabola, motion "forward spin"',
        when: (d) => (d.missileMotionNames || []).length > 0,
    },
    // What the spell SAYS it does — its cooked description plus the dungeon
    // journal's note on it, searched as one body (§3x).
    //
    // A KEYWORD INSIDE `name:` RATHER THAN A FIELD OF ITS OWN, and deliberately
    // not part of plain search. Measured on 9.2.7: folding descriptions into
    // the default corpus grows a typical result by only ~10%, but the growth
    // lands where it is least wanted — `fire` gains 5,336 rows on top of
    // 20,899 — and `sortByRelevance` ranks on the NAME alone, so a description
    // hit sits in the same bucket as a filename hit with nothing to sink it.
    // The value is all in the specific query: `blood pool` finds 56 spells
    // that overlap today's result set by ONE. Explicit until relevance grows a
    // tier for it. Full evidence in docs/DECISIONS.md.
    //
    // Inside `name:` because it is the same question the column already asks —
    // "what is this spell" — answered from its prose instead of its title.
    desc: {
        fields: ["name"],
        hint: 'Its description text — desc kneel, desc "blood pool"',
        when: (d) => d.descriptionText.length > 0,
    },
    // The art the game gives the spell (§3y): its icon's own file name — never
    // the path, which is `interface/icons/` on every icon in every pack — or
    // the FileDataID that names it on wowhead.com/icon=<fid>.
    //
    // INSIDE `name:` FOR THE SAME REASON `desc` IS — the name cell is where the
    // icon is drawn, and both keywords answer "what is this spell" from
    // something other than its title. The keyword is the SCOPED door;
    // `FIELDS.all` reaches icon names too (user's call, 2026-08-10), exactly as
    // it reaches descriptions, so the keyword is how you say "the icon, and
    // only the icon" rather than the only way in.
    //
    // Its own vocabulary is exempt from the corpus-collision measurement, the
    // way every meta keyword is: the word `icon` consumes the token after it
    // rather than joining a corpus, so what matters is ambiguity, and there is
    // none — no other field draws or names an icon.
    icon: {
        fields: ["name"],
        hint: 'Its icon — icon frost, icon "fire flamebolt", icon 135812',
        when: (d) => d.iconNames.length > 0,
    },
    // The expansion that introduced the id. A keyword inside `id:` rather than
    // a field of its own, for the same reason `attach` sits inside `model:`:
    // it QUALIFIES what the column already names. Ordered, so its value takes
    // the comparison grammar — xpac >legion, xpac <=mop.
    xpac: {
        fields: ["id"],
        hint: "Expansion it was added in — xpac wotlk, xpac >legion, xpac <=mop",
        when: (d) => d.expansions.length > 0,
    },
};

/* The two meta keywords by name, for the code that has to spell one rather
 * than iterate them — this module's own matchers, and the pill builders that
 * write a keyword search back out. They are the record's own keys, so they
 * live with it: a second copy sat in app/autocomplete.ts, exported for no
 * reason other than that the pills imported it from there. */
export const ATTACH_WORD = "attach";
export const BONESET_WORD = "boneset";
export const MOTION_WORD = "motion";
export const XPAC_WORD = "xpac";
/** The description keyword, inside `name:` — see FIELDS.name. */
export const DESC_WORD = "desc";
/** The icon keyword, inside `name:` — see FIELDS.name. */
export const ICON_WORD = "icon";
/* Spelled the same as the anim column's `kit` head word (KIT_WORD, below) and
 * deliberately so — both mean "the kit", one in each column. They stay two
 * constants because they are two grammars: this one takes the token after it,
 * that one joins a corpus. Neither field can see the other's. */
export const SOUNDKIT_WORD = "kit";

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
 * ONE, TWO when a comparison was written with air around its operator, or
 * none when the keyword is the chip's last token (a keyword with nothing
 * after it is just a word, and searches as one).
 *
 * THE TWO-TOKEN CASE IS THE TOKENIZER'S OWN PROMISE, HONOURED ONE LEVEL UP.
 * `tokenSpans` already glues a lone operator to what follows — `seat >2`,
 * `seat > 2` and `seat>2` are all one token — but only when the operand is a
 * NUMBER, and an expansion's operand is a WORD. So `xpac >legion` worked and
 * `xpac > legion` silently found nothing. Rejoining HERE rather than
 * widening the tokenizer is deliberate: a lone `>` is meaningless after a
 * keyword and can only be its operator, whereas in free text it is ordinary
 * character data that 265 spell names on 9.2.7 carry.
 *
 * Trivial on purpose, and still a function: the bar's capsule is drawn from
 * this exact call, so what the highlighter covers and what the matcher
 * consumes cannot drift apart.
 */
export const keywordRun = (tokens: { text: string }[], i: number): number =>
    !tokens[i + 1] ? 0
        : (Pills.isOperator(tokens[i + 1].text) && tokens[i + 2]) ? 2
            : 1;

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
        const run = tokens[i].text === word ? keywordRun(tokens, i) : 0;
        if (run) {
            // a run of two is a spaced comparison, rejoined into the single
            // value the matcher reads (`>` + `legion` -> `>legion`)
            values.push(tokens.slice(i + 1, i + 1 + run).map((t) => t.text).join(""));
            i += run;
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
 * — and "both" is a combination no single bit spells.
 *
 * `target` and `others` are deliberately NESTED rather than exclusive.
 * TargetType 4 ("not the caster", 11,227 spells on 9.2.7) is still a target
 * and is what you want back from `model:target`; `others` is the narrower
 * question — content the caster never sees — and it exists because the pill
 * draws that bit in its own colour, so a red crosshair had a glyph and no
 * name. `area` nests the same way over the missile-destination bit, which
 * keeps no word of its own: a missile's destination is a place on the
 * ground like any other, and the icon's tooltip already says which.
 *
 * Note the normal corpus path still substring-matches file names that
 * contain these words (beamtarget_onground) — the same accepted overlap as
 * fx:glow, which categoryRanker sorts out.
 *
 * EXPORTED for the help dialog's legend, which pairs each word with the glyph
 * that stands for it by asking the test about the icon's own bits — rather
 * than keeping a second word -> icon table that could disagree with the search.
 */
export const TARGET_TESTS: Record<string, (m: number) => boolean> = {
    caster: (m) => (m & 1) !== 0,
    target: (m) => (m & (2 | 8)) !== 0,
    others: (m) => (m & 8) !== 0,
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
    target: "Plays on the target — including the never-caster kind",
    others: "Plays on the target and never on the caster",
    area: "Plays where the spell lands — its effect area, or where a missile hits",
    both: "Plays on the caster and the target",
};

/**
 * Split a group's tokens into text tokens and target-mask tests.
 * A field with no masks simply never gets tests back.
 */
function splitTargetTokens<T extends { text: string }>(tokens: T[]):
    { text: T[]; tests: ((mask: number) => boolean)[] } {
    const text: T[] = [], tests: ((mask: number) => boolean)[] = [];
    for (const t of tokens) {
        const test = TARGET_TESTS[t.text];
        if (test) tests.push(test); else text.push(t);
    }
    return {text, tests};
}

const maskMatches = (tests: ((mask: number) => boolean)[], mask: number): boolean =>
    tests.every((fn) => fn(mask));

/**
 * Did a group's tokens NAME a target type this row's mask carries?
 *
 * The pills' hit test for the target icons, sharing `splitTargetTokens` and
 * `maskMatches` with the search itself — so what lights up and what was
 * actually selected cannot drift. Answers false when the group names no target
 * word at all, which is what keeps every icon dark under an ordinary query.
 */
export function maskIsNamed(tokens: { text: string }[], mask: number): boolean {
    const {tests} = splitTargetTokens(tokens);
    return tests.length > 0 && maskMatches(tests, mask);
}

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
    const {text: withMotions, values: attaches} = splitKeyword(tokens, ATTACH_WORD);
    const {text: withTests, values: motions} = splitKeyword(withMotions, MOTION_WORD);
    const {text, tests} = splitTargetTokens(withTests);
    // EVERYTHING below reads `text`, never `tokens` — the keyword, its value
    // and the target words have all been taken out of it, so each is
    // accounted for exactly once. (This used to rebind `tokens = text` and
    // then use both names for the same array, which was correct only by
    // accident and would stop being so the moment a line moved.)
    // Attachment points and the target mask both live on the ROW; the
    // (cat, fid) index below has neither, being shared across spells. Either
    // one in the query therefore forces the row walk.
    // `ref` is a PER-CATEGORY id space (a CreatureDisplayID on display rows, an
    // Item::ID on item rows, 0 elsewhere), so the item corpus may only be
    // consulted for item rows. Ungated, a display row whose CreatureDisplayID
    // happens to equal a real Item::ID matched that unrelated item's name —
    // one live collision on 9.2.7 (display 95279). data.itemCat is derived once
    // in data.ts rather than re-found here, so the two gates cannot drift.
    const itemL = (e: { cat: number; ref: number }) =>
        (e.cat === data.itemCat && e.ref ? (data.itemSearchL.get(e.ref) || "") : "");
    // the flight path lives on the ROW too, so it forces the row walk for the
    // same reason the attachment pair and the target mask do
    if (tests.length || attaches.length || motions.length) {
        for (const [s, entries] of data.spellModelCats) {
            for (const e of entries) {
                if (tests.length && !maskMatches(tests, e.targets)) continue;
                if (attaches.length && !matchesNames(attaches, attachmentNamesOf(e.src, e.dst, data))) continue;
                if (motions.length && !(e.motion && matchesNames(motions, [e.motion.toLowerCase()]))) continue;
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
 * The spells of every named kit whose name answers `test` (pack section
 * `soundKitNames`, from the pinned 8.3.0 table).
 *
 * One walk, two ways in — the implicit half of a `sound:` search below, and
 * the explicit `kit` keyword — so the two spellings of "named that" can only
 * ever disagree about which names match, never about which spells follow.
 */
function spellsByKitName(data: SpellData, test: (nameL: string) => boolean): Set<number> {
    const out = new Set<number>();
    for (const [kitId, name] of data.soundKitName) {
        if (!test(name.toLowerCase())) continue;
        for (const s of data.soundKitSpells.get(kitId) || []) out.add(s);
    }
    return out;
}

/**
 * Search sound kits by Blizzard's own name for them, from a chip's plain words.
 *
 * Unions with the file-name search rather than replacing it — the same way a
 * category word matches file names IN ADDITION to the category — so adding
 * names can only ever widen a `sound:` result, never narrow one. Target words
 * are ignored here: a name describes the kit, not who it plays on, and the
 * file-name half of the union already answers the targeted question.
 */
function spellsBySoundKitName(tokens: QueryToken[], data: SpellData): Set<number> {
    if (!data.soundKitName.size) return new Set<number>();
    const {text} = splitTargetTokens(tokens);
    const words = text.map((t) => t.text).filter(Boolean);
    if (!words.length) return new Set<number>();
    return spellsByKitName(data, (nameL) => words.every((w) => nameL.includes(w)));
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

/**
 * Search the sounds column: file names, an exact SoundKit id, and the kit's
 * own name, unioned — one chip, every way a sound is named.
 *
 * `kit <name>` scopes to the NAME half alone, which is the one question the
 * union cannot ask: THIS kit, by the name Blizzard gave it, never a file that
 * happens to spell the same word. Whatever is left over stays an ordinary
 * sound search and still has to match, so the two intersect — the same shape
 * `boneset` has in the anim column, and the same one-token arity every meta
 * keyword has.
 */
function spellsBySoundColumn(tokens: QueryToken[], data: SpellData): Set<number> {
    const kit = splitKeyword(tokens, SOUNDKIT_WORD);
    if (kit.values.length) {
        const out = spellsByKitName(data, (nameL) => matchesNames(kit.values, [nameL]));
        // the leftover has no `kit` left in it, so this bottoms out
        return kit.text.length
            ? intersect(out, spellsBySoundColumn(kit.text, data))
            : out;
    }
    const out = spellsBySound(tokens, data);
    // an all-numbers chip is also an exact SoundKit ID lookup (the old
    // soundkit: field, folded in 2026-07-19) — several ids in one chip union,
    // like the old orGroups behavior
    if (tokens.every((t) => /^\d+$/.test(t.text))) {
        for (const s of spellsByKitId(tokens, data.soundKitSpells)) out.add(s);
    }
    for (const s of spellsBySoundKitName(tokens, data)) out.add(s);
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
 * Which distinct strings in a deduped pool answer every value of the keyword?
 *
 * SCANNED POOL-FIRST, NOT SPELL-FIRST, and that is the whole reason the pack
 * ships the text deduped: 276,332 spells share 79,331 descriptions, so testing
 * the pool tests each string once instead of 3.5 times. The result is a bitmap
 * over pool slots, which the caller turns into spells with one integer lookup
 * each.
 */
function poolHits(pool: string[], values: string[]): Uint8Array {
    const hit = new Uint8Array(pool.length);
    // one value = one phrase; every value must match, so intersect per value
    const per = values.map((v) => foldedMatchers(
        v.split(" ").filter(Boolean).map((text) => ({text}) as QueryToken)));
    for (let k = 1; k < pool.length; k++) {  // slot 0 is "" and matches nothing
        hit[k] = per.every((res) => matchesFolded(pool[k], res)) ? 1 : 0;
    }
    return hit;
}

/**
 * `name:"desc kneel"` — search what the spell SAYS it does (§3x).
 *
 * The description and the dungeon-journal note are two sources of one idea, so
 * a value matching EITHER is a hit. They are separate pools because they are
 * separately deduped, not because they are separate axes.
 */
function spellsByDescription(values: string[], data: SpellData): Set<number> {
    const out = new Set<number>();
    const {ids, descriptionText, descriptionOf, encounterText, encounterOf} = data;
    if (!descriptionText.length) return out;  // pack older than format 43
    const inDesc = poolHits(descriptionText, values);
    const inEnc = poolHits(encounterText, values);
    for (let i = 0; i < ids.length; i++) {
        if (inDesc[descriptionOf[i]] || inEnc[encounterOf[i]]) out.add(ids[i]);
    }
    return out;
}

/**
 * Does one icon answer one `icon` value?
 *
 * ⚠ THE ID HALF IS KEYWORD-ONLY, and that asymmetry is the point — it is the
 * one thing this axis could not do uniformly (user's call, 2026-08-10). In
 * `FIELDS.all` a lone number is ALREADY an exact spell-ID lookup, deliberately,
 * so letting it also mean "an icon fid" would turn `135812` from the one spell
 * you asked for into the 28 that happen to share a picture. Inside
 * `name:"icon 135812"` there is nothing to collide with: the keyword has said
 * which id space the number lives in.
 *
 * The name half is `nameHasValue` and runs on both doors, so every word of the
 * value must appear somewhere in the name, in any order: icon names are
 * underscore-jammed dev identifiers (`spell_fire_flamebolt`), and word-wise is
 * what lets `icon "fire flamebolt"` reach one without the user having to spell
 * the separator. The id half is EXACT — a fid is an identity, and a substring
 * of one names nothing.
 */
const iconAnswers = (nameL: string, fid: number, value: string, byId: boolean): boolean =>
    nameHasValue(nameL, value) || (byId && fid > 0 && String(fid) === value);

/**
 * `name:"icon frost"`, `name:"icon 135812"` — search the ART the game gives the
 * spell (§3y).
 *
 * SCANNED POOL-FIRST, exactly as the description search is and for the same
 * reason: 129,050 spells on 9.2.7 wear 9,849 distinct icons — 27.7 spells each
 * — so testing the pool tests each name once instead of 28 times. That reuse is
 * also the whole point of the axis: an icon groups spells that the NAME cannot,
 * because most spells borrow art rather than getting their own.
 *
 * `byId` is the caller saying which door it is: true for the `icon` keyword,
 * false for plain search — see `iconAnswers`. It is a parameter rather than two
 * functions so the ONE matcher stays one matcher; what differs between the
 * doors is a single term of the test, not the walk.
 *
 * `iconFids` is empty before format 44, which costs the id half and leaves the
 * name half working — the degradation a stale cached pack should have.
 */
function spellsByIcon(values: string[], data: SpellData, byId: boolean): Set<number> {
    const out = new Set<number>();
    const {ids, iconNames, iconFids, iconOf} = data;
    if (!iconNames.length) return out;
    const hit = new Uint8Array(iconNames.length);
    for (let k = 0; k < iconNames.length; k++) {
        hit[k] = values.every(
            (v) => iconAnswers(iconNames[k], iconFids[k] || 0, v, byId)) ? 1 : 0;
    }
    for (let i = 0; i < ids.length; i++) {
        // iconOf is the pack's own 1-based index; 0 is "this spell has no icon"
        if (iconOf[i] && hit[iconOf[i] - 1]) out.add(ids[i]);
    }
    return out;
}

/* The two words that name where an animation came from. They head no pill —
 * a real AnimKit group is headed by its id and a loose animation has no head
 * at all — so unlike `replace` and `passenger` these are words for a shape
 * that was already on screen and previously unsayable. */
const KIT_WORD = "kit", LOOSE_WORD = "loose";

/**
 * Does every token match this animation, read as part of `word`'s group?
 *
 * The anim column's one matching rule. A token hits either the group's head
 * word or the animation's own name, which is what makes `anim:replace` find
 * every swap while `anim:"replace stealthstand"` scopes to one — and, applied
 * to all four sources alike, what makes `anim:kit` mean kit-borne rather than
 * "an animation with 'kit' in its name". The overlap is deliberate and is this
 * app's documented behaviour everywhere: `anim:loose` also finds
 * Attack2HLoosePierce, exactly as `fx:glow` finds beam_webglowwhite.
 */
function inSource(word: string, data: SpellData, anim: number,
                  tokens: QueryToken[]): boolean {
    const nameL = data.animNamesL[anim] || "";
    return tokens.every((t) => word.includes(t.text) || nameL.includes(t.text));
}

/**
 * Search the animations column.
 *
 * Four sources, each with a head word that joins its corpus (see inSource):
 * `kit` for animations an AnimKit plays, `loose` for ones the spell's visual
 * kit plays directly, `replace` for stand/walk swaps (proc Type 7 merged with
 * aura 312) and `passenger` for what a rider plays in a seat. So anim:replace
 * finds every swap, anim:"replace walk" scopes to walk swaps, and anim:kit is
 * every animation that arrived in a bundle.
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
                if (maskMatches(tests, mask) && inSource(LOOSE_WORD, data, a, text)) {
                    out.add(s);
                    break;
                }
            }
        }
        for (const [s, byKit] of data.animKitTargets) {
            for (const [kit, mask] of byKit) {
                if (!maskMatches(tests, mask)) continue;
                const anims = data.animKitAnims.get(kit) || [];
                if (anims.some((a) => inSource(KIT_WORD, data, a, text))) {
                    out.add(s);
                    break;
                }
            }
        }
        return out;
    }
    for (let a = 0; a < data.animNamesL.length; a++) {
        // Four sources, four head words, ONE rule (see inSource). `kit` and
        // `loose` used to share an untagged branch, which is exactly why the
        // column could show you where an animation came from and the search
        // could not ask.
        if (inSource(KIT_WORD, data, a, tokens)) {
            for (const kit of data.animAnimKits.get(a) || []) {
                for (const s of data.animKitSpells.get(kit) || []) out.add(s);
            }
        }
        if (inSource(LOOSE_WORD, data, a, tokens)) {
            for (const s of data.visualAnimSpells.get(a) || []) out.add(s);
        }
        if (inSource("replace", data, a, tokens)) {
            for (const s of data.replaceSpells.get(a) || []) out.add(s);
        }
        if (inSource("passenger", data, a, tokens)) {
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
    /* TARGET WORDS FIRST, and they are per-ROW here exactly as they are in the
     * model, sound and anim columns: the same chain plays on the caster for one
     * spell and on the target for another, so the mask lives on (spell, id).
     *
     * This column drew the icons and offered the words in autocomplete long
     * before it tested them — `fx:caster` fell through to ordinary corpus text
     * and selected the 32 spells with "caster" in an asset path, while 27 of
     * their cells lit their target icons anyway (the icons ask the mask, the
     * search did not). That is the one drift this app's registry exists to make
     * impossible, so the test belongs here rather than a note in the docs. */
    const {text: aimed, tests} = splitTargetTokens(tokens);
    const maskOk = tests.length ? (m: number) => maskMatches(tests, m) : undefined;
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
    const {text, values: attaches} = splitKeyword(aimed, ATTACH_WORD);
    if (attaches.length) {
        // the points match on the SAME row as any chain corpus words — "a
        // fireball beam launched from the left hand", not "a fireball beam
        // somewhere and a left-hand attachment somewhere"
        for (const [s, rows] of data.spellChainRows) {
            const masks = data.fxTargets.get(s);
            for (const r of rows) {
                if (!matchesNames(attaches, attachmentNamesOf(r.src, r.dst, data))) continue;
                // the row again: who the beam plays on is part of the same row
                // the attachment points came off
                if (maskOk && !maskOk(masks?.get(r.chain) || 0)) continue;
                if (textMatches(data.fxSearchL.get(r.chain) || "", text)) {
                    out.add(s);
                    break;
                }
            }
        }
        return out;
    }
    for (const type of Pills.typesFor("fx")) Pills.scanType(type, data, text, out, maskOk);
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

/* ------------------------------------------------------- expansion */

/** An `xpac` value: an optional comparison, then the rung's name. The operator
 *  alphabet is the numeric grammar's own (pills.ts) rather than a second copy
 *  — this axis compares words where that one compares numbers, and that is the
 *  ONLY difference between them. */
const XPAC_VALUE = new RegExp(`^(${Pills.CMP_OPS})?(.*)$`);

/**
 * Resolve one `xpac:` token to the rung indexes it selects.
 *
 * THE VOCABULARY IS THE PACK'S OWN — key, short, label and aliases all ship in
 * the `expansions` section — so an expansion becomes searchable the moment the
 * build declares it, and no list here can fall behind one.
 *
 * The rung's index IS its value, which is what makes the comparisons free:
 * `>legion` is an index test, not a second ordering table to keep in step.
 * Matching is exact first, then substring on the key/label/short, so `burning`
 * and `pandaria` land the same way a partial model name does elsewhere.
 */
export function expansionIndexes(text: string, data: SpellData): number[] {
    const m = XPAC_VALUE.exec(text.toLowerCase());
    if (!m || !m[2]) return [];
    const [, op = "=", word] = m;

    const exact = data.expansions.find(
        (x) => x.key === word || x.short.toLowerCase() === word
            || x.label.toLowerCase() === word || x.aliases.includes(word));
    const hit = exact ?? data.expansions.find(
        (x) => x.key.includes(word) || x.label.toLowerCase().includes(word)
            || x.short.toLowerCase().includes(word));
    if (!hit) return [];

    const i = hit.index;
    return data.expansions.filter((x) =>
        op === ">" ? x.index > i
            : op === ">=" ? x.index >= i
                : op === "<" ? x.index < i
                    : op === "<=" ? x.index <= i
                        : x.index === i).map((x) => x.index);
}

/** Spells introduced in any expansion these `xpac` values select. The values
 *  UNION: the axis is single-valued, so ANDing two expansions could only ever
 *  be empty. */
function spellsByExpansion(values: string[], data: SpellData): Set<number> {
    const out = new Set<number>();
    for (const v of values) {
        for (const i of expansionIndexes(v, data)) {
            for (const s of data.eraSpells[i] ?? []) out.add(s);
        }
    }
    return out;
}

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
        //
        // DESCRIPTION TEXT **IS** HERE (user's call, 2026-08-10, reversing the
        // same day's original scope). It was measured first and the numbers are
        // in docs/DECISIONS.md: a typical query grows ~10%, and about half of
        // what descriptions find is unreachable any other way — `blood pool`
        // overlaps today's result set by ONE spell. The known cost is that
        // `sortByRelevance` scores on the NAME alone, so a description-only hit
        // ranks alongside a filename hit rather than below it; on a broad word
        // like `fire` that is 5,336 extra rows with no ranking defence. The fix,
        // when it is wanted, is a fourth relevance tier — not removing this.
        run(tokens, data) {
            const out = spellsByName(tokens, data);
            for (const s of spellsByModel(tokens, data)) out.add(s);
            for (const s of spellsBySound(tokens, data)) out.add(s);
            for (const s of spellsByAnim(tokens, data)) out.add(s);
            for (const s of spellsByFx(tokens, data)) out.add(s);
            // one token = one term, all of which must appear — the same shape
            // splitKeyword hands the `desc` and `icon` keywords, so every door
            // to a corpus agrees about what a multi-word query means
            for (const s of spellsByDescription(tokens.map((t) => t.text), data)) out.add(s);
            // ICON NAMES ARE HERE TOO (user's call, 2026-08-10), on the same
            // footing as the four file corpora above: an icon name IS a file
            // name, and `fx:chain` matching chain FILES is the rule this
            // follows rather than an exception to it. It carries the known
            // `desc` cost — sortByRelevance scores on the NAME alone, so an
            // icon-only hit ranks beside a filename hit — and the same fix
            // when it is wanted, which is a further relevance tier.
            //
            // NAMES ONLY (`byId: false`): the fid half is keyword-scoped, or it
            // would take the exact-spell-ID lookup three lines below off a lone
            // number. See iconAnswers.
            for (const s of spellsByIcon(tokens.map((t) => t.text), data, false)) out.add(s);
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
        hint: 'spell name, or desc / icon — fire bolt, desc "blood pool"',
        short: "spell name",
        /**
         * THREE WAYS TO SAY "WHAT IS THIS SPELL", sharing one column: its
         * title, `desc <text>` for what it says it does (§3x), and
         * `icon <name|fid>` for the art it wears (§3y). The last two are
         * KEYWORDS inside this chip, exactly as `xpac` is written inside `id:`
         * — each qualifies the question the column already asks rather than
         * opening a field of its own.
         *
         *   name:fireball   name:"desc kneel"   name:"icon frost"
         *   name:(bolt icon frost)              name:"icon 135812"
         *
         * ⚠ EVERY HALF NARROWS THE OTHERS, which is what putting them in the
         * chip buys: `name:(bolt icon frost)` is a spell CALLED bolt wearing a
         * frost icon — 327 rows on 9.2.7, not two independent searches. A chip
         * with no plain words has no name test to apply, so the keyword hits
         * stand alone.
         *
         * ⛔ THE QUOTES GO ROUND THE VALUE, NEVER ROUND KEYWORD-AND-VALUE, and
         * getting that wrong is silent rather than an error. Each keyword takes
         * exactly ONE token (the frozen one-token rule), so a multi-word value
         * is `name:(icon "fire flamebolt")` — 563 rows. Written
         * `name:(fire "icon frost")` the inner quotes make `icon frost` a
         * single PHRASE token, `splitKeyword` never sees the keyword, and the
         * whole thing degrades to a name search for a phrase no spell has: 0
         * rows, no complaint. Measured, because the wrong form was in this
         * comment first.
         *
         * Written as a fold rather than the old two-branch shape: a third half
         * turned "if there are values, else" into a truth table, and the next
         * keyword should cost one line here rather than another branch.
         */
        run(tokens, data) {
            const icon = splitKeyword(tokens, ICON_WORD);
            const desc = splitKeyword(icon.text, DESC_WORD);
            const halves: Set<number>[] = [];
            // `byId: true` — the keyword is what makes a number unambiguous
            if (icon.values.length) halves.push(spellsByIcon(icon.values, data, true));
            if (desc.values.length) halves.push(spellsByDescription(desc.values, data));
            // The plain words are a test only when there ARE some: an empty
            // `text` once the keywords have been taken out means the chip was
            // nothing but keywords, not that it asked for every spell. With no
            // keywords at all it runs anyway — that is the plain name search,
            // empty tokens and all, exactly as it behaved before.
            if (!halves.length || desc.text.length) {
                halves.push(spellsByName(desc.text, data));
            }
            return halves.reduce(intersect);
        },
    },
    model: {
        label: "Model", tab: true,
        hint: "model file, e.g. 6dr statue", short: "model file",
        run: (tokens, data) => spellsByModel(tokens, data),
    },
    sound: {
        label: "Sound", tab: true,
        hint: "sound file, kit name or SoundKit ID, e.g. felreaver or 86835",
        short: "sound file / kit",
        run: (tokens, data) => spellsBySoundColumn(tokens, data),
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
        hint: 'exact spell ID, or xpac — 133, xpac legion, xpac ">wotlk"',
        short: "spell ID",
        /**
         * Exact ids, plus `xpac <expansion>` — the expansion that introduced
         * the id, written as a KEYWORD inside this chip exactly as `attach` is
         * written inside `model:`. It qualifies what the column already names,
         * so it is not a field of its own and no `xpac:` prefix exists.
         *
         *   id:133   id:"xpac legion"   id:"xpac >wotlk"   id:"xpac <=mop"
         *
         * The keyword split is what keeps a bare number a SPELL ID — `id:5` is
         * spell 5, never Mists — and it is the same `splitKeyword` the
         * attachment and boneset axes use, so the form is learned once.
         */
        run(tokens, data) {
            const {text, values} = splitKeyword(tokens, XPAC_WORD);
            const out = spellsByExpansion(values, data);
            for (const t of text) {
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
