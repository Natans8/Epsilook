// @ts-check
/* Epsilook configuration — the file to edit for quick customization.
 * The full shape is documented in types.d.ts (EpsilookConfig). */
"use strict";

window.EpsilookConfig = {
  // Copy-command buttons shown on every spell row (the spell ID itself is
  // copied by clicking it). {id} is replaced with the spell ID.
  spellCommands: [
    { label: ".cast",   template: ".cast {id}",            hint: "Copy .cast command" },
    { label: ".aura",   template: ".aura {id}",            hint: "Copy .aura command" },
    { label: ".lookup", template: ".lookup spell id {id}", hint: "Copy .lookup command" },
    { label: ".learn",  template: ".learn {id}",           hint: "Copy .learn command" },
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

  // External links ({id} = spell / soundkit / creature display / NPC ID).
  wowheadSpellUrl: "https://www.wowhead.com/spell={id}",
  wowheadSoundUrl: "https://www.wowhead.com/sound={id}",
  wowheadMorphUrl: "https://www.wowhead.com/#modelviewer:1:{id}:0",
  wowheadNpcUrl: "https://www.wowhead.com/npc={id}",

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
    1:  { name: "Classic",                   fid: 538639 },
    2:  { name: "The Burning Crusade",       fid: 131194 },
    3:  { name: "Wrath of the Lich King",    fid: 235510 },
    4:  { name: "Cataclysm",                 fid: 321206 },
    5:  { name: "Mists of Pandaria",         fid: 571576 },
    6:  { name: "Warlords of Draenor",       fid: 937277 },
    7:  { name: "Legion",                    fid: 1725879 },
    8:  { name: "Battle for Azeroth",        fid: 1847992 },
    9:  { name: "Shadowlands",               fid: 3522861 },
    10: { name: "Dragonflight",              fid: 4547767 },
    11: { name: "The War Within",            fid: 5705453 },
    12: { name: "Midnight",                  fid: 7242277 },
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

  // How many tags to show per cell before collapsing behind "+N more".
  tagsCollapsedLimit: 4,

  // How many sound files to show per SoundKit group before collapsing.
  kitFilesCollapsedLimit: 2,

  // Live search: debounce (ms) and minimum query length.
  searchDebounceMs: 250,
  minQueryLength: 2,
};
