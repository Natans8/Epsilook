"""Types and stand-ins the test modules share with the fixtures in
`conftest.py`.

A fixture reaches a test through pytest and needs no import; its type does not,
and importing a name out of `conftest` is not something pytest supports. So the
shared type lives here, where both sides can name it.
"""

from __future__ import annotations

import email.message
import io
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from pack.tables import CsvTables

ROOT = Path(__file__).resolve().parents[2]
"""The repository root.

Derived here and nowhere else: this module sits at a fixed depth and the test
modules do not -- they are grouped by what they cover, and a group can be
added or a file moved between them. A test that counts its own parents is one
whose location is load-bearing, which is how a move turns into a dozen
file-not-found errors instead of a rename.
"""

BuildTables = Callable[..., CsvTables]
"""The `tables` fixture: keyword arguments naming tables, a provider back."""


@dataclass
class Network:
    """The network, as addresses mapped to bodies.

    Installed over `urllib.request.urlopen`, which every fetch policy and the
    content storage alike reach through. Shared rather than written per test
    module because what a request looks like is one fact: two stand-ins for it
    would answer a miss differently the day one of them learned something.
    """

    bodies: dict[str, bytes] = field(default_factory=dict)

    missing: int = 404
    """What an address it does not carry answers.

    A miss is how a build finds out it predates a table, and the code for one
    is a property of the network rather than of the request: a bucket-backed
    one refuses to say whether an object exists, which is a 403.
    """

    asked: Counter[str] = field(default_factory=Counter)
    """One count per request made, so a policy that should not have made one
    can be caught doing it."""

    ranged: list[tuple[str, str]] = field(default_factory=list)
    """Each request that asked for part of a file, as its address and range.
    A reader that fetched a whole archive to reach one file in it appears here
    as nothing at all."""

    def open(self, request: urllib.request.Request, timeout: float | None = None) -> io.BytesIO:
        """Stand in for `urlopen`: bytes, as a context manager."""
        address = request.full_url
        self.asked[address] += 1
        body = self.bodies.get(address)
        if body is None:
            raise urllib.error.HTTPError(address, self.missing, "Missing", email.message.Message(), None)
        wanted = request.headers.get("Range")
        if wanted:
            self.ranged.append((address, wanted))
            first, last = wanted.removeprefix("bytes=").split("-")
            body = body[int(first) : int(last) + 1]
        return io.BytesIO(body)
