"""What the mysqldump scanner must get right, one case per row."""

from __future__ import annotations

import pytest

from .dump import MYSQL_ESCAPES, iter_insert_rows, parse_create_table


def one_value(literal: str) -> str:
    """The single column of a one-row, one-column INSERT holding `literal`."""
    (row,) = iter_insert_rows(f"INSERT INTO `t` VALUES ({literal});")
    return row[0]


@pytest.mark.parametrize(("escape", "character"), sorted(MYSQL_ESCAPES.items()))
def test_every_escape_decodes_to_its_character(escape: str, character: str) -> None:
    assert one_value(f"'a\\{escape}b'") == f"a{character}b"


def test_the_control_escapes_are_characters_not_letters() -> None:
    """The shape that shipped wrong: `\\n` must be a newline, not an `n`.

    Spelled out beside the parametrised sweep because the table can only prove
    the code agrees with itself, and the point of this one is the value.
    """
    assert one_value(r"'Ragnaros\nthe Firelord'") == "Ragnaros\nthe Firelord"
    assert one_value(r"'a\rb\tc\0d\Ze'") == "a\rb\tc\0d\x1ae"


def test_an_unknown_escape_drops_the_backslash() -> None:
    assert one_value(r"'a\qb'") == "aqb"


def test_a_doubled_quote_is_one_quote() -> None:
    assert one_value("'Gnomeregan''s Finest'") == "Gnomeregan's Finest"


def test_a_quoted_value_keeps_its_surrounding_space() -> None:
    assert one_value("'  padded  '") == "  padded  "


def test_an_unquoted_value_is_stripped() -> None:
    assert list(iter_insert_rows("INSERT INTO `t` VALUES ( 1 , 2 );")) == [["1", "2"]]


def test_null_comes_back_as_text() -> None:
    assert one_value("NULL") == "NULL"


def test_an_empty_literal_is_the_empty_string() -> None:
    assert one_value("''") == ""


def test_delimiters_inside_a_literal_do_not_split_the_row() -> None:
    (row,) = iter_insert_rows("INSERT INTO `t` VALUES ('a,b),(c', 7);")
    assert row == ["a,b),(c", "7"]


def test_every_row_of_an_extended_insert_is_yielded() -> None:
    line = "INSERT INTO `t` VALUES (1,'a'),(2,'b'),(3,'c');"
    assert list(iter_insert_rows(line)) == [["1", "a"], ["2", "b"], ["3", "c"]]


def test_a_line_without_values_yields_nothing() -> None:
    assert list(iter_insert_rows("CREATE TABLE `t` (`id` int(10) unsigned NOT NULL);")) == []


@pytest.mark.parametrize("line", [
    "INSERT INTO `t` VALUES ('ends on a backslash\\",
    "INSERT INTO `t` VALUES ('unterminated",
    "INSERT INTO `t` VALUES (1,2",
])
def test_a_truncated_row_is_an_error(line: str) -> None:
    """Loudly, because a silently short row is the failure worth crashing over."""
    with pytest.raises(ValueError):
        list(iter_insert_rows(line))


def test_the_schema_is_the_column_order_an_insert_relies_on() -> None:
    """An INSERT names no columns, so a misread schema misaligns every row."""
    statement = """CREATE TABLE `creature_template` (
      `entry` int(10) unsigned NOT NULL DEFAULT 0,
      `name` char(100) NOT NULL DEFAULT '',
      `modelid1` int(10) unsigned NOT NULL DEFAULT 0,
      PRIMARY KEY (`entry`),
      KEY `idx_name` (`name`)
    ) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4;"""
    assert parse_create_table(statement) == ["entry", "name", "modelid1"]


def test_a_generated_column_is_still_a_column() -> None:
    statement = ("CREATE TABLE `t` (`a` int NOT NULL, "
                 "`b` int GENERATED ALWAYS AS (`a` + 1) STORED, `c` varchar(8));")
    assert parse_create_table(statement) == ["a", "b", "c"]
