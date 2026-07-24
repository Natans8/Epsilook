# build/enums — cached game enums

Checked-in, parseable copies of the external game/client enums the pack build
depends on. Several are **derived from web pages** (wowdev.wiki, WoWDBDefs) that
could change or vanish, or are **hardcoded in the WoW client binary** and exist
in no downloadable table at all — so they live here rather than buried as Python
dicts, greppable and offline.

`build_data.py` loads these as the single source of truth via `load_local_enum(name)`
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

`handler` on a value is the machine tag `build_data.py` dispatches on: it maps an
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
