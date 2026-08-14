#!/usr/bin/env python3
"""Generate `build/expansion_ids.json.gz` — which expansion each spell ID arrived in.

No client table records this, so it is DERIVED: walk the expansions oldest-first
and the first one whose spell table holds an ID is the one that introduced it.

ADDING AN EXPANSION IS ONE `Expansion(...)` ROW IN `LADDER` AND NOTHING ELSE.
Everything that can differ between expansions is a FIELD on that row — the ID
sources, the search words, the Wowhead site, the caveats — so there is no
per-expansion branch anywhere below, and no second place to edit.

A rung's spell IDs come from one or more `Source`s, each wrapping either:

    Archive(...)  a build in the wow.tools DBC archive — used for the eras we
                  ship no pack of, and always the ORIGINAL era client
    Pack(...)     a version Epsilook already ships, read straight from its pack

Both answer the single question "give me this build's spell IDs", so `ids_of`
is the only code that knows they differ. A source's `role` decides what it is
FOR: `origin` sources define the rung, `parallel` ones are measured and recorded
for comparison but never move a spell. That is how a Classic re-release sits
beside the original client it re-implements without contaminating it.

The output is frozen historical data — a shipped expansion's spell table never
changes again — so this runs by hand when an expansion is added and its result
is committed. `build_data.py` only ever reads the JSON.

    python tools/expansions.py            # regenerate
    python tools/expansions.py --verify   # rebuild and diff, writing nothing
    python tools/expansions.py --report   # per-source counts and rung overlaps
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import struct
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import packfile
from repo import CACHE

REPO = Path(__file__).resolve().parent.parent
CACHE_DIR = CACHE / "expansions"
# Committed, tiny, and the reason a login-gated client dump never has to be:
# one delta-encoded spell-ID list per era client that no public archive serves.
SOURCES = REPO / "build" / "sources"
# Gzipped: sorted ID lists compress ~4x, and this is generated, frozen data whose
# line diff would be meaningless anyway. `gzip` is stdlib, so build_data.py reads
# it without gaining a dependency.
OUT = REPO / "build" / "expansion_ids.json.gz"

# The per-table 7z of every archived build of Spell.dbc/db2 (623 of them), from
# the one mirror of the wow.tools archive that is still served. ~150 MB, fetched
# once into .cache/ and never again; only a few members are ever extracted.
ARCHIVE_URL = "https://files.gw2archive.eu/wow.tools/DBFilesClient/Spell.7z"

ORIGIN = "origin"  # defines the rung
PARALLEL = "parallel"  # measured and recorded, never moves a spell


@dataclass(frozen=True)
class Archive:
    """A build held in the wow.tools DBC archive, named by its member filename."""
    member: str

    @property
    def ref(self) -> str:
        return self.member.split(" ")[0].replace("Spell.", "")


@dataclass(frozen=True)
class Pack:
    """A game version Epsilook already ships a pack for."""
    version: str

    @property
    def ref(self) -> str:
        return f"pack {self.version}"


@dataclass(frozen=True)
class Vendored:
    """An era client that no public archive serves, COMMITTED under build/sources.

    Warlords is the case this exists for: every 6.x build on the wow.tools mirror
    is Beta or PTR, and the one retail dump that could be found sits behind a
    sign-in. A rung whose source can vanish is not a real option, so the client
    table is vendored here — recompressed from the original .rar to 7z, and
    trimmed to the single table the ladder reads (16.6 MB -> 2.1 MB).

    Refresh or replace one with:
        python tools/expansions.py --vendor <dump.dbc> --key <key>
    """
    archive: str
    member: str
    origin: str

    @property
    def ref(self) -> str:
        return self.archive


@dataclass(frozen=True)
class Source:
    where: Archive | Pack | Vendored
    role: str = ORIGIN
    note: str = ""


@dataclass(frozen=True)
class Expansion:
    """One rung. Every per-expansion difference is a field here."""
    key: str  # stable id, and the `xpac:` search value
    label: str  # "Wrath of the Lich King"
    short: str  # "WotLK" — the text form, for tooltips/export
    major: int  # game major version — indexes CFG.expansionLogos
    max_level: int  # the level cap this expansion shipped with
    sources: tuple[Source, ...]
    aliases: tuple[str, ...] = ()  # extra words `added:` accepts
    wowhead: str = ""  # Wowhead site prefix ("" = retail)
    caveat: str = ""  # data restriction, carried into the tooltip
    tint: str = ""  # optional palette hook for the tag

    @property
    def origins(self) -> tuple[Source, ...]:
        return tuple(s for s in self.sources if s.role == ORIGIN)


# ---------------------------------------------------------------------------
# THE LADDER — oldest first. The order IS the derivation.
#
# Pre-Legion rungs take the ORIGINAL era client as their origin, never the
# Classic re-release: the re-releases are modern rebuilds carrying content that
# never existed then (Classic Era holds 16,124 spells the real 1.12.1 client did
# not, which alone mis-credited 3,438 spells to Vanilla). Where we ship the
# matching re-release pack it rides along as a `parallel` source, so the two are
# measured against each other in the report without one polluting the other.
# ---------------------------------------------------------------------------
LADDER: list[Expansion] = [
    Expansion(
        key="vanilla", label="Classic", short="Vanilla", major=1, max_level=60,
        aliases=("classic", "vanilla", "1"),
        wowhead="classic",
        sources=(
            Source(Archive("Spell.1.12.1.5875 (Retail) de4b8b4c6f5aab7901f196030cc8aec7.dbc")),
            Source(Pack("1.15.9"), PARALLEL,
                   "Classic Era is a modern rebuild — it carries thousands of "
                   "spells the 1.12.1 client never had, so it cannot date one"),
        ),
    ),
    Expansion(
        key="tbc", label="The Burning Crusade", short="TBC", major=2, max_level=70,
        aliases=("tbc", "bc", "burning crusade", "2"),
        wowhead="tbc",
        sources=(Source(Archive("Spell.2.4.3.8606 (Retail) 497e7d555537366dab10d691c210d25a.dbc")),),
    ),
    Expansion(
        key="wotlk", label="Wrath of the Lich King", short="WotLK", major=3, max_level=80,
        aliases=("wotlk", "wrath", "lich king", "3"),
        wowhead="wotlk",
        sources=(
            Source(Archive("Spell.3.3.5.12340 (Retail) 543b9fe61355b6a77a01714d52fea2e5.dbc")),
            Source(Pack("3.4.3"), PARALLEL,
                   "WotLK Classic is a faithful rebuild — it differs from 3.3.5 "
                   "by well under 1%, but it is still a rebuild"),
        ),
    ),
    Expansion(
        key="cata", label="Cataclysm", short="Cata", major=4, max_level=85,
        aliases=("cata", "cataclysm", "4"),
        wowhead="cata",
        sources=(Source(Archive("Spell.4.3.4.15595 (Retail) 78045add38a9ef6eb5c803c6a2b6dd1e.dbc")),),
    ),
    Expansion(
        key="mop", label="Mists of Pandaria", short="MoP", major=5, max_level=90,
        aliases=("mop", "mists", "pandaria", "5"),
        wowhead="mop",
        sources=(Source(Archive("Spell.5.4.8.18273 (Retail) 870c173a4809e69acea3a01520b3d09d.dbc")),),
    ),
    Expansion(
        key="wod", label="Warlords of Draenor", short="WoD", major=6, max_level=100,
        aliases=("wod", "warlords", "draenor", "6"),
        # THE ONE RUNG NO PUBLIC ARCHIVE COVERS. The wow.tools mirror carries no
        # "Retail" build before 8.x, and the bulk dumps holding the 6.x build
        # configs are switched off, so the CASC route is closed as well — hence a
        # vendored client dump. It was verified against that mirror's 6.2.4 PTR
        # build and is that build MINUS EXACTLY ONE RECORD: 205651 "Test Banner",
        # a test spell cut before launch which returns in Legion. That is the
        # signature of a real retail client, and it also bounds the whole
        # PTR-vs-retail question at one row.
        sources=(Source(Vendored("wod-6.2.4-spell.7z", "spell.dbc",
                                 "https://www.wowmodding.net/files/file/318-wod-624-db2-files/"
                                 " (sign-in required) -> dbfilesclient/spell.dbc"),
                        ORIGIN, "retail 6.2.4 client dump, vendored"),),
    ),
    Expansion(key="legion", label="Legion", short="Legion", major=7, max_level=110,
              aliases=("legion", "7"), sources=(Source(Pack("7.3.5")),)),
    Expansion(key="bfa", label="Battle for Azeroth", short="BfA", major=8, max_level=120,
              aliases=("bfa", "battle for azeroth", "azeroth", "8"),
              sources=(Source(Pack("8.3.7")),)),
    Expansion(key="shadowlands", label="Shadowlands", short="SL", major=9, max_level=60,
              aliases=("sl", "shadowlands", "9"), sources=(Source(Pack("9.2.7")),)),
    Expansion(key="dragonflight", label="Dragonflight", short="DF", major=10, max_level=70,
              aliases=("df", "dragonflight", "10"), sources=(Source(Pack("10.2.7")),)),
    Expansion(key="tww", label="The War Within", short="TWW", major=11, max_level=80,
              aliases=("tww", "war within", "11"), sources=(Source(Pack("11.2.7")),)),
    Expansion(key="midnight", label="Midnight", short="Midnight", major=12, max_level=90,
              aliases=("mn", "midnight", "12"), sources=(Source(Pack("12.0.7")),)),
]


def _archive_7z() -> Path:
    dst = CACHE_DIR / "Spell.7z"
    if not dst.exists():
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        print(f"  downloading {ARCHIVE_URL} (~150 MB, once)")
        with urllib.request.urlopen(ARCHIVE_URL, timeout=600) as r, dst.open("wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
    return dst


def write_vendored(dump: Path, key: str) -> None:
    """Commit a client table for one rung, recompressed to 7z.

    Takes the raw .dbc out of whatever the upstream pack happened to be (a .rar,
    in Warlords' case) and stores just that table, so the repo carries 2.1 MB
    instead of a 250 MB folder or a 21 MB archive of 517 unrelated tables.
    """
    xp = next((x for x in LADDER if x.key == key), None)
    if xp is None:
        raise SystemExit(f"no expansion keyed {key!r} in LADDER")
    dest = next((s.where for s in xp.sources if isinstance(s.where, Vendored)), None)
    if dest is None:
        raise SystemExit(f"{key!r} declares no Vendored source to write")

    ids = _wdbc_ids(dump.read_bytes())  # parse first: never commit an unreadable file
    SOURCES.mkdir(parents=True, exist_ok=True)
    staged = CACHE_DIR / "vendor" / dest.member
    staged.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(dump, staged)
    out = SOURCES / dest.archive
    out.unlink(missing_ok=True)
    subprocess.run(["7z", "a", "-t7z", "-mx=9", "-m0=lzma2", str(out), str(staged)],
                   check=True, stdout=subprocess.DEVNULL)
    print(f"wrote {out.relative_to(REPO)}  ({out.stat().st_size / 1024 / 1024:.1f} MB, "
          f"{len(ids):,} ids from {dump.name})")


def _wdbc_ids(blob: bytes) -> set[int]:
    """Spell IDs from a WDBC record block (field 0 is the key in every build).

    Only the record block is validated: some archived copies carry bytes past
    the string block, which is irrelevant here and must not fail the parse.
    """
    magic, n, _fields, rec, _strings = struct.unpack_from("<4sIIII", blob, 0)
    if magic != b"WDBC":
        raise ValueError(f"not a WDBC file (magic {magic!r})")
    if len(blob) < 20 + n * rec:
        raise ValueError("record block is truncated")
    ids = {struct.unpack_from("<I", blob, 20 + i * rec)[0] for i in range(n)}
    if len(ids) != n:
        raise ValueError("field 0 is not unique — wrong column for the ID")
    return ids


def ids_of(where: Archive | Pack | Vendored) -> set[int]:
    """The spell IDs behind one source. The only place the kinds differ."""
    if isinstance(where, Pack):
        matches = sorted((REPO / "site" / "data").glob(f"{where.version}.*"))
        if not matches:
            raise SystemExit(f"no shipped pack for version {where.version}")
        # Spell ids are structure, so `core` alone has them.
        return set(packfile.load(matches[-1], want=("core",))["spells"]["ids"])

    if isinstance(where, Vendored):
        src = SOURCES / where.archive
        if not src.exists():
            raise SystemExit(f"missing {src}\n  it is committed — restore it from git,"
                             f"\n  or rebuild it from: {where.origin}")
        out = CACHE_DIR / "vendor" / where.member
        if not out.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["7z", "e", str(src), f"-o{out.parent}", where.member, "-y"],
                           check=True, stdout=subprocess.DEVNULL)
        return _wdbc_ids(out.read_bytes())

    out = CACHE_DIR / "builds" / where.member
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["7z", "e", str(_archive_7z()), f"-o{out.parent}",
                        where.member, "-y"], check=True, stdout=subprocess.DEVNULL)
    return _wdbc_ids(out.read_bytes())


def restated() -> dict:
    """The committed file with its ladder re-read off `LADDER`, ids untouched.

    A rung has two halves and they age differently. Which spell ids it claims is
    DERIVED, frozen, and expensive to reproduce -- it wants era clients out of a
    150 MB archive. What the rung IS -- its label, its search words, its level
    cap -- is a DECLARATION right here, and adding a field to it should not cost
    a re-derivation of history that cannot have changed.

    So this rewrites only what the declaration owns. A rung the committed file
    does not have is refused rather than invented: its ids are the half this
    cannot produce, and a rung with none would silently claim no spells.
    """
    with gzip.open(OUT, "rt", encoding="utf-8") as handle:
        data = json.load(handle)
    derived = {rung["key"]: rung for rung in data["ladder"]}
    missing = [xp.key for xp in LADDER if xp.key not in derived]
    if missing:
        raise SystemExit(f"no committed ids for {', '.join(missing)} — "
                         f"run without --restate to derive them")

    ladder = []
    for xp in LADDER:
        was = derived[xp.key]
        ladder.append({
            "key": xp.key, "label": xp.label, "short": xp.short,
            "major": xp.major, "maxLevel": xp.max_level,
            "aliases": list(xp.aliases), "wowhead": xp.wowhead,
            **({"caveat": xp.caveat} if xp.caveat else {}),
            **({"tint": xp.tint} if xp.tint else {}),
            # The derived half, carried through exactly as it was measured.
            "sources": was["sources"], "total": was["total"],
            "introduced": was["introduced"],
        })
        print(f"  {xp.label:<24} max level {xp.max_level:>3}"
              f"  {was['introduced']:>7,} spells kept")
    return {"ladder": ladder, "ids": data["ids"]}


def build(report: bool = False) -> dict:
    seen: set[int] = set()
    era_of: dict[int, str] = {}
    rungs = []

    for xp in LADDER:
        srcs = []
        origin_ids: set[int] = set()
        for s in xp.sources:
            ids = ids_of(s.where)
            srcs.append({"ref": s.where.ref, "role": s.role,
                         "total": len(ids), **({"note": s.note} if s.note else {})})
            if s.role == ORIGIN:
                origin_ids |= ids

        fresh = origin_ids - seen
        seen |= origin_ids
        era_of.update(dict.fromkeys(fresh, xp.key))
        rungs.append({
            "key": xp.key, "label": xp.label, "short": xp.short,
            "major": xp.major, "maxLevel": xp.max_level,
            "aliases": list(xp.aliases), "wowhead": xp.wowhead,
            **({"caveat": xp.caveat} if xp.caveat else {}),
            **({"tint": xp.tint} if xp.tint else {}),
            "sources": srcs, "total": len(origin_ids), "introduced": len(fresh),
        })
        # ASCII only: this prints to a cp1252 console on Windows.
        print(f"  {xp.label:<24} {len(origin_ids):>7,} spells  {len(fresh):>7,} new"
              + ("   (!) " + xp.caveat if xp.caveat else ""))

        if report:
            for s in xp.sources:
                if s.role != PARALLEL:
                    continue
                other = ids_of(s.where)
                print(f"      parallel {s.where.ref}: {len(other):,} spells, "
                      f"{len(other - origin_ids):,} it adds, "
                      f"{len(origin_ids - other):,} it lacks")

    by_era: dict[str, list[int]] = {xp.key: [] for xp in LADDER}
    for sid, key in era_of.items():
        by_era[key].append(sid)
    # Stored as one sorted ID list per expansion — far smaller than a per-spell
    # map, and the consumer rebuilds the lookup in a single pass.
    return {"ladder": rungs, "ids": {k: sorted(v) for k, v in by_era.items()}}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--verify", action="store_true",
                    help="rebuild and compare with the committed file, writing nothing")
    ap.add_argument("--report", action="store_true",
                    help="also measure each parallel source against its rung")
    ap.add_argument("--restate", action="store_true",
                    help="rewrite only what LADDER declares (labels, words, "
                         "level caps), keeping the committed spell ids")
    ap.add_argument("--vendor", metavar="DUMP",
                    help="distil a client dump (.dbc) into build/sources/ and exit")
    ap.add_argument("--key", help="the LADDER key --vendor is writing for")
    args = ap.parse_args()

    if args.vendor:
        if not args.key:
            raise SystemExit("--vendor needs --key (which expansion it is for)")
        write_vendored(Path(args.vendor), args.key)
        return 0

    if args.restate:
        print(f"Restating the ladder in {OUT.name}, keeping its spell ids:")
        data = restated()
    else:
        print("Building the expansion ladder:")
        data = build(report=args.report)
    text = json.dumps(data, separators=(",", ":"))

    if args.verify:
        if not OUT.exists():
            print(f"\n{OUT.name} does not exist yet")
            return 1
        with gzip.open(OUT, "rt", encoding="utf-8") as f:
            same = f.read() == text
        print(f"\n{'identical' if same else 'CONTENT DIFFERS'} — nothing written")
        return 0 if same else 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0 so an unchanged rebuild is byte-identical and does not show up as a
    # repo change — the same rule tools/rebuild.py follows for the packs.
    with gzip.GzipFile(OUT, "wb", mtime=0) as f:
        f.write(text.encode("utf-8"))
    print(f"\nwrote {OUT.relative_to(REPO)}  ({OUT.stat().st_size / 1024:.0f} KB, "
          f"{sum(len(v) for v in data['ids'].values()):,} spells)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
