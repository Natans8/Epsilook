# build/enums — cached game enums

Checked-in, parseable copies of the external game/client enums the pack build
depends on. Several are **derived from web pages** (wowdev.wiki, WoWDBDefs) that
could change or vanish, or are **hardcoded in the WoW client binary** and exist
in no downloadable table at all — so they live here rather than buried as Python
dicts, greppable and offline.

`build/pack` loads these as the single source of truth via `load_local_enum(name)`
(see it and `_enum_id_where` / `_enum_ids_where` near the top of that file). A
missing or malformed file is a hard build error, the same discipline as the
downloaded `.dbde` enums in `cache/enums/`.

These are the **static** enums. The three per-build WoWDBDefs enums that need the
`(BUILD a-b)` build guards (`SpellEffect`, `SpellEffectAura`, `Target`) are still
fetched at build time and cached under `cache/enums/*.dbde` — they change between
game versions, so they are not frozen here.

## Format

```jsonc
{
  "enum": "<canonical table.column or client name>",
  "description": "<what it is, how it is used, how it was verified>",
  "source": ["<url>", ...],          // where the values came from
  "keys": "<what the numeric key means>",
  "values": { "<id>": <payload> }    // payload is a name string, an int, or
}                                    // a per-value {name, handler, ...} object
```

`handler` on a value is the machine tag the build dispatches on: it maps an
enum value to a build bucket (e.g. proc `chain`/`tint`, kit-effect `beam`/`shadowy`)
so the code derives its constants from the file instead of restating the numbers.
Editing a value's `handler` (or a weapon type's `slot`) re-points the build with no
code change.

## Files

| file | enum | keyed by |
|------|------|----------|
| `m2_attachments.json` | M2 attachment points (attach ids on models, missiles, beams, Shadowy/Dissolve/Barrage effects, and — via the geo-link array — vehicle seats) | attachment id |
| `vehicle_geo_component_links.json` | client-hardcoded seat-index → attachment-id array (`g_vehicleGeoComponentLinks`) | seat index |
| `spell_procedural_effect_types.json` | `SpellProceduralEffect.Type` (character-procedure index) | Type |
| `spell_visual_kit_effect_types.json` | `SpellVisualKitEffect.EffectType` (which table `Effect` points at) | EffectType |
| `spell_visual_effect_name_types.json` | `SpellVisualEffectName.Type` (how the effect-name resolves to a model / equipped-weapon slot) | Type |
| `item_quality.json` | `Item.OverallQualityID` quality ramp | OverallQualityID |
| `summon_properties_control.json` | `SummonProperties.Control` | Control |
| `spell_interrupt_flags.json` | `SpellInterruptFlags` — what cancels an **aura or channel** (`SpellInterrupts.AuraInterruptFlags` / `.ChannelInterruptFlags`); movement is **bit 3** | bit number |
| `spell_interrupts_interrupt_flags.json` | `SpellInterrupts::InterruptFlags` — what cancels a **cast** (the scalar column only); movement is **bit 0** | bit number |
| `gameobject_actions.json` | `GameObjectActions`, what `ACTIVATE_OBJECT` (effect 86) does to a gameobject; each value carries its class (model, state, other) | EffectMiscValue_0 |
| `wowhead_effect_names.json` | `SpellEffect.Effect` as Wowhead labels it, pinned from the spell filter page | Effect |
| `wowhead_aura_names.json` | `SpellEffect.EffectAura` as Wowhead labels it, pinned the same way | EffectAura |
| `effect_name_overlay.json` | our own effect names, read ahead of both sources | Effect |
| `aura_name_overlay.json` | our own aura names, read ahead of both sources | EffectAura |
| `spell_aura_handlers.json` | `SpellEffect.EffectAura` handlers on the Epsilon core, `implemented` false where the handler is null or unused; the pair of `spell_effect_handlers.json` | EffectAura |
| `spell_effect_slots.json` | what each `SpellEffect.Effect` value's misc and points columns hold, an amount with its unit, read mechanically, with the evidence and the RP family | Effect |
| `spell_aura_slots.json` | the same for each `SpellEffect.EffectAura` value | EffectAura |
| `spell_schools.json` | the seven spell schools as mask bits, which a `mask` slot over `spell_schools` combines | school mask bit |
| `power_types.json` | the core's power types, health as -2 | Powers |
| `primary_stats.json` | the four stats, -1 all and -2 the primary one | Stats |
| `spell_mechanics.json` | the client's mechanic names | SpellMechanic.ID |
| `dispel_types.json` | the client's dispel type names | SpellDispelType.ID |
| `creature_types.json` | the client's creature type names as mask bits, which a `mask` slot over `creature_types` combines | creature type mask bit |
| `languages.json` | the client's language names | Languages.ID |
| `stealth_types.json` | the core's stealth types, what a Stealth aura grants and Stealth Detection sees through | StealthType |
| `invisibility_types.json` | the core's invisibility types, what an Invisibility aura hides its target in and Invisibility Detection sees into | InvisibilityType |
| `combat_rating_mask.json` | the core's combat ratings as mask bits, which the rating auras test their misc columns against | combat rating mask bit |
| `stat_mask.json` | the four stats as mask bits, which a total-stat aura tests its second misc column against | stat mask bit |
| `power_mask.json` | the power types as mask bits, which a power-cost aura tests its second misc column against | power mask bit |

**The two interrupt files are a matched pair and the whole point is that they are DIFFERENT.** `SpellInterrupts` carries
three interrupt columns and only two of them share an enum; reading all three with one decode is a mistake already made
once here, and it reported the breaks-on-movement channel population 4.4× too low. Check which column you are decoding
before you reach for either file.
