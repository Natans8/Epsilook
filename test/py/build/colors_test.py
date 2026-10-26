"""A colour reaches the pack as one packed integer, its channels clamped into bytes."""

import pytest

from pack.routes.colors import pack_rgb, to_channel


def test_channels_pack_red_first() -> None:
    assert pack_rgb(0x12, 0x34, 0x56) == 0x123456


@pytest.mark.parametrize(("text", "byte"), [("0", 0), ("1", 255), ("0.5", 128), ("", 0), ("2", 255), ("-1", 0)])
def test_a_channel_clamps_into_a_byte(text: str, byte: int) -> None:
    assert to_channel(text) == byte
