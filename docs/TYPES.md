# Search 2.0 — the type system

**This document OWNS types.** `docs/SEARCH.md` is the law of the query language and points here for everything about
what a value means; the two must never both describe a type. If you are adding a searchable number, a new unit, a new
notation or a new UI affordance, this is the only file you need.

**Status: DESIGN. Nothing built.**

**⛔ TERMINOLOGY IS DEFINED ONCE, IN `docs/SEARCH.md` §0** — axis, type, column, row, tag, chip, pill, segment. This file
never redefines a term; if one is missing there, add it there.

The build plan is `docs/PROCESS-LOG-search2.md` §4.

---

## 0. What a type is, in one sentence

> **A type answers four questions about a VALUE — what it means, how it compares, how it is written, and how it is
> drawn — and knows nothing about which axis uses it, which column that axis reads, or what the value is called.**

That ignorance is the whole design. An axis says *"cast time is measured in seconds"*; the `seconds` type says what a
second is, how two of them compare, that `ms` is a thousandth of one, and that a number line is the right control. **The
type never learns the word "casttime".**

---

## 0.5 ⭐ WHERE TYPES SIT NOW — kinds, properties, and what this file does NOT own

**Added 2026-08-10, after `SEARCH.md` L5.2 introduced KINDS. Read this before the catalogue or the assignment table.**

**The full chain, and each link is owned by exactly one document:**

```text
COLUMN  yields  ROWS                     SEARCH.md L5.2
ROW     has a   KIND                     SEARCH.md L5.2   (a kind is what 1.0 called a pill type)
KIND    has     PROPERTIES               SEARCH.md L5.2
PROPERTY has a  TYPE                     ⭐ THIS FILE
TYPE    decides meaning, operators,
                units, format, affordance ⭐ THIS FILE
```

**So a type is now one link down from where this file first described it.** Nothing in the catalogue changes — a
`percent` is still a `percent` — but the thing that HAS a type is a **property of a kind**, not "a searchable value"
in the abstract.

```text
defineKind({
    id: "model.missile", column: "model", word: "missile",
    props: {
        file:   { type: path },          // <- the TYPE is this file's business
        from:   { type: attachPoint },   // <- two properties sharing one type is
        to:     { type: attachPoint },   //    how roles are expressed (L5.2)
        motion: { type: enumOf("SpellMissileMotion") },
        target: { type: targetMask },
    },
});
```

**⚠ THREE CONSEQUENCES FOR THIS DOCUMENT, and they are why §8 was rewritten:**

1. **"One axis, one value" is now enforced STRUCTURALLY.** A property holds one value by construction, so the `invis`
   split (§8.2) stops being a rule to remember and becomes two property lines.
2. **Multi-notation is a property with several types** — `types: [id, text]` on one property, unchanged from §7.
3. **A kind's UI is COMPOSITION, not a new affordance.** The user, 2026-08-10: *"we are doing a different UI solution
   for each type, with sliders and selectors and checkboxes; this is no exception, we can just get the properties
   listed."* Each property draws with its own type's `ui`; the kind lays them out. **`AxisType.ui` still decides every
   leaf, and there is no `ui: "composite"`.**

**⛔ WHAT THIS FILE DOES NOT OWN, so nothing is stated twice:** kinds, properties, columns, rows and the query grammar
are all `SEARCH.md`. **If you came here to add a searchable thing, you need a property on a kind (SEARCH.md L5.2) and
a type for it (here).**

---

## 1. Two layers, and the source owns one of them

**Measured over every column of every table the build reads on 9.2.7 (`ref.column_info`):**

| dbd type                                             | columns | notes                                        |
|------------------------------------------------------|---------|----------------------------------------------|
| `int` — widths 8 / 16 / 32 / 64, signed and unsigned | **909** | 25 are FK/relations, 7 carry a declared enum |
| **`float`**                                          | **320** | **the app has no float axis at all today**   |
| `locstring`                                          | 20      | localised strings — see §9                   |
| `string`                                             | 7       |                                              |
| *(array columns)*                                    | **374** | a structural modifier over all of the above  |

**So the source declares FOUR base types. Everything else is meaning we add.**

- **STORAGE — not ours to choose.** `int` · `float` · `string` · `locstring`, plus the structural modifiers *array*,
  *relation (FK)* and *declared enum*.
- **SEMANTIC — ours, declared, extensible.** What the number MEANS, how it is queried, formatted, and offered.

**The 320 float columns are why this layering matters**: `CollisionHeight`, `HoverHeight`, `ModelScale`, `MountHeight`,
`BarrageEffect.ConeAngle`, `BeamEffect.FixedLength`, `AnimKitSegment.Speed` — heights, widths, radii, angles, rates.
Every one is RP-relevant and not one is reachable today.

---

## 2. The interface — the entire contract in one block

```ts
/**
 * A semantic type. Registered, never hard-coded into a union: adding a type
 * is a call to defineType(), and nothing else in the system changes.
 *
 * THE READING RULE FOR THIS WHOLE INTERFACE:
 *   an ABSENT method DECLINES that operator, and declining is a static
 *   error reported to the user -- never a silent fallback to something else.
 *   `text` has no `compare`, which is why `name:>m` says "the name axis has
 *   no ordering" instead of substring-searching for the characters ">m".
 */
export interface AxisType<V = unknown> {
    /** Registry key, and the word a diagnostic uses: "the scale axis takes a percentage". */
    readonly name: string;

    /** What the pack holds. null = the type has no value at all (see `flag`). */
    readonly storage: "int" | "float" | "string" | "locstring" | null;

    /**
     * Text -> value, or null when the text is not of this type.
     *
     * RETURNING NULL IS THE DISPATCH MECHANISM (§7): an axis may declare
     * several types, and the first whose parse() accepts the operand wins.
     * So `id.parse("frostbolt")` must return null rather than NaN.
     */
    parse(text: string): V | null;

    /**
     * Value -> the string a pill prints and a query can be written with.
     *
     * INVARIANT, and it is a property test (PLAN phase 2):
     *     format(parse(s)) === s   for every canonical s
     * This is what makes "read the pill, type what you see" true, which is
     * the whole of L12 at the value level.
     */
    format(value: V): string;

    /* ---- THE OPERATOR CONTRACT ------------------------------------------
     * Each operator has ONE abstract meaning, fixed by the grammar and
     * identical for every type. A type supplies the BODY for its own
     * domain; it may never give an operator a different meaning.
     */

    /** `=`  exactly this -- the whole value, never a part. */
    equals?(value: V, operand: V): boolean;

    /** `< > <= >=` and ranges. MUST BE A TOTAL ORDER: transitive,
     *  antisymmetric, and consistent with equals(). That contract is what
     *  stops an implementation quietly becoming an override. */
    compare?(value: V, operand: V): number;

    /** a bare token -- partial match. */
    contains?(value: V, operand: string): boolean;

    /** `*` inside a token -- a pattern. */
    glob?(value: V, pattern: string): boolean;

    /** `*` alone -- has any value. */
    present?(value: V): boolean;

    /* ---- WRITING AND DRAWING -------------------------------------------- */

    /** §5. Absent = this type takes no unit, and a unit on it is an error. */
    readonly units?: UnitTable;

    /** §5.3. Absent = decimal only. `{"#": 16}` reads hex. */
    readonly radix?: Record<string, number>;

    /** The DEFAULT control. An axis's domain() may override it -- cardinality
     *  decides the affordance, not the type (§6.1). */
    readonly ui: "text" | "number" | "range" | "picker" | "toggle" | "glyphs";
}

export const TYPES = new Map<string, AxisType>();

export function defineType<V>(t: AxisType<V>): AxisType<V> {
    if (TYPES.has(t.name)) throw new Error(`axis type "${t.name}" already defined`);
    TYPES.set(t.name, t as AxisType);
    return t;
}
```

**⛔ WHAT A TYPE MAY NOT DO**, so it is not discovered later as a feature: add an operator of its own, change precedence,
or make an operator mean something §3's table does not say. **If a type needs a question the operators cannot ask, it
needs an AXIS, not an operator.**

---

## 3. The operator contract

**Three parts, and the third prevents a whole class of bug:**

1. Every operator has ONE abstract meaning, fixed by the grammar and identical everywhere.
2. A type REALISES that meaning for its own domain. It may not give the operator a different meaning.
3. A type may DECLINE an operator — **and declining is a static error, never a silent fallback.**

| operator             | abstract meaning                                        |
|----------------------|---------------------------------------------------------|
| `=`                  | **exactly this** — the whole value, not a part          |
| `<` `>` `<=` `>=`    | **ordering** — earlier/later in this type's total order |
| `-` (between values) | **an interval** in that same order                      |
| `*` alone            | **any value**                                           |
| `*` inside a token   | **a pattern**                                           |
| bare token           | **contains** — a partial match                          |

So `=` on a number is numeric equality and on text is the whole string: **the same idea in two domains.** That is
realisation. An operator meaning "greater than" here and "contains" there would be redefinition, and is forbidden.

### 3.1 The matrix

| type                                                | `=`              | `< > <= >=`                     | `-` range   | `*` alone                | `*` in token       | bare (contains) |
|-----------------------------------------------------|------------------|---------------------------------|-------------|--------------------------|--------------------|-----------------|
| `text`                                              | whole string     | **decline**                     | **decline** | presence                 | glob               | ✅              |
| `path`                                              | whole path       | **decline**                     | **decline** | presence                 | glob (weak — §6.2) | ✅              |
| `enum`                                              | whole enum name  | **decline**                     | **decline** | presence                 | glob               | ✅ on the name  |
| `ordinal`                                           | the rung         | ✅ **its ladder**               | ✅          | presence                 | glob               | ✅ on the name  |
| `id`                                                | ✅ the only mode | **decline** — ids have no order | **decline** | presence                 | **decline**        | ⛔ **never**    |
| `bitmask`                                           | the exact mask   | **decline**                     | **decline** | any bit set              | **decline**        | ⛔              |
| `flag`                                              | **decline**      | **decline**                     | **decline** | presence                 | **decline**        | ⛔              |
| `count`                                             | = n              | ✅                              | ✅          | **no-op** — total (§6.3) | **decline**        | ⛔              |
| `seconds` `percent` `length` `scale` `angle` `rate` | = n              | ✅                              | ✅          | presence                 | **decline**        | ⛔              |

**⚠ `id` DECLINES BOTH ORDERING AND SUBSTRING, and both refusals are deliberate.** Ids have no meaningful order (spell 5
is not "before" spell 6 in any sense a user means), and substring-matching an id is the defect that made
`135812` match 295 spells instead of one.

---

## 4. The catalogue

**Each card is the whole truth about that type.** Read one and you know how it behaves everywhere.

### `text` — human-written prose and names

|               |                                                                                      |
|---------------|--------------------------------------------------------------------------------------|
| **storage**   | `string` / `locstring`                                                               |
| **values**    | spell name, spell description, sound-kit name, icon name, area name, expansion label |
| **operators** | `equals` (whole string) · `contains` · `glob` · `present`. **No ordering**           |
| **units**     | none                                                                                 |
| **format**    | the string itself                                                                    |
| **ui**        | `text`                                                                               |

```ts
export const text = defineType<string>({
    name: "text",
    storage: "string",
    parse: (s) => s,                                   // every string is a valid text
    format: (s) => s,
    equals: (v, o) => fold(v) === fold(o),             // fold = case + typographic (§9.2)
    contains: (v, o) => fold(v).includes(fold(o)),
    glob: (v, p) => globRe(p).test(fold(v)),
    present: (v) => v.length > 0,
    ui: "text",
});
```

**⚠ `text` declines `compare`, and that is load-bearing** — it is what makes `name:anti-magic` one token rather than a
range, and what turns `name:>m` into an honest error instead of a substring search for `>m`.

---

### `path` — asset file paths

|               |                                                    |
|---------------|----------------------------------------------------|
| **storage**   | `string`                                           |
| **values**    | `.m2` model paths, sound file paths, texture paths |
| **operators** | same as `text`                                     |
| **units**     | none                                               |
| **ui**        | `text`                                             |

**⛔ `path` IS A DISTINCT TYPE FROM `text` FOR ONE MEASURED REASON: it can never be anchored.** Asset paths carry no word
segmentation — `beecreature.m2`, `beerfest_keg01.m2`, `hangingbeetle01.m2`. Splitting on `_` yields `beecreature`
and `beerfest`, **neither of which equals `bee` nor `beer`**. So matching is unanchored substring, forced by the corpus,
and `path.glob` is close to a no-op in the middle of a token. **The type exists so the hint can say so** and so a future
anchoring proposal has somewhere to be refused. See SEARCH.md §3.2.

---

### `enum` — a named value from a closed set

|               |                                                                                     |
|---------------|-------------------------------------------------------------------------------------|
| **storage**   | `int`, with a declared enum                                                         |
| **values**    | spell effect names, aura names, implicit-target names, proc types, kit effect types |
| **operators** | `equals` (whole enum name) · `contains` · `glob` · `present`. No ordering           |
| **units**     | none                                                                                |
| **format**    | the enum's own name, e.g. `UNIT_TARGET_ENEMY`                                       |
| **ui**        | **`picker`** — the values exist in the pack and nothing offers them today           |

**The picker is the point.** `mech:unit_target_enemy` already works (21,109 on 9.2.7); what is missing is anything
telling a user the value exists. An `enum` axis is browsable by construction, which is the direct answer to *"I find
myself way too often opening wago.tools when Epsilook doesn't provide."*

**✅ RESOLVED — THERE IS NO LADDER (PHASE 0).** 1.0 matches an enum by trying exact first, then substring, and that
looked like a fourth matching mode. It is not: **matching is `contains`, and "exact first" is RANKING.** So the ladder
collapses into the relevance rule (SEARCH.md D3), and `enum` is `text` plus a picker plus a relevance tier.

---

### `ordinal` — an enum WITH a total order

|               |                                                                               |
|---------------|-------------------------------------------------------------------------------|
| **storage**   | `int`                                                                         |
| **values**    | **expansion** (`xpac`). Candidates, none built: item quality, difficulty tier |
| **operators** | everything `enum` has, **plus `compare` and ranges on its ladder**            |
| **ui**        | ordered `picker`                                                              |

```ts
export const ordinal = defineType<Rung>({
    name: "ordinal",
    storage: "int",
    parse: (s) => LADDER.lookup(s),                    // by name or by index
    format: (r) => r.label,                            // "Legion"
    equals: (v, o) => v.index === o.index,
    compare: (v, o) => v.index - o.index,              // the ladder IS the order
    contains: (v, o) => fold(v.label).includes(fold(o)),
    present: () => true,
    ui: "picker",
});
```

**⭐ `ordinal` EXPLAINS WHY `xpac` FELT SPECIAL.** 1.0 handled it with a private second operator alphabet
(`XPAC_VALUE`) — exactly the duplication L1 forbids. Declaring the type puts it back under the one grammar: same
operators, same precedence, a different domain to compare in.

**⚠ OPEN (§9.5): is the ladder GLOBAL or PER-PACK?** `compare` must be a total order, but rungs are gated by `when?(d)`
— a Vanilla pack has fewer. Undefined whether `xpac:>legion` orders against all twelve rungs or the loaded pack's
subset. **Pick global**: the ladder is a property of Warcraft, not of the pack, and a pack simply has no spells at the
rungs it lacks.

---

### `id` — an identity, not a quantity

|               |                                                                                  |
|---------------|----------------------------------------------------------------------------------|
| **storage**   | `int`                                                                            |
| **values**    | spell id, SoundKit id, AnimKit id, icon fid, model fid, area id, display id      |
| **operators** | **`equals` only**, plus `present`. Declines ordering, ranges, substring and glob |
| **units**     | none — **an id is never normalised, scaled or given a unit**                     |
| **format**    | the digits                                                                       |
| **ui**        | exact entry + a copy button                                                      |

```ts
export const id = defineType<number>({
    name: "id",
    storage: "int",
    /** null on anything that is not purely digits -- this is what lets a
     *  multi-notation axis fall through to `text` (§7). */
    parse: (s) => (/^\d+$/.test(s) ? Number(s) : null),
    format: (n) => String(n),
    equals: (v, o) => v === o,
    present: () => true,
    ui: "number",
});
```

---

### `bitmask` — several bits on ONE ROW, where the combinations are the point

|               |                                                                                |
|---------------|--------------------------------------------------------------------------------|
| **storage**   | `int`                                                                          |
| **values**    | target masks                                                                   |
| **operators** | `equals` (the exact mask) · `present` (any bit set). No ordering, no substring |
| **ui**        | **`glyphs`** — one toggle per named bit                                        |

From `build_data.py`: `caster 1 · target 2 · area 4 · not-caster 8 · missile-dest 16`. So `target` is the test `2|8`,
`area` is `4|16`, and **`both` is `1 AND 2`, a question no single bit spells.** Per-row, because the same chain plays on
the caster for one spell and the target for another.

**This is the answer to *"why do we need 3 keywords instead of just `target caster`"*** — one axis with named values,
global: `target:caster`, `target:area`, `target:both`. The five words stop being vocabulary scattered across four
columns.

---

### `flag` — a bit on a SPELL, with no value at all

|               |                                                                                                                                     |
|---------------|-------------------------------------------------------------------------------------------------------------------------------------|
| **storage**   | `null` — there is nothing to parse, compare or format                                                                               |
| **values**    | attribute bits: `instant`, `casttime`, `channeled`, `unbreakable`, `debuff`, `tracking`, `pose`, `unhindered`; and `freeze`, `camo` |
| **operators** | `present` only                                                                                                                      |
| **ui**        | `toggle`                                                                                                                            |

**⛔ `flag` HAS NO TRI-STATE PROPERTY, because EVERY axis is already tri-state** — by the grammar, not the type system:

    (absent)               don't care
    mech:unbreakable       require
    -mech:unbreakable      exclude

An earlier draft gave `flag` a "tri-state toggle" as a type property. That duplicated the grammar. The UI toggle writes
one of the three states above; it is not a fourth thing.

**`flag` vs `bitmask` — they look alike and are not.** A flag is ONE bit on a SPELL with no combinations. A bitmask is
SEVERAL bits on a ROW where combining them is the entire point.

---

### `count` — a cardinality

|               |                                                      |
|---------------|------------------------------------------------------|
| **storage**   | `int`, derived — never shipped                       |
| **values**    | the universal `count` axis; vehicle seats            |
| **operators** | `equals` · `compare` · ranges. No substring, no glob |
| **units**     | none (dimensionless)                                 |
| **ui**        | `stepper` (`number`)                                 |

**⚠ `count` IS TOTAL FOR THE UNIVERSAL AXIS AND NULLABLE FOR SEATS, WHICH IS WHY `total` LIVES ON THE AXIS, NOT HERE.**
Every column has a cardinality, possibly zero — so `count:*` is every spell. Only 358 spells on 9.2.7 have a seat — so
`seat:*` is a real question. **Same type, opposite totality.**

---

### The numeric family — `seconds` `percent` `length` `scale` `angle` `rate`

**One shape, six units. They differ only in what the number measures.**

| type      | storage     | unit  | values                                                                    | signed  |
|-----------|-------------|-------|---------------------------------------------------------------------------|---------|
| `seconds` | `int` (ms)  | `s`   | cast time, channel duration; *planned:* cooldown, GCD, duration           | no      |
| `percent` | `int`       | `%`   | scale, speed, desaturate, transparency                                    | **yes** |
| `length`  | **`float`** | `yd`  | *planned:* collision height/width, hover height, beam length, spell range | no      |
| `scale`   | **`float`** | `x`   | *planned:* model scale, attached-effect scale                             | no      |
| `angle`   | **`float`** | `deg` | *planned:* cone angle                                                     | no      |
| `rate`    | **`float`** | `x`   | *planned:* anim segment speed, ambient multiplier                         | no      |

```ts
/** The whole family, from one factory. Adding `yards` is one call. */
const numeric = (o: {
        name: string; storage: "int" | "float";
        unit: string; units: UnitTable; signed?: boolean; sentinels?: Sentinels;
    }) => defineType<number>({
        name: o.name,
        storage: o.storage,
        parse: parseNumber(o),        // handles sign, units, sentinels; null if not numeric
        format: (n) => `${o.signed && n > 0 ? "+" : ""}${fmt(n)}${o.unit}`,
        equals: (v, x) => v === x,
        compare: (v, x) => v - x,     // a total order, trivially
        present: () => true,
        units: o.units,
        ui: "range",
    });

const seconds = numeric({
    name: "seconds", storage: "int", unit: "s",
    units: {s: 1, ms: 0.001, m: 60},
    sentinels: {[-1]: "unlimited"}
});
const percent = numeric({
    name: "percent", storage: "int", unit: "%",
    units: {"%": 1}, signed: true
});
const angle = numeric({
    name: "angle", storage: "float", unit: "deg",
    units: {deg: 1, "°": 1}
});
```

**⚠ SENTINELS ARE CLASSIFIED BEFORE THEY ARE SCALED OR COMPARED.** `SpellCastTimes.Base` has a minimum of
**−1,000,000**; `CreatureModelData.CollisionHeight` has **−20,000,000**. Neither is a duration or a height. A sentinel
never enters a range, a bound or a domain — see §6.1.

---

### `colour` — **NOT DEFINED. Blocked on a semantic, not a notation.**

Tints ship as packed `0xRRGGBB`. `tint:#FF00AA` would parse trivially — and answer almost nothing, because **nobody
knows a tint's exact packed value** and exact equality over 16.7M values is not a question anyone asks.

**A colour type needs a MATCHING semantic first**: nearest-colour distance, or named buckets (`tint:red`). Until that is
decided, `#` is not registered as a radix anywhere. SEARCH.md §9 #8.

---

## 5. Units

### 5.0 ⭐ WHICH UNITS CONVERT, AND WHY — only ONE type actually needs it

**The user's call, 2026-08-10: *"don't convert yards, metres don't have a lot of meaning in WoW unfortunately. Make sure
you keep in mind to which units you convert and why, what's logical here."*** Working that through per type is the whole
answer, and it is much smaller than the machinery first suggested:

| type      | canonical | converts?                                | why                                                                                                                                                                   |
|-----------|-----------|------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `seconds` | `s`       | ✅ **`ms` · `s` · `m`**                  | the ONLY real case. WoW durations span 3 orders — 31 sub-second cast times, and cooldowns run to minutes                                                              |
| `length`  | `yd`      | ⛔ **NEVER** — yards only                | **yards are WoW's native unit.** Metres are not a unit the game or its players think in; offering `m` would invite a conversion nobody wants and collide with minutes |
| `percent` | `%`       | ⛔ dimensionless — nothing to convert to | `50%` and `50` are the same number                                                                                                                                    |
| `angle`   | `deg`     | ⛔ degrees only                          | radians are developer-facing. A roleplayer says "a 60 degree cone"                                                                                                    |
| `scale`   | `x`       | ⛔ a multiplier has no alternate unit    | `2x` is twice. There is no second way to say it                                                                                                                       |
| `rate`    | `x`       | ⛔ same                                  |                                                                                                                                                                       |
| `count`   | —         | ⛔ dimensionless                         |                                                                                                                                                                       |

**⭐ SO CONVERSION IS A FEATURE OF `seconds` AND NOTHING ELSE TODAY.** Every other numeric type declares one canonical
unit that is *displayed and accepted*, never converted. That is worth knowing before building the machinery: `units` is
a general mechanism with exactly one current customer, and the honest reason to build it generally is that
`SpellCooldowns` and durations are queued and are the same shape.

**THE TEST FOR ADDING A UNIT: does the AUDIENCE use it?** Not "is it a valid conversion". Yards convert perfectly well
to metres and the conversion is useless, because no Epsilon roleplayer has ever asked for a spell with an 18-metre
range.

### 5.1 The seven rules

1. **A unit is OPTIONAL. A bare number means the CANONICAL unit.** `scale:50` is fifty percent.
2. **⭐ A unit CONVERTS; it does not annotate.** `casttime:500ms` is half a second, `casttime:500` is five hundred
   seconds. Earned: **9.2.7 has 31 sub-second cast times.**
3. **⭐ THE CANONICAL UNIT IS WHAT THE PILL PRINTS, NEVER WHAT THE PACK STORES.** Cast times store milliseconds and the
   pill prints seconds, so `casttime:2` is two seconds. Any other choice means a query cannot be written by reading the
   screen, which is L12.
4. **A unit NEVER selects an axis** — it only scales a value inside one. Otherwise the unit is doing the axis's job.
5. **An unknown unit is an ERROR**, never ignored. `scale:50s` says *scale takes a percentage*.
6. **A type that declines `compare` declines units.** `text` has neither, so `name:100%` is ordinary text — which is why
   the **396** spell names containing `%` and the **38** containing `#` cannot collide. Structural.
7. **Every unit has an ASCII spelling; a prettier symbol is display-only.** `×`→`x`, `°`→`deg`, folded by the existing
   typographic pass. **Measured: ZERO spell names contain `×` or `°`.**

**Units are PER-TYPE, so there is no global unit vocabulary to collide**: `m` may be minutes on `seconds` and metres on
`length`, because an axis has exactly one type and the two never meet.

### 5.2 Ranges

    casttime:500ms-2s     mixed scales convert -- the useful spelling
    scale:10-90%          the unit on the last bound
    scale:(-50%)-10%      a parenthesised negative bound

### 5.3 A radix is not a unit

|           | changes                              | example         |
|-----------|--------------------------------------|-----------------|
| **unit**  | the SCALE of the value               | `500ms` ≠ `500` |
| **radix** | how the DIGITS ARE READ — same value | `#FF` = `255`   |

Both hang off `parse`, but they must stay named apart or something that is really a notation gets declared as a unit and
starts converting.

### 5.4 ⭐ What the BUILD normalises — and what it must not

**There are TWO units per numeric axis, and conflating them is the trap:**

|                  | lives in                         | example                        |
|------------------|----------------------------------|--------------------------------|
| **STORAGE unit** | the pack — integral              | `casttime` in **milliseconds** |
| **DISPLAY unit** | the pill, and a bare query value | `casttime` in **seconds**      |

**⭐ THE QUERY CONVERTS DOWN INTO STORAGE; THE PACK IS NEVER CONVERTED UP INTO DISPLAY.** `casttime:1.5` becomes `1500`
and compares as an integer.

1. **Precision.** Cast times are whole milliseconds. Shipped as seconds they become `1.5`, `0.1`, `2.75` — and `=` on a
   float that is not exact in binary is a silent wrong answer.
2. **Size.** `1500` gzips better than `1.5` across 129k rows.
3. **Debuggability.** A pack you can eyeball against wago.tools is worth keeping.

**So `build_data.py` owes CONSISTENCY AND A DECLARATION, not a rescaling:**

- **One column, one unit, identical on all eleven packs.** Real work — the source is not internally consistent.
- **The unit is DECLARED in the pack** beside `meta.counts`, so `data.ts`, `export.ts` and `tools/dossier.py` read it
  instead of each hardcoding `/1000`.
- **⛔ IDENTITY COLUMNS ARE NEVER NORMALISED** — ids, fids, enum values, bitmasks and packed RGB are not quantities.
- **⚠ A SENTINEL IS RECOGNISED BEFORE IT IS SCALED.** −1,000,000 ms must not become −1,000 s and enter a domain.

---

## 6. Domains — how the UI knows what to draw

### 6.1 Cardinality decides the affordance, not the type

**Measured on 9.2.7, and this was invisible until the numbers were on screen:**

| column                              | min             | max   | distinct | a naive control would…     |
|-------------------------------------|-----------------|-------|----------|----------------------------|
| `CreatureModelData.CollisionHeight` | **−20,000,000** | 334.9 | 1,758    | span 20 million — unusable |
| `CreatureModelData.ModelScale`      | 0.03            | 7.0   | 41       | fine                       |
| `CreatureModelData.HoverHeight`     | 0               | 50    | 25       | fine                       |
| `BarrageEffect.ConeAngle`           | 27              | 60    | **3**    | a slider over three values |
| `BarrageEffect.Range`               | 10              | 60    | **4**    | a slider over four values  |

1. **Bounds must be ROBUST, not extremal.** Exclude declared sentinels, or take a percentile band, and say on the
   control that it is clipped.
2. **⭐ `ConeAngle` and `CollisionHeight` are BOTH `float` and want completely different controls** — 3 distinct values
   is a **picker**, 1,758 is a **slider**. So `AxisType.ui` is a DEFAULT that the axis's `domain()` overrides.

```ts
export interface AxisDomain {
    lo: number;
    hi: number;                     // robust bounds, sentinels excluded
    step: number;
    values?: (number | string)[];   // present when cardinality is low -> picker
    clipped?: boolean;              // true when lo/hi hid outliers; the UI says so
}
```

**⛔ THE DOMAIN IS DERIVED FROM THE LOADED PACK, NEVER DECLARED.** Value sets differ per game version, so a hard-coded
min/max would be wrong on ten packs out of eleven.

### 6.2 Where glob is honest and where it is theatre

`glob` is genuinely useful on **segmented** corpora — enum names, icon names, spell names. On `path` it is close to a
no-op in the middle of a token (§4, `path`). **The hint tells the truth rather than implying precision the corpus cannot
deliver**, and a glob on a path raises a WARNING.

### 6.3 `total` vs nullable

|                                           |                                                                                | `axis:*` means                      |
|-------------------------------------------|--------------------------------------------------------------------------------|-------------------------------------|
| **nullable** — may simply not exist       | `attach`, `desc`, `icon`, `xpac`, `kit`, `motion`, `scale`, `casttime`, `seat` | **has one at all.** Useful          |
| **total** — always defined, possibly zero | `count`, and any derived measure                                               | **everything.** True, and worthless |

For a total axis the wildcard is **answered** rather than rejected — L2 forbids falling through, and "every spell" is
literally correct — but it is never offered in autocomplete and the bar marks it a no-op. **`total: true` on the AXIS is
the whole declaration.**

---

## 7. Multi-notation axes — one subject, several spellings

**An axis declares an ORDERED list of types. The first whose `parse()` accepts the operand wins.**

|                                  | example                                         | verdict                        |
|----------------------------------|-------------------------------------------------|--------------------------------|
| **two QUANTITIES** on one word   | `invis` = a channel id **and** a detector count | ⛔ **two axes.** Split it      |
| **two NOTATIONS** of one subject | `kit` = a sound kit, as its name **or** its id  | ✅ **one axis, two notations** |

**THE DISCRIMINATOR IS DECIDABLE: when both readings match, do they select the SAME row?** `kit:85701` and
`kit:SPELL_MA_Revamp_Frostbolt_Precast` name one kit. `invis:13` and `invis:>0` name unrelated populations.

**THE RULES:**

1. Dispatch is by the SHAPE of the operand; the declared order is the precedence.
2. **An operator is offered only if EVERY declared type implements it** — a multi-notation axis is the INTERSECTION of
   its types' capabilities, never the union. So `kit:>5` is a static error, because `id` and `text` both decline
   ordering.
3. **⚠ A COLLISION MUST BE MEASURED, AND THE MEASUREMENT MUST BE ENFORCED.**

**Measured for `kit` — 84,351 names on the 8.3.0 table: exactly THREE are all digits** (`"0"`, `"9"`, `"150"`),
placeholder junk, and **not one equals its own id**. So `kit:<number>` reads as the id and nothing real is lost.

**⛔ BUT FREQUENCY IS NOT A GUARANTEE, so the check is a BUILD-TIME ASSERTION, not a note.** A pack rebuild can introduce
a digit-name collision and silently change a bookmarked query. `check.py` fails when a multi-notation axis's notations
can both accept one operand and disagree.

**⚠ TWO OPEN QUESTIONS (§9.6):** which notation runs for `kit:*`, where there is no operand shape to dispatch on — and
whether `kit:="150"` is acceptable, given the quote is then doing notation SELECTION, a second role the delimiter rules
forbid.

**⛔ THERE IS NO `mixed` TYPE.** An earlier draft had one for "the sound column (files ∪ kit names ∪ ids)". It was never
a type — it is an axis with three notations, each of which has a real type.

---

## 8. THE KIND CATALOGUE — every kind, its properties, and each property's type

**⚠ REBUILT 2026-08-10 after `SEARCH.md` L5.2.** This was a flat "value → type" list, which the kind model supersedes:
a type belongs to a **property**, a property belongs to a **kind**, and a kind belongs to a **column**. **This table is
the PHASE 5 port order and the PHASE 2 declaration list.**

**How to read it:** each row is one `defineKind`. `target` appears on most kinds and is always the same `mask` type —
listed only where it is known to carry one. **Properties in bold do not exist in 1.0** and are the reachable wins.

**⛔ PROVISIONAL WHERE MARKED `?`.** Confirm against `ref.column_info` in PHASE 5 before declaring. Do not name a
property from an identifier (CLAUDE.md's standing rule).

### 8.1 `model` — what is drawn

| kind | properties → type |
|---|---|
| **missile** | `file` path · `from` attachPoint · `to` attachPoint · `motion` enum · `target` mask · **`castOffset` vec3?** · **`impactOffset` vec3?** · **`decay` seconds?** |
| **ground** | `file` path · `target` mask |
| **trail** | `file` path · `target` mask |
| **barrage** | `file` path · `attach` attachPoint · **`coneAngle` angle** (3 distinct values → picker) · **`range` length** (4 values) |
| **attached** | `file` path · `attach` attachPoint · `target` mask · **`scale` scale?** |
| **display** | `id` id · `name` text · `file` path |
| **item** | `file` path · `itemId` id |
| **mount** | `file` path · `name` text |
| **equipped** | `slot` enum |

### 8.2 `sound` — what is heard

| kind | properties → type |
|---|---|
| **sound** | `file` path · `kit` **[id, text]** (multi-notation, §7) · `target` mask · **`type` enum?** (`SoundKit.SoundType`, designed and parked) |

### 8.3 `anim` — how it moves

| kind | properties → type |
|---|---|
| **replace** | `from` enum · `to` enum · `target` mask |
| **passenger** | `enter` enum · `sit` enum · `exit` enum |
| **kit** | `id` id · `anim` enum · `boneset` enum · **`speed` rate?** (`AnimKitSegment.Speed`) |
| **loose** | `anim` enum · `boneset` enum |

### 8.4 `fx` — what it looks like

| kind | properties → type |
|---|---|
| **chain** | `texture` path · `from` attachPoint · `to` attachPoint · `tint` **colour (blocked, §4)** · `target` mask · **`length` length?** · **`minDistance` length?** |
| **dissolve** | `attach` attachPoint · `target` mask |
| **ghost** | `attach` attachPoint · `target` mask |
| **glow** | `target` mask · **`colour` colour?** |
| **tint** | `colour` **colour (blocked)** · `target` mask |
| **screen** | `type` enum · `target` mask |
| **scale** | `percent` percent · `target` mask |
| **speed** | `percent` percent · `mode` enum (run/walk/fly/swim) · `target` mask |
| **transparency** | `percent` percent · `target` mask |
| **desaturate** | `percent` percent · `target` mask |
| **freeze** | *(flag — no value)* · `target` mask |
| **camo** | *(flag — no value)* · `target` mask |
| **morph** | `display` **[id, text]** · `target` mask |
| **summon** | `creature` **[id, text]** |
| **object** | `object` **[id, text]** |
| **shapeshift** | `form` enum |
| **seat** | `count` count · `attach` attachPoint · **`passengerAttach` attachPoint** |
| **invis** | `channel` id — **⚠ SPLIT, see 8.6** |
| **detect** | `channel` id · `count` count — **the other half of the split** |

### 8.5 `mech` · `name` · `id`

| column | kind | properties → type |
|---|---|---|
| `mech` | **effect** | `enum` enum · `target` mask · **`misc0` int?** · **`misc1` int?** · **`amplitude` float?** · **`radius` length?** |
| `mech` | **aura** | `enum` enum · `target` mask · **`stacks` count?** (`CumulativeAura`, route already added) |
| `mech` | **casttime** | `seconds` seconds |
| `mech` | **channeled** | `seconds` seconds *(sentinel: unlimited)* |
| `mech` | **location** | `area` **[id, text]** |
| `mech` | **triggers** | `spell` **[id, text]** |
| `mech` | **origin** | `spell` **[id, text]** |
| `mech` | *(planned)* **range** | `yards` length *(sentinel: unlimited)* — new source |
| `mech` | *(planned)* **cooldown** | `seconds` seconds — new source |
| `mech` | *(planned)* **cost** | `amount` count — new source |
| `name` | **name** | `text` text |
| `name` | **description** | `text` text |
| `name` | **icon** | `name` text · `fid` id |
| `id` | **id** | `value` id |
| `id` | **expansion** | `rung` ordinal |

### 8.6 ⚠ THE SPLITS AND RENAMES THIS TABLE FORCES

| # | what | why |
|---|---|---|
| 1 | **`invis` becomes two kinds** — `invis{channel}` and `detect{channel,count}` | one word carried a channel id AND a detector count, told apart by whether an operator was typed (`operatorOnly`). Two quantities are two things (§4.2b) |
| 2 | **`from` / `to` replace the unioned `attach`** on missile and chain | **2,014 of 2,997 beam rows have different source and destination attachments.** `attach` survives as the declared UNION |
| 3 | **the model category word `attach` → `attached`** | it collides with the attachment keyword: `model:attach` is 16, `model:{attach:chest}` is 51,581. Gate G1 fails today |
| 4 | **`ghost` was two registrations** (`fx:shadowy`, `fx:ghostmat`) under one word | one word, two kinds — decide whether they are one kind with a `material` property, or two words |
| 5 | **`path` the type vs `path` the trajectory** | the property is `motion`; `path` stays the type |
| 6 | **`.tag-*` CSS → `.seg-*`** | `tag` now means a query unit (§0) |

### 8.7 ⭐ WHAT THE CATALOGUE REVEALS

- **The `target` mask is on ~25 of ~35 kinds.** It is the most-shared property in the app, which is why it read like a
  universal axis and why it is not one — it is a property most kinds happen to have.
- **`float` is still unreachable everywhere.** Every bold entry above that is `angle`, `length`, `rate` or `scale` is a
  float column the app has never exposed (TYPES §1: 320 of them).
- **Multi-notation `[id, text]` appears SIX times** — sound kit, morph, summon, object, area, triggered spell. It is a
  pattern, not a special case, and it is the same shape each time: a thing with an id and a name.
- **Three kinds are pure flags** (`freeze`, `camo`, and the attribute bits), so `flag` earns its place as a type with
  no value.
- **⚠ `vec3` HAS NO TYPE YET.** `CastOffset_0/1/2` and `ImpactOffset_0/1/2` are 3-vectors. Either three properties, or
  a new composite type. **Decide before touching missiles**; do not invent one speculatively.

---

## 9. Open type questions

| #       | question                                                                                                                       | why it matters                                                                   |
|---------|--------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------|
| **9.0** | **`vec3` has no type.** `CastOffset_0/1/2`, `ImpactOffset_0/1/2` — three properties, or one composite type? | blocks the missile kind (§8.7) |
| **9.1** | **Arrays are unmodelled — 374 columns.** An array column is where the row model must choose one-row-vs-N                       | that choice sets every `count` on the column. **Decide in the spike**            |
| **9.2** | **Case folding and Unicode normalisation are a per-type `equals`/`contains` contract**, filed elsewhere as "not architectural" | it IS architectural by this document's own definition. `locstring` is 20 columns |
| **9.3** | `locstring` is declared storage but no type reads it as anything but `text`                                                    | i18n was parked; if revived it lands here                                        |
| **9.4** | **Does `enum` have an exact→substring→glob LADDER, or is it `text` + a picker?**                                               | blocks the mech column port                                                      |
| **9.5** | Is the `ordinal` ladder global or per-pack?                                                                                    | **recommend global** — see §4                                                    |
| **9.6** | `kit:*` dispatch, and whether `kit:="150"` gives the quote a second role                                                       | §7                                                                               |

---

## 10. Adding a type — the whole workflow

**If this takes more than the four steps below, the design has drifted.**

1. **Measure the column first** — `ref.column_info` for storage, then min/max/distinct and the sentinel check (§6.1). *A
   column that is 90% one value is a different proposition from one that varies.*
2. **`defineType({...})`** in `types.ts` — one call. Reach for the `numeric()` factory if it is a quantity.
3. **Assign it** — one row in §8, and one `types: [...]` entry on the axis.
4. **Nothing else.** No kernel edit, no parser edit, no UI edit, no help edit. **If a fifth step appears, stop and fix
   the framework instead** — that is §2.5's extension contract, and this is the test of it.
