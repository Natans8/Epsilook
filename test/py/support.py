"""Types the test modules share with the fixtures in `conftest.py`.

A fixture reaches a test through pytest and needs no import; its type does not,
and importing a name out of `conftest` is not something pytest supports. So the
shared type lives here, where both sides can name it.
"""

from __future__ import annotations

from collections.abc import Callable

from pack.tables import CsvTables

BuildTables = Callable[..., CsvTables]
"""The `tables` fixture: keyword arguments naming tables, a provider back."""
