/* SEARCH 2.0 — L2 vocabulary. THE TYPE REGISTRY AND ITS CATALOGUE.
 *
 * A type answers four questions about a VALUE — what it means, how it
 * compares, how it is written, and how it is drawn — and knows nothing about
 * which property uses it, which kind that property belongs to, which column
 * that kind sits in, or what the value is called. That ignorance is the whole
 * design: an axis says *"cast time is measured in seconds"*; `seconds` says
 * what a second is, that `ms` is a thousandth of one, and that a number line
 * is the right control. The type never learns the word "casttime".
 *
 * ⭐ WHAT A TYPE DOES **NOT** OWN, AND THIS IS THE 2026-08-11 CORRECTION
 * (PLAN §3.2b): THE OPERATOR BODIES. A JS method is a promise that the
 * executor is JavaScript in this process, which is exactly what implementation
 * independence forbids — the same query has to be answerable by SQL or by a
 * web service. So:
 *
 *   which operators this type ACCEPTS   here, as DATA — a list of references
 *   what `contains` DOES to a `path`    backend/memory.ts, keyed (op, type)
 *   the same, for a database            backend/sql.ts — `LIKE '%x%'`
 *
 * ⚠ `parse` AND `format` STAY, AND THE DISTINCTION IS THE SUBTLE BIT. They do
 * not cross the backend seam: `parse` runs in the PARSER, turning typed text
 * into the value that then travels as data, and `format` runs in the PILL,
 * turning a value back into text. Both are above the seam, in the process that
 * owns the text. What crosses is their RESULT, which is why `Value` is
 * constrained to a JSON scalar — a query that cannot be serialised cannot be
 * POSTed, and "a query is data all the way down" would be a slogan.
 *
 * ⛔ WHAT A TYPE MAY NEVER DO, so it is not discovered later as a feature: add
 * an operator of its own, change precedence, or give an operator a meaning
 * §3's table does not state. If a type needs a question the operators cannot
 * ask, it needs an AXIS, not an operator. The operator VOCABULARY may still
 * grow — `defineOperator` is a registry — but only the language grows it.
 *
 * ADDING A TYPE IS `defineType({...})` AND NOTHING ELSE (TYPES §10): no kernel
 * edit, no parser edit, no UI edit, no help edit. If a fifth step appears,
 * stop and fix the framework — that is the extension contract, and this file
 * is where it is tested.
 */
import type {Operator} from "./operators";
import {contains, exact, glob, ORDERING, OPERATORS, present} from "./operators";
import type {NumericSpec, UnitTable} from "./units";
import {formatNumber, parseNumber} from "./units";

/**
 * What a value may BE.
 *
 * A JSON scalar, and the constraint is load-bearing rather than tidy: an
 * operand parsed here is put into a query that a backend executes, and a SQL
 * or HTTP backend can only receive what serialises. Anything richer — a Rung
 * object, a Date, a compiled RegExp — would quietly make this engine
 * in-process-only (PLAN §3.2b).
 */
export type Value = string | number;

/** The four base types the SOURCE declares. Ours to read, never to choose:
 *  measured over every column the build reads on 9.2.7, 909 int, 320 float,
 *  20 locstring, 7 string (TYPES §1). */
export type Storage = "int" | "float" | "string" | "locstring";

/** The DEFAULT control. A property's measured domain may override it —
 *  cardinality decides the affordance, not the type: `ConeAngle` and
 *  `CollisionHeight` are both float and want a picker and a slider
 *  respectively (TYPES §6.1). */
export type Affordance = "text" | "number" | "range" | "picker" | "toggle" | "glyphs";

export interface AxisType<V extends Value = Value> {
    /** Registry key, and the word a diagnostic uses: *"the scale axis takes a
     *  percentage"*. */
    readonly name: string;

    /** What the pack holds. `null` = the type has no value at all — see
     *  `flag`, which is the only one. */
    readonly storage: Storage | null;

    /**
     * Text -> value, or null when the text is not of this type.
     *
     * ⭐ RETURNING NULL IS THE DISPATCH MECHANISM (TYPES §7): a property may
     * declare several types, and the first whose `parse` accepts the operand
     * wins. So `id.parse("frostbolt")` must return null rather than NaN, and
     * null must never mean "bad input" — the diagnostic is composed one level
     * up, once NO declared type has accepted it.
     *
     * ABSENT = THIS TYPE HAS NO VALUES AT ALL (`flag`). Nothing to parse.
     */
    parse?(text: string): V | null;

    /**
     * Value -> the string a pill prints and a query can be written with.
     *
     * INVARIANT, and it is a property test: `format(parse(s)) === s` for every
     * s that `format` itself produced. That is what makes *"read the pill,
     * type what you see"* true rather than hoped for (L12). Input is lenient
     * — `50`, `50%`, `500ms` all parse — and output is one canonical form.
     */
    format?(value: V): string;

    /**
     * THE OPERATOR CONTRACT, as DATA.
     *
     * An operator absent from this list is DECLINED, and declining is a static
     * error reported in the user's words — never a silent fallback. `text` has
     * no ordering, which is why `name:>m` says *"the name axis has no
     * ordering"* instead of substring-searching for the characters `>m` as 1.0
     * does. It is the null-object rule expressed as data instead of as a
     * missing method, so it can be checked without asking JavaScript.
     */
    readonly accepts: readonly Operator[];

    /** TYPES §5. Absent = this type takes no unit, and a unit on it is an
     *  error. Present implies an order — see `defineType`. */
    readonly units?: UnitTable;

    /** One line, in the user's words, for the help row and the diagnostic. */
    readonly hint: string;

    readonly ui: Affordance;
}

/** Every declared type, by name. */
export const TYPES = new Map<string, AxisType>();

/**
 * Register one type.
 *
 * THE THREE VALIDATIONS ARE STRUCTURAL LAWS, NOT DEFENSIVE CODE. Each catches
 * a declaration that would compile, load, and then be quietly wrong:
 *
 *   1. an operator this registry has never heard of — a typo in `accepts`
 *      would otherwise mean the type silently declines it,
 *   2. a value-bearing operator with no `parse`/`format` — the operand could
 *      never be read, so the axis would match nothing forever,
 *   3. units without an order (TYPES §5.1 rule 6) — `text` has neither, which
 *      is precisely why the 396 spell names containing `%` cannot collide with
 *      a percentage. Declaring units on an unordered type would reopen that.
 */
export function defineType<V extends Value>(type: AxisType<V>): AxisType<V> {
    if (TYPES.has(type.name)) throw new Error(`type "${type.name}" already defined`);

    for (const op of type.accepts) {
        if (OPERATORS.get(op.name) !== op) {
            throw new Error(`type "${type.name}" accepts unregistered operator "${op.name}"`);
        }
    }

    const valued = type.accepts.some((op) => op !== present);
    if (valued && !(type.parse && type.format)) {
        throw new Error(
            `type "${type.name}" accepts an operator that takes a value but cannot parse or format one`);
    }

    if (type.units && !ORDERING.every((op) => type.accepts.includes(op))) {
        throw new Error(`type "${type.name}" declares units but declines ordering (TYPES §5.1 rule 6)`);
    }

    TYPES.set(type.name, type as AxisType);
    return type;
}

/* ══════════════════════════════════════════════════ THE CATALOGUE ══════
 *
 * Each entry is the whole truth about that type. Read one and you know how it
 * behaves everywhere. The order is TYPES §4's.
 */

/* ─────────────────────────────────────────────────────────── the words ── */

/**
 * `text` — human-written prose and names.
 *
 * Spell names, descriptions, sound-kit names, icon names, area names.
 *
 * ⚠ IT DECLINES ORDERING, AND THAT IS LOAD-BEARING. It is what makes
 * `name:anti-magic` one token rather than a range, and what turns `name:>m`
 * into an honest error instead of a substring search for `>m`.
 */
export const text = defineType<string>({
    name: "text",
    storage: "string",
    parse: (s) => s,                        // every string is a valid text
    format: (s) => s,
    accepts: [exact, contains, glob, present],
    hint: "words — matched anywhere in the text unless you anchor with =",
    ui: "text",
});

/**
 * `path` — asset file paths. `.m2` models, sound files, textures.
 *
 * ⛔ A DISTINCT TYPE FROM `text` FOR ONE MEASURED REASON: IT CAN NEVER BE
 * ANCHORED. Asset paths carry no word segmentation — `beecreature.m2`,
 * `beerfest_keg01.m2`, `hangingbeetle01.m2`. Split them on `_` and the words
 * are `beecreature` and `beerfest`, NEITHER of which equals `bee` nor `beer`.
 * So matching is unanchored substring, forced by the corpus, and `glob` in the
 * middle of a token is close to a no-op.
 *
 * The type exists so the HINT can say so, and so a future anchoring proposal
 * has somewhere to be refused (SEARCH.md §3.2).
 */
export const path = defineType<string>({
    name: "path",
    storage: "string",
    parse: (s) => s,
    format: (s) => s,
    accepts: [exact, contains, glob, present],
    hint: "part of a file path — file names run words together, so bee also finds beer",
    ui: "text",
});

/**
 * `enum` — a named value from a closed set.
 *
 * Spell effect names, aura names, implicit-target names, proc types, kit
 * effect types. Stored as an int with a declared enum; the VALUE a query binds
 * is the enum's own NAME, because that is the only half a person can type.
 *
 * ⭐ THE PICKER IS THE POINT. `mech:unit_target_enemy` already works (21,109
 * on 9.2.7); what is missing is anything telling a user the value exists. An
 * enum property is browsable by construction, which is the direct answer to
 * *"I find myself way too often opening wago.tools when Epsilook doesn't
 * provide."*
 *
 * ✅ THERE IS NO EXACT->SUBSTRING->GLOB LADDER (PHASE 0 closed TYPES §9.4).
 * 1.0 matches an enum by trying exact first and then substring, which looked
 * like a fourth matching mode. It is not: matching is `contains`, and "exact
 * first" is RANKING. The ladder collapses into the relevance rule.
 */
/* The binding is `enumeration` because `enum` is a reserved word; the REGISTRY
 * KEY is "enum", which is the name everything else — a diagnostic, a doc, a
 * future SQL backend's lookup table — actually uses. */
export const enumeration = defineType<string>({
    name: "enum",
    storage: "int",
    parse: (s) => s,
    format: (s) => s,
    accepts: [exact, contains, glob, present],
    hint: "one of a fixed list of names — pick one, or type part of it",
    ui: "picker",
});

/**
 * `ordinal` — an enum WITH a total order. The expansion ladder, today.
 *
 * ⭐ IT DIFFERS FROM `enum` IN EXACTLY ONE WAY: it accepts the ordering
 * operators. Everything else — parse, format, the picker — is identical, and
 * that is the honest modelling rather than a shortcut.
 *
 * ⚠ SO WHERE IS THE ORDER? IN THE PACK, NOT HERE. The ladder ships as
 * `pack.expansions` (format 42+, oldest first), which means a rung's RANK is
 * data the loaded pack supplies and cannot be a constant in this file — a
 * hardcoded list would be a second copy of `tools/expansions.py`, and two
 * copies of one fact drift. So `parse` and `format` carry the rung's name and
 * the BACKEND resolves rank from the ladder it holds. TYPES §9.5 asked whether
 * the ladder is global or per-pack and recommended global; this shape is
 * neutral on that and defers it to the backend, which is where the answer can
 * be measured.
 *
 * ⭐ THIS IS WHY `xpac` FELT SPECIAL IN 1.0 — it was handled with a private
 * second operator alphabet (`XPAC_VALUE`), exactly the duplication L1 forbids.
 * Declaring the type puts it back under the one grammar: same operators, same
 * precedence, a different domain to compare in.
 */
export const ordinal = defineType<string>({
    name: "ordinal",
    storage: "int",
    parse: (s) => s,
    format: (s) => s,
    accepts: [exact, contains, glob, present, ...ORDERING],
    hint: "a rung on a ladder — name one, or compare with < and >",
    ui: "picker",
});

/* ──────────────────────────────────────────────────────── the numbers ── */

/**
 * `id` — an identity, not a quantity.
 *
 * Spell id, SoundKit id, AnimKit id, icon fid, model fid, area id, display id.
 *
 * ⚠ IT DECLINES BOTH ORDERING AND SUBSTRING, AND BOTH REFUSALS ARE
 * DELIBERATE. Ids have no meaningful order — spell 5 is not "before" spell 6
 * in any sense a user means — and substring-matching an id is the defect that
 * made `135812` match 295 spells instead of one. An id is never normalised,
 * scaled, or given a unit.
 */
export const id = defineType<number>({
    name: "id",
    storage: "int",
    /* Digits only, and SAFE digits: `Number("99999999999999999999")` loses
     * precision silently, so an id that cannot survive the round trip is not
     * an id of ours. Null rather than NaN — this is the dispatch mechanism
     * that lets a multi-notation property fall through to `text`. */
    parse: (s) => {
        if (!/^\d+$/.test(s)) return null;
        const n = Number(s);
        return Number.isSafeInteger(n) ? n : null;
    },
    format: (n) => String(n),
    accepts: [exact, present],
    hint: "the exact id — a number, matched whole",
    ui: "number",
});

/**
 * `count` — a cardinality.
 *
 * The universal `count` axis, and vehicle seats. Derived, never shipped: it is
 * the size of a row set, so no column stores it.
 *
 * ⚠ TOTAL FOR THE UNIVERSAL AXIS AND NULLABLE FOR SEATS, WHICH IS WHY
 * `total` LIVES ON THE AXIS AND NOT HERE. Every column has a cardinality,
 * possibly zero — so `count:*` is every spell. Only 358 spells on 9.2.7 have a
 * seat — so `seat:*` is a real question. Same type, opposite totality.
 */
export const count = defineType<number>({
    name: "count",
    storage: "int",
    parse: (s) => {
        if (!/^\d+$/.test(s)) return null;
        const n = Number(s);
        return Number.isSafeInteger(n) ? n : null;
    },
    format: (n) => String(n),
    accepts: [exact, present, ...ORDERING],
    hint: "how many — a whole number, or a comparison like >4",
    ui: "number",
});

/**
 * THE NUMERIC FAMILY, FROM ONE FACTORY. Adding `yards` is one call.
 *
 * They differ only in what the number measures and how it is written; the
 * arithmetic is `units.ts` and is shared, which is what keeps "a unit converts
 * rather than annotates" one rule rather than five.
 */
function numeric(spec: NumericSpec & { name: string; hint: string }): AxisType<number> {
    return defineType<number>({
        name: spec.name,
        storage: spec.storage,
        parse: parseNumber(spec),
        format: formatNumber(spec),
        accepts: [exact, present, ...ORDERING],
        units: spec.units,
        hint: spec.hint,
        ui: "range",
    });
}

/**
 * `seconds` — durations. Cast time and channel duration today; cooldown, GCD
 * and aura duration are queued and are the same shape.
 *
 * ⭐ THE ONLY TYPE THAT ACTUALLY CONVERTS (TYPES §5.0). WoW durations span
 * three orders of magnitude — 31 sub-second cast times on 9.2.7, cooldowns
 * running to minutes — so `500ms` and `3m` both have to be sayable.
 *
 * STORED IN MILLISECONDS AND PRINTED IN SECONDS, which is TYPES §5.4's rule
 * that the canonical unit is what the PILL prints and never what the pack
 * holds. `casttime:2` is therefore two seconds, and any other choice would
 * mean a query cannot be written by reading the screen.
 */
export const seconds = numeric({
    name: "seconds",
    storage: "int",
    unit: "s",
    units: {s: 1000, ms: 1, m: 60000},
    sentinels: {[-1]: "unlimited"},
    hint: "a duration in seconds — 1.5, 500ms, 2-5, or unlimited",
});

/**
 * `percent` — proportional change. Scale, speed, desaturate, transparency.
 *
 * SIGNED, because the sign IS the information: a scale aura at +30% and one at
 * −30% are opposite effects, and a pill that printed `30%` for both would be
 * unreadable. Dimensionless, so nothing converts — `50%` and `50` are the same
 * number (TYPES §5.0).
 */
export const percent = numeric({
    name: "percent",
    storage: "int",
    unit: "%",
    units: {"%": 1},
    signed: true,
    hint: "a percentage — 50, +30, -30, or a range like 10-90",
});

/**
 * `length` — distances in the world. Beam length, collision height, spell
 * range (planned).
 *
 * ⛔ YARDS ONLY, NEVER METRES (the user's call, 2026-08-10): *"don't convert
 * yards, metres don't have a lot of meaning in WoW unfortunately."* Yards are
 * WoW's native unit and what its players think in. The conversion is perfectly
 * valid and perfectly useless — no Epsilon roleplayer has asked for an
 * 18-metre range — and offering `m` would additionally collide with minutes.
 * THE TEST FOR ADDING A UNIT IS WHETHER THE AUDIENCE USES IT, never whether
 * the conversion is correct.
 */
export const length = numeric({
    name: "length",
    storage: "float",
    unit: "yd",
    units: {yd: 1},
    hint: "a distance in yards — 5, 10-40",
});

/**
 * `angle` — cone angles and facings. Degrees only; radians are developer-
 * facing and a roleplayer says "a 60 degree cone".
 */
export const angle = numeric({
    name: "angle",
    storage: "float",
    unit: "deg",
    units: {deg: 1, "°": 1},
    hint: "an angle in degrees — 60, 27-60",
});

/**
 * `multiplier` — a bare factor. Model scale, attached-effect scale, anim
 * segment speed, ambient multiplier.
 *
 * ⭐ THIS IS TYPES §4's `scale` AND `rate` MERGED, AND THE MERGE IS A
 * CORRECTION RATHER THAN A SHORTCUT. Their rows in that table are identical in
 * every column that a type owns — float, unit `x`, no conversion, unsigned —
 * and differ only in what they measure, which TYPES §0 says out loud is none
 * of a type's business ("knows nothing about... what the value is called").
 * Two names for one thing is the repetition rule broken inside the registry
 * built to prevent it.
 *
 * AND `scale` WAS A COLLIDING NAME BESIDES: the fx column has a `scale` KIND
 * (an aura that resizes something), whose own value is a `percent`. One word
 * for a kind and a type is exactly what §0 bans. `multiplier` names what the
 * value IS — `2x` is twice — and leaves `scale` to the kind.
 */
export const multiplier = numeric({
    name: "multiplier",
    storage: "float",
    unit: "x",
    units: {x: 1, "×": 1},
    hint: "a multiplier — 2 is twice, 0.5 is half",
});

/* ─────────────────────────────────────────────────── the valueless ── */

/**
 * `bitmask` — several bits on ONE ROW, where the combinations are the point.
 *
 * Target masks, and today nothing else. From `build_data.py`:
 * `caster 1 · target 2 · area 4 · not-caster 8 · missile-dest 16`.
 *
 * ⚠ THE VALUE IS A NAMED TEST, NOT A NUMBER, and that is not a compromise —
 * it is what the bits are. `target` is the test `2|8`, `area` is `4|16`, and
 * **`both` is `1 AND 2`, a question no single bit spells.** So the operand is
 * a name and the arithmetic behind it is a declared table, which belongs to
 * the backend because it is a fact about the bits rather than about the type.
 *
 * This is the answer to *"why do we need 3 keywords instead of just `target
 * caster`"*: one property with named values, and the five words stop being
 * vocabulary scattered across four columns. Per-row, because the same chain
 * plays on the caster for one spell and on the target for another.
 *
 * ⛔ NO SUBSTRING AND NO GLOB. Matching part of a bit's NAME is how 1.0's
 * `caster` came to mean two unrelated things (L4).
 */
export const bitmask = defineType<string>({
    name: "bitmask",
    storage: "int",
    parse: (s) => s,
    format: (s) => s,
    accepts: [exact, present],
    hint: "who it plays on — pick from the named roles",
    ui: "glyphs",
});

/**
 * `flag` — a bit on a SPELL, with no value at all.
 *
 * The attribute bits (`instant`, `casttime`, `channeled`, `unbreakable`,
 * `debuff`, `tracking`, `pose`, `unhindered`) and the valueless fx (`freeze`,
 * `camo`). There is nothing to parse, compare or format, which is why this is
 * the one type with `storage: null` and no `parse`.
 *
 * ⛔ IT HAS NO TRI-STATE PROPERTY, BECAUSE EVERY AXIS IS ALREADY TRI-STATE —
 * by the grammar, not by the type system:
 *
 *     (absent)            don't care
 *     mech:unbreakable    require
 *     -mech:unbreakable   exclude
 *
 * An earlier draft gave `flag` a "tri-state toggle" as a type property. That
 * duplicated the grammar. The UI toggle writes one of the three states above;
 * it is not a fourth thing.
 *
 * ⚠ `flag` vs `bitmask` — THEY LOOK ALIKE AND ARE NOT. A flag is ONE bit on a
 * SPELL with no combinations. A bitmask is SEVERAL bits on a ROW where
 * combining them is the entire point.
 */
export const flag = defineType<never>({
    name: "flag",
    storage: null,
    accepts: [present],
    hint: "either the spell has it or it does not",
    ui: "toggle",
});

/* ⛔ `colour` IS DELIBERATELY NOT DEFINED, and this comment is the refusal.
 *
 * Tints ship as packed 0xRRGGBB. `tint:#FF00AA` would parse trivially — and
 * answer almost nothing, because NOBODY KNOWS A TINT'S EXACT PACKED VALUE and
 * exact equality over 16.7M values is not a question anyone asks. A colour
 * type is blocked on a MATCHING SEMANTIC, not on a notation: nearest-colour
 * distance, or named buckets (`tint:red`). Until that is decided, `#` is not
 * registered as a radix anywhere — which is also why `AxisType` carries no
 * `radix` field yet (TYPES §2 sketches one; no type needs it, and an unread
 * field is a declaration nothing can be wrong about). TYPES §4, SEARCH.md §9.
 */
