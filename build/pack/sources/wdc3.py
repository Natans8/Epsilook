"""A WDC3 reader presenting a client table the way the CSV export presents it.

Format reference: https://wowdev.wiki/DB2. The reader exists because no Python
library reads WDC3; the one complete licensed implementation is a C# tool,
which is something a build can run but not import.

The file says how its values are packed and nothing about what they mean, so a
schema has to be supplied alongside it. What the reader needs is a column's
name, width, signedness and cardinality -- not a `.dbd`, which is one way of
writing those down. Keeping the parser for that format out of here is what lets
this module be tested without one.

Three properties of the format fail silently rather than loudly:

  * A section is skipped on its encryption key and file bounds, never on its
    record count. A locale the build does not carry still declares records
    while pointing past the end of the file.
  * An id list is present exactly when the schema marks the id column as
    stored outside the record; otherwise the id is an ordinary field.
  * A string offset is measured from the field's own byte position, against
    the record area the whole file declares rather than the section's.

The exported column order is the schema's order, with arrays expanded to
``Name_0..Name_n``. Nothing is hoisted or reordered: a table whose id column
sits fourth exports it fourth.
"""

from __future__ import annotations

import math
import struct
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Context, Decimal

NONE, BITPACKED, COMMON, PALLET, PALLET_ARRAY, BITPACKED_SIGNED = range(6)

_HEADER = struct.Struct("<4s9IHH7I")
"""Magic then seventeen words. One word too many puts the section headers four
bytes late, every section then reads a non-zero encryption key and is skipped,
and the table parses to zero records without raising."""

_SECTION = struct.Struct("<Q8I")
_FIELD_STRUCTURE = struct.Struct("<hH")
_STORAGE_INFO = struct.Struct("<HHII3I")

_SIGNIFICANT = Context(prec=14, rounding=ROUND_HALF_EVEN)
"""The significant digits the CSV export holds a rounded float to."""


@dataclass(frozen=True)
class ColumnSpec:
    """What one exported column means, independent of how it is packed.

    Attributes:
        name: the column's name, before an array's elements are numbered.
        kind: one of `int`, `float`, `string`, `locstring`.
        bits: the declared width. Bounds the value's meaningful part, which is
            not always what the packing spends on it.
        signed: whether the value carries a sign.
        count: an array's cardinality; 1 for a plain column.
        is_id: whether this column is the table's id.
        is_relation: whether it is the foreign key to the parent table.
        in_record: whether the record itself carries it. False for a column
            the id list or the relationship map supplies.
    """

    name: str
    kind: str = "int"
    bits: int = 32
    signed: bool = True
    count: int = 1
    is_id: bool = False
    is_relation: bool = False
    in_record: bool = True

    def spellings(self) -> list[str]:
        """The CSV header names: one, or `Name_0..Name_n` for an array."""
        if self.count <= 1:
            return [self.name]
        return [f"{self.name}_{i}" for i in range(self.count)]


@dataclass(frozen=True)
class Section:
    """One data section: usually one locale, sometimes an encrypted block."""

    encryption_key: int
    file_offset: int
    record_count: int
    string_table_size: int
    offset_records_end: int
    id_list_size: int
    relationship_data_size: int
    offset_map_id_count: int
    copy_table_count: int

    def readable(self, size: int) -> bool:
        """Whether this section's bytes are present and unencrypted.

        The record count is not the test: an absent locale declares records
        while carrying a non-zero encryption key and an offset past end of
        file.
        """
        return (self.encryption_key == 0
                and self.record_count > 0
                and 0 < self.file_offset < size)


@dataclass(frozen=True)
class Field:
    """One record field's storage description, as the file declares it."""

    index: int
    offset_bits: int
    size_bits: int
    storage: int
    default: int
    pallet_at: int
    common_at: int
    additional_size: int


@dataclass(frozen=True)
class Column:
    """One exported column joined to the field that stores it."""

    spec: ColumnSpec
    field: Field | None


def read_bits(data: bytes, offset_bits: int, size_bits: int) -> int:
    """A little-endian bitfield of `size_bits` starting `offset_bits` into data.

    Read against the whole section rather than a record-sized slice: a field
    ending at the record boundary needs a byte of alignment slack, and a slice
    would return a short read instead, dropping the value's high bits.
    """
    if not size_bits:
        return 0
    start = offset_bits >> 3
    shift = offset_bits & 7
    length = (size_bits + shift + 7) >> 3
    raw = int.from_bytes(data[start:start + length], "little")
    return (raw >> shift) & ((1 << size_bits) - 1)


def sign_extend(value: int, bits: int) -> int:
    """Two's complement over an arbitrary width."""
    if bits and value & (1 << (bits - 1)):
        return value - (1 << bits)
    return value


def format_float(value: float) -> str:
    """A float32 spelled the way the CSV export spells it.

    The float32 is widened, rounded to eleven decimal places, and then held to
    fourteen significant digits. Both limits show in the output and neither
    implies the other: `-96.00900268554688` keeps all eleven places at thirteen
    digits, while `1616.858642578125` reaches fourteen digits first and comes
    out `1616.8586425781` with ten. The two steps break a tie differently and
    both spellings are needed to match the export: an exact half goes away
    from zero when places are dropped, and to an even digit when significant
    figures are. Trailing zeros are stripped and a whole number loses its
    fractional part.

    Whether the result is written in exponent form is decided after rounding
    rather than before: `0.0001` is what a float32 slightly under it rounds to
    and is written plainly, where `-1e-06` is not. Magnitudes past what eleven
    places can describe are written at full precision instead, which is the one
    place more than fourteen digits appear.
    """
    if not math.isfinite(value):
        return str(value)
    if abs(value) >= 1e15:
        return repr(value)
    if value == int(value):
        return str(int(value))

    rounded = _SIGNIFICANT.plus(
        Decimal(value).quantize(Decimal("1e-11"), rounding=ROUND_HALF_UP))
    if not rounded:
        return "0"
    if abs(rounded) >= Decimal("1e-4"):
        return f"{rounded:f}".rstrip("0").rstrip(".")

    sign, digits, exponent = rounded.normalize().as_tuple()
    power = int(exponent) + len(digits) - 1
    mantissa = str(digits[0])
    if len(digits) > 1:
        mantissa += "." + "".join(str(digit) for digit in digits[1:])
    return (f"{'-' if sign else ''}{mantissa}"
            f"e{'-' if power < 0 else '+'}{abs(power):02d}")


class Db2:
    """One WDC3 file, read against the schema that names its columns."""

    def __init__(self, blob: bytes, schema: Sequence[ColumnSpec] | None) -> None:
        """Parse the file's structure. Values are decoded when rows are read.

        Args:
            blob: the whole decompressed file.
            schema: the exported columns, in order. None names them
                positionally, which is enough to inspect a table whose schema
                is not to hand.

        Raises:
            ValueError: the bytes are not a WDC3 file.
        """
        if blob[:4] != b"WDC3":
            raise ValueError(f"not WDC3: {blob[:4]!r}")
        self.blob = blob
        (_magic, self.record_count, self.field_count, self.record_size,
         self.string_table_size, self.table_hash, self.layout_hash,
         self.min_id, self.max_id, self.locale, self.flags, self.id_index,
         self.total_field_count, self.bitpacked_data_offset,
         self.lookup_column_count, self.field_storage_info_size,
         self.common_data_size, self.pallet_data_size,
         self.section_count) = _HEADER.unpack_from(blob, 0)

        at = _HEADER.size
        self.sections = [Section(*_SECTION.unpack_from(blob, at + i * _SECTION.size))
                         for i in range(self.section_count)]
        at += self.section_count * _SECTION.size

        # The field structure array carries a declared width that a packed
        # field does not honour, so nothing here reads it; the storage info
        # that follows is what decoding uses.
        at += self.field_count * _FIELD_STRUCTURE.size
        storage = [_STORAGE_INFO.unpack_from(blob, at + i * _STORAGE_INFO.size)
                   for i in range(self.field_storage_info_size // _STORAGE_INFO.size)]
        at += self.field_storage_info_size

        self.pallet_data = blob[at:at + self.pallet_data_size]
        at += self.pallet_data_size
        self.common_data = blob[at:at + self.common_data_size]

        self.fields = self._fields(storage)
        self.declared = self._join(schema)
        self._commons = {c.field.index: self._common_map(c.field)
                         for c in self.declared
                         if c.field is not None and c.field.storage == COMMON}

    def _fields(self, storage: Sequence[tuple[int, ...]]) -> list[Field]:
        """The record's fields, with each pallet and common block located.

        Both blocks are laid out in field order, so their offsets accumulate in
        one pass over the fields that use them.
        """
        fields: list[Field] = []
        pallet_at = common_at = 0
        for index, entry in enumerate(storage):
            offset_bits, size_bits, additional, kind = entry[:4]
            fields.append(Field(index=index, offset_bits=offset_bits,
                                size_bits=size_bits, storage=kind,
                                default=entry[4], pallet_at=pallet_at,
                                common_at=common_at, additional_size=additional))
            if kind in (PALLET, PALLET_ARRAY):
                pallet_at += additional
            elif kind == COMMON:
                common_at += additional
        return fields

    def _join(self, schema: Sequence[ColumnSpec] | None) -> list[Column]:
        """Pair each declared column with the field that stores it.

        Only the columns the record carries consume fields, and they do so in
        order. That is what keeps a table whose id lives in the id list aligned
        with one whose id is an ordinary field.
        """
        if schema is None:
            return [Column(ColumnSpec(name=f"Field_{f.index}"), f)
                    for f in self.fields]
        columns: list[Column] = []
        position = 0
        for spec in schema:
            field = None
            if spec.in_record:
                field = self.fields[position] if position < len(self.fields) else None
                position += 1
            columns.append(Column(spec, field))
        return columns

    @property
    def columns(self) -> list[str]:
        """The CSV header: the schema's order, arrays expanded."""
        return [name for column in self.declared
                for name in column.spec.spellings()]

    def _common_map(self, field: Field) -> dict[int, int]:
        """A common-data field's exceptions to its default, keyed by record id."""
        block = self.common_data[field.common_at:
                                 field.common_at + field.additional_size]
        return dict(struct.unpack_from("<II", block, at)
                    for at in range(0, len(block) - 7, 8))

    def _value_bits(self, column: Column) -> int:
        """How many bits of a column's raw value carry meaning.

        Whichever of the packing and the declaration is narrower, because
        either can be the binding one. A bitpacked field holds the value
        sign-compressed into as many bits as its range needs, so a 26-bit
        colour extends from bit 25 rather than from the declared 32. Where the
        packer spent more bits than the type has, the type bounds it instead:
        an attachment declared one byte and stored in nine reads -1 from bit 7
        and 255 from bit 8. A pallet or common field holds a 32-bit word whose
        meaningful part is only ever what the schema declares, so extending a
        one-byte -1 over the width of the index that addressed it produces a
        large positive number.
        """
        spec, field = column.spec, column.field
        if field is None:
            return spec.bits
        if field.storage == NONE:
            stored = field.size_bits // spec.count if spec.count else field.size_bits
        elif field.storage in (BITPACKED, BITPACKED_SIGNED):
            stored = field.size_bits
        else:
            stored = 32
        return min(stored, spec.bits) or spec.bits

    def _values(self, column: Column, block: bytes, record_at: int,
                record_id: int) -> list[int]:
        """The column's raw unsigned value(s), before width and type apply."""
        spec, field = column.spec, column.field
        if field is None:
            return [0] * spec.count
        base = record_at * 8 + field.offset_bits
        if field.storage == NONE:
            width = field.size_bits // spec.count if spec.count else field.size_bits
            return [read_bits(block, base + i * width, width)
                    for i in range(spec.count)]
        if field.storage in (BITPACKED, BITPACKED_SIGNED):
            return [read_bits(block, base, field.size_bits)]
        if field.storage == COMMON:
            return [self._commons.get(field.index, {}).get(record_id, field.default)]
        index = read_bits(block, base, field.size_bits)
        at = field.pallet_at + index * 4 * spec.count
        return list(struct.unpack_from(f"<{spec.count}I", self.pallet_data, at))

    def _text(self, column: Column, values: Sequence[int], block: bytes,
              record_at: int, strings_at: int) -> list[str]:
        """Turn a column's raw values into the text the CSV export carries."""
        spec = column.spec
        bits = self._value_bits(column)
        mask = (1 << bits) - 1
        out: list[str] = []
        for position, value in enumerate(values):
            value &= mask
            if spec.kind in ("string", "locstring"):
                out.append(self._string(column, value, block, record_at,
                                        position, strings_at))
            elif spec.kind == "float":
                out.append(format_float(struct.unpack(
                    "<f", (value & 0xFFFFFFFF).to_bytes(4, "little"))[0]))
            elif spec.signed:
                out.append(str(sign_extend(value, bits)))
            else:
                out.append(str(value))
        return out

    def _string(self, column: Column, value: int, block: bytes, record_at: int,
                position: int, strings_at: int) -> str:
        """One string field, resolved from its offset.

        The offset is signed and measured from the field's own byte position.
        It counts against the record area the header declares, while the string
        block follows only this section's records, so the two are reconciled
        before indexing. Where a table has one section the correction is zero.
        """
        field = column.field
        if value == 0 or field is None:
            return ""
        here = (record_at + (field.offset_bits >> 3)
                + position * (column.spec.bits >> 3))
        at = (strings_at + here + sign_extend(value, column.spec.bits)
              - self.record_size * self.record_count)
        if not 0 <= at < len(block):
            return ""
        end = block.find(b"\0", at)
        return block[at:end if end >= 0 else None].decode("utf-8", errors="replace")

    def _layout(self, section: Section) -> dict[str, int]:
        """Where each of a section's parts begins, in the file's own order."""
        at = section.file_offset
        if self.flags & 1:
            records_size = section.offset_records_end - section.file_offset
            strings_size = 0
        else:
            records_size = self.record_size * section.record_count
            strings_size = section.string_table_size
        cursor = at + records_size + strings_size

        parts = {"records_at": at, "records_size": records_size,
                 "strings_size": strings_size, "id_list_at": cursor}
        cursor += section.id_list_size
        parts["copy_at"] = cursor
        cursor += section.copy_table_count * 8
        parts["offset_map_at"] = cursor
        cursor += section.offset_map_id_count * 6
        parts["relationship_at"] = cursor
        cursor += section.relationship_data_size
        parts["offset_map_ids_at"] = cursor
        return parts

    def _relationship(self, section: Section, at: int) -> dict[int, int]:
        """`record index -> foreign id`, for a relation stored outside the record."""
        if not section.relationship_data_size:
            return {}
        count = struct.unpack_from("<I", self.blob, at)[0]
        return dict(struct.unpack_from("<II", self.blob, at + 12 + i * 8)[::-1]
                    for i in range(count))

    def id_position(self) -> int:
        """Which exported column carries the id.

        Not always the first, so anything keying rows by id has to ask. Mount
        exports three localised strings ahead of it.
        """
        at = 0
        for column in self.declared:
            if column.spec.is_id:
                return at
            at += column.spec.count
        return 0

    def rows(self) -> Iterator[tuple[str, ...]]:
        """Every readable section's rows, as text, in file order."""
        for section in self.sections:
            if not section.readable(len(self.blob)):
                continue
            yield from self._section_rows(section)

    def _section_rows(self, section: Section) -> Iterator[tuple[str, ...]]:
        """One section's records, then the copies that reuse them."""
        layout = self._layout(section)
        relationship = self._relationship(section, layout["relationship_at"])

        if self.flags & 1:
            produced = self._offset_map_rows(section, layout, relationship)
        else:
            produced = self._record_rows(section, layout, relationship)

        by_id: dict[int, tuple[str, ...]] = {}
        for record_id, row in produced:
            if section.copy_table_count:
                by_id[record_id] = row
            yield row

        # A copy is a real exported row reusing another record's data, so a
        # reader that drops them comes out short rather than wrong.
        id_at = self.id_position()
        for i in range(section.copy_table_count):
            new_id, copied = struct.unpack_from("<II", self.blob,
                                                layout["copy_at"] + i * 8)
            source = by_id.get(copied)
            if source is not None:
                yield source[:id_at] + (str(new_id),) + source[id_at + 1:]

    def _record_rows(self, section: Section, layout: dict[str, int],
                     relationship: dict[int, int]
                     ) -> Iterator[tuple[int, tuple[str, ...]]]:
        """Fixed-length records, with their strings in the block that follows."""
        start = layout["records_at"]
        block = self.blob[start:start + layout["records_size"]
                          + layout["strings_size"]]
        ids: list[int] = []
        if section.id_list_size:
            ids = list(struct.unpack_from(f"<{section.id_list_size // 4}I",
                                          self.blob, layout["id_list_at"]))

        for index in range(section.record_count):
            record_at = index * self.record_size
            record_id = ids[index] if ids else self._inline_id(block, record_at)
            yield record_id, self._row(block, record_at, record_id,
                                       layout["records_size"],
                                       relationship.get(index, 0))

    def _inline_id(self, block: bytes, record_at: int) -> int:
        """The id read out of the record, for a table with no id list."""
        column = next((c for c in self.declared if c.spec.is_id), None)
        if column is None or column.field is None:
            return 0
        return self._values(column, block, record_at, 0)[0]

    def _row(self, block: bytes, record_at: int, record_id: int,
             strings_at: int, foreign: int) -> tuple[str, ...]:
        """One record, spelled as the CSV export spells it."""
        out: list[str] = []
        for column in self.declared:
            if column.field is None and column.spec.is_id:
                out.append(str(record_id))
            elif column.field is None and column.spec.is_relation:
                out.append(str(foreign))
            else:
                out.extend(self._text(
                    column, self._values(column, block, record_at, record_id),
                    block, record_at, strings_at))
        return tuple(out)

    def _offset_map_rows(self, section: Section, layout: dict[str, int],
                         relationship: dict[int, int]
                         ) -> Iterator[tuple[int, tuple[str, ...]]]:
        """Variable-length records: inline strings, and no string table."""
        count = section.offset_map_id_count
        entries = [struct.unpack_from("<IH", self.blob,
                                      layout["offset_map_at"] + i * 6)
                   for i in range(count)]
        ids = struct.unpack_from(f"<{count}I", self.blob,
                                 layout["offset_map_ids_at"])

        for index, ((offset, size), record_id) in enumerate(zip(entries, ids)):
            record = self.blob[offset:offset + size]
            out: list[str] = []
            at = 0
            for column in self.declared:
                if column.field is None and column.spec.is_id:
                    out.append(str(record_id))
                    continue
                if column.field is None and column.spec.is_relation:
                    out.append(str(relationship.get(index, 0)))
                    continue
                text, at = self._inline_value(column.spec, record, at)
                out.extend(text)
            yield record_id, tuple(out)

    def _inline_value(self, spec: ColumnSpec, record: bytes,
                      at: int) -> tuple[list[str], int]:
        """One column of an offset-map record, and where the next one starts."""
        out: list[str] = []
        for _ in range(spec.count):
            if spec.kind in ("string", "locstring"):
                end = record.find(b"\0", at)
                out.append(record[at:end].decode("utf-8", errors="replace"))
                at = end + 1
                continue
            width = spec.bits >> 3
            value = int.from_bytes(record[at:at + width], "little")
            at += width
            if spec.kind == "float":
                out.append(format_float(
                    struct.unpack("<f", value.to_bytes(4, "little"))[0]))
            elif spec.signed:
                out.append(str(sign_extend(value, spec.bits)))
            else:
                out.append(str(value))
        return out, at
