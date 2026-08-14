"""The pack build as a layered package.

Layers, in data-flow order; imports point the other way, toward ``sources/``:

    sources/  acquisition: download, cache, extraction, distillation, provenance
    tables/   the provider seam: ``Tables`` -- available, header, rows
    routes/   the readers: tables in, typed bundles out
    derive/   the graph walk and every cross-route derivation, computed once
    model/    the section registry -- the extension point
    encode/   per-column layouts the sections declare
    emit/     module files, the manifest, hashes, locale placement

``drift``, ``targets``, ``supplements``, ``progress`` and ``build`` are
vocabulary any layer may import and import no layer. ``routes/``, ``derive/``,
``model/`` and ``encode/`` name no file path and no URL.
"""
