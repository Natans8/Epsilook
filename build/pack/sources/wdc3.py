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
from dataclasses import dataclass, replace
from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Context, Decimal

NONE, BITPACKED, COMMON, PALLET, PALLET_ARRAY, BITPACKED_SIGNED = range(6)

_HEADER = struct.Struct("<4s9IHH7I")
"""Magic then seventeen words. One word too many puts the section headers four
bytes late, every section then reads a non-zero encryption key and is skipped,
and the table parses to zero records without raising."""

_SECTION = struct.Struct("<Q8I")
_FIELD_STRUCTURE = struct.Struct("<hH")
_STORAGE_INFO = struct.Struct("<HHII3I")

_WIDENED = Context(prec=15, rounding=ROUND_HALF_UP)
"""The precision the export widens a float to before rounding its places."""

_SIGNIFICANT = Context(prec=14, rounding=ROUND_HALF_EVEN)
"""The significant digits it then holds the rounded decimal to."""


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

    def readable(self, size: int, offset_map: bool = False) -> bool:
        """Whether this section's bytes are present and unencrypted.

        The record count is not the test: an absent locale declares records
        while carrying a non-zero encryption key and an offset past end of
        file.

        An offset-map section is bounded by where its records end rather than
        by a fixed record size, so one that declares no end describes a span
        of negative length, and the id list, copy table and offset map all
        then resolve to somewhere before the section begins.
        """
        return (
            self.encryption_key == 0
            and self.record_count > 0
            and 0 < self.file_offset < size
            and (not offset_map or self.offset_records_end > self.file_offset)
        )


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
    """One exported column joined to the field that stores it.

    Everything a value needs beyond the raw bits is settled here rather than
    per row, because all of it follows from the spec and the field and both are
    fixed once the file is parsed.

    Attributes:
        bits: how many bits of the raw value carry meaning.
        mask: those bits, as a mask.
        element_bits: the width of one array element inside the record.
        pallet: reader for one row's worth of pallet entries, when the value
            lives in the pallet block.
        common: the field's exceptions to its default, when it lives in the
            common block.
    """

    spec: ColumnSpec
    field: Field | None
    bits: int
    mask: int
    element_bits: int
    pallet: struct.Struct | None
    common: dict[int, int] | None


def value_bits(spec: ColumnSpec, field: Field | None) -> int:
    """How many bits of a column's raw value carry meaning.

    Whichever of the packing and the declaration is narrower, because either
    can be the binding one. A bitpacked field holds the value sign-compressed
    into as many bits as its range needs, so a 26-bit colour extends from bit
    25 rather than from the declared 32. Where the packer spent more bits than
    the type has, the type bounds it instead: an attachment declared one byte
    and stored in nine reads -1 from bit 7 and 255 from bit 8. A pallet or
    common field holds a 32-bit word whose meaningful part is only ever what
    the schema declares, so extending a one-byte -1 over the width of the index
    that addressed it produces a large positive number.
    """
    if field is None:
        return spec.bits
    if field.storage == NONE:
        stored = element_bits(spec, field)
    elif field.storage in (BITPACKED, BITPACKED_SIGNED):
        stored = field.size_bits
    else:
        stored = 32
    return min(stored, spec.bits) or spec.bits


def element_bits(spec: ColumnSpec, field: Field) -> int:
    """The width of one element of a field the record stores directly."""
    return field.size_bits // spec.count if spec.count else field.size_bits


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
    raw = int.from_bytes(data[start : start + length], "little")
    return (raw >> shift) & ((1 << size_bits) - 1)


def sign_extend(value: int, bits: int) -> int:
    """Two's complement over an arbitrary width."""
    if bits and value & (1 << (bits - 1)):
        return value - (1 << bits)
    return value


def format_float(value: float) -> str:
    """A float32 spelled the way the CSV export spells it.

    The export rounds three times and each step shows in the output, so none of
    them implies the others. The float32 is widened to fifteen significant
    digits, rounded to eleven decimal places, and finally held to fourteen
    significant digits. Rounding once straight to eleven disagrees wherever the
    discarded digits carry the eleventh place over: `214.1703338623046875`
    reaches `214.170333862305` at fifteen digits and `214.17033386231` from
    there, where a single rounding gives `214.1703338623`. The last step is
    what leaves a larger magnitude with fewer places, `2506.97998046875` coming
    out `2506.9799804688`. Halves go away from zero in the first two steps and
    to an even digit in the third, trailing zeros are stripped, and a whole
    number loses its fractional part.

    Whether the result is written in exponent form is decided after rounding
    rather than before: `0.0001` is what a float32 slightly under it rounds to
    and is written plainly, where `-1e-06` is not. Magnitudes past what eleven
    places can describe are written at full precision instead.
    """
    if not math.isfinite(value):
        return str(value)
    if abs(value) >= 1e15:
        return repr(value)
    if value == int(value):
        return str(int(value))

    rounded = _SIGNIFICANT.plus(_WIDENED.plus(Decimal(value)).quantize(Decimal("1e-11"), rounding=ROUND_HALF_UP))
    if not rounded:
        return "0"
    if abs(rounded) >= Decimal("1e-4"):
        return f"{rounded:f}".rstrip("0").rstrip(".")

    sign, digits, exponent = rounded.normalize().as_tuple()
    power = int(exponent) + len(digits) - 1
    mantissa = str(digits[0])
    if len(digits) > 1:
        mantissa += "." + "".join(str(digit) for digit in digits[1:])
    return f"{'-' if sign else ''}{mantissa}e{'-' if power < 0 else '+'}{abs(power):02d}"


class Db2:
    """One WDC3 file, read against the schema that names its columns."""

    def __init__(self, blob: bytes, schema: Sequence[ColumnSpec] | None) -> None:
        """Parse the file's structure. Values are decoded when rows are read.

        Args:
            blob: the whole decompressed file.
            schema: the exported columns, in order. None names them
                positionally, which is enough to inspect a table whose schema
                is not to hand; `_positional` says what such a read cannot
                tell you.

        Raises:
            ValueError: the bytes are not a WDC3 file.
        """
        if blob[:4] != b"WDC3":
            raise ValueError(f"not WDC3: {blob[:4]!r}")
        self.blob = blob
        # Seventeen words, of which decoding reads nine; the rest are bound to
        # throwaways rather than dropped so the count stays visible.
        (
            _magic,
            self.record_count,
            self.field_count,
            self.record_size,
            _string_table_size,
            _table_hash,
            _layout_hash,
            _min_id,
            _max_id,
            _locale,
            self.flags,
            self.id_index,
            _total_field_count,
            _bitpacked_data_offset,
            _lookup_column_count,
            self.field_storage_info_size,
            self.common_data_size,
            self.pallet_data_size,
            self.section_count,
        ) = _HEADER.unpack_from(blob, 0)

        at = _HEADER.size
        self.sections = [
            Section(*_SECTION.unpack_from(blob, at + i * _SECTION.size)) for i in range(self.section_count)
        ]
        at += self.section_count * _SECTION.size

        # The field structure array carries a declared width that a packed
        # field does not honour, so nothing here reads it; the storage info
        # that follows is what decoding uses.
        at += self.field_count * _FIELD_STRUCTURE.size
        storage = [
            _STORAGE_INFO.unpack_from(blob, at + i * _STORAGE_INFO.size)
            for i in range(self.field_storage_info_size // _STORAGE_INFO.size)
        ]
        at += self.field_storage_info_size

        self.pallet_data = blob[at : at + self.pallet_data_size]
        at += self.pallet_data_size
        self.common_data = blob[at : at + self.common_data_size]

        self.fields = self._fields(storage)
        self.declared = self._join(schema)
        self._record_area = self.record_size * self.record_count
        # A float32 has far fewer distinct values in a table than it has rows,
        # because pallet and common storage deduplicate them by construction.
        # Keyed on the raw word rather than the float, which is strictly finer.
        self._floats: dict[int, str] = {}

    def _fields(self, storage: Sequence[tuple[int, ...]]) -> list[Field]:
        """The record's fields, with each pallet and common block located.

        Both blocks are laid out in field order, so their offsets accumulate in
        one pass over the fields that use them.
        """
        fields: list[Field] = []
        pallet_at = common_at = 0
        for index, entry in enumerate(storage):
            offset_bits, size_bits, additional, kind = entry[:4]
            fields.append(
                Field(
                    index=index,
                    offset_bits=offset_bits,
                    size_bits=size_bits,
                    storage=kind,
                    default=entry[4],
                    pallet_at=pallet_at,
                    common_at=common_at,
                    additional_size=additional,
                )
            )
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
            schema = self._positional()
        columns: list[Column] = []
        position = 0
        for spec in schema:
            field = None
            if spec.in_record:
                field = self.fields[position] if position < len(self.fields) else None
                position += 1
            columns.append(self._column(spec, field))
        return columns

    def _positional(self) -> list[ColumnSpec]:
        """A schema for a file whose own is not to hand: one column per field.

        Two things a record cannot say about itself go missing with the schema,
        and a caller reading positions has to know both. A value's type is one:
        a string is stored as the offset that locates it, so it reads as a
        number with nothing to mark it as anything else. An array's cardinality
        is the other: a field declares the width of the whole array and never
        how many elements share it, so an array stays one column instead of
        becoming one per element.

        The id is not among them, and leaving it out cost more than a name. A
        file whose id list supplies it gets a column of its own ahead of the
        fields; one whose record carries it has the header say which field that
        is. Either way the id is in the row and the copy table can find it,
        where before it was absent and every copied row overwrote the first
        column instead.
        """
        columns = [ColumnSpec(name=f"Field_{field.index}") for field in self.fields]
        if self.flags & 4:
            return [ColumnSpec(name="ID", is_id=True, in_record=False), *columns]
        if 0 <= self.id_index < len(columns):
            columns[self.id_index] = replace(columns[self.id_index], is_id=True)
        return columns

    def _column(self, spec: ColumnSpec, field: Field | None) -> Column:
        """One joined column, with everything a value needs precomputed."""
        bits = value_bits(spec, field)
        pallet = common = None
        if field is not None and field.storage in (PALLET, PALLET_ARRAY):
            pallet = struct.Struct(f"<{spec.count}I")
        elif field is not None and field.storage == COMMON:
            common = self._common_map(field)
        return Column(
            spec=spec,
            field=field,
            bits=bits,
            mask=(1 << bits) - 1,
            element_bits=element_bits(spec, field) if field is not None else 0,
            pallet=pallet,
            common=common,
        )

    @property
    def columns(self) -> list[str]:
        """The CSV header: the schema's order, arrays expanded."""
        return [name for column in self.declared for name in column.spec.spellings()]

    def _common_map(self, field: Field) -> dict[int, int]:
        """A common-data field's exceptions to its default, keyed by record id."""
        block = self.common_data[field.common_at : field.common_at + field.additional_size]
        return dict(struct.unpack_from("<II", block, at) for at in range(0, len(block) - 7, 8))

    def _values(self, column: Column, block: bytes, record_at: int, record_id: int) -> list[int]:
        """The column's raw unsigned value(s), before width and type apply."""
        spec, field = column.spec, column.field
        if field is None:
            return [0] * spec.count
        base = record_at * 8 + field.offset_bits
        if field.storage == NONE:
            width = column.element_bits
            return [read_bits(block, base + i * width, width) for i in range(spec.count)]
        if field.storage in (BITPACKED, BITPACKED_SIGNED):
            return [read_bits(block, base, field.size_bits)]
        if column.common is not None:
            return [column.common.get(record_id, field.default)]
        if column.pallet is None:
            raise ValueError(
                f"field {field.index} declares storage type {field.storage}, which this reader does not know"
            )
        index = read_bits(block, base, field.size_bits)
        return list(column.pallet.unpack_from(self.pallet_data, field.pallet_at + index * 4 * spec.count))

    def _text(self, column: Column, values: Sequence[int], block: bytes, record_at: int, strings_at: int) -> list[str]:
        """Turn a column's raw values into the text the CSV export carries."""
        spec, mask, bits = column.spec, column.mask, column.bits
        if spec.kind in ("string", "locstring"):
            return [
                self._string(column, value & mask, block, record_at, position, strings_at)
                for position, value in enumerate(values)
            ]
        return [self._spell(spec.kind, spec.signed, value & mask, bits) for value in values]

    def _spell(self, kind: str, signed: bool, value: int, bits: int) -> str:
        """One scalar value, spelled the way the CSV export spells it."""
        if kind == "float":
            word = value & 0xFFFFFFFF
            text = self._floats.get(word)
            if text is None:
                text = self._floats[word] = format_float(struct.unpack("<f", word.to_bytes(4, "little"))[0])
            return text
        return str(sign_extend(value, bits) if signed else value)

    def _string(self, column: Column, value: int, block: bytes, record_at: int, position: int, strings_at: int) -> str:
        """One string field, resolved from its offset.

        The offset is signed and measured from the field's own byte position.
        It counts against the record area the header declares, while the string
        block follows only this section's records, so the two are reconciled
        before indexing. Where a table has one section the correction is zero.
        """
        field = column.field
        if value == 0 or field is None:
            return ""
        here = record_at + (field.offset_bits >> 3) + position * (column.spec.bits >> 3)
        at = strings_at + here + sign_extend(value, column.spec.bits) - self._record_area
        if not 0 <= at < len(block):
            return ""
        end = block.find(b"\0", at)
        return block[at : end if end >= 0 else None].decode("utf-8", errors="replace")

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

        parts = {"records_at": at, "records_size": records_size, "strings_size": strings_size, "id_list_at": cursor}
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
        # The count is the file's own word, and the block that has to hold the
        # pairs is what bounds it. Unbounded, a malformed header walks the read
        # into whatever follows the section and builds a dict out of it.
        count = min(struct.unpack_from("<I", self.blob, at)[0], max(0, (section.relationship_data_size - 12) // 8))
        return dict(struct.unpack_from("<II", self.blob, at + 12 + i * 8)[::-1] for i in range(count))

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
        offset_map = bool(self.flags & 1)
        for section in self.sections:
            if not section.readable(len(self.blob), offset_map):
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

        # A copy is a real exported row reusing another record's data, so a
        # reader that drops them comes out short rather than wrong. The copy
        # table is read before the rows so that only the rows it names are
        # held: a section whose copies reuse a hundredth of it would otherwise
        # be retained whole, which is not what a generator promises.
        copies = [
            struct.unpack_from("<II", self.blob, layout["copy_at"] + i * 8) for i in range(section.copy_table_count)
        ]
        wanted = {copied for _new_id, copied in copies}

        sources: dict[int, tuple[str, ...]] = {}
        for record_id, row in produced:
            if record_id in wanted:
                sources[record_id] = row
            yield row

        id_at = self.id_position()
        for new_id, copied in copies:
            source = sources.get(copied)
            if source is not None:
                yield source[:id_at] + (str(new_id),) + source[id_at + 1 :]

    def _record_rows(
        self, section: Section, layout: dict[str, int], relationship: dict[int, int]
    ) -> Iterator[tuple[int, tuple[str, ...]]]:
        """Fixed-length records, with their strings in the block that follows."""
        start = layout["records_at"]
        block = self.blob[start : start + layout["records_size"] + layout["strings_size"]]
        ids: list[int] = []
        if section.id_list_size:
            ids = list(struct.unpack_from(f"<{section.id_list_size // 4}I", self.blob, layout["id_list_at"]))

        for index in range(section.record_count):
            record_at = index * self.record_size
            record_id = ids[index] if ids else self._inline_id(block, record_at)
            yield record_id, self._row(block, record_at, record_id, layout["records_size"], relationship.get(index, 0))

    def _inline_id(self, block: bytes, record_at: int) -> int:
        """The id read out of the record, for a table with no id list."""
        column = next((c for c in self.declared if c.spec.is_id), None)
        if column is None or column.field is None:
            return 0
        return self._values(column, block, record_at, 0)[0]

    @staticmethod
    def _supplied(column: Column, record_id: int, foreign: int) -> str | None:
        """The text for a column the record does not carry, or None.

        The id list and the relationship map are the two places a value lives
        outside the record, and both row shapes have to consult them.
        """
        if column.field is not None:
            return None
        if column.spec.is_id:
            return str(record_id)
        return str(foreign) if column.spec.is_relation else None

    def _row(self, block: bytes, record_at: int, record_id: int, strings_at: int, foreign: int) -> tuple[str, ...]:
        """One record, spelled as the CSV export spells it."""
        out: list[str] = []
        for column in self.declared:
            supplied = self._supplied(column, record_id, foreign)
            if supplied is not None:
                out.append(supplied)
            else:
                out.extend(
                    self._text(column, self._values(column, block, record_at, record_id), block, record_at, strings_at)
                )
        return tuple(out)

    def _offset_map_rows(
        self, section: Section, layout: dict[str, int], relationship: dict[int, int]
    ) -> Iterator[tuple[int, tuple[str, ...]]]:
        """Variable-length records: inline strings, and no string table."""
        count = section.offset_map_id_count
        entries = [struct.unpack_from("<IH", self.blob, layout["offset_map_at"] + i * 6) for i in range(count)]
        ids = struct.unpack_from(f"<{count}I", self.blob, layout["offset_map_ids_at"])

        for index, ((offset, size), record_id) in enumerate(zip(entries, ids)):
            record = self.blob[offset : offset + size]
            out: list[str] = []
            at = 0
            foreign = relationship.get(index, 0)
            for column in self.declared:
                supplied = self._supplied(column, record_id, foreign)
                if supplied is not None:
                    out.append(supplied)
                    continue
                if column.field is None:
                    # A column the record does not carry has no bytes here to
                    # advance over. Reading one would shift every column after
                    # it and resynchronise a string on the wrong NUL, and the
                    # row would still come out the right width. Spelled the way
                    # the fixed-length path spells it, so one schema does not
                    # describe two row shapes.
                    out.extend(self._text(column, [0] * column.spec.count, record, 0, 0))
                    continue
                text, at = self._inline_value(column.spec, record, at)
                out.extend(text)
            yield record_id, tuple(out)

    def _inline_value(self, spec: ColumnSpec, record: bytes, at: int) -> tuple[list[str], int]:
        """One column of an offset-map record, and where the next one starts."""
        out: list[str] = []
        for _ in range(spec.count):
            if spec.kind in ("string", "locstring"):
                end = record.find(b"\0", at)
                out.append(record[at:end].decode("utf-8", errors="replace"))
                at = end + 1
                continue
            width = spec.bits >> 3
            value = int.from_bytes(record[at : at + width], "little")
            at += width
            out.append(self._spell(spec.kind, spec.signed, value, spec.bits))
        return out, at
