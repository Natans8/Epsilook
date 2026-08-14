"""The WDC3 reader, over files built byte by byte.

The client's own tables cannot be committed, so every structural rule is
asserted against a file this module writes. The builder takes raw record bytes
rather than encoding values itself: one that knew how to encode would be
asserting its own encoder, and each rule here was a defect that survived a
reader agreeing with itself.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

import pytest

from pack.sources import wdc3
from pack.sources.wdc3 import ColumnSpec

_HEADER = struct.Struct("<4s9IHH7I")
_SECTION = struct.Struct("<Q8I")
_FIELD_STRUCTURE = struct.Struct("<hH")
_STORAGE_INFO = struct.Struct("<HHII3I")

ID = ColumnSpec(name="ID", is_id=True, in_record=False)
"""The common case: an id the id list supplies rather than the record."""


@dataclass
class Stored:
    """One field's storage description, as the file declares it."""

    offset_bits: int
    size_bits: int
    storage: int = wdc3.NONE
    additional: int = 0
    default: int = 0
    """What a common-storage field reads where the record has no exception."""


@dataclass
class Built:
    """One section's contents, before the offsets that locate them are known."""

    records: bytes
    strings: bytes = b""
    ids: tuple[int, ...] = ()
    copies: tuple[tuple[int, int], ...] = ()
    relations: tuple[tuple[int, int], ...] = ()
    encryption_key: int = 0
    unheld_records: int = 0
    """Records the header counts that this section does not hold, which is what
    displaces a string offset in a table with an unreadable second section."""


@dataclass
class Table:
    """A whole db2, assembled from parts a test states directly."""

    fields: list[Stored]
    sections: list[Built]
    record_size: int
    schema: list[ColumnSpec]
    pallet: bytes = b""
    common: bytes = b""
    has_id_list: bool = True

    def blob(self) -> bytes:
        """The file, with every offset resolved."""
        total = sum(len(s.records) // self.record_size + s.unheld_records
                    for s in self.sections)
        head = (_HEADER.size + _SECTION.size * len(self.sections)
                + _FIELD_STRUCTURE.size * len(self.fields)
                + _STORAGE_INFO.size * len(self.fields)
                + len(self.pallet) + len(self.common))

        bodies: list[bytes] = []
        headers: list[bytes] = []
        at = head
        for section in self.sections:
            body = section.records + section.strings
            body += struct.pack(f"<{len(section.ids)}I", *section.ids)
            for new_id, copied in section.copies:
                body += struct.pack("<II", new_id, copied)
            relations = b""
            if section.relations:
                relations = struct.pack("<3I", len(section.relations), 0, 0)
                for foreign, index in section.relations:
                    relations += struct.pack("<II", foreign, index)
            body += relations
            headers.append(_SECTION.pack(
                section.encryption_key, at,
                len(section.records) // self.record_size, len(section.strings),
                0, len(section.ids) * 4, len(relations), 0, len(section.copies)))
            bodies.append(body)
            at += len(body)

        out = _HEADER.pack(
            b"WDC3", total, len(self.fields), self.record_size,
            sum(len(s.strings) for s in self.sections), 0, 0, 0, 0, 0,
            4 if self.has_id_list else 0, 0, len(self.fields), 0, 0,
            _STORAGE_INFO.size * len(self.fields), len(self.common),
            len(self.pallet), len(self.sections))
        out += b"".join(headers)
        out += b"".join(_FIELD_STRUCTURE.pack(0, 0) for _ in self.fields)
        for stored in self.fields:
            out += _STORAGE_INFO.pack(stored.offset_bits, stored.size_bits,
                                      stored.additional, stored.storage,
                                      stored.default, 0, 0)
        return out + self.pallet + self.common + b"".join(bodies)


def read(table: Table) -> wdc3.Db2:
    """The reader, over a table this module built."""
    return wdc3.Db2(table.blob(), table.schema)


def test_a_pallet_value_masks_to_the_width_the_schema_declares() -> None:
    """A pallet entry is a 32-bit word whose high bytes need not be clean.

    The width of the index that addressed it says nothing about the value, so
    extending over that width turns a one-byte -1 into a large positive number.
    """
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=5, storage=wdc3.PALLET,
                       additional=8)],
        # Two entries whose meaningful byte is the low one.
        pallet=bytes.fromhex("ff3da240") + bytes.fromhex("133da240"),
        sections=[Built(records=bytes([0, 1]), ids=(10, 11))],
        record_size=1,
        schema=[ID, ColumnSpec(name="AttachID", bits=8)])

    assert read(table).columns == ["ID", "AttachID"]
    assert list(read(table).rows()) == [("10", "-1"), ("11", "19")]


def test_a_bitpacked_value_extends_over_its_own_width_when_that_is_narrower() -> None:
    """A bitpacked field holds the value sign-compressed to its own width.

    A 26-bit colour must extend from bit 25; extending it over the schema's 32
    leaves a negative value looking positive.
    """
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=26,
                       storage=wdc3.BITPACKED_SIGNED)],
        sections=[Built(records=struct.pack("<I", 0x3DA640E), ids=(1,))],
        record_size=4,
        schema=[ID, ColumnSpec(name="Colour", bits=32)])

    assert list(read(table).rows()) == [("1", "-2464754")]


def test_a_bitpacked_value_extends_over_the_declared_width_when_that_is_narrower() -> None:
    """The packer may spend more bits than the type has, and then the type
    bounds it: one byte stored in nine reads -1 from bit 7, not 255 from bit 8."""
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=9,
                       storage=wdc3.BITPACKED_SIGNED)],
        sections=[Built(records=struct.pack("<H", 0xFF), ids=(1,))],
        record_size=2,
        schema=[ID, ColumnSpec(name="MissileAttachment", bits=8)])

    assert list(read(table).rows()) == [("1", "-1")]


def test_the_id_column_keeps_the_position_the_schema_gives_it() -> None:
    """The export order is the schema's order, with nothing hoisted.

    Several tables declare the id after their strings, and a reader that always
    writes it first disagrees with the export on every column.
    """
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=32)],
        sections=[Built(records=struct.pack("<I", 0), ids=(42,))],
        record_size=4,
        schema=[ColumnSpec(name="Name_lang", kind="locstring"), ID])

    assert read(table).columns == ["Name_lang", "ID"]
    assert read(table).id_position() == 1


def test_an_id_the_schema_puts_in_the_record_is_decoded_from_it() -> None:
    """No id list means the id is an ordinary field, decoded like any other."""
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=32),
                Stored(offset_bits=32, size_bits=32)],
        sections=[Built(records=struct.pack("<II", 900, 5)
                        + struct.pack("<II", 901, 6))],
        record_size=8,
        has_id_list=False,
        schema=[ColumnSpec(name="FileDataID", is_id=True),
                ColumnSpec(name="Flags")])

    assert read(table).columns == ["FileDataID", "Flags"]
    assert list(read(table).rows()) == [("900", "5"), ("901", "6")]


def test_a_copied_row_carries_its_new_id_in_the_id_column() -> None:
    """A copy is a real exported row reusing another's data.

    Dropping them comes out short; writing the new id in the wrong column comes
    out wrong, which is why the id's declared position decides where it goes.
    """
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=32)],
        sections=[Built(records=struct.pack("<I", 11), ids=(1,),
                        copies=((2, 1),))],
        record_size=4,
        schema=[ColumnSpec(name="Value"), ID])

    assert read(table).columns == ["Value", "ID"]
    assert list(read(table).rows()) == [("11", "1"), ("11", "2")]


def test_a_section_holding_an_encryption_key_is_skipped() -> None:
    """An absent locale still declares records, so the key is what decides."""
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=32)],
        sections=[Built(records=struct.pack("<I", 5), ids=(1,)),
                  Built(records=struct.pack("<I", 6), ids=(2,),
                        encryption_key=0xDEADBEEF)],
        record_size=4,
        schema=[ID, ColumnSpec(name="Value")])

    assert list(read(table).rows()) == [("1", "5")]


def test_a_string_offset_is_measured_from_the_fields_own_position() -> None:
    """The stored value is signed and relative to the field, not to the block."""
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=32)],
        # One record of four bytes, then a block whose first byte is the empty
        # string; the name begins one byte after that.
        sections=[Built(records=struct.pack("<I", 4 + 1),
                        strings=b"\0Parabola\0", ids=(3,))],
        record_size=4,
        schema=[ID, ColumnSpec(name="Name", kind="string")])

    assert list(read(table).rows()) == [("3", "Parabola")]


def test_a_string_offset_counts_records_the_section_does_not_hold() -> None:
    """Offsets are measured against the record area the header declares.

    A table whose second section is unreadable still had its strings placed
    after every record, so the readable section's block begins earlier than the
    offsets assume.
    """
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=32)],
        sections=[Built(records=struct.pack("<I", 4 + 1 + 4),
                        strings=b"\0Parabola\0", ids=(3,), unheld_records=1)],
        record_size=4,
        schema=[ID, ColumnSpec(name="Name", kind="string")])

    assert list(read(table).rows()) == [("3", "Parabola")]


def test_an_array_expands_to_numbered_columns() -> None:
    """`Attributes[3]` exports as `Attributes_0..2`, each element read in turn."""
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=96)],
        sections=[Built(records=struct.pack("<3i", 1, -2, 3), ids=(1,))],
        record_size=12,
        schema=[ID, ColumnSpec(name="Attributes", count=3)])

    assert read(table).columns == ["ID", "Attributes_0", "Attributes_1",
                                   "Attributes_2"]
    assert list(read(table).rows()) == [("1", "1", "-2", "3")]


def test_a_common_field_falls_back_to_its_declared_default() -> None:
    """Common storage lists only the records that differ from the default."""
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=0, storage=wdc3.COMMON,
                       additional=8, default=255)],
        common=struct.pack("<II", 2, 19),
        sections=[Built(records=b"\0\0", ids=(1, 2))],
        record_size=1,
        schema=[ID, ColumnSpec(name="SizeClass", bits=8)])

    assert list(read(table).rows()) == [("1", "-1"), ("2", "19")]


def test_a_relation_outside_the_record_comes_from_the_relationship_map() -> None:
    """A column the schema keeps out of the record is supplied by the map."""
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=32)],
        sections=[Built(records=struct.pack("<I", 5) + struct.pack("<I", 6),
                        ids=(1, 2), relations=((77, 0), (88, 1)))],
        record_size=4,
        schema=[ID, ColumnSpec(name="Value"),
                ColumnSpec(name="SpellID", is_relation=True, in_record=False)])

    assert read(table).columns == ["ID", "Value", "SpellID"]
    assert list(read(table).rows()) == [("1", "5", "77"), ("2", "6", "88")]


def test_an_unsigned_column_is_not_sign_extended() -> None:
    """Signedness is the schema's to state; the packing cannot imply it."""
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=8)],
        sections=[Built(records=b"\xff", ids=(1,))],
        record_size=1,
        schema=[ID, ColumnSpec(name="Flags", bits=8, signed=False)])

    assert list(read(table).rows()) == [("1", "255")]


def test_a_table_read_without_a_schema_names_its_columns_positionally() -> None:
    """Enough to inspect a table whose schema is not to hand."""
    table = Table(
        fields=[Stored(offset_bits=0, size_bits=32)],
        sections=[Built(records=struct.pack("<I", 7))],
        record_size=4,
        schema=[])

    assert wdc3.Db2(table.blob(), None).columns == ["Field_0"]


@pytest.mark.parametrize(("value", "text"), [
    (5.0, "5"),
    (0.0, "0"),
    (0.10000000149011612, "0.10000000149"),
    (3.1415927410125732, "3.14159274101"),
    (-96.00900268554688, "-96.00900268555"),
    (1.5707999467849731, "1.57079994678"),
    (12.300000190734863, "12.30000019073"),
    # Rounding straight to eleven places gives 214.1703338623 here: the
    # fifteen-digit step carries the eleventh place over first. Both signs,
    # because a rule that rounds toward zero passes one and fails the other.
    (214.1703338623046875, "214.17033386231"),
    (109.99756622314453125, "109.99756622315"),
    (-245.2870330810546875, "-245.28703308106"),
    (-113.63899993896484375, "-113.63899993897"),
    (27.169942855834961, "27.16994285584"),
    # Fourteen significant digits reached before eleven places are spent, so
    # ten survive. An exact half goes to the even digit at this step, which is
    # what separates these two.
    (2506.97998046875, "2506.9799804688"),
    (-2525.26806640625, "-2525.2680664062"),
    (1616.858642578125, "1616.8586425781"),
    (1114.2847900390625, "1114.2847900391"),
    # Rounds up to exactly the smallest magnitude still written plainly.
    (9.9999997473787516e-05, "0.0001"),
    (-9.9999999747524271e-07, "-1e-06"),
    (7.9688600301742554e-06, "7.96886e-06"),
    (1e20, "1e+20"),
])
def test_a_float_is_spelled_the_way_the_export_spells_it(value: float,
                                                         text: str) -> None:
    """Fifteen significant digits, then eleven places, then fourteen digits.

    Every pair here was read out of a published table and its published export,
    so a rule that drops one of the three steps fails at least one of them.
    """
    assert wdc3.format_float(value) == text


def test_reading_something_that_is_not_wdc3_fails_loudly() -> None:
    """Nearly every other malformation in this format fails silently."""
    with pytest.raises(ValueError, match="WDC2"):
        wdc3.Db2(b"WDC2" + b"\0" * 100, None)
