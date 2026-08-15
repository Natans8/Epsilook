"""The words the graph of spells that reach other spells is read through.

An edge exists because some effect row on the source triggers the target, and
what the edge SAYS is the word that row's effect or aura prints. The edges
themselves are mech rows now, one kind per direction -- they are the same edges
read from either end, so shipping them again here would be a third copy of one
fact. What stays is the pool those rows store a number into.
"""

from __future__ import annotations

from ..registry import register
from ..section import Count, Layout, Section


LINK_KIND_NAMES = register(Section(
    name="linkKindNames",
    doc="The word each spell-to-spell edge prints, by the number a row stores.",
    module="core",
    produce=lambda reads: {"names": list(reads.rows.link_words)},
    columns=("names",),
    layout=Layout.BARE,
    reads=("rows",),
    counts=(Count("linkKinds", lambda columns, _r: len(columns["names"])),),
))
