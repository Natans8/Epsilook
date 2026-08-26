"""The icon table: deduping, and the two places case is folded."""

from __future__ import annotations

from pack.derive.icons import NO_ICON, build_icon_index

FROST = "Interface/Icons/Spell_Frost_FrostBolt02.blp"
FIRE = "Interface/Icons/Spell_Fire_FlameBolt.blp"


def test_a_spell_points_at_its_icons_place_in_the_table() -> None:
    index = build_icon_index([100], {100: 500}, {500: FROST})
    assert index.names == ["spell_frost_frostbolt02"]
    assert index.fids == [500]
    assert index.spells == [1]


def test_the_name_is_lowercased_because_it_is_a_url_key() -> None:
    """Unlike the paths it comes from, which keep their own casing: this one is
    what the icon service is asked for, not something a reader reads."""
    index = build_icon_index([100], {100: 500}, {500: FROST})
    assert index.names == ["spell_frost_frostbolt02"]


def test_the_directory_test_folds_case_rather_than_assuming_one() -> None:
    """The listfile is taken with its own casing, so an icon whose path shouts
    must still be recognised as an icon."""
    index = build_icon_index([100], {100: 500}, {500: "INTERFACE/ICONS/SPELL_HOLY_HEAL.BLP"})
    assert index.names == ["spell_holy_heal"]


def test_two_spells_sharing_an_icon_share_its_entry() -> None:
    index = build_icon_index([100, 200], {100: 500, 200: 500}, {500: FROST})
    assert index.names == ["spell_frost_frostbolt02"]
    assert index.spells == [1, 1]


def test_the_first_file_id_to_claim_a_name_keeps_it() -> None:
    """The same name resolves through several ids across builds, and two ids in
    one build can share a base name from different folders. The picture is the
    same either way."""
    index = build_icon_index(
        [100, 200], {100: 500, 200: 600}, {500: FROST, 600: "Interface/Icons/other/Spell_Frost_FrostBolt02.blp"}
    )
    assert index.names == ["spell_frost_frostbolt02"]
    assert index.fids == [500]
    assert index.spells == [1, 1]


def test_a_spell_with_no_icon_indexes_nothing() -> None:
    """Which is why the table is 1-based: zero has to mean no icon."""
    index = build_icon_index([100, 200], {200: 500}, {500: FROST})
    assert index.spells == [NO_ICON, 1]


def test_an_icon_outside_the_icon_directory_is_not_one() -> None:
    """A file id can name a model or a texture; only the icon folder serves an
    icon, and pointing the icon service at anything else yields nothing."""
    index = build_icon_index([100], {100: 500}, {500: "Spells/Fire_Missile.m2"})
    assert index.spells == [NO_ICON]
    assert index.names == []


def test_an_icon_whose_file_id_the_listfile_cannot_name_is_dropped() -> None:
    index = build_icon_index([100], {100: 500}, {})
    assert index.spells == [NO_ICON]


def test_the_spell_order_given_is_the_order_returned() -> None:
    """The indices are positional, so the caller's order is the contract."""
    index = build_icon_index([200, 100], {100: 500, 200: 600}, {500: FROST, 600: FIRE})
    assert index.names == ["spell_fire_flamebolt", "spell_frost_frostbolt02"]
    assert index.spells == [1, 2]
