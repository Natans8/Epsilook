"""Acquisition: URLs, cache policy, archive extraction, TDB distillation.

The only layer that names a URL or an input file path. It brings every byte
the build reads into the cache -- downloaded CSVs, the distilled TrinityCore
tables, the community listfile, the checked-in enum files -- and hands the
layer above a `Sources` saying where each of them is. Knows nothing about
spells.

`fetch_sources` is the door: one call brings a build's whole world into the
cache. Beside it are the readers for the sources that are parsed rather than
merely located -- the checked-in enum tables, the expansion ladder, and the two
community name lists. Everything else is an implementation detail of a
submodule, reachable by naming it.
"""

from __future__ import annotations

from .acquire import Sources, fetch_sources
from .enums import load_local_enum, read_anim_names, read_enum_names
from .expansions import load_expansions
from .wago import SOUNDKITNAME_BUILD, TABLES

__all__ = [
    "SOUNDKITNAME_BUILD",
    "Sources",
    "TABLES",
    "fetch_sources",
    "load_expansions",
    "load_local_enum",
    "read_anim_names",
    "read_enum_names",
]
