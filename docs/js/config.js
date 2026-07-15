/* Epsilook configuration — the file to edit for quick customization. */
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

  // External links ({id} = spell / soundkit ID).
  wowheadSpellUrl: "https://www.wowhead.com/spell={id}",
  wowheadSoundUrl: "https://www.wowhead.com/sound={id}",

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
