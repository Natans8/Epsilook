"""What the catalogue tool guarantees: the module it writes is the source
roster rendered, and the checked-in copy is that rendering."""

from __future__ import annotations

import pytest

from catalogue import MODULE, generated, rendered


def test_a_table_renders_as_a_class_with_a_column_per_attribute() -> None:
    text = rendered("creature_template", "the dump's", [("entry", False), ("modelid", True)])
    assert text.startswith("class creature_template(Table):")
    assert '    entry = Column("entry")' in text
    assert '    modelid = Column("modelid", array=True)' in text


def test_the_checked_in_catalogue_is_the_roster_rendered() -> None:
    """The same comparison the repository check makes, skipped where the
    definitions are not cached rather than fetched."""
    fresh = generated(fetch=False)
    if fresh is None:
        pytest.skip("table definitions not cached")
    assert MODULE.read_text(encoding="utf-8") == fresh
