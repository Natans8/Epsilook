"""The section registry -- the build's extension point.

A pack section is one ``Section`` record; assembly, ``meta.counts``,
``meta.domains``, module placement, locale output, the generated drift table
and the registry guard all follow from it. Knows nothing about bytes.
"""

from .registry import SECTIONS, register
from .section import Count, Domain, Encoding, Scope, Section, SectionColumns

__all__ = [
    "Count",
    "Domain",
    "Encoding",
    "SECTIONS",
    "Scope",
    "Section",
    "SectionColumns",
    "register",
]
