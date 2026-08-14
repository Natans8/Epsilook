"""Acquisition: URLs, cache policy, archive extraction, TDB distillation.

The only layer that names a URL or an input file path. `fetch_sources` brings
every byte one build reads into the cache and returns a `Sources` saying where
each of them is; the other exports read the sources that are parsed rather than
merely located.
"""

from __future__ import annotations

from .acquire import Sources, fetch_sources
from .enums import (enum_id_where, enum_ids_where, load_local_enum,
                    read_anim_names, read_enum_names)
from .expansions import load_expansions
from .listfile import resolve_paths
from .wago import SOUNDKITNAME_BUILD, TABLES

__all__ = [
    "SOUNDKITNAME_BUILD",
    "Sources",
    "TABLES",
    "enum_id_where",
    "enum_ids_where",
    "fetch_sources",
    "load_expansions",
    "load_local_enum",
    "read_anim_names",
    "read_enum_names",
    "resolve_paths",
]
