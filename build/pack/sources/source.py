"""The source interface every acquisition goes through.

Three jobs live in this layer, and each module used to run all three its own
way. A table export is a url and a cache check; the community listfile is a
release lookup and a tag comparison; the TrinityCore dump is an archive, a
member inside it, a distillation and a freshness test nothing else could
reuse. Nothing said which steps a source has, so a new one had nowhere to be
written except alongside whichever existing module it resembled most.

The three, separated:

    locating    where the bytes are: a url, or a file tracked in the
                repository. An ``Origin`` is a value, so what a build reads
                can be reported without a request.
    getting     bringing them into the cache under a policy, which is the one
                question that differs -- can this source change under a build
                that already shipped?
    extracting  turning them into the rows a ``tables`` provider serves. A CSV
                already is rows; a mysqldump and a db2 are not.

``acquire`` is the whole of it: a path a provider can open, or ``None`` when
this build declares the source absent.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from ..progress import log


@dataclass(frozen=True)
class Origin:
    """Where one source's bytes come from, said without fetching them.

    A value rather than a step, for two reasons. A build can report what it
    reads on a machine with no network, which is what makes a pack's
    provenance answerable at all. And it is the one place an address is
    written down: the layer rule that nothing above here names a url only
    means something if the addresses below it are values a reader can find.
    """

    address: str
    """A url, or the path of a file tracked in the repository."""

    detail: str = ""
    """What is taken from the address, when the address is not the whole
    answer: which asset of a release, where the release is what is published
    at a fixed endpoint and the asset's own url is not."""

    def describe(self) -> str:
        """One line naming where these bytes come from."""
        return f"{self.address} ({self.detail})" if self.detail else self.address


@dataclass(frozen=True)
class Part:
    """One file of a gathered source, named where it lands.

    A declaration rather than a source of its own. What the parts of one
    gathered source share is the policy that gets them, so a part states only
    what is its own: where its bytes are, what to call them, and whether this
    build lacking them is a fact rather than a failure.
    """

    origin: Origin
    name: str
    """The file name it lands under, inside the gatherer's directory."""

    optional: bool = False
    """Whether this build not having it is declared rather than an error.

    A property of the source, not of how bytes travel: which tables a client
    predates is a fact about that client, and a policy that had to carry it
    could only ever answer it for the one transport it happens to use.
    """


class Fetch(Protocol):
    """A policy for getting located bytes, and for when a cached copy will do.

    The policies differ on one question: can this source change under a build
    that already shipped? A version-pinned export cannot, so one fetch is the
    last one; a community list can, so it is revalidated or refetched; a file
    tracked in the repository is never fetched at all.
    """

    def get(self, origin: Origin, dest: Path, refresh: bool,
            optional: bool = False) -> bool:
        """Ensure ``dest`` holds the origin's bytes.

        Args:
            origin: where the bytes come from.
            dest: where they must be once this returns.
            refresh: get them again even where a cached copy would pass.
            optional: the source declares this build may not have it, so an
                upstream saying so is an answer rather than a failure.

        Returns:
            True once they are there; False where this build is declared to
            lack it. Any other failure raises or exits.
        """
        raise NotImplementedError

    def get_many(self, parts: Sequence[Part], into: Path,
                 refresh: bool) -> list[Path]:
        """Get a whole set at once, and say which of them landed.

        The set is offered rather than the parts one at a time because that is
        the only moment a policy can act on what they share. Over http there is
        nothing to share and this is a loop; over a content store, resolving
        keys is one pass over an index whose repeated scanning would otherwise
        dominate the read. A policy with nothing to share calls ``each``.

        Args:
            parts: what to get, in the order they are declared.
            into: the directory they land in.
            refresh: get them again even where cached copies would pass.

        Returns:
            Where each part that landed now is. Empty when this build is
            declared to lack every one of them.
        """
        raise NotImplementedError


def each(fetch: Fetch, parts: Sequence[Part], into: Path,
         refresh: bool) -> list[Path]:
    """Get parts one at a time: what a policy with nothing to share does.

    Written once here rather than in each policy, so that the policies which
    do have something to share are the only ones that say anything about it.
    """
    landed = []
    for part in parts:
        dest = into / part.name
        if fetch.get(part.origin, dest, refresh, part.optional):
            landed.append(dest)
    return landed


class Extract(Protocol):
    """Turning located bytes into the rows a ``tables`` provider serves.

    The open end of this layer: a format nothing else reads arrives here, and
    every one of them needs the same two answers. Improvising them per module
    is what left the TrinityCore distillation with a completeness test that
    only it could use, and a db2 reader with nowhere to put the schema its
    columns are named from.
    """

    def complete(self, into: Path) -> bool:
        """Whether ``into`` already holds exactly what this extraction writes.

        Not merely whether something is there. A widened column list, a table
        added to the roster and a half-written directory all leave an artifact
        that exists and is wrong, and the cheap check that spots none of them
        is the one a build runs on every source it has already extracted.
        """
        raise NotImplementedError

    def run(self, located: Path, into: Path) -> None:
        """Write the rows out.

        Args:
            located: the bytes, as the fetch left them.
            into: the directory to write into. It exists.
        """
        raise NotImplementedError


class Source(Protocol):
    """One thing a build reads, from where it lives to where it lands.

    The contract every implementation must honour:

    - ``acquire`` returns a path that exists, or ``None`` when this build
      declares the source absent. Never a path that is not there.
    - Acquiring twice returns the same path, and the second call redoes only
      what the source's own policy says has gone stale.
    - ``refresh`` gets the source again. What that reaches is the source's
      business rather than the caller's: it stops at any test already comparing
      what the cache holds against what would be written, and at any bytes
      whose own policy can tell whether they moved.
    - ``origins`` costs nothing: no request and no read. It is what lets a
      build say what it reads without reading any of it.
    - An absent source leaves nothing a later run would take for a complete
      one.
    """

    @property
    def name(self) -> str:
        """What this source is called in the log and in an error.

        Read-only on the interface so a frozen implementation satisfies it;
        every one of them below declares it as a field.
        """
        raise NotImplementedError

    def origins(self) -> list[Origin]:
        """Where its bytes come from. Plural: a source may gather several."""
        raise NotImplementedError

    def acquire(self, refresh: bool) -> Path | None:
        """Bring it into the cache, and say where it is."""
        raise NotImplementedError


@dataclass(frozen=True)
class Fetched:
    """A source that is its bytes: get them, and that is the whole of it.

    Everything whose format a provider already reads -- a table export, the
    listfile, a checked-in name list -- and every tracked file, which is
    gotten by being there.
    """

    name: str
    origin: Origin
    dest: Path
    """Where the bytes land, and what a provider is pointed at."""

    fetch: Fetch

    def origins(self) -> list[Origin]:
        """The one place these bytes come from."""
        return [self.origin]

    def acquire(self, refresh: bool) -> Path | None:
        """Get the bytes, and say where they are."""
        if not self.fetch.get(self.origin, self.dest, refresh):
            return None
        return self.dest


@dataclass(frozen=True)
class Extracted:
    """A source whose bytes have to be turned into rows before anything reads
    them.

    An archive of mysqldump SQL today, a db2 storage next. The shape is the
    same either way and it is the extraction that differs, which is the point
    of having named the step.
    """

    name: str
    inner: Source
    """Where the bytes come from: a source in its own right, so an extraction
    never has to know a cache policy as well."""

    extract: Extract
    into: Path
    """The directory the rows land in."""

    def origins(self) -> list[Origin]:
        """Whatever the bytes were fetched from."""
        return self.inner.origins()

    def acquire(self, refresh: bool) -> Path | None:
        """Extract, unless what is already there is what would be written.

        The completeness test comes first so a cached extraction costs
        nothing, not even locating the bytes it came from -- which for an
        archive is a download somebody would otherwise pay for on every build.

        It decides on its own, and ``refresh`` does not override it. The test
        compares what the cache holds against what this extraction writes,
        exactly, so a cache that passes it is one no re-run could improve;
        overriding it would spend a re-scan of a solid archive, and where that
        archive has since been pruned a fresh download of it, to arrive at the
        same rows.

        What refresh reaches is the extraction, and not the bytes under it. It
        answers "the rows may be wrong", which re-running the extraction is
        what settles; the bytes have their own policy and it already knows
        whether they moved. Forwarding it would re-transfer hundreds of
        megabytes of an archive published against a fixed release to arrive at
        the identical file -- and it would not even buy a repair, because a
        fetch writes through a temporary and renames, so an interrupted one
        leaves no destination to be stale.
        """
        if self.extract.complete(self.into):
            log(f"  cached   {self.into.name}")
            return self.into
        located = self.inner.acquire(False)
        if located is None:
            return None
        self.into.mkdir(parents=True, exist_ok=True)
        self.extract.run(located, self.into)
        return self.into


@dataclass(frozen=True)
class Gathered:
    """One policy over several files, landing in a directory a provider reads.

    What separates this from ``Fetched`` is what the provider is handed -- a
    directory rather than a file -- and not how many files there are. A
    directory holding one is still a directory, and it is the gatherer that
    names it and decides what lands in it.

    Holding one ``Fetch`` over many parts, rather than many sources each with a
    policy of their own, is what lets a policy see the whole set: over http
    every part carries an identical policy anyway, and a content store cannot
    resolve its keys in one pass unless something asks it for the set.
    """

    name: str
    into: Path
    fetch: Fetch
    parts: Sequence[Part]

    def origins(self) -> list[Origin]:
        """Every part's, in the order the parts are declared."""
        return [part.origin for part in self.parts]

    def acquire(self, refresh: bool) -> Path | None:
        """Get every part, and return the directory they share.

        Absent only when every part is. A directory in which this build
        predates each file is not a source degrading as declared, it is a
        version nothing was fetched for -- so nothing is left behind for a
        later run to find and take for a complete one.
        """
        if not self.fetch.get_many(self.parts, self.into, refresh):
            return None
        self.into.mkdir(parents=True, exist_ok=True)
        return self.into
