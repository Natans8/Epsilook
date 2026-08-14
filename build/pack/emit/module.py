"""Module files: what a build's sections are grouped into, and how they are named.

A module is one file the browser fetches. Sections are assigned to one by the
``module`` they declare, so grouping is a property of the registry rather than
a decision taken here.

The name a module ships under is its own content hash. That is what makes
sharing fall out instead of being arranged: two builds whose sections encode to
the same bytes produce the same file name, so the file is written once and both
manifests point at it. Nothing has to decide in advance whether a module is
common to every build -- if it is, it is shared, and if a build diverges it
gets its own name with no special case anywhere.

The alternative, one file holding everything the builds have in common, was
measured and refused: it forces every reader to fetch the union of what all
builds reference, and the union of the file-name table alone is half again the
slice any one build uses.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from ..model.section import Scope, Section

DIGEST_LENGTH = 12
"""How much of the content hash names a module.

Long enough that two modules colliding is not a thing that happens, short
enough to read in a directory listing. A collision would silently serve one
build another's data, so this is the one number here worth being generous with.
"""


@dataclass(frozen=True)
class Module:
    """One file a build ships, ready to write.

    ``digest`` names the file, so an unchanged module keeps its name across
    rebuilds and a browser holding it never asks again.
    """

    name: str
    """The logical name -- what the module is, without the version or hash."""

    scope: Scope
    """Whether this module is expected to recur across builds. Sharing does not
    depend on it: two modules with the same bytes share whatever they declare.
    It records the intent, so a module declared universal that stops recurring
    is a question worth asking rather than a silent extra file."""

    payload: bytes
    """The gzipped bytes, as they land on disk."""

    digest: str
    """The content hash of `payload`, truncated to `DIGEST_LENGTH`."""

    @property
    def filename(self) -> str:
        """What the module is called on disk, and in every manifest naming it."""
        return f"{self.name}-{self.digest}.json.gz"


def encode(payload: Mapping[str, object]) -> bytes:
    """One module's sections as the gzipped bytes that ship.

    Deterministic in every respect that could otherwise vary: keys sorted, no
    timestamp in the gzip header, one fixed compression level. An unchanged
    module has to encode to the same bytes on every machine, because the bytes
    are what names it -- a nondeterministic encoder would rename every module
    on every rebuild and re-ship the whole pack.
    """
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8")
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as handle:
        handle.write(raw)
    return buf.getvalue()


def assemble(sections: Sequence[Section],
             produced: Mapping[str, object]) -> list[Module]:
    """Group produced sections into the modules that will be written.

    Args:
        sections: the registered sections, in registry order.
        produced: each section's encoded payload, by section name. A section
            with no entry was switched off by a table its build lacks, and is
            left out rather than shipped empty -- absence is what the manifest
            reports.

    Returns:
        One `Module` per module named by the sections, ordered by first
        appearance in the registry. Within a module the section keys are
        sorted rather than kept in that order, because the bytes name the file
        and a producer that built its output from an unordered source would
        otherwise rename the module without changing what it holds.

    Raises:
        ValueError: two sections in one module disagree about its scope. A
            module is written once and referenced by whoever wants it, so it
            cannot be per-build for one section and universal for another.
        ValueError: `produced` holds a section the registry does not declare.
            Ignoring it would drop a route's whole output with nothing to
            notice: the section would simply never appear in any module.
    """
    undeclared = set(produced) - {section.name for section in sections}
    if undeclared:
        raise ValueError(f"produced but not registered: {', '.join(sorted(undeclared))}")

    order: list[str] = []
    payloads: dict[str, dict[str, object]] = {}
    scopes: dict[str, Scope] = {}
    for section in sections:
        if section.name not in produced:
            continue
        if section.module not in payloads:
            order.append(section.module)
            payloads[section.module] = {}
            scopes[section.module] = section.scope
        elif scopes[section.module] is not section.scope:
            raise ValueError(
                f"module {section.module!r} is declared "
                f"{scopes[section.module].value} and {section.scope.value}")
        payloads[section.module][section.name] = produced[section.name]

    modules = []
    for name in order:
        payload = encode(payloads[name])
        digest = hashlib.sha256(payload).hexdigest()[:DIGEST_LENGTH]
        modules.append(Module(name=name, scope=scopes[name], payload=payload,
                              digest=digest))
    return modules
