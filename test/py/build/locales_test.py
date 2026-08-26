"""Reading one build in another language: the roster, the sources, the merge.

Built from plain values wherever it can be. What a language IS to the code is a
declaration and two compositions of the provider seam, so none of this needs a
source stood up.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from pack.derive import CONTEXT_FIELDS, DEFAULT_LOCALE, LOCALES, SPOKEN_FIELDS, DeriveContext, Spoken
from pack.derive.locales import locale_of, locales_named
from pack.derive.spelltext import ENGLISH
from pack.model import SECTIONS
from pack.routes import (
    AreaGates,
    CreatureModels,
    GameObjectData,
    ItemModels,
    MountData,
    ShapeshiftForms,
    SpellNames,
    SpellText,
)
from pack.sources.tdb import LOCALE_COLUMN, TDB_LOCALE_TABLES
from pack.supplements import spoken
from pack.tables.csv_tables import CsvTables
from pack.tables.locales import check_translation_declaration, locale_overlays, translated_exports
from pack.tables.overlay import OverlaidTables

BASE = """\
ID,Name_lang,Rank
10,Fireball,3
11,Frostbolt,2
"""

TRANSLATED = """\
ID,Name_lang,Rank
10,Огненный шар,3
11,,2
"""

CREATURES = """\
entry,name,modelid1
1,Wolf,17
2,Bear,18
"""

CREATURE_NAMES = """\
entry,locale,Name
1,ruRU,Волк
1,deDE,Wolf
2,ruRU,
3,ruRU,Кабан
"""


@pytest.fixture(name="build")
def _build(tmp_path: Path) -> Path:
    """A build's own tables, as acquisition would leave them."""
    directory = tmp_path / "9.2.7.45745"
    directory.mkdir()
    (directory / "SpellName.csv").write_text(BASE, encoding="utf-8")
    (directory / "creature_template.csv").write_text(CREATURES, encoding="utf-8")
    return directory


@pytest.fixture(name="translated")
def _translated(build: Path) -> Path:
    """The same build's translated tables, in their own directory."""
    directory = build / "locale-ruRU"
    directory.mkdir()
    (directory / "SpellName.csv").write_text(TRANSLATED, encoding="utf-8")
    return directory


# The roster: what a language IS to the code.


def test_the_default_language_is_one_the_packs_are_built_in() -> None:
    """Every reader falls back to it without checking, so a default nothing
    ships would send them all down the fallback and report English as the
    answer to a question about another language.
    """
    assert DEFAULT_LOCALE in {locale.code for locale in LOCALES}


def test_a_language_the_roster_does_not_declare_is_refused() -> None:
    """Defaulting instead would ship English under that language's name."""
    assert locale_of(DEFAULT_LOCALE).text is ENGLISH
    with pytest.raises(KeyError, match="zzZZ"):
        locale_of("zzZZ")


def test_a_client_that_publishes_fewer_languages_names_the_ones_it_has() -> None:
    """Not every client publishes every language, and which it has is a fact
    about the client rather than something to probe for.
    """
    assert locales_named(()) == LOCALES
    assert [locale.code for locale in locales_named(("enUS",))] == [DEFAULT_LOCALE]
    assert [locale.code for locale in locales_named(("ruRU",))] == [DEFAULT_LOCALE, "ruRU"]


def test_the_default_language_is_built_whether_or_not_it_was_asked_for() -> None:
    """Every pack ships it, which is what lets a reader fall back to it without
    checking first.
    """
    assert DEFAULT_LOCALE in {locale.code for locale in locales_named(("frFR",))}


def test_every_declared_language_words_a_duration_in_its_own_language() -> None:
    """The unit is written into the cooked sentence, not formatted by a reader,
    so a language that inherited another's would put an English word in the
    middle of its own prose.
    """
    spoken_units = {locale.code: locale.text.seconds for locale in LOCALES}
    assert len(set(spoken_units.values())) > 1
    for code, seconds in spoken_units.items():
        assert seconds and all(word for word in seconds), code


def test_every_field_a_language_replaces_is_one_the_context_holds() -> None:
    """`Spoken` is the slice of the context a locale pass rebuilds, so a field
    on it the context does not have could never be spliced back in.
    """
    assert SPOKEN_FIELDS
    assert not SPOKEN_FIELDS - CONTEXT_FIELDS


COOKED_FROM = {"templates"}
"""The spoken fields no section reads, because something else reads them.

The raw templates are the cooker's input and `prose` is its output, so they are
read again per language without being shipped in one.
"""


def test_every_field_a_language_replaces_is_read_by_some_section() -> None:
    """A field rebuilt per language that nothing reads is a second read of the
    sources for nothing.
    """
    read = {field for section in SECTIONS if section.localizable for field in section.reads}
    assert not SPOKEN_FIELDS - read - COOKED_FROM


def test_a_build_read_in_another_language_keeps_everything_else() -> None:
    """The ids, the graph walk and the listfile resolution are the build's own,
    read once -- which is what lets the two halves of a split section be joined
    by position.
    """
    context = DeriveContext(build=None, spell_ids=[1, 2, 3])  # type: ignore[arg-type]
    said = Spoken(
        names=SpellNames(names={1: "Огненный шар"}),
        alt_names={},
        templates=SpellText(),
        creatures=CreatureModels(),
        items=ItemModels(),
        mounts=MountData(),
        objects=GameObjectData(),
        forms=ShapeshiftForms(),
        areas=AreaGates(),
        prose=context.prose,
    )
    russian = context.spoken_in(said)
    assert russian.spell_ids == [1, 2, 3]
    assert russian.names.names == {1: "Огненный шар"}
    assert context.names.names == {}


# The admission: which rows one language claims out of a table holding all of them.


def test_a_language_admits_only_rows_written_in_it() -> None:
    """The server's tables hold every language at once, so reading one is
    refusing the rest.
    """
    admits = spoken("ruRU")
    assert admits("ruRU")
    assert not admits("deDE")
    assert not admits("")
    assert not admits("ruru")


def test_an_unnamed_language_is_refused_rather_than_matching_nothing() -> None:
    """A rule admitting nothing and one admitting everything are a typo apart,
    and the second unions ten languages into one table.
    """
    with pytest.raises(ValueError, match="no language named"):
        locale_overlays("")


def test_the_two_declarations_of_the_translation_overlay_agree() -> None:
    """Only the overlay map knows the world table's spelling of a column and
    only the distiller's roster knows what was written out, so they are
    compared against each other.
    """
    assert check_translation_declaration() == []
    assert all(overlay.judged_on == LOCALE_COLUMN for overlay in locale_overlays("ruRU").values())
    assert set(locale_overlays("ruRU")) == {"creature_template", "gameobject_template"}
    assert not {overlay.table for overlay in locale_overlays("ruRU").values()} - set(TDB_LOCALE_TABLES["world"])


# The compositions: a second export restating a table, and a keyed translation
# revising one. Both go through the merge that already served the hotfixes.


def restated(build: Path, translated: Path, *tables: str) -> OverlaidTables:
    """The build's tables with a second export restating the named ones."""
    return OverlaidTables(base=CsvTables(build), overlays=translated_exports(tables), source=CsvTables(translated))


def test_a_translated_table_stands_in_for_the_build_s_own(build: Path, translated: Path) -> None:
    """A reader asks for a table and never learns which of the two answered.

    A row nobody has translated comes back empty, and the untranslated name is
    what ships: losing it would lose the spell, not merely its translation.
    """
    tables = restated(build, translated, "SpellName")
    assert list(tables.rows("SpellName", ["ID", "Name_lang"])) == [("10", "Огненный шар"), ("11", "Frostbolt")]


def test_a_column_the_language_never_touches_is_the_build_s(build: Path, translated: Path) -> None:
    """Both exports carry it and both agree, so the fallback is what keeps a
    column outside the language from depending on which of the two answered.
    """
    tables = restated(build, translated, "SpellName")
    assert list(tables.rows("SpellName", ["ID", "Rank"])) == [("10", "3"), ("11", "2")]


def test_the_build_decides_which_rows_the_table_has(build: Path, translated: Path) -> None:
    """The two exports do not agree on that -- a string can exist in one
    language and not in another -- and adding to the row set here would make one
    section a different length in two languages.
    """
    (translated / "SpellName.csv").write_text(TRANSLATED + "12,Дуга,1\n", encoding="utf-8")
    tables = restated(build, translated, "SpellName")
    assert [row[0] for row in tables.rows("SpellName", ["ID", "Name_lang"])] == ["10", "11"]


def test_a_row_the_translation_has_never_seen_comes_back_as_the_build_has_it(build: Path, translated: Path) -> None:
    """Not row-aligned, so the join is what carries it: a row missing from the
    middle of one export must not shift every row after it.
    """
    (translated / "SpellName.csv").write_text("ID,Name_lang,Rank\n11,Ледяная стрела,2\n", encoding="utf-8")
    tables = restated(build, translated, "SpellName")
    assert list(tables.rows("SpellName", ["ID", "Name_lang"])) == [("10", "Fireball"), ("11", "Ледяная стрела")]


def test_a_column_the_caller_did_not_ask_the_key_for_still_joins(build: Path, translated: Path) -> None:
    """The key is read whether or not it was asked for, and dropped again, so a
    route reading one column gets the same answer as one reading two.
    """
    tables = restated(build, translated, "SpellName")
    assert list(tables.rows("SpellName", ["Name_lang"])) == [("Огненный шар",), ("Frostbolt",)]


def test_a_table_the_substitute_does_not_cover_comes_from_the_build(build: Path, translated: Path) -> None:
    """Which tables it may answer for is named rather than taken from whatever
    it happens to hold: a stray file would otherwise replace a table nobody
    meant to substitute.
    """
    tables = restated(build, translated)
    assert list(tables.rows("SpellName", ["ID", "Name_lang"])) == [("10", "Fireball"), ("11", "Frostbolt")]
    assert tables.header("SpellName") == ["ID", "Name_lang", "Rank"]


def test_a_substitution_cannot_introduce_a_table_the_build_lacks(build: Path, translated: Path) -> None:
    """What tables a build has is a fact about that build, and a source
    standing in for one of them does not change it.
    """
    (translated / "Mount.csv").write_text("ID,Name_lang\n1,Скакун\n", encoding="utf-8")
    tables = restated(build, translated, "Mount")
    assert not tables.available("Mount")


def test_a_translated_name_revises_the_server_s_own(build: Path) -> None:
    """The creature and object names are the server's alone, so the language
    they are read in is the server's too.

    A translation RESTATES the base's rows, which decides two things here: a
    row it leaves blank keeps the untranslated name, and a row the base does
    not have is not one to add. The server's translation tables really do carry
    entries its world tables do not.
    """
    (build / "creature_template_locale.csv").write_text(CREATURE_NAMES, encoding="utf-8")
    world = CsvTables(build)
    tables = OverlaidTables(base=world, overlays=locale_overlays("ruRU"), source=world)
    assert list(tables.rows("creature_template", ["entry", "name"])) == [
        ("1", "Волк"),
        # Its ruRU row carries no name, so the untranslated one stands rather
        # than the row being blanked.
        ("2", "Bear"),
    ]


def test_a_patch_still_adds_the_rows_it_carries(build: Path) -> None:
    """The other half of the same field: a hotfix row the client has not is a
    row the server is adding, and that must keep working.
    """
    (build / "creature_template_locale.csv").write_text(CREATURE_NAMES, encoding="utf-8")
    world = CsvTables(build)
    patching = {"creature_template": replace(locale_overlays("ruRU")["creature_template"], restates=False)}
    tables = OverlaidTables(base=world, overlays=patching, source=world)
    assert [row[0] for row in tables.rows("creature_template", ["entry", "name"])] == ["1", "2", "3"]


def test_another_language_s_rows_are_refused(build: Path) -> None:
    (build / "creature_template_locale.csv").write_text(CREATURE_NAMES, encoding="utf-8")
    world = CsvTables(build)
    tables = OverlaidTables(base=world, overlays=locale_overlays("frFR"), source=world)
    assert list(tables.rows("creature_template", ["entry", "name"])) == [("1", "Wolf"), ("2", "Bear")]


def test_a_release_with_no_translations_leaves_every_name_alone(build: Path) -> None:
    """A world dump may predate the `*_locale` tables, and the names then stay
    in the language the dump's own tables are written in.
    """
    world = CsvTables(build, absent_tables={"creature_template_locale": "no dump"})
    tables = OverlaidTables(base=world, overlays=locale_overlays("ruRU"), source=world)
    assert list(tables.rows("creature_template", ["entry", "name"])) == [("1", "Wolf"), ("2", "Bear")]
