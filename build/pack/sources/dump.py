"""Reading a mysqldump SQL file.

TrinityCore publishes its world and hotfix databases as mysqldump output, and
the build wants a few columns of a few tables out of roughly 700 MB of SQL.
No maintained library reads a dump file: the MySQL parsers on offer either
handle DDL only, attach to a live server, or produce dumps rather than consume
them. So the scanner lives here, and the escape table it decodes through is
written out in full. The tempting shortcut -- treat a backslash as "take the
next character literally" -- is right for ``\\\\`` and ``\\'`` and silently
wrong for every control escape, which is how a newline becomes the letter n.
"""

from __future__ import annotations

from collections.abc import Iterator

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
    # The wildcards keep their backslash: inside a string literal MySQL leaves
    # these two alone so the sequence survives to whatever pattern match reads
    # it. Every other unknown escape drops the backslash instead.
    "%": "\\%",
    "_": "\\_",
}
"""The character following a backslash, mapped to what it stands for.

The full set the MySQL parser accepts, not just the set ``mysqldump`` is known
to emit: a dump written by any other tool reaches the same scanner.
"""


def parse_create_table(statement: str) -> list[str]:
    """The column names of a ``CREATE TABLE`` statement, in declaration order.

    Order is the whole point: an ``INSERT`` names no columns, so a row's values
    are positional and the schema is the only thing that says which value is
    which. Keys, indexes and constraints are not columns and do not appear.

    Parsed rather than pattern-matched. The DDL in a dump is kilobytes against
    hundreds of megabytes of rows, so a real parser costs nothing here and
    removes a whole class of quiet mistake on an unusual column type.
    """
    parsed = sqlglot.parse_one(statement, dialect="mysql")
    return [column.name for column in parsed.find_all(expressions.ColumnDef)]


def iter_insert_rows(line: str) -> Iterator[list[str]]:
    r"""Yield one list of column values per row of an ``INSERT ... VALUES`` line.

    Values come back as text. A quoted value keeps its characters exactly,
    including the leading and trailing spaces a name may legitimately carry;
    an unquoted token -- a number, ``NULL`` -- is stripped of the whitespace
    the dump may have put around it. ``NULL`` is therefore indistinguishable
    from the four-character string, which is what a text-in-text-out reader
    can offer and what the table provider contract pins.

    Reading a statement at a time costs nothing: ``mysqldump`` caps a statement
    at ``--net-buffer-length``, so a dump is thousands of medium lines rather
    than one enormous one.

    A line with no ``VALUES`` yields nothing, so the caller can hand every line
    of a dump to this without filtering first.

    Raises ``ValueError`` when a string literal is left open at end of line.
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
