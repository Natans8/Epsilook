"""Types and stand-ins the test modules share with the fixtures in
`conftest.py`.

A fixture reaches a test through pytest and needs no import; its type does not,
and importing a name out of `conftest` is not something pytest supports. So the
shared type lives here, where both sides can name it.

The same goes for a rule two test modules both need. What a Lua table stands
for is one of those: both addon suites read values back out of an interpreter,
and two answers to that question would differ on the empty table long before
anybody noticed.
"""

from __future__ import annotations

import email.message
import io
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from pack.tables import CsvTables

try:
    # The package ships no type stubs, and writing one for an interpreter
    # binding would be a second account of an API this reads three names from.
    import lupa.lua51 as lua51  # type: ignore[import-untyped]
except ImportError:
    # Only the addon suites need it, and each skips itself without it. Failing
    # to import here instead would take the whole run down with them.
    lua51 = None  # type: ignore[assignment]

BuildTables = Callable[..., CsvTables]
"""The `tables` fixture: keyword arguments naming tables, a provider back."""


def unwrap(value: Any) -> Any:
    """A Lua value as the Python one it stands for.

    A Lua table is a list where its keys are one to n and a mapping otherwise,
    which is the same distinction the addon's emitter made on the way in.

    An empty table is read as an empty list, because Lua has one value for both
    and nothing in it says which was meant. That ambiguity is the language's
    rather than the layout's: a reader is handed a table with nothing in it
    either way. A test that cares whether a result is empty should say that
    rather than compare against one shape or the other.
    """
    if not lua51.lua_type(value) == "table":
        return value.decode("utf-8") if isinstance(value, bytes) else value
    keys = list(value.keys())
    if not keys:
        return []
    if keys == list(range(1, len(keys) + 1)):
        return [unwrap(value[key]) for key in keys]
    return {(key.decode("utf-8") if isinstance(key, bytes) else key):
            unwrap(value[key]) for key in keys}


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

    def open(self, request: urllib.request.Request, timeout: float | None = None
             ) -> io.BytesIO:
        """Stand in for `urlopen`: bytes, as a context manager."""
        address = request.full_url
        self.asked[address] += 1
        body = self.bodies.get(address)
        if body is None:
            raise urllib.error.HTTPError(address, self.missing, "Missing",
                                         email.message.Message(), None)
        wanted = request.headers.get("Range")
        if wanted:
            self.ranged.append((address, wanted))
            first, last = wanted.removeprefix("bytes=").split("-")
            body = body[int(first):int(last) + 1]
        return io.BytesIO(body)
