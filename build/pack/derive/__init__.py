"""The one graph walk and every cross-route derivation.

Anything two sections need -- the spell to visual to kit to effect walk,
path resolution, the icon index, target masks -- is computed here once and
handed to every section through the shared ``DeriveContext``. Sections may
not depend on each other; sharing through this layer is what keeps the
section registry flat. Knows nothing about encoding.
"""

from .context import DeriveContext

__all__ = ["DeriveContext"]
