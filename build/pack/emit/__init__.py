"""Module files, the manifest, per-module hashes, locale placement.

Reads the section registry and never a route. Owns byte determinism: sorted
keys, fixed mtimes, stable ordering, so an unchanged pack rebuilds
byte-identical.
"""
