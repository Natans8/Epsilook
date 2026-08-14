"""What a spell's effects DO, who they are aimed at, and what they trigger.

One row per effect rather than per spell, because a search scope binds its axes
to one row: a query for an effect that is also aimed a certain way must mean a
single effect that is both, not two effects that are one each.
"""

from __future__ import annotations

from collections import Counter

from ...derive import Reads
from ...derive.links import link_kind_word
from ...targets import IMPLICIT_PREFIX
from ...measure import numeric_domain
from ..registry import register
from ..section import Count, Domain, Layout, Scope, Section, SectionColumns


def spell_mechanics(reads: Reads) -> SectionColumns:
    """One row per distinct effect, carrying what it does and who it is for."""
    rows = reads.rows.mechanics
    return {"spellIds": [row[0] for row in rows],
            "effects": [row[1] for row in rows],
            "auras": [row[2] for row in rows],
            "targetsA": [row[3] for row in rows],
            "targetsB": [row[4] for row in rows]}


def used_targets(reads: Reads) -> list[int]:
    """The implicit-target ids this build's rows actually name, sorted."""
    return sorted({target for row in reads.rows.mechanics
                   for target in (row[3], row[4]) if target})


def target_names(reads: Reads) -> SectionColumns:
    """The name of each implicit target in use, without its enum prefix.

    Keyed by id rather than dense, because the ids in use are scattered through
    a much larger range. An id the enum does not name is left out and renders
    as its raw id, which is the same fallback an unknown effect gets.
    """
    return {"names": {str(target): reads.target_names[target].removeprefix(
        IMPLICIT_PREFIX) for target in used_targets(reads)
        if target in reads.target_names}}


def target_bits(reads: Reads) -> SectionColumns:
    """The caster, target or area bit each implicit target contributes.

    A row's icons are the union of its two targets' bits, so this rides as a
    small map rather than as a fourth column as long as the mechanics rows --
    which measured a hundred and ten kilobytes gzipped for the same fact.
    """
    return {"bits": {str(target): reads.target_bits[target]
                     for target in used_targets(reads)
                     if reads.target_bits.get(target)}}


def spell_links(reads: Reads) -> SectionColumns:
    """Every edge from a spell to a spell it triggers, and the word it prints.

    One direction only: "triggered by" is these same edges read backwards, so
    the app inverts the index at load rather than the pack carrying it twice.
    A pair joined in two different ways stays two rows, since those are two
    distinct facts; the renderer merges them into one chip listing both words.
    """
    kinds: dict[str, int] = {}
    rows = []
    for source, destination, effect, aura in sorted(reads.effects.links):
        word = link_kind_word(effect, aura, reads.effect_names, reads.aura_names)
        rows.append((source, destination, kinds.setdefault(word, len(kinds))))
    # Two effect rows differing only in a column the pack does not ship are one
    # edge once the word is what identifies it.
    rows = sorted(set(rows))
    return {"srcIds": [row[0] for row in rows],
            "dstIds": [row[1] for row in rows],
            "kinds": [row[2] for row in rows],
            "targets": [reads.effects.link_targets.get((row[0], row[1]), 0)
                        for row in rows],
            "kindNames": list(kinds)}


SPELL_MECHANICS = register(Section(
    name="spellMechanics",
    doc="One row per spell effect: what it does and who it is aimed at.",
    module="core",
    produce=spell_mechanics,
    columns=("spellIds", "effects", "auras", "targetsA", "targetsB"),
    reads=("rows",),
    counts=(Count("spellMechanics",
                  lambda columns, _r: len(columns["spellIds"])),),
    domains=(Domain("count.mech", lambda columns, _r: numeric_domain(
        Counter(columns["spellIds"]).values())),),
))

EFFECT_NAMES = register(Section(
    name="effectNames",
    doc="Every effect id's enum name, for the word a mechanics pill prints.",
    module="names",
    produce=lambda reads: {"names": reads.effect_names},
    columns=("names",),
    layout=Layout.BARE,
    reads=("effect_names",),
))

AURA_NAMES = register(Section(
    name="auraNames",
    doc="Every aura id's enum name, for the word a mechanics pill prints.",
    module="names",
    produce=lambda reads: {"names": reads.aura_names},
    columns=("names",),
    layout=Layout.BARE,
    reads=("aura_names",),
))

IMPLICIT_TARGET_NAMES = register(Section(
    name="implicitTargetNames",
    doc="The name of each implicit target this build's rows name.",
    module="names",
    produce=target_names,
    columns=("names",),
    layout=Layout.BARE,
    reads=("rows", "target_names"),
    counts=(Count("implicitTargets", lambda columns, _r: len(columns["names"])),),
))

IMPLICIT_TARGET_BITS = register(Section(
    name="implicitTargetBits",
    doc="The caster, target or area bit each implicit target contributes.",
    module="core",
    produce=target_bits,
    columns=("bits",),
    layout=Layout.BARE,
    reads=("rows", "target_bits"),
))

SPELL_LINKS = register(Section(
    name="spellLinks",
    doc="Every edge from a spell to one it triggers, and the word that edge prints.",
    module="core",
    produce=spell_links,
    columns=("srcIds", "dstIds", "kinds", "targets", "kindNames"),
    reads=("effects", "effect_names", "aura_names"),
    counts=(Count("spellLinks", lambda columns, _r: len(columns["srcIds"])),
            Count("linkKinds", lambda columns, _r: len(columns["kindNames"]))),
))


def spell_keybinds(reads: Reads) -> SectionColumns:
    """Which key an aura stops working while it holds."""
    rows = sorted((spell, override)
                  for spell, overrides in reads.effects.keybinds.ids.items()
                  for override in overrides)
    return {"spellIds": [row[0] for row in rows],
            "overrideIds": [row[1] for row in rows],
            "targets": [reads.effects.keybinds.masks.get(row, 0) for row in rows]}


def keybinds(reads: Reads) -> SectionColumns:
    """Each referenced override's key, its timing word, and what it casts."""
    used = sorted({override for overrides in reads.effects.keybinds.ids.values()
                   for override in overrides})
    return {"ids": used,
            "functions": [reads.keybinds[override].function for override in used],
            "whens": [reads.keybinds[override].when for override in used],
            # What retail casts in the key's place. Shipped for a later pass
            # and not displayed, since Epsilon only disables the key.
            "spells": [reads.keybinds[override].spell for override in used]}


SPELL_KEYBINDS = register(Section(
    name="spellKeybinds",
    doc="Which keybound override an aura suppresses while it holds.",
    module="core",
    produce=spell_keybinds,
    columns=("spellIds", "overrideIds", "targets"),
    reads=("effects",),
    counts=(Count("spellKeybinds", lambda columns, _r: len(columns["spellIds"])),),
))

KEYBINDS = register(Section(
    name="keybinds",
    doc="Each suppressed key, when it is suppressed, and what replaces it.",
    module="core",
    produce=keybinds,
    columns=("ids", "functions", "whens", "spells"),
    reads=("effects", "keybinds"),
    counts=(Count("keybinds", lambda columns, _r: len(columns["ids"])),),
))
