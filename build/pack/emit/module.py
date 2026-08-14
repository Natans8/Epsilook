"""Module files: what a build's sections are grouped into, and how they are named.

A module is one file the browser fetches. Sections are assigned to one by the
``module`` they declare, so grouping is a property of the registry rather than
a decision taken here.

The name a module ships under is its own content hash. That is what makes
sharing fall out instead of being arranged: two builds whose sections serialise
to the same bytes produce the same file name, so the file is written once and
both manifests point at it. Nothing has to decide in advance whether a module
is common to every build -- if it is, it is shared, and if a build diverges it
gets its own name.

A section is not necessarily one module's worth. The columns carrying the
game's own language go to the locale module and the rest stay with the
structure, so a reader wanting Russian fetches one file instead of a second
copy of every id. The section keeps its name in both, and joining them is
reading two objects with the same key.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from ..model.section import Section

DIGEST_LENGTH = 12
"""How much of the content hash names a module.

A module's name changes exactly when its bytes do, so a collision would serve
one build another's data, and a needlessly long hash costs only the width of a
directory listing.
"""


@dataclass(frozen=True)
class Module:
    """One file a build ships, ready to write.

    An unchanged module keeps its name across rebuilds, so a browser holding it
    never asks for it again.
    """

    name: str
    """The logical name -- what the module is, without the version or hash."""

    payload: bytes
    """The gzipped bytes, as they land on disk."""

    @property
    def digest(self) -> str:
        """The content hash of ``payload``, truncated to ``DIGEST_LENGTH``."""
        return hashlib.sha256(self.payload).hexdigest()[:DIGEST_LENGTH]

    @property
    def filename(self) -> str:
        """What the module is called, and what every manifest naming it says.

        A bare filename: which directory it lands in is the writer's, since
        that is where the artifact's layout is decided.
        """
        return f"{self.name}-{self.digest}.json.gz"


def serialize(payload: Mapping[str, object]) -> bytes:
    """One module's sections as the gzipped bytes that ship.

    Named apart from the ``encode`` layer, which lays out columns: by the time
    a payload reaches here its columns are already laid out and only the bytes
    are left to decide.

    Key order is the order the sections were added, which is the registry's.
    Nothing is sorted: the bytes name the file, so re-ordering them would
    rename every module without changing what it holds. Determinism therefore
    rests on producers being deterministic, which is required of them anyway --
    laundering an unordered producer here would hide that defect rather than
    fix it.
    """
    buf = io.BytesIO()
    # No timestamp in the header, one fixed level: an unchanged module has to
    # serialise to the same bytes on every machine, because they name it.
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as handle:
        # One section at a time into the open stream. Encoding the whole module
        # first would hold the document as text, again as bytes, and again
        # compressed -- five times the size it ships at, where this is bounded
        # by the largest single section. The bytes are the same either way.
        handle.write(b"{")
        for at, (name, section) in enumerate(payload.items()):
            if at:
                handle.write(b",")
            handle.write(json.dumps(name, ensure_ascii=False).encode("utf-8"))
            handle.write(b":")
            handle.write(json.dumps(section, ensure_ascii=False,
                                    separators=(",", ":")).encode("utf-8"))
        handle.write(b"}")
    return buf.getvalue()


def absent_sections(sections: Sequence[Section],
                    produced: Mapping[str, object]) -> list[str]:
    """The registered sections this build produced nothing for, sorted.

    The one answer to "what does this build lack": `assemble` leaves these out
    of every module and the manifest reports them, and both read it from here
    so the artifact cannot say a section is absent while a module carries it.
    """
    return sorted(section.name for section in sections if section.name not in produced)


LOCALE_MODULE = "names"
"""Where a section's localizable columns go by default.

One module rather than one per section: every name in the pack is swapped
together when the language changes, so splitting them finer would only make a
reader fetch more files for one decision.
"""

LOCALE_MODULES = ("names", "text")
"""The modules that hold a language rather than a structure.

Two, and the split between them is what each is FOR rather than what it holds:
a name is needed for the first keystroke, and prose is not. A section already
in one of these is language throughout and stays whole.
"""


def split(section: Section, payload: object) -> list[tuple[str, object]]:
    """One section's payload, split into the modules it belongs in.

    A section with no localizable columns is one entry. A section with some is
    two: the structure in its own module and the language in the locale one,
    under the same section name in both.
    """
    if not section.localizable or not isinstance(payload, dict):
        return [(section.module, payload)]
    if section.module in LOCALE_MODULES:
        return [(section.module, payload)]
    spoken = {name: column for name, column in payload.items()
              if name in section.localizable}
    rest = {name: column for name, column in payload.items()
            if name not in section.localizable}
    placed: list[tuple[str, object]] = [(LOCALE_MODULE, spoken)]
    # A section that is ALL language contributes nothing to its own module, and
    # shipping an empty object there would make a reader think it had checked.
    if rest:
        placed.insert(0, (section.module, rest))
    return placed


def assemble(sections: Sequence[Section],
             produced: Mapping[str, object]) -> list[Module]:
    """Group produced sections into the modules that will be written.

    Args:
        sections: the registered sections, in registry order.
        produced: each section's encoded payload, by section name. A section
            with no entry was switched off by a table its build lacks, and is
            left out rather than shipped empty -- an empty column reads as
            "nothing matches", which is a different claim from "this build
            never had it". `absent_sections` is what reports the difference.

    Returns:
        One `Module` per module named by the produced sections, ordered by
        first appearance in the registry.

    Raises:
        ValueError: `produced` holds a section the registry does not declare.
            Ignoring it would drop a route's whole output with nothing to
            notice: the section would appear in no module and no manifest.
    """
    undeclared = set(produced) - {section.name for section in sections}
    if undeclared:
        raise ValueError(f"produced but not registered: {', '.join(sorted(undeclared))}")

    payloads: dict[str, dict[str, object]] = {}
    for section in sections:
        if section.name in produced:
            for module, payload in split(section, produced[section.name]):
                payloads.setdefault(module, {})[section.name] = payload
    return [Module(name=name, payload=serialize(payload))
            for name, payload in payloads.items()]
