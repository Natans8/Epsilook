"""The section registry -- the build's extension point.

A pack section is one ``Section`` record; assembly, ``meta.counts``,
``meta.domains``, module placement, locale output and the registry guard all
follow from it.
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
