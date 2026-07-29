"""Parser for WoWDBDefs `.dbd` files — the schema source for tools/builddb.py.

A `.dbd` file describes one client db2 table across every build the community has
ever seen. It is the only machine-readable source for three things the wago.tools
CSV export cannot tell us:

  * the **type** of a column — the CSV is untyped text, and DuckDB's inference
    lands everything on BIGINT/DOUBLE. The `.dbd` gives the real width and
    signedness (`Flags<u32>`, `Gender<u8>`), which is both smaller on disk and
    honest about what the game stores.
  * the **relationships** — `int<SpellVisualKit::ID> ParentSpellVisualKitID`
    names the table a column points at. That is the FK graph, and it is what
    turns 79 loose tables into something you can navigate.
  * the **comments** — `// 1: SpellProceduralEffectID, 2: ...` is often the only
    documentation an enum column has anywhere.

Format reference: https://github.com/wowdev/WoWDBDefs (README.md).

    COLUMNS
    int ID
    int<SpellVisualKit::ID> ParentSpellVisualKitID
    int EffectType // what Effect points at
    string Name?                      <- trailing ? = unverified/guessed

    LAYOUT 8AD4C267
    BUILD 9.2.7.45745, 9.2.7.45338
    BUILD 9.2.0.42423-9.2.7.45745     <- inclusive range
    $noninline,id$ID<32>
    EffectType<u8>
    Offset<32>[3]                     <- array of 3

The COLUMNS block is build-independent (the union of every column ever seen);
the BUILD blocks say which of them a *particular* client actually ships, in
order, with widths. We need both: COLUMNS for meaning, the matching BUILD block
for types.

Nothing here fails hard. A table with no `.dbd`, a build with no matching block,
or a column the definition has never heard of all degrade to "no metadata" —
the builder falls back to DuckDB's own inference. This is a development tool;
losing a type annotation must never cost you the data.
"""

from __future__ import annotations

import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

DBD_URL = "https://raw.githubusercontent.com/wowdev/WoWDBDefs/master/definitions/{table}.dbd"

# A build id: "9.2.7.45745". Compared componentwise, so 10.x sorts after 9.x
# (the same trap version_key() fixes in build_data.py — a string sort puts
# "10.2.7" before "9.2.7").
Build = tuple[int, int, int, int]

_COLUMN_RE = re.compile(
    r"^(?P<type>int|float|string|locstring)"
    r"(?:<(?P<fk_table>[^:>]+)::(?P<fk_column>[^>]+)>)?"
    r"\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)"
    r"(?P<unverified>\?)?"
    r"\s*(?://\s*(?P<comment>.*))?$"
)

_BUILD_COLUMN_RE = re.compile(
    r"^(?:\$(?P<annotations>[^$]*)\$)?"
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)"
    r"(?P<unverified>\?)?"
    r"(?:<(?P<unsigned>u)?(?P<width>8|16|32|64)>)?"
    r"(?:\[(?P<array>\d+)\])?"
    r"\s*(?://.*)?$"
)


def parse_build(text: str) -> Build | None:
    """`"9.2.7.45745"` -> `(9, 2, 7, 45745)`. Tolerates a missing 4th part."""
    parts = text.strip().split(".")
    if not 2 <= len(parts) <= 4:
        return None
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    while len(nums) < 4:
        nums.append(0)
    return (nums[0], nums[1], nums[2], nums[3])


@dataclass
class Column:
    """One entry of the COLUMNS block — what the column *means*, build-independent."""

    name: str
    type: str  # int | float | string | locstring
    fk_table: str | None = None
    fk_column: str | None = None
    unverified: bool = False
    comment: str | None = None


@dataclass
class BuildColumn:
    """One entry of a BUILD block — how a particular client *stores* the column."""

    name: str
    width: int | None = None  # 8 / 16 / 32 / 64; None = not an integer
    unsigned: bool = False
    array: int | None = None  # array cardinality, if any
    is_id: bool = False  # $id$      — the primary key
    is_relation: bool = False  # $relation$ — the FK back to the parent table
    noninline: bool = False  # $noninline$ — stored outside the record


@dataclass
class BuildBlock:
    """A set of builds that share one column layout."""

    builds: list[Build] = field(default_factory=list)
    ranges: list[tuple[Build, Build]] = field(default_factory=list)
    layouts: list[str] = field(default_factory=list)
    columns: list[BuildColumn] = field(default_factory=list)

    def matches(self, build: Build) -> bool:
        return build in self.builds or any(lo <= build <= hi for lo, hi in self.ranges)

    def matches_loosely(self, build: Build) -> bool:
        """Same major.minor.patch, ignoring the build number.

        Our ten packs are pinned to exact builds, but a `.dbd` may only list the
        neighbouring hotfix build of the same patch. The column layout does not
        change within a patch, so this is a safe second try — and it is what
        stops a perfectly good definition being discarded over a build suffix.
        """
        return any(b[:3] == build[:3] for b in self.builds) or any(
            lo[:3] <= build[:3] <= hi[:3] for lo, hi in self.ranges
        )


@dataclass
class Definition:
    """A parsed `.dbd`: the meaning of every column, plus per-build layouts."""

    table: str
    columns: dict[str, Column] = field(default_factory=dict)
    blocks: list[BuildBlock] = field(default_factory=list)

    def block_for(self, build: Build) -> BuildBlock | None:
        """The layout this client ships, exact match preferred over same-patch."""
        for block in self.blocks:
            if block.matches(build):
                return block
        for block in self.blocks:
            if block.matches_loosely(build):
                return block
        return None

    def widths_for(self, build: Build) -> dict[str, BuildColumn]:
        """`{base column name -> BuildColumn}` for this build (empty if unknown)."""
        block = self.block_for(build)
        return {c.name: c for c in block.columns} if block else {}


def parse(text: str, table: str) -> Definition:
    """Parse one `.dbd` document. Never raises on malformed input — an
    unparseable line is skipped, because a partial definition still beats none."""
    definition = Definition(table=table)
    block: BuildBlock | None = None
    in_columns = False

    for raw in text.splitlines():
        line = raw.strip()

        if not line:
            # A blank line closes the COLUMNS block and separates BUILD blocks.
            in_columns = False
            block = None
            continue

        if line == "COLUMNS":
            in_columns, block = True, None
            continue

        if in_columns:
            m = _COLUMN_RE.match(line)
            if m:
                definition.columns[m["name"]] = Column(
                    name=m["name"],
                    type=m["type"],
                    fk_table=m["fk_table"],
                    fk_column=m["fk_column"],
                    unverified=bool(m["unverified"]),
                    comment=(m["comment"] or "").strip() or None,
                )
            continue

        if line.startswith(("LAYOUT", "BUILD", "COMMENT")):
            if block is None:
                block = BuildBlock()
                definition.blocks.append(block)

            keyword, _, rest = line.partition(" ")
            if keyword == "LAYOUT":
                block.layouts.extend(h.strip() for h in rest.split(",") if h.strip())
            elif keyword == "BUILD":
                for entry in rest.split(","):
                    entry = entry.strip()
                    if "-" in entry:
                        lo_text, _, hi_text = entry.partition("-")
                        lo, hi = parse_build(lo_text), parse_build(hi_text)
                        if lo and hi:
                            block.ranges.append((lo, hi))
                    else:
                        parsed = parse_build(entry)
                        if parsed:
                            block.builds.append(parsed)
            # COMMENT lines are human-readable only; nothing to record.
            continue

        if block is not None:
            m = _BUILD_COLUMN_RE.match(line)
            if m:
                # not `annotations`: that name is taken by the __future__ import
                annos = (m["annotations"] or "").split(",")
                block.columns.append(
                    BuildColumn(
                        name=m["name"],
                        width=int(m["width"]) if m["width"] else None,
                        unsigned=bool(m["unsigned"]),
                        array=int(m["array"]) if m["array"] else None,
                        is_id="id" in annos,
                        is_relation="relation" in annos,
                        noninline="noninline" in annos,
                    )
                )

    return definition


def load(table: str, cache_dir: Path, refresh: bool = False,
         timeout: int = 60) -> Definition | None:
    """Fetch (and cache) one table's `.dbd`. Returns None if it has none.

    Cached forever by default: definitions change only when someone reverse
    engineers a new column, and a stale one costs a type annotation, not data.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"{table}.dbd"

    if refresh or not path.exists():
        try:
            request = urllib.request.Request(
                DBD_URL.format(table=table),
                headers={"User-Agent": "Epsilook-devdb (github.com/Natans8/Epsilook)"},
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                path.write_bytes(response.read())
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                # No definition upstream — a real answer, so remember it rather
                # than re-asking on every build.
                path.write_text("", encoding="utf-8")
            else:
                return None
        except OSError:
            # Offline, or the network hiccuped. Fall through to any cached copy.
            if not path.exists():
                return None

    text = path.read_text(encoding="utf-8", errors="replace")
    return parse(text, table) if text.strip() else None
