#!/usr/bin/env python3
"""Generate an in-game test sheet for Epsilon — one command per line.

    python tools/epsilon_test.py preventsanim            # a shipped flag, by handler
    python tools/epsilon_test.py TrackTargetInChannel    # or by its enum name
    python tools/epsilon_test.py 358                     # or by bit
    python tools/epsilon_test.py channelled --mode cast  # a derived delivery bucket
    python tools/epsilon_test.py --list                  # what can be tested

WHY THIS EXISTS
    Deciding whether a flag actually does anything on Epsilon needs the user in
    game, and their time is the expensive part. Hand-assembling those lists got
    a spell id FABRICATED once (30991 was claimed to be Permanent Feign Death;
    it is Stealth) and produced a batch whose examples were not channels at all,
    which made the answers meaningless. Both failures are mechanical, so they
    belong to a script.

THE THREE RULES IT ENCODES, each learned the hard way

    1. EPSILON TAKES ONE COMMAND AT A TIME. Every command is alone on its line
       with nothing after it, so the whole line can be copied blind. Commentary
       is always on its own `#` line.

    2. ALWAYS A CONTRAST PAIR. A flag-SET spell next to a flag-CLEAR one that
       is otherwise comparable. Without the control, "it looked normal" is not
       a verdict about the flag.

    3. SAMPLE THE INTERSECTION, NOT THE FLAG. `AllowActionsDuringChannel` alone
       samples spells that are not channels, and the user rightly refused to
       conclude anything from it. `requires` in the enum file says so, and this
       honours it — as does `--with`, for asking the same question by hand.

It reads `build/cache/epsilook.duckdb`, so it needs no cache of its own.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dossier import CACHE, ROOT, schema_for, select_pack  # noqa: E402

try:
    import duckdb  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    sys.exit("tools/epsilon_test.py needs DuckDB:  python -m pip install duckdb")

DB_PATH = CACHE / "epsilook.duckdb"
ENUM = ROOT / "build" / "enums" / "spell_attributes.json"

BOLD, DIM, GOLD, RESET = "\033[1m", "\033[2m", "\033[33m", "\033[0m"

# Delivery buckets are derived, not bits, so they are not in the enum file.
# Kept here as SQL predicates over a SpellMisc row aliased `m`, which is the
# only place this script knows anything the enum file does not.
DERIVED = {
    "channelled": "((m.Attributes_1 & 4) <> 0 OR (m.Attributes_1 & 64) <> 0)",
    "casttime": "NOT ((m.Attributes_1 & 4) <> 0 OR (m.Attributes_1 & 64) <> 0) "
                "AND coalesce(ct.\"Base\", 0) > 0",
    "instant": "NOT ((m.Attributes_1 & 4) <> 0 OR (m.Attributes_1 & 64) <> 0) "
               "AND coalesce(ct.\"Base\", 0) = 0",
}

# `.aura` is the workhorse: it applies and holds, and `.unaura` takes it off
# without relogging. `.cast` is what a spell actually DOES when cast, which is
# a different question for anything with a cast phase. `.npc set aura` puts it
# on a spawned target, which is the only way to judge anything target-side.
MODES = {
    "aura": ("apply to yourself and hold it",
             lambda sid: [f".aura {sid}", f".unaura {sid}"]),
    "cast": ("cast it at your current target",
             lambda sid: [f".cast {sid}"]),
    "self": ("cast it on yourself",
             lambda sid: [f".cast {sid} self"]),
    "npc": ("put it on a spawned NPC (select it first)",
            lambda sid: [f".npc set aura {sid}"]),
}


def load_flags() -> dict[str, dict[str, Any]]:
    """handler/name/bit -> the enum entry, plus the derived delivery buckets."""
    data = json.loads(ENUM.read_text(encoding="utf-8"))
    out: dict[str, dict[str, Any]] = {}
    for bit, meta in data["values"].items():
        entry = {"bit": int(bit), "name": meta["name"], "label": meta.get("label"),
                 "handler": meta.get("handler"), "requires": meta.get("requires"),
                 "context": meta.get("context")}
        out[str(bit)] = entry
        out[meta["name"].lower()] = entry
        if meta.get("handler"):
            out[meta["handler"]] = entry
    for word in DERIVED:
        out[word] = {"bit": None, "name": word, "label": f"delivery: {word}",
                     "handler": word, "requires": None, "context": None}
    return out


def bit_sql(bit: int) -> str:
    """The SpellMisc predicate for one attribute bit, as `m.Attributes_N & mask`."""
    column, offset = divmod(bit, 32)
    return f'(m."Attributes_{column}" & {1 << offset}) <> 0'


def predicate(entry: dict[str, Any], extra: int | None) -> str:
    """SET condition for a flag: its own bit, AND-ed with whatever qualifies it."""
    if entry["bit"] is None:
        base = DERIVED[entry["handler"]]
    else:
        base = bit_sql(entry["bit"])
    for req in (entry.get("requires"), extra):
        if req is not None:
            base = f"({base} AND {bit_sql(int(req))})"
    return base


def sample(con, schema: str, where: str, limit: int) -> list[tuple[int, str]]:
    """Spells matching `where`, preferring ones that actually render something.

    A test spell with no visual proves nothing you can SEE, which is the whole
    point of the exercise — so rows with a SpellXSpellVisual come first. Test
    and internal names are excluded: they are disproportionately broken, and a
    spell that does nothing because it is a stub reads exactly like a flag that
    does nothing.
    """
    sql = f"""
        SELECT m."SpellID", s.name
        FROM {schema}."SpellMisc" m
        JOIN {schema}.spells s ON s.spell_id = m."SpellID"
        LEFT JOIN {schema}."SpellCastTimes" ct ON ct."ID" = m."CastingTimeIndex"
        WHERE m."DifficultyID" = 0 AND ({where})
          AND s.name NOT ILIKE '%test%' AND s.name NOT ILIKE '%internal%'
          AND s.name NOT ILIKE '%unused%' AND s.name NOT ILIKE '%[dnt]%'
        ORDER BY EXISTS (SELECT 1 FROM {schema}."SpellXSpellVisual" x
                         WHERE x."SpellID" = m."SpellID") DESC,
                 m."SpellID"
        LIMIT {int(limit)}"""
    return [(int(i), n) for i, n in con.execute(sql).fetchall()]


def sheet(entry: dict[str, Any], pack: dict[str, Any], mode: str,
          count: int, extra: int | None) -> None:
    schema = schema_for(pack["id"])
    con = duckdb.connect(str(DB_PATH), read_only=True)
    where = predicate(entry, extra)
    control = f"NOT ({where})"
    if entry["bit"] is not None:
        # A control that is otherwise ALIKE: same channel-ness where the flag
        # only means anything on a channel. Comparing a channel against an
        # instant would answer a different question than the one being asked.
        req = entry.get("requires") or entry.get("context") or extra
        if req is not None:
            control = f"(NOT {bit_sql(entry['bit'])} AND {bit_sql(int(req))})"

    hits = sample(con, schema, where, count)
    controls = sample(con, schema, control, count)
    counted = con.execute(
        f'SELECT count(DISTINCT m."SpellID") FROM {schema}."SpellMisc" m '
        f'LEFT JOIN {schema}."SpellCastTimes" ct ON ct."ID" = m."CastingTimeIndex" '
        f'WHERE m."DifficultyID" = 0 AND ({where})').fetchone()
    total = int(counted[0]) if counted else 0
    con.close()

    verb, commands = MODES[mode]
    bit = "" if entry["bit"] is None else f" (bit {entry['bit']})"
    print(f"# {'=' * 74}")
    print(f"# {entry['name']}{bit} - {entry.get('label') or ''}")
    print(f"# {pack.get('label') or pack['id']} | {total:,} spells | mode: {verb}")
    if entry.get("requires") is not None:
        print(f"# INTERSECTED with bit {entry['requires']} — the flag alone samples "
              f"spells it cannot mean anything for.")
    print(f"# {'=' * 74}")
    print("#")
    print("# HOW: copy ONE line at a time. Compare the SET block against the")
    print("#      CONTROL block - without the control there is no verdict.")

    for title, rows in (("SET - the flag is on these", hits),
                        ("CONTROL - flag off, otherwise comparable", controls)):
        print(f"\n# {'-' * 72}\n# {title}\n# {'-' * 72}")
        if not rows:
            print("# (none on this build)")
        for sid, name in rows:
            print(f"\n# {sid}  {name}")
            for line in commands(sid):
                print(line)


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("flag", nargs="?", help="handler, enum name, bit, or delivery bucket")
    ap.add_argument("--version", help="pack id or prefix (default: the pack marked default)")
    ap.add_argument("--mode", default="aura", choices=sorted(MODES),
                    help="which command form to emit (default: aura)")
    ap.add_argument("-n", "--count", type=int, default=3, help="spells per block")
    ap.add_argument("--with", dest="with_bit", type=int, metavar="BIT",
                    help="also require this bit — the intersection rule, by hand")
    ap.add_argument("--list", action="store_true", help="what can be tested, and exit")
    args = ap.parse_args()

    if not DB_PATH.exists():
        return int(bool(sys.stderr.write(
            f"missing {DB_PATH} — run: python tools/builddb.py\n")))

    flags = load_flags()
    if args.list or not args.flag:
        print(f"{BOLD}shipped flags{RESET} (searchable in the app)")
        seen = set()
        for entry in flags.values():
            if entry["handler"] and entry["name"] not in seen:
                seen.add(entry["name"])
                bit = "derived" if entry["bit"] is None else f"bit {entry['bit']}"
                print(f"  {GOLD}{entry['handler']:<22}{RESET} {entry['name']:<28} {DIM}{bit}{RESET}")
        print(f"\n{DIM}any of the 449 names or bit numbers also works, "
              f"e.g. `epsilon_test.py NoAuraIcon`{RESET}")
        return 0

    found = flags.get(args.flag.lower())
    if found is None:
        print(f"unknown flag {args.flag!r} - try --list", file=sys.stderr)
        return 1

    sheet(found, select_pack(args.version), args.mode, args.count, args.with_bit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
