#!/usr/bin/env python3
"""The route reference, and the graph it draws: every table, field and section the build declares.

    python tools/routes.py                        # the reference, as markdown
    python tools/routes.py --check                # exit 1 where docs/reference/routes.md is stale
    python tools/routes.py --write                # rewrite it
    python tools/routes.py --upstream soundRows   # everything a table, field or section is built from
    python tools/routes.py --downstream SoundKit  # everything built from it

The reference is written from the registries in `build/pack`, so it cannot
describe a route that is not there; every build of the default pack rewrites
it, and `tools/check.py` runs `--check`. Its numbers are the default pack's
manifest counts, read from the committed manifest here and from the fresh one
by the build, which are the same numbers once the build is committed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "build"))

from pack.__main__ import DATA_DIR, REFERENCE, ROSTER  # noqa: E402
from pack.emit.reference import Reference, document  # noqa: E402
from pack.pipeline import route_reference  # noqa: E402


def default_pack() -> tuple[str, dict[str, int]]:
    """The default pack's identity and its manifest counts, as committed."""
    roster = json.loads(ROSTER.read_text(encoding="utf-8"))
    chosen = next((entry for entry in roster if entry.get("default")), None)
    if chosen is None:
        sys.exit(f"error: {ROSTER} names no default pack")
    manifest = json.loads((DATA_DIR.parent / chosen["file"]).read_text(encoding="utf-8"))
    return chosen["id"], manifest["meta"]["counts"]


def walk(ref: Reference, name: str, direction: str) -> str:
    """Every node reached from each node carrying a name, grouped by kind."""
    starts = ref.nodes_named(name)
    if not starts:
        sys.exit(f"error: no table, field or section is named {name}")
    blocks: list[str] = []
    for start in starts:
        reached = ref.upstream(start) if direction == "upstream" else ref.downstream(start)
        verb = "is built from" if direction == "upstream" else "builds"
        lines = [f"{start.name} ({start.kind}) {verb}:"]
        for kind in ("section", "field", "table"):
            named = [node.name for node in reached if node.kind == kind]
            if named:
                lines.append(f"  {kind + 's':9} {', '.join(named)}")
        if len(lines) == 1:
            lines.append("  nothing")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="exit 1 where the committed reference is stale")
    ap.add_argument("--write", action="store_true", help="rewrite the reference")
    ap.add_argument("--upstream", metavar="NAME", help="what a table, field or section is built from")
    ap.add_argument("--downstream", metavar="NAME", help="what is built from a table, field or section")
    args = ap.parse_args()
    pack, counts = default_pack()
    ref = route_reference(counts, pack)
    if args.upstream or args.downstream:
        print(walk(ref, args.upstream or args.downstream, "upstream" if args.upstream else "downstream"))
        return
    fresh = document(ref)
    if args.write:
        REFERENCE.parent.mkdir(parents=True, exist_ok=True)
        REFERENCE.write_bytes(fresh.encode("utf-8"))
        print(f"wrote {REFERENCE.relative_to(ROOT)}")
        return
    if not args.check:
        sys.stdout.write(fresh)
        return
    held = REFERENCE.read_bytes().decode("utf-8").replace("\r\n", "\n") if REFERENCE.exists() else ""
    if held != fresh:
        sys.exit(f"error: {REFERENCE.relative_to(ROOT)} is stale; run python tools/routes.py --write")
    print("route reference current")


if __name__ == "__main__":
    main()
