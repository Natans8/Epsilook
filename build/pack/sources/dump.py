"""Reading a mysqldump SQL file.

No maintained library consumes a dump file, so the scanner lives here. Its
escape table is written out in full: treating a backslash as "take the next
character literally" is silently wrong for every control escape.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import sqlglot
from sqlglot import expressions

MYSQL_ESCAPES = {
    "0": "\0",
    "'": "'",
    '"': '"',
    "b": "\b",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "Z": "\x1a",
    "\\": "\\",
    # The wildcards keep their backslash so the sequence survives to whatever
    # pattern match reads it. Every other unknown escape drops it.
    "%": "\\%",
    "_": "\\_",
}
"""The character following a backslash, mapped to what it stands for.

The full set the MySQL parser accepts, not only what ``mysqldump`` emits.
"""


LOSSY_TYPES = frozenset({"FLOAT"})
"""Column types a dump prints with fewer digits than the column holds.

MySQL renders a ``FLOAT`` at six significant digits and a ``DOUBLE`` at full
precision, so only the first arrives rounded.
"""


@dataclass(frozen=True)
class Column:
    """One column of a dumped table: its name, and the type it was declared."""

    name: str

    kind: str
    """The SQL type, as the dialect spells it -- ``INT``, ``FLOAT``, ``VARCHAR``."""

    @property
    def lossy(self) -> bool:
        """Whether a dump prints this column with fewer digits than it holds."""
        return self.kind in LOSSY_TYPES


def parse_create_table(statement: str) -> list[Column]:
    """Parse a ``CREATE TABLE`` statement into its columns.

    They come back in declaration order, which an ``INSERT`` relies on: it names
    no columns, so a row's values are positional. Keys, indexes and constraints
    do not appear.
    """
    parsed = sqlglot.parse_one(statement, dialect="mysql")
    # `.this.name` is the enum member's own name. Formatting the member and
    # stripping its class prefix would leave every kind unrecognised after an
    # upstream rename, and `lossy` false with it.
    return [Column(column.name, column.kind.this.name if column.kind else "")
            for column in parsed.find_all(expressions.ColumnDef)]


def iter_insert_rows(line: str) -> Iterator[list[str]]:
    r"""Yield one list of column values per row of an ``INSERT ... VALUES`` line.

    Values come back as text: a quoted value keeps its characters exactly, an
    unquoted token is stripped of surrounding whitespace, and ``NULL`` is
    indistinguishable from the four-character string. A line with no ``VALUES``
    yields nothing.

    Raises:
        ValueError: a string literal or a row is left open at end of line.
    """
    start = line.find("VALUES")
    if start < 0:
        return
    i, n = start + len("VALUES"), len(line)
    while i < n:
        while i < n and line[i] != "(":
            i += 1
        if i >= n:
            return
        i += 1
        row: list[str] = []
        value: list[str] = []
        quoted = in_string = False
        while i < n:
            char = line[i]
            if in_string:
                if char == "\\":
                    escaped = line[i + 1 : i + 2]
                    if not escaped:
                        raise ValueError("INSERT ends inside a string literal")
                    value.append(MYSQL_ESCAPES.get(escaped, escaped))
                    i += 2
                elif char != "'":
                    value.append(char)
                    i += 1
                elif line[i + 1 : i + 2] == "'":
                    value.append("'")  # a doubled quote, not the terminator
                    i += 2
                else:
                    in_string = False
                    i += 1
                continue
            if char == "'":
                quoted = in_string = True
                i += 1
            elif char in ",)":
                row.append("".join(value) if quoted else "".join(value).strip())
                value, quoted = [], False
                i += 1
                if char == ")":
                    yield row
                    break
            else:
                value.append(char)
                i += 1
        else:
            raise ValueError("INSERT ends inside a row")
