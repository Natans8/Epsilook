/* Epsilook configuration — the file to edit for quick customization. */
"use strict";

window.EpsilookConfig = {
  // Copy-command buttons shown on every spell row.
  // {id} is replaced with the spell ID.
  spellCommands: [
    { label: "cast",   template: ".cast {id}",            hint: "Copy .cast command" },
    { label: "aura",   template: ".aura {id}",            hint: "Copy .aura command" },
    { label: "lookup", template: ".lookup spell id {id}", hint: "Copy .lookup command" },
    { label: "ID",     template: "{id}",                  hint: "Copy the spell ID" },
  ],

  // Copy command on each model tag.
  // {base} = file name without path and extension, {file} = file name, {path} = full path, {fid} = FileDataID.
  modelCopyTemplate: ".lookup object {base}",

  // How many rows to render per infinite-scroll batch.
  scrollBatch: 60,

  // How many tags to show per cell before collapsing behind "+N more".
  tagsCollapsedLimit: 4,

  // Live search: debounce (ms) and minimum query length.
  searchDebounceMs: 250,
  minQueryLength: 2,
};
