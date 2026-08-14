"""Bit arithmetic across columns, and the intersection a flag may declare."""

from __future__ import annotations

from pack.routes.attributes import WORD_BITS, attribute_bit, read_spell_attributes, shipped_attributes


def test_a_bit_is_found_in_the_column_that_holds_it() -> None:
    """Bit `B` lives in column `B // 32` at `1 << (B % 32)`, so a flag past the
    first word is the case worth pinning."""
    words = (0, 1 << 5)
    assert attribute_bit(words, WORD_BITS + 5)
    assert not attribute_bit(words, 5)


def test_a_build_whose_array_is_too_short_reads_the_flag_as_unset() -> None:
    """The build predates the flag, which is an absence rather than an error."""
    assert not attribute_bit((1,), WORD_BITS * 3)


def test_every_shipped_flag_declares_a_handler() -> None:
    """The handler name is what makes a bit ship, and what the pill reads."""
    shipped = shipped_attributes()
    assert shipped
    assert all(meta.get("handler") for meta in shipped.values())


def test_a_spell_is_grouped_under_each_flag_it_carries() -> None:
    bit, meta = min(shipped_attributes().items())
    if meta.get("requires") is not None:
        bit, meta = min((b, m) for b, m in shipped_attributes().items()
                        if m.get("requires") is None)
    column, offset = divmod(bit, WORD_BITS)
    words = tuple([0] * column + [1 << offset])
    grouped = read_spell_attributes({100: words, 200: (0,)})
    assert grouped[str(meta["handler"])] == [100]


def test_a_flag_that_requires_another_is_an_intersection() -> None:
    """The bit alone samples spells the word would be false of, so it counts
    only alongside the bit it declares."""
    required = sorted(bit for bit, meta in shipped_attributes().items()
                      if meta.get("requires") is not None)
    if not required:
        return
    bit = required[0]
    meta = shipped_attributes()[bit]
    other = int(str(meta["requires"]))
    width = max(bit, other) // WORD_BITS + 1

    def words(*bits: int) -> tuple[int, ...]:
        packed = [0] * width
        for one in bits:
            packed[one // WORD_BITS] |= 1 << (one % WORD_BITS)
        return tuple(packed)

    grouped = read_spell_attributes({
        100: words(bit),           # the flag alone, which says nothing
        200: words(bit, other),    # the intersection that does
    })
    assert grouped[str(meta["handler"])] == [200]
