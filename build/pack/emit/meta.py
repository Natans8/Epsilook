"""What the pack says about itself: format, provenance, counts, domains.

Everything here is a DERIVED fact shipped so nothing downstream re-derives it.
The counts are how the drift tables are read straight out of the packs instead
of being estimated, and the domains are what let a numeric control be drawn
without the app measuring a quarter of a million values on every load.

Both are assembled from the section records rather than written out by hand, so
a section that declares a count contributes one and a section that goes away
takes its own with it.
"""

from __future__ import annotations

import time
from collections.abc import Mapping

from ..build import Build
from ..derive import DeriveContext
from ..model import SECTIONS, CountFamily, Section, SectionColumns
from ..progress import detail

PACK_FORMAT = 60
"""What shape the artifact is in.

60 gives every attached model its placement: how big it is drawn, where it sits
against its point, how it is turned there, and what it animates. The four kinds
reached through the attached-model table -- `attach`, `display`, `item` and
`equipped` -- each gain `scale`, `built`, `offset`, `rotation`, `anim` and
`animkit`. `scale` is the size the attachment asks for and `built` the size the
model itself is; they are apart because how the client combines them is not a
fact this data holds, and a fifth of rows ask for no scale while naming a model
whose own is not one.
`offset` and `rotation` are the first properties to ship as more than one
column: each is one value to a reader and three numbers here, so a reader of 59
finds a property where it expected a column. The numbers are fixed-point --
thousandths of a factor, thousandths of a yard, tenths of a degree -- because a
whole-number column is what both readers are fastest at.

59 renames the body-point vocabulary the other way round: the worn-model kind
ships as `attach` and every attachment-point property -- the five model kinds'
plus the dissolve, shadowy and vehicle anchors -- ships as `where`. A reader
of 58 finds neither name it knows.

58 renames the worn-model row kind: a model stuck to a body ships as `worn`
rather than `attached`, so the kind's word stops colliding with the `attach`
property that says which body point anything rides on. A reader of 57 finds
rows of a kind it has never heard of.

57 adds `spellRanges`: the distance band of every spell that reaches past
its caster, as its far edge, its near edge and the two flags saying the
reach is the caster's own body or their equipped weapon rather than the
band's number. Self is the complement, so a spell absent from the section
reaches nobody but itself, and the far edge keeps the client's own
fifty-thousand-yard marker for a band with no far edge at all.

56 names a morph's property for what it stores: the row's `display` is now
`creature`, since a transform aura carries a creature entry and the display
is what that creature wears. `morphDisplays` becomes `creatureDisplays` and
takes in the summoned creatures' displays beside the morphed ones, keyed by
the creature either way. A new `displaySkins` section carries the textures
each named display paints over its model, one row per texture in slot
order, for every display the pack names -- a creature's, a form's, a
mount's, or one an effect name attaches -- and those textures join the
named files.

55 renames the vehicle row kind and its subject. A spell that seats its
subject ships as `vehicle` rather than `seats`, and the seat count that
was `count` is now `seats` -- the axis reads `vehicle:{seats:4}`, where
it read `seats:{count:4}`. A reader resolves a pooled row's kind by the
word the pack ships and has no mapping layer, so 54's rows are unknown
to it rather than differently shaped.

54 gives a missile row how many projectiles its flight path is written for.
`missileMotions` gains a `projectiles` column beside the names it carried,
and the row stores its motion id twice -- once read as a name, once as that
count -- so the number stays one copy per motion rather than one per row.
It also makes absence a section-level fact: a section whose `needs` a build
lacks ships absent instead of empty, `meta.degradedSections` names the
sections shipping thinner than usual and the table that thinned each, and a
row's per-kind `vocab` and `absent` name only that kind's own properties.

53 makes the language an axis of the artifact: the manifest names the structure
modules apart from the ones holding a language, and the second group is keyed
by language code. English stops being the base and becomes the first entry of
that group, which is why a reader of 52 would find no `names` module at all
rather than a differently-shaped one.

52 finishes the reshape: the visual-effect and mechanics columns ship rows too,
so every column a spell carries more than one of is a row table and the
twenty-three per-spell sections they were assembled from are gone. A row may
now carry columns no property of its kind declares -- which dissolve it is, the
aura sharing an effect's row -- shipped apart from the values so the evaluator
still sees exactly what the catalogue declares.

51 shipped rows for the model, sound and animation columns: the distinct rows of
each kind pooled once, plus per spell a count and its references, in place of
the seven per-spell sections they were assembled from.

50 was the row's CONTENT: a mask on every row the game aims somewhere, the role
a rider's animation plays in, and the storage unit each numeric axis is
measured in. Two of those change row counts rather than only adding columns --
an animation used both entering and seated is two rows, because which act it
belongs to is the question being asked.

Bumped whenever a reader that understood the last version would misread this
one. The app refuses a pack whose format it does not know, which is what makes
a half-deployed change loud instead of subtly wrong.
"""


def counts_of(section: Section, columns: SectionColumns, context: DeriveContext) -> dict[str, int]:
    """Every `meta.counts` entry one section contributes."""
    reads = context.reads(section.reads)
    counted: dict[str, int] = {}
    for declared in section.counts:
        if isinstance(declared, CountFamily):
            counted.update(declared.compute(columns, reads))
        else:
            counted[declared.key] = declared.compute(columns, reads)
    return counted


def domains_of(section: Section, columns: SectionColumns, context: DeriveContext) -> dict[str, Mapping[str, object]]:
    """Every `meta.domains` entry one section contributes.

    A domain that measures to nothing is left out rather than shipped empty: an
    axis with no values in this pack has no control to draw, which is a
    different thing from one whose values are all zero.
    """
    reads = context.reads(section.reads)
    return {
        declared.key: ({**measured, "unit": declared.unit} if declared.unit else measured)
        for declared in section.domains
        if (measured := declared.compute(columns, reads)) is not None
    }


def gathered(
    produced: Mapping[str, SectionColumns], context: DeriveContext
) -> tuple[dict[str, int], dict[str, Mapping[str, object]]]:
    """The counts and domains of every section that shipped.

    Registry order, which groups a section's counts with the section they
    describe. Nothing depends on the order -- these are looked up by key -- so
    the artifact does not carry a second list saying what it should be.

    Args:
        produced: what each section's `produce` returned, by section name.
        context: the build's derive context, for the reads a count declares.

    Returns:
        The two `meta` tables.
    """
    counted: dict[str, int] = {}
    measured: dict[str, Mapping[str, object]] = {}
    for section in SECTIONS:
        if section.name not in produced:
            continue
        with detail("gather counts and domains", section.name):
            counted.update(counts_of(section, produced[section.name], context))
            measured.update(domains_of(section, produced[section.name], context))
    return counted, measured


def meta(
    build: Build,
    label: str,
    listfile_tag: str,
    counts: Mapping[str, int],
    domains: Mapping[str, Mapping[str, object]],
    *,
    degraded: Mapping[str, list[str]] | None = None,
) -> dict[str, object]:
    """The pack's own header.

    The counts and domains are the default language's, because that is the pass
    they are gathered from. Only the counts over cooked prose could differ at
    all -- how many distinct strings a redirect chain collapses to is a fact
    about the wording -- and nothing reads them per language: what the drift
    tables and the numeric controls describe is the build, which is one thing
    whoever is reading it.

    Args:
        build: what is being packed, and what it was found to lack.
        label: the human name the version picker shows.
        listfile_tag: which listfile release named this pack's assets.
        counts: the assembled `meta.counts`.
        domains: the assembled `meta.domains`.
        degraded: per shipped section, the absent tables thinning it. The
            claim `absentTables` cannot make on its own: which of the
            sections that DID ship hold less than they would, and why.
    """
    return {
        "format": PACK_FORMAT,
        "version": build.version,
        "label": label,
        # The date and not the time: two rebuilds on one day have to compare
        # equal, since that is what makes a deterministic rebuild provable.
        "built": time.strftime("%Y-%m-%d"),
        "listfileTag": listfile_tag,
        "tdbTag": build.tdb or "",
        "absentTables": sorted(build.absent_tables),
        "degradedSections": dict(degraded or {}),
        "counts": dict(counts),
        "domains": dict(domains),
    }
