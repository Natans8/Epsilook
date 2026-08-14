"""The one graph walk and every cross-route derivation.

Anything two sections need -- the spell to visual to kit to effect walk, path
resolution, the icon index, target masks -- is computed here once and handed to
every section through the shared ``DeriveContext``.
"""

from .context import DeriveContext

__all__ = ["DeriveContext"]
