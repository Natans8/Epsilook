"""Acquisition: URLs, cache policy, archive extraction, TDB distillation.

The only layer that names a URL or a file path. Serves raw table files to
``tables/`` implementations -- downloaded CSVs, the distilled TDB, checked-in
enum files and vendored archives alike -- and records provenance for each.
Knows nothing about spells.
"""
