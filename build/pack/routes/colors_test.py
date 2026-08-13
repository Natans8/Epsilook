"""The hue word is a search term, so what it names is a product decision."""

from __future__ import annotations

import pytest

from .colors import hue_word, hue_words, pack_rgb, to_channel, unpack_rgb


@pytest.mark.parametrize(("channels", "word"), [
    ((255, 0, 0), "red"),
    ((255, 128, 0), "orange"),
    ((255, 255, 0), "yellow"),
    ((0, 255, 0), "green"),
    ((0, 255, 255), "cyan"),
    ((0, 0, 255), "blue"),
    ((160, 0, 255), "purple"),
    ((255, 0, 160), "pink"),
])
def test_every_bucket_is_reachable(channels: tuple[int, int, int], word: str) -> None:
    assert hue_word(*channels) == word


def test_the_hue_circle_wraps_back_to_red() -> None:
    """Red is the only word on both ends, so a magenta-red must not fall off."""
    assert hue_word(255, 0, 40) == "red"


@pytest.mark.parametrize("channels", [(255, 255, 255), (128, 128, 128), (0, 0, 0),
                                      (10, 10, 12)])
def test_a_colourless_tint_names_nothing(channels: tuple[int, int, int]) -> None:
    """White, grey and near-black are the absence of a colour, and forcing them
    into the nearest bucket would make `fx:blue` match untinted content."""
    assert hue_word(*channels) == ""


def test_a_packed_colour_round_trips() -> None:
    assert unpack_rgb(pack_rgb(18, 52, 86)) == (18, 52, 86)


def test_several_colours_give_each_word_once_in_order() -> None:
    """A shadowy row carries two colours and a searcher looking for either
    should find it -- but a repeated word helps nobody."""
    assert hue_words((pack_rgb(255, 0, 0), pack_rgb(0, 0, 255),
                      pack_rgb(200, 0, 0))) == "red blue"


def test_a_sentinel_colour_contributes_no_word() -> None:
    assert hue_words((-1, pack_rgb(0, 255, 0))) == "green"


@pytest.mark.parametrize(("text", "byte"), [("0", 0), ("1", 255), ("0.5", 128),
                                            ("", 0), ("2", 255), ("-1", 0)])
def test_a_channel_clamps_into_a_byte(text: str, byte: int) -> None:
    assert to_channel(text) == byte
