"""The pack build as a layered package.

Layers, in data-flow order; imports point the other way (a layer imports only
layers closer to ``sources/``, plus the package-root vocabulary modules):

    sources/  acquisition: download, cache, extraction, distillation, provenance
    tables/   the provider seam: ``Tables`` -- available, header, rows
    routes/   the readers: tables in, typed bundles out
    derive/   the graph walk and every cross-route derivation, computed once
    model/    the section registry -- the extension point
    encode/   per-column layouts the sections declare
    emit/     module files, the manifest, hashes, locale placement

Beside them sit the package-root vocabulary modules -- ``drift``, ``targets``,
``progress``, ``build`` -- which any layer may import and which import no
layer.

Two rules keep the layers honest:

- Imports flow toward ``sources/`` only. An emitter reads the registry, never
  a route; a route never sees an emitter.
- ``routes/``, ``derive/``, ``model/`` and ``encode/`` name no file path and
  no URL. Every byte enters through a ``Tables`` implementation and leaves
  through ``emit/``, which is what makes the source swappable and the artifact
  reshapeable without touching a route.

``docs/DATA_ROUTES.md`` documents what each route means; this package moves
code, not meaning.
"""
