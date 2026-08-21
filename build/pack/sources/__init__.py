"""Acquisition: what a source is, where it lives, and how it becomes rows.

The only layer that names a url, and the one that decides where a fetched byte
lands; a provider in `tables/` may open what it left there. A `Source` is the
seam: `source_roster` declares everything one build reads without fetching any
of it, and `fetch_sources` acquires that roster and returns a `Sources` saying
where each of them landed. The other exports read the sources that are parsed
rather than merely located.
"""

from __future__ import annotations

from .acquire import Roster, Sources, fetch_sources, source_roster
from .enums import (enum_id_where, enum_ids_where, load_local_enum,
                    read_anim_names, read_enum_names)
from .expansions import ExpansionLadder, load_expansions
from .source import Source
from .wago import SOUNDKITNAME_BUILD, TABLES

# The seam and the roster, and deliberately not the kit they are built from:
# an `Origin` carries an address, so re-exporting the constructors would put
# assembling a source with a url in it within reach of a caller the layer rules
# forbid it to. The layer's own modules import those from `.source` directly.
__all__ = [
    "SOUNDKITNAME_BUILD",
    "Roster",
    "Source",
    "Sources",
    "TABLES",
    "enum_id_where",
    "enum_ids_where",
    "fetch_sources",
    "ExpansionLadder",
    "load_expansions",
    "load_local_enum",
    "read_anim_names",
    "read_enum_names",
    "source_roster",
]
