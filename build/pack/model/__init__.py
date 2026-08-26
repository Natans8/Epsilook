"""The section registry -- the build's extension point.

A pack section is one ``Section`` record; assembly, ``meta.counts``,
``meta.domains``, module placement, locale output and the registry guard all
follow from it.
"""

from .registry import SECTIONS, register
from .section import Cardinality, Count, CountFamily, Domain, Encoding, Layout, Scope, Section, SectionColumns

# Last, and for its side effects: importing a section module registers it, so
# this is what fills SECTIONS. It must follow the two imports above, which are
# what a section module reaches back for.
from . import sections  # noqa: E402  (side-effecting, and order matters)

__all__ = [
    "Cardinality",
    "Count",
    "CountFamily",
    "Domain",
    "Encoding",
    "Layout",
    "SECTIONS",
    "Scope",
    "Section",
    "SectionColumns",
    "register",
    "sections",
]
