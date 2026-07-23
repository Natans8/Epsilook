# Epsilook data routes

Every path data takes from an upstream source to a pixel in the app. This is the
map of *where things come from*; `build/build_data.py` is the implementation and
`CLAUDE.md` holds the decisions and gotchas behind it.

Read it in five stages:

1. [Sources](#1-sources) — what gets downloaded, from where
2. [The visual graph](#2-the-visual-graph-spine) — the spine every visual route hangs off
3. [Payload routes](#3-payload-routes) — the ~20 routes from a kit/spell to something showable
4. [The pack](#4-the-pack) — how it lands in the UI
5. [Version differences](#5-version-differences) — what each of the six builds does and doesn't have
6. [Runtime routes](#6-runtime-routes-browser-on-demand) — what the browser fetches live

---

## 0. The pipeline at a glance

```mermaid
flowchart LR
  subgraph SRC["Sources (build-time, cached in build/cache/)"]
    W["wago.tools<br/>33 db2 tables as CSV"]
    L["community listfile<br/>fid → path"]
    T["TrinityCore TDB<br/>world + hotfixes SQL"]
    A["anims.js<br/>AnimID → name"]
    E["WoWDBDefs enums<br/>SpellEffect / SpellEffectAura"]
  end

  B["build_data.py<br/>walk + resolve + bake"]
  P["docs/data/&lt;build&gt;/pack.json.gz<br/>column-oriented, ~44 sections"]
  D["data.js<br/>builds in-memory indexes"]
  U["search.js + app.js<br/>query + render"]

  W --> B
  L --> B
  T --> B
  A --> B
  E --> B
  B --> P --> D --> U

  subgraph RT["Runtime hotlinks (on demand, never bulk)"]
    Z["zamimg — icons, sounds"]
    C["wago CASC — .blp textures, logos"]
    V["wowtools.work — 3D viewer"]
    H["wowhead — spell/npc/model pages"]
  end
  U -.-> Z
  U -.-> C
  U -.-> V
  U -.-> H
```

Nothing is fetched from a local DB dump, and nothing is fetched per-result at
runtime. Everything the search touches is baked into the pack.

---

## 1. Sources

| Source | URL shape | Role |
|---|---|---|
| **wago.tools** | `wago.tools/db2/{table}/csv?build={version}` | The 33 client db2 tables. Version-pinned, so a pack always matches its build. |
| **community listfile** | `github.com/wowdev/wow-listfile` (latest release) | `FileDataID → path`. The only way a fid becomes `cfx_mage_fireball_missile.m2`. ~150 MB, streamed and filtered, never loaded whole. |
| **TrinityCore TDB** | GitHub release `.7z` per era | Two distinct roles — see below. |
| **anims.js** | `wow.tools.local` raw | `AnimID → name` (Stand, SpellCastDirected, …). |
| **WoWDBDefs `meta/enums/`** | raw master | `SpellEffect.dbde` + `SpellEffectAura.dbde` — the authority on what a mechanic enum value means. |

### TDB does two unrelated jobs

```mermaid
flowchart LR
  TDB["TDB release .7z"] --> WORLD["world dump"]
  TDB --> HOT["hotfixes dump"]

  WORLD --> CT["creature_template<br/>creature → NPC name"]
  WORLD --> CTM["creature_template_model<br/>creature → display ids"]
  CT --> USE1["morphs + summons<br/>(server-side; the client never ships it)"]
  CTM --> USE1

  HOT --> OV["9 tables overlaid onto the<br/>wago rows BY ROW ID"]
  OV --> USE2["post-ship corrections<br/>(TDB wins where it has a row)"]
```

**World tables are the only source of creature names and displays** — that data
lives on the server, so without a `TDB_RELEASES` entry morph pills render as
`creature #<id>`. **Hotfix tables** are the rows Blizzard patched over the wire
after the build shipped; they are applied on top of wago by row ID for
`spell_name`, `spell_x_spell_visual`, `spell_visual`, `spell_visual_missile`,
`spell_visual_effect_name`, `spell_effect`, `spell_misc`,
`creature_display_info`, `creature_model_data`.

A version with no TDB entry still builds — morphs stay unresolved, hotfixes
don't apply, and the build logs both.

---

## 2. The visual graph spine

Almost every visual route starts here. Both hops are many-to-many.

```mermaid
flowchart LR
  S["Spell<br/>(SpellName, or Spell.Name_lang pre-BfA)"]
  SXSV["SpellXSpellVisual"]
  SV["SpellVisual"]
  SVE["SpellVisualEvent"]
  K["SpellVisualKit"]
  SVKE["SpellVisualKitEffect<br/>EffectType dispatch"]
  MS["SpellVisualMissile<br/>(missile set)"]

  S --> SXSV --> SV
  SV -->|"Caster/HostileSpellVisualID<br/>(redirect, + target bit)"| SV
  SV -->|"SpellVisualEvent rows"| SVE -->|"+ TargetType"| K
  SV -->|"SpellVisualMissileSetID<br/>+ RaidSpellVisualMissileSetID"| MS
  SV -->|"AnimEventSoundID"| AES["SoundKitEntry → sound fids"]
  K --> SVKE
```

Three things to hold onto:

**The kit edge carries a target mask.** `SpellVisualEvent.TargetType` says *who
the kit plays on*, and it rides along with everything that kit contributes.
A visual can reach the same kit through several event rows, so masks union per
edge. Impact kits genuinely carry duplicate rows differing only in TargetType —
that is why a row can be caster *and* target.

| TargetType | bit | search word | icon meaning |
|---|---|---|---|
| 1 | 1 | `caster` | on the caster |
| 2 | 2 | `target` | on the target |
| 3 | 4 | `area` | on the ground at the target |
| 4 | 8 | `target` | on the target only, never the caster |
| 5 | 16 | `area` | on the ground where the missile lands |
| 0 | — | — | effectively unused (1 row in 207,241 on 9.2.7); contributes nothing |

**…but `TargetType` is relative to the CAST, not to the visual.** It distinguishes
"the caster" from "the unit being cast at" — and on a **self-cast spell those are
the same unit**, where the client still writes `Target`. Taken literally that draws
a *target* icon on Divine Shield's own bubble, Ice Barrier, Invisibility and every
other self-buff's aura visual: 32,136 spells and 48,025 model rows on 9.2.7.
`SpellEffect.ImplicitTarget` is what tells a self-cast from a real one, so the two
tables must be read together (`resolve_target_mask` in `build_data.py`).

*Which* effect row to believe depends on **when** the visual plays —
`SpellVisualEvent.StartEvent` (`meta/enums/SpellVisualEventEvent.dbde`: 1/2 precast,
3 cast, 4/5 travel, 6 impact, **7/8 aura**, 9/10 area trigger, 11/12 channel,
13 one-shot). So each kit edge keeps its mask split in two halves:

| phase | who to believe | why |
|---|---|---|
| **aura** (StartEvent 7/8) | the `APPLY_AURA` effects' implicit target | the visual belongs to the aura, so it plays on whoever *carries* it — which can disagree with the rest of the spell (Vanish, Blink: a self-aura beside effects aimed at others) |
| every other phase | *all* effects' implicit targets | they share the cast's frame, so "Target" is the caster only when the whole spell is self-cast (Healing Potion, Eye of Kilrogg) |

A `Target` bit becomes `Caster` when its half's test says the spell targets only
the caster. **Only that bit is rewritten** — `TargetType 4` ("Target, not caster")
says outright that it is not the caster, so it never flips. The rule is
monotone: it replaces bit 2 with bit 1 and can never clear a caster bit, which
makes the transition histogram a build oracle (9.2.7: `2→1` 37,485, `3→1` 10,276,
`7→5` 153, `10→9` 21, `18→17` 18; plus 22 rows `2→3` where the aura phase flips
but another phase keeps a genuine target).

The contrast that shows it working: **17 Power Word: Shield** (`TARGET_UNIT_TARGET_ALLY`)
keeps `holydivineshield_state_base` on *target*, while **642 Divine Shield**
(`TARGET_UNIT_CASTER`) moves `cfx_paladin_divineshield_statebase` to *caster* —
the same kind of shield-state visual, correctly told apart. Banish and Polymorph
are untouched.

Note this reads `StartEvent` **only** far enough to get the icons right; the full
phase axis (surfacing cast/aura/impact per pill) is deliberately not built. When
it is: 97.7% of kits appear in just one phase, so phase is nearly a property of
the kit, and `StartEvent`/`EndEvent` are populated on all ten packs (no drift).

**The missile path bypasses events entirely**, so missile content carries *no*
mask — that is exactly the ~4% of unmasked rows in every pack, and the row count
matching the missile row count is a good build oracle.

**A `SpellVisual` can redirect to another `SpellVisual`.** Four columns on the
row name a substitute visual the client swaps in (`VISUAL_REDIRECTS` in
`build_data.py`); the build follows them so the spell also reaches everything
the substitute carries. This matters because the redirected-to visual is
usually reachable no other way — on 9.2.7 only 37 of 228 caster targets and 30
of 257 hostile targets also appear in `SpellXSpellVisual` — so following the
redirect is what makes that content visible at all, not a re-labelling of rows
already shown (263 spells gain a caster/target model bit this way).

| Column | extra bit | meaning |
|---|---|---|
| `CasterSpellVisualID` | `caster` (1) | what the caster themself sees |
| `HostileSpellVisualID` | `target` (2) | what a hostile target sees |
| `LowViolenceSpellVisualID` | — | client-setting variant, no target semantic |
| `ReducedUnexpectedCameraMovementSpellVisualID` | — | client-setting variant, no target semantic |

The bit rides along with everything reached through that redirect, exactly like
a `TargetType` mask, and unions with it. Two traps the build handles and any
future edit must keep: **the redirect graph has cycles** (a self-reference and a
two-cycle on 9.2.7, chains up to 3 hops), so expansion is a mask-fixpoint
worklist, not recursion; and **a hotfix row replaces the wago `SpellVisual` row
wholesale**, so the redirect columns (and `AnimEventSoundID`) join the TDB
hotfix overlay or a hotfixed visual silently loses them.

---

## 3. Payload routes

### 3a. Kit dispatch — `SpellVisualKitEffect.EffectType`

The single busiest fan-out in the build. `EffectType` says which table `Effect`
points at.

```mermaid
flowchart LR
  KE["SpellVisualKitEffect"]

  KE -->|"1"| PROC["SpellProceduralEffect"]
  KE -->|"5"| SK["SoundKitID"]
  KE -->|"6"| SVA["SpellVisualAnim"]
  KE -->|"7"| SH["ShadowyEffect"]
  KE -->|"8"| EM["SpellEffectEmission"]
  KE -->|"11"| DE["DissolveEffect"]
  KE -->|"12"| EG["EdgeGlowEffect"]
  KE -->|"13"| BE["BeamEffect"]
  KE -->|"17"| BA["BarrageEffect"]
  KE -->|"19"| SVSE["SpellVisualScreenEffect"]

  PROC --> PT["dispatched again by Type<br/>(see 3b)"]
  SK --> SKE["SoundKitEntry → sound fids"]
  SVA --> AK["AnimKitID → AnimKitSegment"]
  SVA --> LA["Initial/LoopAnimID → AnimationData"]
  SH --> GH["ghost — 2 packed colors"]
  EM --> AM["SpellVisualKitAreaModel → model fid"]
  DE --> TBS["TextureBlendSet → texture fids"]
  EG --> GL["glow — packed RGB + alpha"]
  BE --> CH["SpellChainEffects"]
  BA --> EN["SpellVisualEffectName → model fid"]
  SVSE --> SE["ScreenEffect"]
```

The remaining EffectType values were audited and deliberately dropped: **2**
(ModelAttach-by-id) is 100% redundant with the parent-kit walk; **10**
(UnitSoundType) plays the target's own sound and names no file; **15/20** are
absent from the data; the rest carry no model or sound columns.

### 3b. Proc dispatch — `SpellProceduralEffect.Type`

`Type` is the client's character-procedure index, so it selects both the handler
*and* which `Value_n` column holds the payload. This is the second fan-out.

| Type | Payload column | Becomes |
|---|---|---|
| 0, 12, 26 | `Value_0` → SpellChainEffects | **chain** (beams) |
| 1 | `Value_0` packed RGB | **tint** |
| 7 | `Value_0..3` → AnimationData | **stance** anims |
| 9 | `Value_0` → SpellVisualKitAreaModel | **model** (`ground`) |
| 11 | — | **freeze** (valueless) |
| 14 | `Value_0` alpha 0..1 | **transparency %** |
| 18 | — | **camo** (valueless) |
| 21 | `Value_2` strength 0..1 | **desaturate %** |
| 22 | `Value_3` packed RGB | **ghost** (material recolor) |
| 23 | `Value_3` packed RGB | **tint** (material recolor) |
| 27 | `Value_0` → WeaponTrail | **model** (`trail`) |

Colors are `0xRRGGBB`; `INT_MIN` is the "unset" sentinel. The types not
surfaced (2–6, 8, 10, 13, 15–17, 19–20, 24–25, 28–34) are renderer or gameplay
state, or too rare to be worth a pill. The full decode with evidence is in
CLAUDE.md → *Proc type decode*.

### 3c. The six model routes

Every `(spell, model)` row is tagged with **how** the model is used. Same fid can
appear once per category.

```mermaid
flowchart LR
  A1["SpellVisualKitModelAttach"] --> EN["SpellVisualEffectName"]
  M1["SpellVisual → SpellVisualMissile"] --> EN
  E17["kit ET 17 → BarrageEffect"] --> EN

  EN -->|"Type 0 (.ModelFileDataID)"| LF["listfile → model path"]
  EN -->|"Type 1 (.GenericID = Item::ID)<br/>attach route only"| ITM["ItemModifiedAppearance → ItemAppearance<br/>→ ItemDisplayInfo → ModelFileData"]
  ITM --> LF
  EN -->|"Type 2 (.GenericID = CreatureDisplayID)<br/>attach route only"| CDI["CreatureDisplayInfo.ModelID<br/>→ CreatureModelData.FileDataID"]
  CDI --> LF
  EN -->|"Type 3-10, no named file"| WPN["sentinel fid per slot<br/>'equipped main hand' / 'off hand'<br/>/ 'ranged' / 'ammo'"]

  E8["kit ET 8 → SpellEffectEmission"] --> AM["SpellVisualKitAreaModel<br/>.ModelFileDataID"]
  P9["proc Type 9"] --> AM

  P27["proc Type 27 → WeaponTrail<br/>.FileDataID"] --> LF
  AM --> LF

  A1 -.->|"category"| C0["attach — no word, loose pills"]
  A1 -.->|"category (Type 1)"| C6["item"]
  A1 -.->|"category (Type 2)"| C5["display"]
  M1 -.->|"category"| C1["missile"]
  E17 -.->|"category"| C4["barrage"]
  E8 -.->|"category"| C2["ground"]
  P9 -.->|"category"| C2
  P27 -.->|"category"| C3["trail"]
```

`SpellVisualKitAreaModel` carries its fid **directly** — no
`SpellVisualEffectName` hop. Note `ground`, not `area`: the target words include
`area` and the two mean different things (only 42% of this category's rows carry
an area target bit).

**`SpellVisualEffectName.Type`** picks how the effect-name resolves to a model:
**0 = FileDataID** (`ModelFileDataID`, every route above), **1 = Item**
(`GenericID` = Item::ID), **2 = CreatureDisplayInfo** (`GenericID` = a
CreatureDisplayID). On the **attach route only**, a Type-2 row resolves that
display through `CreatureDisplayInfo → CreatureModelData` (pure client data — no
TDB) into the `display` model category. Its pill sits in the Models column but
wears the morph pill's buttons (Wowhead model viewer by displayId, ⧉ copy
displayId, `.morph`, `.lookup display creature`) and keeps its attachment point
like any other attached model. The label is the model's base filename. The
category word is **`display`**, not `creature`: a creature model's path lives
under `creature/…`, so `creature` would collide with ~21% of the model-file
corpus by the filename-substring rule. Missiles/barrage keep reading
`ModelFileDataID` for every Type (they carry no CreatureDisplay/Item content).

**Type 1 = an Item::ID → the `item` model category** (attach route only). The
item carries its own model through the appearance chain
`ItemModifiedAppearance → ItemAppearance → ItemDisplayInfo → ModelResourcesID
→ ModelFileData.FileDataID` (pure client data, so it works on the TDB-less
Classic packs; 99.8% of reached items resolve on 9.2.7), plus the display name
and quality from `ItemSearchName` and the inventory icon from
`ItemAppearance.DefaultIconFileDataID`. `ItemSparse` is deliberately **not**
downloaded: measured to add zero names over `ItemSearchName` for this
population, at 6× the size. The pill has two shapes, split on whether the item
has a name (about two-thirds do; the rest are internal props — unnamed potions,
dynamite, gizmos — that exist only to be held in a visual):

- **named** → `[Wowhead item page] · {target}{icon}{name} · attach · ⧉ copy
  item id · .additem · .lookup item {name}`. The name is coloured by the item's
  quality (the classic poor→artifact ramp; colour only, **not** searchable). Both
  the leading `[wh]` button *and the icon* are Wowhead item links opening the
  model view (`item={id}/#modelviewer`) — that `<a href>` anchor is the app's
  proven tooltip trigger, so hovering the icon raises the item tooltip. The label
  stays a click-to-search button (with a `data-wowhead` mirror for its own
  tooltip) rather than a link, so clicking the name searches instead of
  navigating.
- **nameless** → `[3D viewer] · {target}{icon}{model base name} · attach ·
  .lookup item {model base name}`. No Wowhead, no `.additem`, no id copy —
  none resolve without a name — and `.lookup item` falls back to the model's
  base filename (no extension; `.lookup item` accepts either a name or a model
  name). The icon still reads (you can see it is a potion or a bomb).

The category word is **`item`**; it collides with ~4.3% of the model-file corpus
(the `item/objectcomponents/…` paths) by the filename-substring rule — well under
the ~21% that ruled out `creature`, and coherent because those files *are* item
models. `model:"item <name>"` matches on the item name via a dedicated corpus
(`itemSearchL`); the model file and category word match through the ordinary
model index. This is the **attach route only** — the 62 missile-route Type-1
effect-names on 9.2.7 render nothing, matching the "item attachments" scope.

**Types 3–10 = a weapon the caster already has.** They carry *no* model of their
own (`ModelFileDataID` **and** `GenericID` both 0) while attaching to weapon/hand
M2 points and being frequently reused as a missile — i.e. the model is the real
item the caster is holding, resolved client-side at cast. The `Type` picks the
**slot**, and dual-wield emits a mainhand+offhand pair. `SpellVisualEffectNameType.dbde`
defines only 0–2, but [wowdev.wiki/EnumeratedString](https://wowdev.wiki/EnumeratedString#SpellVisualEffectName::Type)
carries the client's own enum, and it matches what the data showed:

| Type | official name | pill | evidence (spell names) |
|--|--|--|--|
| 3 | Unit - Item - Main hand | `equipped main hand` | Throw Spear, Heroic Throw, Javelin Toss, Impale, Fishing |
| 4 | Unit - Item - Off hand | `equipped off hand` | Pandaren Spirit (`T3@LargeWeaponRight + T4@LargeWeaponLeft`) |
| 5 | Unit - Item - Ranged | `equipped ranged` | Arcane Shot, Pistol Barrage, Hold Rifle, Wailing Arrow |
| 6 | Unit - Ammo - Basic | `equipped ammo` | Sha Corruption (2 rows) |
| 7 | Unit - Ammo - Preferred | `equipped ammo` | missile-only (1 row) |
| 8 | Main hand *(ignore disarmed)* | `equipped main hand` | Hold/Sharpen/Throw Sword, Whirling Blade |
| 9 | Off hand *(ignore disarmed)* | `equipped off hand` | Thal'kiel skull, Crystalline Swords |
| 10 | Ranged *(ignore disarmed)* | `equipped ranged` | Hold Rifles, Barrage, Death Blossom |

Eight types, **four pills**: "(ignore disarmed)" is a visibility rule for a
disarmed caster rather than a different weapon, and basic-vs-preferred ammo says
which arrow the client picks, so both collapse. Because there is no file to name,
these rows carry a **sentinel fid per slot** (`SYNTHETIC_MODEL_FILES`, −1…−4) and
render as a flat marker pill — no 3D, texture, Wowhead or `.lo` button — while
keeping their category (`attach` vs thrown-as-`missile`), attachment point and
target icon. Each sentinel gets a synthetic `files` entry whose *path is its
label*, so it renders and searches through the ordinary filename route with no
special case: a pill click searches `model:"equipped off hand"` exactly as a real
model pill searches its own filename. Every label opens with **`equipped`** — a
word no real model path carries — so `model:equipped` still finds the whole family
(where `model:weapon` would also catch every `weapon/…` file). That one word is
also the only thing autocomplete offers: the slots are *values*, and only meta
words belong there (the `attach <point>` rule, §3c). The rows'
`StartAnimID`/`AnimID`/`EndAnimID`/`AnimKitID` already reach the Animations column
(§3e), so what the spell *plays* was searchable before the model was.

**Trap — "fileless" is not always spelled 0.** The Classic re-release clients
backfill these rows with an **unnamed placeholder fid** instead: Cata 4.4.2 points
all seven of its weapon rows at fid **1255628**, WotLK 3.4.3 one — the very same
effect-name IDs (8905–8909, 9007, 50201) that are fid 0 on every other build. One
fid shared across six weapon slots is not a per-weapon model, and taken literally
it renders a junk `file #1255628` pill. So a weapon row's fid is trusted **only
when the listfile can name it**, which keeps genuinely hardcoded weapons (
Sylvanas's bow, fid 3597252 on 9.2.7+) rendering as the real models they are. The
check runs once in `read_model_sources`, after the hotfix overlay, and rewrites
the placeholder to 0 so every downstream route takes its existing "no file →
sentinel" branch. Only weapon rows are touched — a Type-0 row naming the same fid
keeps its normal model pill (which is why Cata still reports one unnamed file).

### 3d. The four-and-a-half sound routes

```mermaid
flowchart LR
  K5["kit EffectType 5"] --> SKID["SoundKitID"]
  MSND["SpellVisualMissile.SoundEntriesID"] --> SKID
  CSND["SpellChainEffects.SoundKitID"] --> SKID
  AESND["SpellVisual.AnimEventSoundID"] --> SKID
  SKID --> SKE["SoundKitEntry"] --> FID["sound FileDataIDs"]
```

The chain route is the "half": a beam's own sound folds into the spell's Sounds
column and inherits the chain's target mask.

`AnimEventSoundID` hangs off the `SpellVisual` row itself (not a kit or a
missile), and its value is a `SoundKit::ID` — the same type the missile route
already eats — so it drops straight into the existing sound plumbing. It is the
**widest-reaching of these** — 1,999 spells on 9.2.7 (vs a few hundred each for
the caster/hostile redirects), populated on every pack including Vanilla — and
it inherits the redirect target bit of whatever edge reached the visual.

### 3e. The animation routes

```mermaid
flowchart LR
  K6["kit ET 6 → SpellVisualAnim"] -->|AnimKitID| AKS["AnimKitSegment"] --> AID1["AnimIDs — grouped under an AnimKit head"]
  MAK["SpellVisualMissile.AnimKitID"] --> AKS
  K6 -->|"Initial/LoopAnimID"| AID2["AnimIDs — loose pills"]
  MA2["SpellVisualKitModelAttach"] -->|"AnimKitID"| AKS
  MA2 -->|"Start/Anim/EndAnimID"| AID2
  P7["proc Type 7"] --> AID3["AnimIDs — 'stance' group"]
  VS["VehicleSeat (via aura 296 → Vehicle)"] -->|"Enter/Ride/RideUpper/Exit anims"| AID4["AnimIDs — 'passenger' group"]
  VS -->|"VehicleEnter/Exit/RideAnimLoop"| AID2
  VS -->|"6 × AnimKitID"| AKS
  AID1 --> N["names via anims.js"]
  AID2 --> N
  AID3 --> N
  AID4 --> N
```

`SpellVisualAnim`'s initial/loop anims are **the dominant source** — 119k rows
vs 32k animkit rows on 9.2.7. `-1` and `0` both mean unset (0 would be Stand).
Impact kits animate the *target*, so these are not caster-only.

`SpellVisualKitModelAttach` carries animations on the SAME rows that attach a
model (§3c, attachment point in §3h): its `StartAnimID`/`AnimID`/`EndAnimID` are
AnimationData ids for the attached model's start/loop/end and join the loose
pills; its `AnimKitID` rejoins the animkit groups. Keyed by kit, they union into
the existing buckets (no pack section of their own), and are indexed even when
the row's `ModelFileDataID` is 0 (a Type 1/2 effect-name, whose model comes from
`GenericID`, or a Type 3–10 equipped-weapon row that has no model at all), since
they are anims the spell's kit plays. Same `>0` gate as `SpellVisualAnim`. Adds
~10.5k animkit and ~6.7k loose-anim (spell,anim) pairs on 9.2.7.

The vehicle-seat route splits by **whose** animation it is: the nine
passenger columns (`EnterAnimStart/Loop`, `RideAnimStart/Loop`,
`RideUpperAnimStart/Loop`, `ExitAnimStart/Loop/End`) head a `passenger`
group, while the vehicle's own three (`VehicleEnterAnim`, `VehicleExitAnim`,
`VehicleRideAnimLoop`) join the loose pills — the rider's behaviour and the
vehicle's are different things. The six `*AnimKitID` columns are ordinary
`AnimKit::ID`s and rejoin the animkit groups, so the build counts them as
"used" and ships their segments. Population on 9.2.7: 99.8% of seats set at
least one passenger anim, the vehicle's own are 3–7%, any animkit 12.7%.

### 3f. Routes that start at `SpellEffect`, not at a visual

Six fx categories skip the visual graph entirely: a particular `Effect` or
`EffectAura` enum makes `EffectMiscValue_n` an id into another table.

```mermaid
flowchart LR
  SE["SpellEffect"]
  SE -->|"EffectAura 56 (TRANSFORM)<br/>misc0 = creature id"| MO["morph"]
  SE -->|"Effect 28 (SUMMON)<br/>misc0 = creature, misc1 = SummonProperties"| SU["summon"]
  SE -->|"EffectAura 260 (SCREEN_EFFECT)<br/>misc0 = ScreenEffect id"| SC["screen"]
  SE -->|"EffectAura 36 (MOD_SHAPESHIFT)<br/>misc0 = SpellShapeshiftForm"| SS["shapeshift"]
  SE -->|"EffectAura 370 (OVERRIDE_NAME)<br/>misc0 = SpellOverrideName"| ON["alt names — search corpus only"]
  SE -->|"EffectAura 296 (SET_VEHICLE_ID)<br/>misc0 = Vehicle id"| VE["vehicle"]
  SE -->|"Effect / EffectAura enum ids"| ME["Mechanics column"]
```

**The vehicle route covers "the caster BECOMES a vehicle", not "boards one".**
`CONTROL_VEHICLE` (aura 236) is the far larger population — 1,581 rows vs 247
on 9.2.7 — but its `EffectMiscValue_0` is a seat/flag value, not a
`Vehicle.db2` id, so it needs its own route and is deliberately not wired up.

**These effect-driven fx carry a target mask of their own** (pack format 25),
and it does *not* come from the visual graph — it is the producing
`SpellEffect` row's `ImplicitTarget_0`/`_1` (the `Target` enum, mapped to the
same caster/target/area bits as §2's `TargetType`, by `implicit_target_bit`).
It answers *who the effect lands on*: a polymorph's morph is on the **target**,
a self-transform on the **caster**, a summon on the **area** where it lands.
These rows never pass through `SpellVisualEvent`, so `TargetType` says nothing
about them — the implicit target is the only source. Alt-names (aura 370) are
search-corpus-only and carry no mask.

**misc0 on a transform aura is a creature id, not a display id** — a
long-standing trap. Both morphs and shapeshift forms then walk the same
creature→model chain:

```mermaid
flowchart LR
  CR["creature entry"] -->|"TDB creature_template_model<br/>(or legacy modelid1..4)"| DI["CreatureDisplayID"]
  FORM["SpellShapeshiftForm.CreatureDisplayID"] --> DI
  DI --> CDI["CreatureDisplayInfo.ModelID"] --> CMD["CreatureModelData.FileDataID"] --> LF["listfile → model path"]
```

Screen effects are the one payload arriving from **both** directions — the aura
route (~2.3k spells) and the kit route via `SpellVisualScreenEffect` (18 rows on
9.2.7) — so the walk extends an already-populated set.

### 3g. Screen effect payload

```mermaid
flowchart LR
  SEF["ScreenEffect"] -->|"Param_0 (Effect=3)"| FOG["fog tint aarrggbb<br/>low 24 bits = color, top byte = opacity"]
  SEF -->|FullScreenEffectID| FSE["FullScreenEffect"]
  FSE --> GR["ColorMultiply / ColorAddition"]
  FSE --> VG["Mask triplet = radial vignette"]
  FSE -->|OverlayTextureFileDataID| OVL["overlay — finished art"]
  FSE -->|TextureBlendSetID| MSK["TextureBlendSet → mask textures"]
```

The two texture columns are **not interchangeable**: overlays are finished art
drawn in their own colors, masks are flat blend-set art the grade colors paint.
The pack tags each texture with its role. The wiki's `rrggbbxx` claim for
`Param_0` is WotLK-era and wrong for modern rows — ours reads `aarrggbb`,
settled by name semantics.

### 3h. Attachment points — where on the model something plays

```mermaid
flowchart LR
  MA["SpellVisualKitModelAttach.AttachmentID"] --> AN["M2 attachment name"]
  SV["SpellVisual.MissileAttachment<br/>+ MissileDestinationAttachment"] --> AN
  BE["BeamEffect.SourceAttachID<br/>+ DestAttachID"] --> AN
  AN --> P["pill segment — 'Chest' or 'SpellRightHand → Chest'"]
```

Three routes carry an attachment, and **all three are RAW M2 attachment ids**
(the `M2_ATTACHMENT_NAMES` table) — only `VehicleSeat` is indexed, see §3i.
The id is part of the row key, so the same model at two points stays two rows
and renders as two pills: on 9.2.7, 44,906 (spell, fid, category) groups split
this way, and the split is what makes a caster/target difference visible
instead of silently merged.

**Single-point vs travelling is a real distinction, not a formatting choice.**
Attached, ground, trail and barrage models sit at ONE point and render the
bare name; missiles and beams travel and render `Source → Dest`. The two are
indistinguishable in the data (both look like "src set, dst unset"), so the
renderer is told explicitly — `TRAVELLING_MODEL_CATS` in app.js. A travelling
row that knows only one end reads `from X` / `to Y`; it must never render a
dangling arrow.

Two traps:

- **`SpellVisualKitModelAttach.LowDefModelAttachID` is a FileDataID**, not an
  attachment — max 430259 on 9.2.7, despite the name.
- **Missile attachments are taken from `SpellVisual`, not
  `SpellVisualMissile`.** The missile route is per-visual (a whole set is
  unioned into one bucket) and that is also where the data lives: 105.6k rows
  carry a destination there versus 14.9k on the missile table. `spell_visual`
  in `TDB_TABLES` must overlay both columns — a hotfix row replaces the wago
  row wholesale, so omitting them would silently blank the attachments.

`SpellChainEffects` itself has **no** attachment column (its `Joint*` fields
are geometry); beams attach through `BeamEffect`, which is why chains only
carry attach points on builds that have that table. Dissolve (`AttachID`, 307
rows), shadowy (`AttachPos`, 161) and barrage (`AttachmentPoint`, 7) also
carry one and are deliberately not wired up yet.

### 3i. Vehicle seat payload

```mermaid
flowchart LR
  V["Vehicle (via aura 296)"] -->|"SeatID_0..7"| VS["VehicleSeat"]
  VS -->|"AttachmentID = INDEX"| GL["g_vehicleGeoComponentLinks[]"]
  GL -->|"M2 attachment id"| AN["attachment name — one pill per seat"]
  VS -->|"passenger anim columns"| PA["'passenger' anim group"]
  VS -->|"vehicle anim columns"| LP["loose anim pills"]
  VS -->|"AnimKit columns"| AK["animkit groups"]
```

A vehicle fills up to eight `SeatID_n` slots; the filled count IS the seat
count, and 0-seat vehicles are dropped at build.

**`VehicleSeat.AttachmentID` is an INDEX, not an M2 attachment id** — it
indexes a table hardcoded in the client binary (`g_vehicleGeoComponentLinks`),
which exists in no db2 and so is transcribed into `build_data.py`. wowdev.wiki
quotes the array but hedges it with a `?`, so it was verified rather than
trusted: 138 vehicle M2s were fetched and each seat checked against its own
vehicle's model. The decoded attachment is present **91.2%** of the time vs
**42.4%** for the raw value, and where the hypotheses diverge it is decisive —
index 14 decodes to `VehicleSeat2`, present on 100% of the models using it,
while raw 14 (`ShoulderFlapLeft`) is present on 0%. Indices 13..20 come out as
`VehicleSeat1..8` in order, which the array's own shape corroborates.

Two consequences worth knowing:

- The array is 6.0.1-era; modern data has indices past its end (26, 27). Those
  stay unmapped and render as a raw `idx N` rather than a guess.
- The decoded names are the game's own and often read oddly as seat positions
  (`Breath` and `ChestBloodBack` are the 2nd and 4th most common on 9.2.7)
  because artists reuse generic attachment slots as seat anchors. **That is the
  data, not a decode error** — the pill tooltip says so explicitly.

**Do not reuse this decode for the other attachment columns** (§3h): they are
*raw* M2 attachment ids. `SpellVisualKitModelAttach.AttachmentID` spans -1..57
across 55 distinct values on 9.2.7 — the direct-id signature — versus
`VehicleSeat.AttachmentID`'s dense 0..27.

---

## 4. The pack

The build bakes everything into one gzipped, **column-oriented** JSON per game
version: a section like `{spellIds, fids}` is parallel arrays where row *i*
links `spellIds[i]` to `fids[i]`. That gzips far better than a list of objects.

```mermaid
flowchart LR
  subgraph LINK["link sections (spell → item, + target mask)"]
    L1["spellModels · spellSounds · spellAnimKits<br/>spellVisualAnims · spellAnims · spellFx<br/>spellDissolves · spellGlows · spellShadowies<br/>spellGhostMats · spellTints · spellDesaturates<br/>spellTransparencies · spellFreezes · spellCamos<br/>spellScreens · spellMorphs · spellShapeshifts<br/>spellSummons · spellVehicles · spellPassengerAnims<br/>spellVehicleAnims · spellVehicleAnimKits<br/>spellEffects · spellAuras"]
  end
  subgraph PAY["payload sections (item → what it is)"]
    P1["fxChains · fxTextures · dissolves · dissolveTextures<br/>glows · shadowies · ghostMats · tints<br/>screens · screenTextures · morphs · morphDisplays<br/>shapeshifts · shapeshiftDisplays · summons<br/>vehicles · vehicleSeats"]
  end
  subgraph NAME["name tables"]
    N1["files (fid → path) · animNames · effectNames<br/>auraNames · iconNames · modelCatNames<br/>targetNames · summonControlNames"]
  end
  LINK --> IDX["data.js<br/>forward + reverse Map per section"]
  PAY --> IDX
  NAME --> IDX
  IDX --> Q["search.js — FIELDS registry"]
  IDX --> R["app.js — cells + pills"]
```

Sections carrying a parallel `targets` array (the target-icon feature):
`spellModels`, `spellSounds`, `spellAnimKits`, `spellVisualAnims`, `spellFx`,
`spellDissolves`, `spellGlows`, `spellShadowies`, `spellGhostMats` (these from
`SpellVisualEvent.TargetType`, §2), plus — from `SpellEffect.ImplicitTarget`
(§3f, pack format 25) — `spellMorphs`, `spellSummons`, `spellVehicles`,
`spellShapeshifts`, `spellScreens`. Both feed the same `maskIndex` in `data.js`
and the same icon renderer, so the two mask sources are indistinguishable
downstream.

`data.js` builds a **forward and a reverse index** for each — spell→items for
rendering, item→spells for searching. Every section read is guarded
(`if (pack.X)`) so an older-format pack degrades rather than crashes.

---

## 5. Version differences

Ten builds ship, spanning 2004-era content to current retail. Going *backwards*
is a different problem from going forwards: forwards is additive, backwards is
mostly "the table does not exist yet." The five Classic re-release clients
(Vanilla / TBC / WotLK / Cataclysm / MoP) complicate that — see below.

### The ten packs

| Build | Label | Spells | Pack | TDB release | Absent tables |
|---|---|---:|---:|---|---:|
| 1.15.8.67156 | Vanilla Classic | 31,248 | 0.7 MB | — | 6 |
| 2.5.6.68775 | TBC Classic | 28,650 | 0.7 MB | — | 13 |
| 3.4.3.58936 | WotLK Classic | 49,394 | 1.3 MB | TDB335.25101 | 10 |
| 4.4.2.60895 | Cataclysm Classic | 71,227 | 1.9 MB | — | 10 |
| 5.5.4.68716 | Mists of Pandaria Classic | 98,129 | 2.7 MB | — | 6 |
| 7.3.5.26972 | Legion | 179,382 | 5.0 MB | TDB735.00 | 4 |
| 8.3.7.35662 | Battle for Azeroth | 227,237 | 6.4 MB | TDB837.20101 | 1 |
| 9.2.7.45745 | Shadowlands *(default)* | 276,332 | 7.9 MB | TDB927.22111 | 0 |
| 10.2.7.55664 | Dragonflight | 327,092 | 9.5 MB | TDB1027.24051 | 0 |
| 11.2.7.65299 | The War Within | 375,895 | 11.1 MB | TDB1127.26011 | 0 |

**All ten are at pack format 28** (SpellVisualEffectName Type 1 → item model
pills — §3c). The recent bumps are additive and version-agnostic: format 26
added the invis/detect channel pills (`MOD_INVISIBILITY[_DETECT]` auras), format
27 the `display` model category, format 28 the `item` category. All carry back
to Vanilla (SpellVisualEffectName.Type is present on every shipped build — no
absent-table or optional-column drift; the five item tables also ship on every
build, so the route degrades by *content*, not by a missing table). Earlier
format costs still hold: format 22 target masks ~+11% size, format 23 vehicles
essentially free, format 24 attachment points ~+18% model rows, format 25 one
`targets` array per effect-fx link section. Format 28 renamed `spellModels`'s
`displayIds` array to `refIds` (it now carries an Item::ID on item rows too) and
added the `items`/`itemIconNames`/`itemQualityNames` sections; a format-27 pack
is still read (its `displayIds` array is accepted as `refIds`). Splitting the
equipped-weapon marker per slot (§3c) needed **no** bump — it only changes which
sentinel fids appear in the existing `files`/`spellModels` sections, and the
frontend reads any negative fid as fileless rather than naming one.

### Attachment coverage by version

Read from each pack after the format-24 rebuild:

| Pack | model rows | with an attach point | missiles w/ both ends | beams w/ both ends |
|---|--:|--:|--:|--:|
| Vanilla 1.15.8 (fmt 22) | 31,651 | — | — | — |
| TBC 2.5.6 (fmt 22) | 35,006 | — | — | — |
| WotLK 3.4.3 | 74,693 | 68,565 | 718 | 0 |
| Cataclysm 4.4.2 | 94,285 | 84,859 | 1,412 | 0 |
| MoP 5.5.4 | 126,079 | 110,706 | 2,289 | 1 |
| Legion 7.3.5 | 214,432 | 200,466 | 3,563 | 537 |
| BfA 8.3.7 | 264,466 | 198,655 | 3,592 | 2,448 |
| Shadowlands 9.2.7 | 314,064 | 226,810 | 3,753 | 5,273 |
| Dragonflight 10.2.7 | 368,230 | 252,382 | 3,977 | 7,237 |
| TWW 11.2.7 | 418,432 | 278,576 | 4,085 | 9,013 |

Beam attach points need `BeamEffect`, which WotLK and Cataclysm lack — hence
the zeroes, and MoP's single row. Attached-model coverage is high everywhere
(~85-92% of rows outside BfA).

### Creature-display models by version

`display`-category rows (`SpellVisualEffectName` Type 2, §3c), read from each
pack's `meta.counts.spellDisplayModels`. `SpellVisualEffectName.Type` is present
on every shipped build, so the route degrades by *content*, not by a missing
column — the Classic re-releases simply carry few Type-2 attach rows.

| Pack | display rows | | Pack | display rows |
|---|--:|---|---|--:|
| Vanilla 1.15.8 | 23 | | BfA 8.3.7 | 721 |
| TBC 2.5.6 | 1 | | Shadowlands 9.2.7 | 1,087 |
| WotLK 3.4.3 | 0 | | Dragonflight 10.2.7 | 1,432 |
| Cataclysm 4.4.2 | 4 | | TWW 11.2.7 | 1,827 |
| MoP 5.5.4 | 48 | | | |
| Legion 7.3.5 | 445 | | | |

WotLK 3.4.3's zero is data-truthful (that Classic client has no Type-2 attach row
resolving to a display), not a build failure. All rows resolve to a real model
fid — unresolvable displays are dropped at build time.

### Item models by version

`item`-category rows (`SpellVisualEffectName` Type 1, §3c), from each pack's
`meta.counts` — `spellItemModels` (rows), `items` (distinct), `namedItems`
(with an `ItemSearchName` name). Attach route only.

| Pack | item rows | items | named | | Pack | item rows | items | named |
|---|--:|--:|--:|---|---|--:|--:|--:|
| Vanilla 1.15.8 | 36 | 18 | 10 | | BfA 8.3.7 | 935 | 562 | 562 |
| TBC 2.5.6 | 0 | 0 | 0 | | Shadowlands 9.2.7 | 1,211 | 651 | 433 |
| WotLK 3.4.3 | 0 | 0 | 0 | | Dragonflight 10.2.7 | 1,431 | 709 | 467 |
| Cataclysm 4.4.2 | 0 | 0 | 0 | | TWW 11.2.7 | 1,579 | 764 | 497 |
| MoP 5.5.4 | 0 | 0 | 0 | | | | | |
| Legion 7.3.5 | 719 | 481 | 481 | | | | | |

TBC through MoP are data-truthful zeroes: those Classic clients carry no Type-1
attach row (the route first appears in the retail-line Legion data and, oddly,
in a handful of Vanilla Classic rows). Legion/BfA showing 100% named is also the
data — the nameless internal-prop items (potions, dynamite) are reached mainly
on the later builds. The named share is what decides the pill shape per row.

### Equipped-weapon markers by version

Sentinel rows (`SpellVisualEffectName` Type 3–10, §3c), read from each pack's
`meta.counts.spellWeaponModels` and split by slot from its `spellModels` fids.
Like the display route, `Type` ships on every build, so this degrades by content
only.

| Pack | rows | main hand | off hand | ranged | ammo |
|---|--:|--:|--:|--:|--:|
| Vanilla 1.15.8 | 0 | 0 | 0 | 0 | 0 |
| TBC 2.5.6 | 46 | 22 | 5 | 5 | 14 |
| WotLK 3.4.3 | 140 | 85 | 10 | 8 | 37 |
| Cataclysm 4.4.2 | 248 | 115 | 18 | 37 | 78 |
| MoP 5.5.4 | 357 | 195 | 26 | 48 | 88 |
| Legion 7.3.5 | 626 | 401 | 46 | 80 | 99 |
| BfA 8.3.7 | 678 | 427 | 47 | 90 | 114 |
| Shadowlands 9.2.7 | 698 | 477 | 49 | 93 | 79 |
| Dragonflight 10.2.7 | 732 | 510 | 48 | 97 | 77 |
| TWW 11.2.7 | 754 | 526 | 46 | 103 | 79 |

Vanilla's 0 is data-truthful: its single Type-3 effect-name (8905) is not reached
by any kit or missile set, so no spell shows the marker. Its pack predates the
count and omits the key — it was deliberately **not** rebuilt for a zero-valued
diagnostic field (see "the build is deterministic" in CLAUDE.md). WotLK and Cata
are the two packs whose numbers depend on the placeholder-fid rule in §3c: before
it they read 132 and **0**. The per-slot split added 2–3 rows per pack over the
single-sentinel build: where one spell threw *both* weapons at the same
attachment point the merged row is now two pills (9.2.7's three are the Demon
Hunter glaive spells — Fury of the Illidari ×2, Glaive Tempest).

### The five Classic re-release clients don't sit on the timeline

Vanilla Classic (1.15.8), TBC Classic (2.5.6), WotLK Classic (3.4.3),
Cataclysm Classic (4.4.2) and MoP Classic (5.5.4) are *not* points on the
retail line — they are current-generation Classic clients backporting old
content, so a client's db2 set reflects its fork point, not the game era. The
absent-table counts therefore do **not** nest by era:

- **TBC Classic is the most stripped client of the ten** (13 absent =
  WotLK's 10 + `TextureBlendSet` + `Vehicle` + `VehicleSeat`).
- **Cataclysm Classic is as stripped as WotLK Classic** (10 absent) — the
  4.4.x client still lacks `BeamEffect`, `DissolveEffect`, `EdgeGlowEffect`,
  `SpellEffectEmission`, `WeaponTrail` and `FullScreenEffect`.
- **Vanilla Classic and MoP Classic are the richest of the five** (6 absent
  each) — but *differently*: Vanilla keeps `BeamEffect`, `DissolveEffect`,
  `EdgeGlowEffect` and `FullScreenEffect`; MoP keeps those three effect tables
  plus `SpellEffectEmission` (ground models), and is the only Classic client
  with the emission route populated, but drops `FullScreenEffect`.
- **Only WotLK Classic has a TDB** (the 3.3.5 world-only dump). Vanilla, TBC,
  Cataclysm and MoP all build TDB-less: creature morph and summon
  *names/displays* don't resolve (the pills fall back to raw ids), and no
  hotfix overlay applies. Summon *control* words (guardian/pet/…) still work —
  those come from `SummonProperties`, a client table.

| Feature | Vanilla 1.15.8 | TBC 2.5.6 | Cata 4.4.2 | MoP 5.5.4 | Via |
|---|:--:|:--:|:--:|:--:|---|
| chain / beam | ✓ | proc-only | proc-only | ✓ | `BeamEffect` present on Vanilla & MoP; TBC/Cata chains all arrive via proc Type 0 |
| dissolve | ✓ (4) | — | — | ✓ (1) | `DissolveEffect` |
| glow | ✓ (1) | — | — | ✓ (1) | `EdgeGlowEffect` |
| ground models (emission) | — | — | — | ✓ | `SpellEffectEmission` — populated only on MoP |
| screen fx | partial | — | partial | partial | Vanilla keeps `FullScreenEffect`; Cata/MoP have only `ScreenEffect`+aura route; none has the `SpellVisualScreenEffect` kit route; TBC neither populated |
| ghost (shadowy) | — | — | — | — | `ShadowyEffect` absent on all four |
| barrage / trail | — | — | — | — | `BarrageEffect` / `WeaponTrail` absent on all four |
| alt-name search | — | — | — | — | `SpellOverrideName` absent on all four |
| morph / summon names | — | — | — | — | no TDB world DB for these builds |

Everything else — models, sounds, animations, mechanics, tints, transparency,
freeze, shapeshifts — works on all four. Unlike the original-3.3.5 data, these
modern Classic clients carry the full proc enum (each has a Type-21 desaturate
row), so the "proc types stop at 17" cutoff below is a WotLK *Classic* client
trait, not a general Classic one.

### When each table arrived

This is the *retail* client progression; the Classic re-release clients above
fork off it and are covered in the previous section.

```mermaid
flowchart LR
  W["WotLK 3.4.3<br/>10 absent"] --> L["Legion 7.3.5<br/>4 absent"] --> B["BfA 8.3.7<br/>1 absent"] --> S["Shadowlands 9.2.7+<br/>complete"]

  W -.->|"gained at Legion"| G1["BeamEffect · DissolveEffect<br/>EdgeGlowEffect · ShadowyEffect<br/>FullScreenEffect · SpellEffectEmission<br/>WeaponTrail"]
  L -.->|"gained at BfA"| G2["BarrageEffect<br/>SpellOverrideName<br/>SpellName (split out of Spell)"]
  B -.->|"gained at Shadowlands"| G3["SpellVisualScreenEffect<br/>(the kit route into screen fx)"]
```

**`SpellName` is the one non-monotonic case** and worth understanding: it was
split out of `Spell.db2` in BfA, so Legion carries the name on `Spell.Name_lang`
— but WotLK *Classic* is a modern client and has `SpellName` normally. The
absence tracks the client generation, not the game era. `SPELL_NAME_SOURCES`
picks whichever exists.

### What that costs each version

| Feature | WotLK | Legion | BfA | 9.2.7+ | Why |
|---|:--:|:--:|:--:|:--:|---|
| chain / beam | partial | ✓ | ✓ | ✓ | WotLK has no `BeamEffect` — its 755 chains all come via proc Type 0 |
| dissolve | — | ✓ | ✓ | ✓ | `DissolveEffect` |
| glow | — | ✓ | ✓ | ✓ | `EdgeGlowEffect` |
| ghost (shadowy) | — | ✓ | ✓ | ✓ | `ShadowyEffect` |
| ghost (material) | — | ✓ | ✓ | ✓ | proc Type 22 — *see below* |
| desaturate | — | ✓ | ✓ | ✓ | proc Type 21 — *see below* |
| camo | — | ✓ | ✓ | ✓ | proc Type 18 — *see below* |
| screen fx grading | — | partial | partial | ✓ | `FullScreenEffect` absent in WotLK; kit route needs `SpellVisualScreenEffect` |
| ground models (emission) | — | ✓ | ✓ | ✓ | `SpellEffectEmission` |
| trail models | — | ✓ | ✓ | ✓ | `WeaponTrail` |
| barrage models | — | — | ✓ | ✓ | `BarrageEffect` |
| alt-name search | — | — | ✓ | ✓ | `SpellOverrideName` |
| vehicles / passenger anims | thin | ✓ | ✓ | ✓ | `Vehicle` + `VehicleSeat` present everywhere; WotLK's thinness is *content*, not schema — see below |

Everything else — models, sounds, animations, mechanics, morphs, summons,
shapeshifts, tints, transparency, freeze — works on all ten.

### Vehicles by version

Counts read from each pack's `meta.counts` after the format-23 rebuild:

| Pack | format | spell→vehicle | seats | passenger anims | seat animkits |
|---|:--:|--:|--:|--:|--:|
| Vanilla 1.15.8 | 22 | — | — | — | — |
| TBC 2.5.6 | 22 | — | — | — | — |
| WotLK 3.4.3 | 23 | 4 | 6 | 24 | 0 |
| Cataclysm 4.4.2 | 23 | 59 | 92 | 259 | 2 |
| MoP 5.5.4 | 23 | 121 | 221 | 596 | 10 |
| Legion 7.3.5 | 23 | 162 | 292 | 795 | 21 |
| BfA 8.3.7 | 23 | 185 | 328 | 909 | 22 |
| Shadowlands 9.2.7 | 23 | 233 | 384 | 1,138 | 44 |
| Dragonflight 10.2.7 | 23 | 293 | 419 | 1,397 | 49 |
| TWW 11.2.7 | 23 | 323 | 464 | 1,529 | 57 |

**Vanilla and TBC were deliberately not rebuilt** — vehicles are a WotLK-era
feature, so those two stay at format 22 and simply carry no vehicle sections.
The runtime guards every section read, so mixed pack formats are fine.

**WotLK's 4 is real, not a bug.** Aura 296 *is* `SET_VEHICLE_ID` on that build
(verified via `read_enum_names`, so it is not enum drift) — WotLK Classic just
has 7 `SET_VEHICLE_ID` rows in the whole of `SpellEffect`. The expansion that
introduced vehicles overwhelmingly uses `CONTROL_VEHICLE` (aura 236, 213 rows
there) instead, which is a different route we do not surface.

### Two things that look like bugs and are not

**Empty sections are often the enum, not the table.** WotLK's ghost-material,
desaturate and camo sections are empty even though no *table* is missing: those
come from `SpellProceduralEffect` types 22, 21 and 18, and **WotLK's proc types
stop at 17**. The enum is append-only, so the cutoff is exactly what the counts
show — freeze (Type 11) and transparency (Type 14) are populated on WotLK, and
everything above 17 is zero.

**Category searches can return rows for a feature this build lacks.** That is
the documented filename-substring behavior, not a fallback. On WotLK
`fx:desaturate` still matches `healbeam_desaturated`, `model:trail` matches
`ribbontrail`, and `fx:glow` matches `beam_webglowwhite`.

### Era differences visible in the data

Some gaps are content, not schema — the same route exists, the game just used it
differently:

| Section | WotLK | 9.2.7 | Reading |
|---|---:|---:|---|
| `spellAnimKits` | 446 | 42,415 | AnimKits barely existed in the WotLK era (its 446 come mostly from the §3e ModelAttach route) |
| `spellVisualAnims` | 39,247 | 125,793 | …but `SpellVisualAnim` was already the dominant animation source |
| `spellSounds` | 71,474 | 674,779 | modern spells carry far denser sound graphs |
| `spellShapeshifts` | 69 | 120 | forms grew slowly; displays actually *shrank* (20 → 18) |

### Drift is declared, not branched

Five declarations near the top of `build_data.py` absorb all of the above, so
the readers stay version-agnostic — adding a version is a config edit, not a
code edit:

| Declaration | Handles |
|---|---|
| `OPTIONAL_TABLES` | Table postdates the build → 404 tolerated, section empty, feature switches off. |
| `OPTIONAL_COLUMNS` | Table exists, one column doesn't → default stands in (3 so far: two missile-set variants, plus `ReducedUnexpectedCameraMovementSpellVisualID` absent on Legion 7.3.5 and BfA 8.3.7). |
| `SPELL_NAME_SOURCES` | Data moved tables — first candidate that exists wins. |
| `TDB_OPTIONAL_TABLES` / `TDB_OPTIONAL_COLUMNS` / `CREATURE_DISPLAY_SOURCES` | The same three kinds of drift on the TrinityCore side, in its own namespace. |
| `array_columns()` | A column that changed shape — `CreatureDisplayID_0..3` became a scalar in 10.2.0. |

**Anything not declared is still a hard error.** An unexpected schema change must
fail the build loudly rather than silently lose data. To add a version, run the
build and let it tell you what is missing, then decide per item whether it
belongs in a declaration or is a genuine bug.

### TDB-side caveats

- **WotLK's world data is not an exact build match.** TDB335 targets original
  3.3.5a, not the 3.4.x Classic client. It is the only creature name/display
  source for the era and resolution looks fine, but treat WotLK morph and summon
  names as best-effort.
- **Legion-era and 3.3.5 dumps have no `creature_template_model`** — displays
  live in `modelid1..4` columns on `creature_template` instead.
- **TDB335 is world-only** (no hotfixes dump), and TDB735 nests its SQLs in a
  subfolder without the `full_` infix. Both shapes are declared in
  `TDB_RELEASES`.
- **Vanilla Classic (1.15.8) and TBC Classic (2.5.6) have no TDB at all** —
  TrinityCore ships no 1.15/2.5 world database, so they are absent from
  `TDB_RELEASES` and `fetch_tdb` returns `None`. Morph/summon names and displays
  don't resolve for those two builds (raw ids only); every wago-sourced section
  is unaffected.

---

## 6. Runtime routes (browser, on demand)

Nothing here is fetched during search or bulk-downloaded. All of it is
user-triggered and configured in `docs/js/config.js`.

| Route | URL | Trigger |
|---|---|---|
| Spell icons | `wow.zamimg.com/images/wow/icons/medium/{icon}.jpg` | Lazy per visible row. Icon *names* are baked into the pack. |
| Sound playback | `wow.zamimg.com/sound-ids/live/enus/{bucket}/{fid}/{base}.ogg` | Explicit click. Serves current retail; 404s fail soft. |
| Texture preview | `wago.tools/api/casc/{fid}?version={version}` | Hover, after a 150 ms intent delay. Raw `.blp`, decoded in-browser by the vendored `bufo.js` + `js-blp.js`. Version-pinned to the active pack. |
| Expansion logo | same CASC API | One image per version switch. |
| 3D model viewer | `wowtools.work/mv/?filedataid={fid}&type=m2` | Link-out only, nothing fetched. |
| Wowhead | `wowhead.com/{wh}spell=` · `/{wh}npc=` · `/{wh}sound=` · `#modelviewer:` | Link-out only. `{wh}` = per-version site prefix (`config.js` `wowheadSitePrefix`): Vanilla → `classic/`, everything else → retail (empty). Only `/classic/` and retail are permanent Wowhead sections, so the mid-Classic clients point at retail rather than a seasonal section that will rot. The model viewer (morph/display pills) has no `{wh}` — always retail (best skin compositing; display IDs render cross-era). |

House rule, unchanged: **fetch only on explicit user action, never preload,
never bulk-download.** The icon and sound hotlinks sit on tolerated-hotlinking
footing, not an affirmative license.

---

## Quick reference — where does column *X* come from?

| Column | Routes feeding it |
|---|---|
| **Models** | attach (kit→ModelAttach→EffectName Type 0), display (kit→ModelAttach→EffectName Type 2→CreatureDisplayID→model, morph-style pill), missile (SpellVisual→MissileSet), ground (kit ET 8 + proc 9→AreaModel), trail (proc 27→WeaponTrail), barrage (kit ET 17→BarrageEffect); every row also carries its M2 attachment point (§3h) |
| **Sounds** | kit ET 5, missile `SoundEntriesID`, chain `SoundKitID`, `SpellVisual.AnimEventSoundID` — all → SoundKitEntry |
| **Animations** | SpellVisualAnim initial/loop (loose), AnimKit via ET 6 + missile (grouped), ModelAttach Start/Anim/End (loose) + its AnimKit (grouped), proc Type 7 (stance), VehicleSeat passenger anims (passenger) + its vehicle anims (loose) + its AnimKits (grouped) |
| **Effects (fx)** | chain, dissolve, glow, ghost, tint, desaturate, transparency, freeze, camo, screen, shapeshift, morph, summon, seat — see §3a–3i |
| **Mechanics** | `SpellEffect.Effect` + `.EffectAura` enums, names from WoWDBDefs |
| **Name search** | SpellName/Spell + `NameSubtext_lang` + SpellOverrideName alt names |
| **Target bits** | `SpellVisualEvent.TargetType` on the kit edge (§2), resolved against `SpellEffect.ImplicitTarget` per phase (`StartEvent`) so a self-cast spell's "Target" reads as the caster, plus `Caster`/`HostileSpellVisualID` redirects that mark whatever they reach caster/target |
