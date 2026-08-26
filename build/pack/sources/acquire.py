"""Everything one build reads: declared, gathered into the cache, and named.

The single entry point to this layer: above it nothing knows a url, a cache
policy or a file name.

Declaring the roster and acquiring it are two steps rather than one, and the
split is what makes the first answerable on its own -- what a build reads, and
where each of it comes from, with no request made and no network needed.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from ..progress import log
from .client import client_tables_source
from .enums import enum_sources
from .expansions import expansions_source
from .listfile import listfile_source, supplement_source
from .source import Source
from .tdb import tdb_locale_source, tdb_source
from .visual_effect_names import visual_effect_names_source
from .wago import locale_tables_source, pinned_tables_source, tables_source


@dataclass(frozen=True)
class Roster:
    """Every source one build reads, declared and not yet fetched.

    Kept apart from `Sources` because the two answer different questions: this
    one says what a build reads and from where, and it can say so offline.
    """

    tables: Source
    """This build's own table exports, one file per db2 table."""

    pinned_tables: Source
    """The build sound-kit names come from, never the one being packed."""

    enums: Sequence[Source]
    """The name lists that are fetched every build rather than checked in."""

    listfile: Source
    """The community listfile: file data id to asset path."""

    supplement: Source
    """A private client's own names for the assets it adds, vendored."""

    expansions: Source
    """The committed ladder of which expansion introduced a spell."""

    visual_effect_names: Source
    """The committed names for visual effects, distilled from a vendored client.

    Checked in for the same reason the ladder is: the strings were stripped out
    of the client during Mists of Pandaria, and no published archive serves a
    build from the window where they were last complete.
    """

    tdb: Source | None
    """The TrinityCore release for this build, or None when none maps to it."""

    locale_tables: Mapping[str, Source] = field(default_factory=dict)
    """Language code -> that language's copies of the translated tables.

    The build's own export is one language already -- asking for none is
    asking for the exporter's default -- so this holds the languages BESIDE
    that one and is empty for a build shipping only it.
    """

    translations: Source | None = None
    """The server dump's ``*_locale`` tables, or None when no release maps here
    or no second language was asked for."""


@dataclass(frozen=True)
class Sources:
    """Where one build's sources ended up on disk.

    Kept apart rather than merged: `pinned_tables` is another build's, and `tdb`
    holds rows that override `tables` by row id.
    """

    tables: Path
    """This build's own table CSVs, one file per db2 table."""

    pinned_tables: Path
    """The build sound-kit names come from, never the one being packed."""

    listfile: Path
    """The community listfile: file data id to asset path."""

    tdb: Path | None
    """The distilled TrinityCore tables, or None when no release maps here."""

    locale_tables: Mapping[str, Path] = field(default_factory=dict)
    """Language code -> the directory holding that language's tables.

    Only the languages beside the build's own, and only those whose export
    landed: a language nothing came back for is left out rather than pointed
    at an empty directory. It is also the roster of further languages this
    build can be read in, which is why nothing else records that.

    The server's own translations need no entry: they are distilled into the
    release directory `tdb` already names, so acquiring them is the whole of
    what the build needs from them.
    """


def source_roster(version: str, locales: Sequence[str] = (), client: str = "") -> Roster:
    """What one build reads, declared without fetching any of it.

    Args:
        version: the build id.
        locales: the languages to read BESIDE the build's own export, which is
            already one. Naming none is what every pack did before there was a
            second language, and it costs nothing.
        client: the private client to read the tables out of, or empty for a
            build somebody published an export of. It changes this one source
            and nothing else: the listfile, the enums, the ladder and the
            server dump are the same wherever the tables came from.
    """
    return Roster(
        tables=(client_tables_source(client, version) if client else tables_source(version)),
        pinned_tables=pinned_tables_source(),
        enums=enum_sources(),
        listfile=listfile_source(),
        supplement=supplement_source(),
        expansions=expansions_source(),
        visual_effect_names=visual_effect_names_source(),
        tdb=tdb_source(version),
        locale_tables={locale: locale_tables_source(version, locale) for locale in locales},
        translations=tdb_locale_source(version) if locales else None,
    )


def acquired(source: Source, refresh: bool) -> Path | None:
    """Acquire one source, reporting what it is and where it comes from.

    One heading per source, whatever its shape, so the build's own output says
    what the roster says. Only the first origin is named: a gathered source
    has one per file and sixty addresses is not a heading.
    """
    origins = source.origins()
    more = f", and {len(origins) - 1:,} more" if len(origins) > 1 else ""
    log(f"{source.name}, from {origins[0].describe()}{more}:")
    return source.acquire(refresh)


def fetch_sources(version: str, refresh: bool, locales: Sequence[str] = (), client: str = "") -> Sources:
    """Ensure every source this build needs is cached, and say where it is.

    Args:
        version: the build id.
        locales: the languages to read beside the build's own export.
        refresh: re-fetch every source even where a cached copy would do.
        client: the private client to read the tables out of, if any.

    Raises:
        SystemExit: if a source the build cannot do without came back absent.
            Absence is how a build reports predating a table, which is why it
            is not an error on its own -- but a whole directory of them means
            the version was never published rather than that it degraded.
    """
    roster = source_roster(version, locales, client)
    tables = acquired(roster.tables, refresh)
    pinned_tables = acquired(roster.pinned_tables, refresh)
    for source in roster.enums:
        acquired(source, refresh)
    listfile = acquired(roster.listfile, refresh)
    # Acquired for the check and the log rather than for a path: all three are
    # tracked files, read where they are declared -- `listfile.SUPPLEMENT`,
    # `expansions.EXPANSIONS_FILE` and
    # `visual_effect_names.VISUAL_EFFECT_NAMES_FILE`.
    acquired(roster.supplement, refresh)
    acquired(roster.expansions, refresh)
    acquired(roster.visual_effect_names, refresh)
    if roster.tdb is None:
        log(f"TDB: no release maps to {version}; the routes that need one degrade as declared")
        tdb = None
    else:
        tdb = acquired(roster.tdb, refresh)

    landed = {
        locale: path
        for locale, source in roster.locale_tables.items()
        if (path := acquired(source, refresh)) is not None
    }
    # Acquired for its effect: the distillation lands beside the release's own
    # tables, which `tdb` already points at.
    if roster.translations is not None:
        acquired(roster.translations, refresh)

    if tables is None or pinned_tables is None or listfile is None:
        absent = [
            name
            for name, path in (("tables", tables), ("sound-kit names", pinned_tables), ("listfile", listfile))
            if path is None
        ]
        sys.exit(
            f"error: {', '.join(absent)} came back absent for build "
            f"{version}; check the build id is one that was published"
        )
    return Sources(tables=tables, pinned_tables=pinned_tables, listfile=listfile, tdb=tdb, locale_tables=landed)
