/* Epsilook configuration — the file to edit for quick customization. */
"use strict";

window.EpsilookConfig = {
  // Copy-command buttons shown on every spell row (the spell ID itself is
  // copied by clicking it). {id} is replaced with the spell ID.
  // `extra: true` commands hide behind the "+N more" expander.
  spellCommands: [
    { label: ".cast",    template: ".cast {id}",            hint: "Copy .cast command" },
    { label: ".aura",    template: ".aura {id}",            hint: "Copy .aura command" },
    { label: ".lookup",  template: ".lookup spell id {id}", hint: "Copy .lookup command" },
    { label: ".learn",   template: ".learn {id}",           hint: "Copy .learn command",   extra: true },
    { label: ".unaura",  template: ".unaura {id}",          hint: "Copy .unaura command",  extra: true },
    { label: ".unlearn", template: ".unlearn {id}",         hint: "Copy .unlearn command", extra: true },
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

  // "Copy for Discord" export: at most this many rows (Discord caps messages).
  discordExportRows: 40,

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
