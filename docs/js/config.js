// @ts-check
/* Epsilook configuration — the file to edit for quick customization.
 * The full shape is documented in types.d.ts (EpsilookConfig). */
"use strict";

window.EpsilookConfig = {
    // Copy-command buttons shown on every spell row (the spell ID itself is
    // copied by clicking it). {id} is replaced with the spell ID.
    spellCommands: [
        {label: ".cast", template: ".cast {id}", hint: "Copy .cast command"},
        {label: ".aura", template: ".aura {id}", hint: "Copy .aura command"},
        {label: ".lookup", template: ".lookup spell id {id}", hint: "Copy .lookup command"},
        {label: ".learn", template: ".learn {id}", hint: "Copy .learn command"},
    ],

    // Copy command on each model tag.
    // {base} = file name without path and extension, {file} = file name, {path} = full path, {fid} = FileDataID.
    modelCopyTemplate: ".lookup object {file}",

    // Copy command on each animation tag ({name} = animation name).
    animCopyTemplate: ".lookup emote {name}",

    // Copy command on each SoundKit tag ({id} = SoundKit ID).
    soundKitCopyTemplate: "/script PlaySound({id})",

    // Copy command on each AnimKit tag ({id} = AnimKit ID).
    animKitCopyTemplate: ".modify animkit {id}",

    // Copy commands on each morph tag ({id} = CreatureDisplayID,
    // {file} = model file name).
    morphCopyTemplate: ".morph {id}",
    morphLookupTemplate: ".lookup display creature {file}",

    // Copy commands on each summon tag ({id} = creature ID, {name} = NPC name).
    summonLookupTemplate: ".lookup creature {name}",
    summonSpawnTemplate: ".npc spawn {id}",

    // Copy commands on each gameobject-spawn tag. {id} = the gameobject_template
    // entry (always known — it is the effect's misc value); {name} = the object's
    // MODEL base filename, always — never its display name (user's call
    // 2026-07-24). Objects with no model resolve no lookup and the button is
    // simply omitted.
    objectLookupTemplate: ".lookup object {name}",
    objectSpawnTemplate: ".gobject spawn {id}",

    // Copy command on each mount tag ({id} = CreatureDisplayID). Mounts use
    // .modify mount rather than .morph — the display is what you RIDE, not what
    // you become — and it works off the display id whether or not the mount
    // resolved a name.
    mountModifyTemplate: ".modify mount {id}",

    // Copy commands on each item tag (SpellVisualEffectName Type 1). {id} = the
    // Item::ID, {name} = the item's display name for a named item OR its model
    // base filename (NO extension) for a nameless one — .lookup item accepts
    // either. .additem is offered on named items only (adding a nameless prop by
    // id does nothing useful), so it takes {id}.
    itemLookupTemplate: ".lookup item {name}",
    itemAddTemplate: ".additem {id}",

    // External links ({id} = spell / soundkit / creature display / NPC ID,
    // {wh} = the version-appropriate Wowhead site prefix, see wowheadSitePrefix).
    // The model viewer (morph) has no {wh} — it always stays on retail (best
    // creature-skin compositing; display IDs render across eras).
    wowheadSpellUrl: "https://www.wowhead.com/{wh}spell={id}",
    wowheadSoundUrl: "https://www.wowhead.com/{wh}sound={id}",
    wowheadMorphUrl: "https://www.wowhead.com/#modelviewer:1:{id}:0",
    wowheadNpcUrl: "https://www.wowhead.com/{wh}npc={id}",
    // Item page, opened straight on its 3D model view. The #modelviewer fragment
    // makes Wowhead land on the model tab (the item's whole point here), and the
    // page still carries the tooltip the data-wowhead attribute shows on hover.
    wowheadItemUrl: "https://www.wowhead.com/{wh}item={id}/#modelviewer",
    // GameObject page, opened on its 3D model view like the item link.
    wowheadObjectUrl: "https://www.wowhead.com/{wh}object={id}/#modelviewer",

    // GAMEOBJECT_TYPEs Wowhead actually has pages for. Wowhead indexes only
    // PLAYER-FACING objects and skips mechanical/invisible ones, so linking
    // every named object 404s about half the time. Verified 2026-07-24 against
    // wowhead.com/objects (whose own type labels — Container / Shared Container
    // / Treasure / Herb / Mining Node / Fishing Pool / Interactive / Quest /
    // Tool — map onto exactly these) and spot-checked 9 objects, 9/9 agreeing:
    //   HAS a page  3 CHEST (Rusty Chest, Cache of the Fire Lord),
    //               10 GOOBER (Pet Stone), 2 QUESTGIVER (Scrying Bowl),
    //               22 SPELLCASTER (Portal to Stormwind)
    //   NO page     0 DOOR, 5 GENERIC, 6 TRAP, 8 SPELL_FOCUS, 18 RITUAL
    // 25 FISHINGHOLE and 51 GATHERINGNODE are Wowhead's Fishing Pool / Herb /
    // Mining Node labels; no spell reaches one, but they belong to the rule.
    // Add a type here to turn its link on — no rebuild needed, the pack ships
    // every object's type.
    wowheadObjectTypes: [2, 3, 10, 22, 25, 51],

    // Wowhead has separate sections per game era, reached by a path prefix on
    // www.wowhead.com (e.g. /classic/spell=133). Data-page links ({wh} in the
    // URLs above) use the prefix for the active pack's MAJOR version; anything
    // unlisted falls back to retail (empty prefix).
    //
    // ONLY /classic/ (Vanilla) and retail are permanent. The seasonal Classic
    // sections (/tbc/, /wotlk/, /cata/, /mop-classic/) exist only while that
    // Classic season runs and Wowhead redirects them to retail once it ends —
    // so the mid-Classic clients deliberately point at retail rather than a
    // section that will rot. To send a version to its own section, add a
    // `major: "prefix/"` line here; to retire one, delete its line.
    wowheadSitePrefix: {
        1: "classic/", // Vanilla (classic.wowhead.com redirects here) — permanent
        // 2 TBC / 3 WotLK / 4 Cata / 5 MoP / 7+ retail-era -> retail, no prefix
    },

    // 3D preview: the "3d" link on each model tag opens the model in the
    // community WoW.tools mirror's model viewer ({fid} = FileDataID). The
    // mirror serves a fixed ~10.0 game build, so models removed from the game
    // after that may fail to load there. Set to "" to disable the link.
    modelViewerUrl: "https://wowtools.work/mv/?filedataid={fid}&type=m2",

    // Sound playback: the ▶ on each sound file streams it from Wowhead's CDN,
    // fetched only when clicked ({fid} = FileDataID, {bucket} = fid % 256,
    // {base} = file name, cosmetic — the CDN goes by FileDataID alone).
    // Set to "" to disable playback. Serves the current retail build, so a
    // file removed from the game since this pack's version plays nothing.
    soundPlayUrl: "https://wow.zamimg.com/sound-ids/live/enus/{bucket}/{fid}/{base}.ogg",

    // Playback volume, 0–1 (raw game sounds can be loud).
    soundVolume: 0.5,

    // Texture hover preview on beam/dissolve pills: the raw game .blp is
    // fetched from wago.tools' CASC API and decoded in the browser
    // ({fid} = FileDataID, {version} = the active pack's full build).
    // Fetched only on hover, cached per session. Set to "" to disable.
    texturePreviewUrl: "https://wago.tools/api/casc/{fid}?version={version}",

    // Longest edge of the preview image, in CSS pixels (larger textures are
    // scaled down, small ones stay at native size).
    texturePreviewMax: 256,

    // Expansion logo shown beside the version selector. The .blp comes from the
    // same version-pinned wago CASC API as the texture previews and is decoded
    // in-browser by the vendored js-blp — one small image per version switch,
    // and a failure just hides the logo.
    //
    // Keyed by the build's MAJOR version, which is what identifies the
    // expansion (9.2.7 -> 9 -> Shadowlands). To add one, find its
    // interface/glues/common/glues-wow-*logo.blp id in the community listfile.
    // Verified against a real build for 3/7/9/10/11; the rest are read off the
    // listfile by name and will simply not render if an id is wrong.
    expansionLogos: {
        1: {name: "Classic", fid: 538639},
        2: {name: "The Burning Crusade", fid: 131194},
        3: {name: "Wrath of the Lich King", fid: 235510},
        4: {name: "Cataclysm", fid: 321206},
        5: {name: "Mists of Pandaria", fid: 571576},
        6: {name: "Warlords of Draenor", fid: 937277},
        7: {name: "Legion", fid: 1725879},
        8: {name: "Battle for Azeroth", fid: 1847992},
        9: {name: "Shadowlands", fid: 3522861},
        10: {name: "Dragonflight", fid: 4547767},
        11: {name: "The War Within", fid: 5705453},
        12: {name: "Midnight", fid: 7242277},
    },

    // Rendered height of that logo, in CSS pixels (the art is 512x256).
    expansionLogoHeight: 38,

    // Spell icon shown next to the name, hotlinked from Wowhead's CDN
    // ({icon} = icon name; sizes: tiny/small/medium/large). Set to "" to
    // disable icons entirely.
    spellIconUrl: "https://wow.zamimg.com/images/wow/icons/medium/{icon}.jpg",

    // "Copy as Text" export: character budget for the pasted block, sized off
    // Discord's 2000-char message cap with room left for the header and a
    // possible "...and N more" footer line.
    discordCharLimit: 1800,

    // How many rows to render per infinite-scroll batch.
    scrollBatch: 60,

    // Collapsed baseline height (px) for a result row's multi-value cells. Each
    // cell hides whatever overflows this height behind a single "+N more"; the
    // tallest cell sets the row height. Expanding one cell grows the row and
    // lets the others reveal more to fill it. Larger = fewer "+N more" up front
    // but taller rows.
    collapsedRowHeight: 130,

    // Live search: debounce (ms) and minimum query length.
    searchDebounceMs: 250,
    minQueryLength: 2,
};
