"""The readers: one module per route family.

A reader takes the ``Tables`` it is handed and returns a typed bundle. This
layer owns the interpretive half of the build -- dispatch on effect and
procedure types, chain expansion, target-mask resolution, description
cooking. It never learns where rows came from or what ships: no file paths,
no URLs, no emitters.
"""
