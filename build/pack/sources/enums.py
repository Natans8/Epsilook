"""What a db2 enum value means, from the three places the answer lives.

Checked-in files under ``build/enums`` carry the values this build interprets
itself; WoWDBDefs carries the community's names for the rest; wow.tools carries
the animation names. The latter two are refetched every build.
"""

from __future__ import annotations

import json
import sys
import re
from typing import Any

from ..progress import log
from .cache import BUILD_DIR, CACHE_DIR, download_volatile

ENUMS_DIR = BUILD_DIR / "enums"
"""Checked-in enum tables: values this build decides the meaning of itself."""

# Animation names indexed by AnimID (Stand=0, ...), maintained by wow.tools
ANIMS_JS_URL = "https://raw.githubusercontent.com/Marlamin/wow.tools.local/main/wwwroot/js/anims.js"

# Enum value names from WoWDBDefs meta/enums. SpellEffect names
# SpellEffect.Effect (SPELL_EFFECT_* without the prefix), SpellEffectAura names
# SpellEffect.EffectAura (SPELL_AURA_*).
WOWDBDEFS_ENUM_URL = "https://raw.githubusercontent.com/wowdev/WoWDBDefs/master/meta/enums/{name}.dbde"
ENUM_FILES = ["SpellEffect", "SpellEffectAura", "Target"]


def load_local_enum(name: str) -> dict[int, Any]:
    """Load a checked-in build/enums/<name>.json enum into {value: payload}.

    The payload is whatever the file holds: a name string, an int, or a
    per-value metadata dict; see enums/README.md for the format. A missing or
    malformed file is a hard error.
    """
    data = json.loads((ENUMS_DIR / f"{name}.json").read_text(encoding="utf-8"))
    return {int(k): v for k, v in data["values"].items()}


def enum_ids_where(mapping: dict[int, Any], handler: str) -> set[int]:
    """Select the enum values whose metadata dict carries this handler."""
    return {k for k, v in mapping.items()
            if isinstance(v, dict) and v.get("handler") == handler}


def enum_id_where(mapping: dict[int, Any], handler: str) -> int:
    """Select the one enum value with this handler; error unless exactly one."""
    ids = enum_ids_where(mapping, handler)
    if len(ids) != 1:
        sys.exit(f"error: enums expected exactly one value for handler "
                 f"'{handler}', got {sorted(ids)}")
    return next(iter(ids))


def read_anim_names() -> list[str]:
    """Parse the animationNames JS array (index = AnimID)."""
    src = (CACHE_DIR / "anims.js").read_text(encoding="utf-8")
    names = re.findall(r'"([^"]*)"', src)
    if len(names) < 1000 or names[0] != "Stand":
        sys.exit("error: anims.js did not parse as expected")
    return names


def read_enum_names(name: str, version: str) -> dict[int, str]:
    """Parse a WoWDBDefs meta/enums .dbde file into {value: NAME}.

    Format: one "ID NAME" per line, optionally "// comment" suffixed, and some
    lines carry a "(BUILD a-b, c-d)" guard restricting which game builds the
    name applies to. Lines with no name are skipped.
    """
    ver = tuple(int(p) for p in version.split("."))
    names: dict[int, str] = {}
    for line in (CACHE_DIR / "enums" / f"{name}.dbde").read_text(encoding="utf-8").splitlines():
        line = line.split("//", 1)[0].strip()
        if line.startswith("(BUILD "):
            guard, _, line = line[len("(BUILD "):].partition(")")
            line = line.strip()

            def in_range(rng: str) -> bool:
                # Compared over as many components as the guard names. A guard
                # written `7.3.5` against a build of `7.3.5.26972` would other-
                # wise compare short-and-therefore-less at both ends and match
                # nothing, dropping the name on the build it was written for.
                lo, _, hi = rng.strip().partition("-")
                lo_t = tuple(int(p) for p in lo.split("."))
                hi_t = tuple(int(p) for p in hi.split(".")) if hi else lo_t
                return lo_t <= ver[:len(lo_t)] and ver[:len(hi_t)] <= hi_t

            if not any(in_range(r) for r in guard.split(",")):
                continue
        m = re.fullmatch(r"(\d+) ([A-Z][A-Z0-9_]*)", line)
        if m:
            names[int(m.group(1))] = m.group(2)
    if len(names) < 100:
        sys.exit(f"error: enums/{name}.dbde did not parse as expected ({len(names)} names)")
    return names



def fetch_enum_names() -> None:
    """Refresh the animation names and the WoWDBDefs enum lists.

    Unconditional: both keep being corrected for game builds that shipped years
    ago.
    """
    log("Animation names (wow.tools):")
    download_volatile(ANIMS_JS_URL, CACHE_DIR / "anims.js")

    log("Enum names (wowdev/WoWDBDefs):")
    for name in ENUM_FILES:
        download_volatile(WOWDBDEFS_ENUM_URL.format(name=name),
                          CACHE_DIR / "enums" / f"{name}.dbde")
