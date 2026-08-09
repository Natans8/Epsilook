/* Epsilook configuration — the file to edit for quick customization.
 * EpsilookConfig below documents the full shape. */

/** One copy-command button on a spell row ({id} = spell ID). */
export interface SpellCommand {
    label: string;
    template: string;
    hint: string;
    /**
     * The label a PILL uses, where width is scarce — Epsilon's own accepted
     * abbreviation of the command (`.cast`/`.cas`/`.ca`/`.c`, `.aura`/`.au`).
     * The row strip always shows the full `label`; a pill falls back to it when
     * this is absent. What gets COPIED is `template` either way, so the two can
     * never say different things.
     */
    short?: string;
}

/** One entry in the theme dropdown (`themes` below). */
export interface ThemeChoice {
    /** A `:root[data-theme="id"]` palette in app.css, or the reserved "auto". */
    id: string;
    label: string;
}

/** The user-tunable surface. */
export interface EpsilookConfig {
    themes: ThemeChoice[];
    defaultTheme: string;
    /** Which palette id the reserved "auto" theme resolves to per OS setting. */
    autoTheme: { light: string; dark: string };
    spellCommands: SpellCommand[];
    /**
     * Which of `spellCommands` ride a spell-link chip, by label. Named rather
     * than re-templated so `.cast {id}` has one definition — a chip and a row
     * must never disagree about what `.cast` copies. An unknown label is
     * skipped; empty means no command buttons on link chips at all.
     */
    linkCommands: string[];
    modelCopyTemplate: string;
    animCopyTemplate: string;
    soundKitCopyTemplate: string;
    animKitCopyTemplate: string;
    morphCopyTemplate: string;
    morphLookupTemplate: string;
    summonLookupTemplate: string;
    summonSpawnTemplate: string;
    objectLookupTemplate: string;
    objectSpawnTemplate: string;
    mountModifyTemplate: string;
    itemLookupTemplate: string;
    itemAddTemplate: string;
    areaLookupTemplate: string;
    areaMapTemplate: string;
    wowheadSpellUrl: string;
    wowheadSoundUrl: string;
    wowheadMorphUrl: string;
    wowheadNpcUrl: string;
    wowheadZoneUrl: string;
    wowheadItemUrl: string;
    wowheadObjectUrl: string;
    wowheadObjectTypes: number[];
    /** Wowhead site path prefix keyed by game major version ("classic/" for 1);
     *  unlisted versions fall back to retail (empty prefix). */
    wowheadSitePrefix: Record<number, string>;
    modelViewerUrl: string;
    soundPlayUrl: string;
    soundVolume: number;
    texturePreviewUrl: string;
    texturePreviewMax: number;
    /** Inline expansion art per MAJOR version — the marker beside a spell id.
     *  Self-hosted paths under site/, never a hotlink. */
    expansionArt: Record<number, string>;
    /** Expansion logo per build MAJOR version, e.g. 9 -> Shadowlands. */
    expansionLogos: Record<number, { name: string; fid: number }>;
    /** Rendered height of that logo, in CSS pixels. */
    expansionLogoHeight: number;
    spellIconUrl: string;
    discordCharLimit: number;
    scrollBatch: number;
    collapsedRowHeight: number;
    searchDebounceMs: number;
    minQueryLength: number;
}

export const CFG: EpsilookConfig = {
    // The theme dropdown, in the order it lists them. Each id is a palette
    // block in css/app.css (`:root[data-theme="id"]`); adding a theme is one
    // block there plus one line here, and the dropdown shows up on its own
    // once there are two (with one theme there is nothing to pick, so the
    // control stays hidden — same rule as the version selector).
    //
    // The id "auto" is reserved: it is not a palette but "follow the OS's
    // light/dark setting", re-following it live. It only means something once a
    // light palette exists, and which one it picks is `autoTheme` below.
    themes: [
        {id: "dark", label: "Dark"},
        {id: "moonwell", label: "Light — Moonwell"},
        {id: "vellum", label: "Light — Vellum"},
        {id: "auto", label: "Match system"},
    ],

    // Which palette "auto" resolves to at each OS setting. Two ids from the
    // registry above — no magic strings in theme.ts, so shipping a different
    // light palette is a one-word change here.
    autoTheme: {light: "moonwell", dark: "dark"},

    // The theme used until someone picks one. Must name the palette app.css
    // applies with no data-theme set (its bare `:root` block) — otherwise the
    // first visit paints that one for an instant before this takes over.
    defaultTheme: "dark",

    // Copy-command buttons shown on every spell row (the spell ID itself is
    // copied by clicking it). {id} is replaced with the spell ID.
    spellCommands: [
        {label: ".cast", template: ".cast {id}", hint: "Copy .cast command", short: ".c"},
        {label: ".aura", template: ".aura {id}", hint: "Copy .aura command", short: ".au"},
        {
            label: ".lookup", template: ".lookup spell id {id}",
            hint: "Copy .lookup command", short: ".lo",
        },
        {label: ".learn", template: ".learn {id}", hint: "Copy .learn command", short: ".le"},
    ],

    // Which commands a spell-link chip carries (labels from spellCommands
    // above). A chip is narrow and sits inside a group, so it gets the three
    // that act on the linked spell itself; .learn is a row-level question about
    // your own character. Add a label here to offer more.
    linkCommands: [".cast", ".aura", ".lookup"],

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

    // Copy commands on each area-gate tag ({name} = the area's own name,
    // {id} = its UiMapID). .lookup tele SEARCHES the teleport list rather than
    // assuming a destination exists, which is why it is right here and .tele /
    // .worldport are not (user's call — an area name is rarely a tele name).
    // The map command is omitted when the area resolved no map.
    areaLookupTemplate: ".lookup tele {name}",
    // ⚠ THE FrameXML GLOBAL, NOT `C_Map.OpenWorldMap` — that one was ADDED IN
    // PATCH 11.1.5 and does not exist on the 9.2.7 client Epsilon runs, so the
    // macro silently did nothing. Verified in game: this form works, as do
    // `ShowUIPanel(WorldMapFrame); WorldMapFrame:SetMapID(id)` and an
    // IsShown-guarded ToggleWorldMap; this is simply the shortest of the three.
    areaMapTemplate: "/run OpenWorldMap({id})",

    // External links ({id} = spell / soundkit / creature display / NPC ID,
    // {wh} = the version-appropriate Wowhead site prefix, see wowheadSitePrefix).
    // The morph model viewer has no {wh} — it stays on retail (best creature-skin
    // compositing; display IDs render across eras). It opens the viewer over the
    // SPELL'S OWN page rather than Wowhead's home page: the #modelviewer fragment
    // works on any page, so the spell page is the useful place to land.
    // {spell} = the spell being viewed, {id} = the creature display it shows.
    wowheadSpellUrl: "https://www.wowhead.com/{wh}spell={id}",
    wowheadSoundUrl: "https://www.wowhead.com/{wh}sound={id}",
    wowheadMorphUrl: "https://www.wowhead.com/spell={spell}/#modelviewer:1:{id}:0",
    wowheadNpcUrl: "https://www.wowhead.com/{wh}npc={id}",
    // Zone page. {id} is the area's ROOT, never the area itself: Wowhead has
    // pages for top-level zones only, so zone=7964 (the subzone The Drift) is a
    // 404 while its root zone=7637 (Suramar) resolves.
    wowheadZoneUrl: "https://www.wowhead.com/{wh}zone={id}",
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
    // EVERY Classic-era pack points at its own section (user's call, 2026-08-09:
    // "?v=3.4.3 would all lead to the wotlk version of the wiki"). An earlier
    // pass listed only Vanilla, reasoning that the seasonal sections rot when
    // their season ends. They do — and Wowhead REDIRECTS them to retail when it
    // happens, which is precisely where they would have pointed anyway. So the
    // caution bought nothing and cost the correct link for the whole season.
    //
    // To send a version to its own section, add a `major: "prefix/"` line; to
    // retire one, delete its line. 7+ is the retail era and takes no prefix.
    wowheadSitePrefix: {
        1: "classic/",     // Vanilla — permanent (classic.wowhead.com redirects here)
        2: "tbc/",         // Burning Crusade Classic
        3: "wotlk/",       // Wrath Classic
        4: "cata/",        // Cataclysm Classic
        5: "mop-classic/", // Mists Classic
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

    // The small per-expansion art beside a spell id, keyed by major version the
    // same way expansionLogos below is.
    //
    // VENDORED under site/img/expansions/ (~34 KB for all eleven), NOT hotlinked
    // — the user's call, and it also keeps the table free of eleven third-party
    // requests. The source is warcraft.wiki.gg's own `{{Xx-inline}}` templates,
    // which is where this art is maintained; each file is that template's image
    // at its native size. Extensions differ because the wiki's do (TBC is a
    // .gif), which is why this maps to a PATH rather than deriving one.
    //
    // ⛔ The game's own art does NOT work here and both alternatives were tried:
    // `interface/icons/expansionicon_*` exists for the first SIX expansions only
    // (404 for Legion onward), and the glue logos in expansionLogos are full
    // "World of Warcraft" lockups, so shrunk to row height they all read alike.
    expansionArt: {
        1: "img/expansions/vanilla.png",
        2: "img/expansions/tbc.gif",
        3: "img/expansions/wotlk.png",
        4: "img/expansions/cata.png",
        5: "img/expansions/mop.png",
        6: "img/expansions/wod.png",
        7: "img/expansions/legion.png",
        8: "img/expansions/bfa.png",
        9: "img/expansions/shadowlands.png",
        10: "img/expansions/dragonflight.png",
        11: "img/expansions/tww.png",
    },

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
