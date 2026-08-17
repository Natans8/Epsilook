#!/usr/bin/env python3
"""Everything the data knows about one spell, followed to the leaves.

    python tools/dossier.py 133                  # Fireball, readable summary
    python tools/dossier.py fireball             # by name (exact match wins, lowest id)
    python tools/dossier.py polymorph --list     # every name match, nothing else
    python tools/dossier.py 133 --json           # the whole document on stdout, for jq
    python tools/dossier.py 3562 1953 --diff     # two spells, side by side
    python tools/dossier.py 116 --version 1.15   # any cached pack, not just the default
    python tools/dossier.py --packs              # which packs this database carries

WHY IT EXISTS
    Answering "what IS this spell" means eight ad-hoc queries across SpellMisc,
    SpellEffect, the SpellXSpellVisual -> SpellVisual -> SpellVisualEvent ->
    SpellVisualKit chain, the kit-effect dispatch, the missile set and the
    listfile - and then decoding four enums by hand. This walks the whole graph
    once and emits a single structure, with every id RESOLVED beside its raw
    value so the output is both readable and checkable.

    It reads `.cache/epsilook.duckdb` (tools/builddb.py) and nothing else.
    It is a DEVELOPMENT tool: nothing in `site/` or `build/` imports it, and
    tools/check.py does not run it, for the same reason it does not run
    builddb.py - the database is a disposable cache, not a product invariant.

EVERY ID IS RESOLVED, AND A FAILURE TO RESOLVE IS VISIBLE
    Ids come out as {"id": n, "name": "..."} and FileDataIDs as
    {"fid": n, "path": "..."}. A value that could not be decoded keeps its
    number and gains no name, so a missing decode shows up as an absence of
    prose rather than as a plausible-looking wrong answer.

A TABLE THE PACK DOES NOT HAVE IS REPORTED, NOT AN EXCEPTION
    The Classic re-releases carry far fewer tables than retail - Vanilla has no
    Mount, no ShadowyEffect, no BarrageEffect and no TrinityCore world dump at
    all. Every query names its tables, so a query against an absent one returns
    nothing and the table is listed under `absent_tables` in the output. That
    is what makes `--version 1.15` usable instead of a stack trace.

ROUTES FOLLOWED TO A LEAF - everything means everything:

  identity     SpellName, Spell (subtext/description/aura description)
  era          presence across every cached pack, incl. "retired"
  misc         SpellMisc: schools, attribute bits unpacked, icon file,
               cast/duration/range indices, speed
  effects      SpellEffect: effect + aura enums, both implicit targets,
               mechanic, radius, base points, aura period, trigger spell
  ENTITIES     EffectMiscValue dispatched BY EFFECT/AURA (it is a different id
               space per effect) ->
                 creature   -> tdb_creature_template -> creature_template_model
                             -> CreatureDisplayInfo -> CreatureModelData -> .m2
                 gameobject -> tdb_gameobject_template -> GameObjectDisplayInfo
                 vehicle    -> Vehicle -> VehicleSeat -> M2 attachment
                 shapeshift -> SpellShapeshiftForm -> up to 4 displays
               plus SummonProperties on a summon's second slot, and
               EffectItemType -> ItemSearchName -> ItemModifiedAppearance ->
               ItemAppearance -> ItemDisplayInfo -> models + its three kits
  mount        Mount.SourceSpellID -> MountXDisplay -> CreatureDisplayInfo
  visuals      SpellXSpellVisual -> SpellVisual -> SpellVisualEvent (start/end
               phase + target type) -> SpellVisualKit, and the missile set ->
               SpellVisualMissile -> motion name + attachment pair
  kit effects  dispatched by EffectType, ALL of them:
                 1  SpellProceduralEffect -- dispatched AGAIN by Type into
                    chain / tint / scale / anim replacement / area model /
                    alpha / item visual / desaturate / weapon trail
                 5  SoundKit -> SoundKitEntry -> sound files
                 6  SpellVisualAnim -> named anims + AnimKit -> its segments
                 7  ShadowyEffect  -> two packed colours + attach
                 8  SpellEffectEmission -> SpellVisualKitAreaModel -> .m2
                 11 DissolveEffect -> TextureBlendSet -> textures
                 12 EdgeGlowEffect -> packed colour + alpha
                 13 BeamEffect -> SpellChainEffects -> colour + textures
                 17 BarrageEffect -> SpellVisualEffectName -> .m2
                 19 SpellVisualScreenEffect -> ScreenEffect -> FullScreenEffect
  attachments  SpellVisualKitModelAttach -> SpellVisualEffectName -> model +
               texture, M2 attachment name, positioner, AnimKit
  assets       every {fid, path} anywhere in the finished document, deduped and
               sorted by kind -- so a route added later is included for free
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import re
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from packs import schema_name
from repo import CACHE

try:
    # The `type: ignore` is REQUIRED, not cosmetic: tools/check.py type-checks
    # all of tools/, and CI runs it on a machine that has never installed
    # duckdb. Without this, mypy fails with import-not-found and the whole
    # check goes red over an optional dependency of a development tool.
    import duckdb  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - the one dependency, and it is optional
    sys.exit(
        "tools/dossier.py needs DuckDB, which pyproject.toml declares:\n"
        "    uv run python tools/dossier.py"
    )

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = CACHE / "epsilook.duckdb"
VERSIONS_JSON = ROOT / "site" / "data" / "versions.json"

EPSILOOK = "https://natans8.github.io/Epsilook/?v={build}&q=id%3A{id}"
WOWHEAD = "https://www.wowhead.com/{prefix}spell={id}"
SCHOOLS = ["Physical", "Holy", "Fire", "Nature", "Frost", "Shadow", "Arcane", "school7"]

BOLD, DIM, GOLD, RESET = "\033[1m", "\033[2m", "\033[33m", "\033[0m"

# Every query names its tables as {V}."Name", so the tables a query needs can be
# read straight off the SQL - which is what lets an absent table be reported
# instead of raising. A typo lands in the same list, so it is self-diagnosing.
TABLE_RE = re.compile(r'\{V}\."(\w+)"')


# ------------------------------------------------------------------ the packs

def packs() -> list[dict[str, Any]]:
    """site/data/versions.json - the same manifest tools/rebuild.py reads."""
    return json.loads(VERSIONS_JSON.read_text(encoding="utf-8"))


def select_pack(wanted: str | None) -> dict[str, Any]:
    """The pack whose build id starts with `wanted`, or the manifest default."""
    every = packs()
    if not wanted:
        for entry in every:
            if entry.get("default"):
                return entry
        return every[0]
    hits = [e for e in every if e["id"].startswith(wanted)]
    if not hits:
        known = ", ".join(e["id"] for e in every)
        sys.exit(f"no pack id starts with {wanted!r}\nknown: {known}")
    return hits[0]


def wowhead_prefix(build_id: str) -> str:
    """Vanilla ids only resolve on Wowhead's Classic site (config.ts's rule)."""
    return "classic/" if build_id.split(".")[0] == "1" else ""


@lru_cache(maxsize=1)
def _expansion_ladder() -> tuple[list[dict[str, Any]], dict[int, int]]:
    """The committed expansion ladder, or empty if it has not been generated."""
    path = Path(__file__).resolve().parent.parent / "build" / "expansion_ids.json.gz"
    if not path.exists():
        return [], {}
    with gzip.open(path, "rt", encoding="utf-8") as f:
        data = json.load(f)
    rungs = data["ladder"]
    return rungs, {sid: i for i, r in enumerate(rungs) for sid in data["ids"][r["key"]]}


def expansion_of(sid: int) -> str | None:
    """The expansion that introduced a spell ID — the full label, or None."""
    rungs, index = _expansion_ladder()
    i = index.get(sid)
    return rungs[i]["label"] if i is not None else None


def delivery_secs(ms: int) -> str:
    """A delivery time as the number the APP prints — `deliverySecs` in src/data.ts.

    A port rather than a shared implementation, because one side is TypeScript
    in the browser and the other is Python here; so it is spelled to agree
    exactly, and that is the whole reason it is a named function instead of an
    f-string. `ms / 1000:g` was the old spelling and it disagrees on the six
    values that are not on a 10 ms grid: 333, 666, 1333, 1625 and 2125 ms of
    cast time, and a 1 ms channel. `floor(x + 0.5)`, not `round()`, because
    Python rounds halves to EVEN and JavaScript rounds them UP — 1625 ms is
    1.63 in the app and would be 1.62 here.
    """
    return f"{math.floor(ms / 10 + 0.5) / 100:g}"


class Dossier:
    def __init__(self, pack: dict[str, Any]) -> None:
        if not DB_PATH.exists():
            sys.exit(f"no exploration database at {DB_PATH}\n"
                     f"build it first:  python tools/builddb.py")
        self.build: str = pack["id"]
        self.label: str = pack.get("label") or self.build
        self.ver = schema_name(self.build)
        self.con = duckdb.connect(str(DB_PATH), read_only=True)
        self.V = f'"{self.ver}"'

        # `spells` is builddb.py's own view over the pre-BfA table split: Legion
        # keeps the name on `Spell` and everything else on `SpellName`. Reading
        # the view is what makes every pack answer the same question, and it is
        # the same "do not re-derive what the tooling already resolved" rule the
        # build follows with SPELL_NAME_SOURCES.
        self.schemas = {s for s, in self.con.execute(
            "SELECT DISTINCT table_schema FROM information_schema.tables "
            "WHERE table_name = 'spells'").fetchall()}
        if self.ver not in self.schemas:
            have = ", ".join(sorted(self.schemas))
            sys.exit(f"{self.label} is not in {DB_PATH.name} (no schema {self.ver})\n"
                     f"cached: {have}\n"
                     f"add it:  python tools/builddb.py {'.'.join(self.build.split('.')[:3])}")

        self.tables = {t.lower() for t, in self.con.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = ?",
            [self.ver]).fetchall()}
        self.ref_tables = {t.lower() for t, in self.con.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'ref'").fetchall()}
        self.absent: set[str] = set()

        self.enum: dict[str, dict[int, str]] = {}
        for e, v, n in self._ref("SELECT enum_name, value, name FROM ref.enum_value"):
            self.enum.setdefault(e, {})[int(v)] = n
        self.path = dict(self._ref("SELECT fid, path FROM ref.listfile"))
        self.anim = dict(self._ref("SELECT anim_id, name FROM ref.anim_name"))
        self.anim_emote = self._anim_emotes()
        self.gob_display = self._gob_displays()
        self.attach = dict(self._ref("SELECT attachment_id, name FROM ref.m2_attachment"))
        self.kit_kind = {int(t): (n, note) for t, n, note in self._ref(
            "SELECT effect_type, target_table, note FROM ref.kit_effect_type")}
        self.proc_kind = {int(t): b for t, b in self._ref(
            "SELECT type, becomes FROM ref.proc_type")}
        self.motion = self._motion_names()

    # ------------------------------------------------------------------ helpers
    def _ref(self, sql: str) -> list[tuple]:
        """A `ref` lookup. Absent on a partially built database; not fatal."""
        table = sql.split("FROM ")[-1].split()[0]
        if table.split(".")[-1].lower() not in self.ref_tables:
            self.absent.add(table)
            return []
        return self.con.execute(sql).fetchall()

    def available(self, sql: str) -> bool:
        """False - and the table remembered - if this pack does not carry it."""
        missing = [t for t in TABLE_RE.findall(sql) if t.lower() not in self.tables]
        self.absent.update(missing)
        return not missing

    def q(self, sql: str, *a: Any) -> list[tuple]:
        if not self.available(sql):
            return []
        return self.con.execute(sql.replace("{V}", self.V), list(a)).fetchall()

    def rows(self, sql: str, *a: Any) -> list[dict[str, Any]]:
        if not self.available(sql):
            return []
        cur = self.con.execute(sql.replace("{V}", self.V), list(a))
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    def _motion_names(self) -> dict[int, str]:
        """Missile flight-path names, from the database or the build's own CSV.

        SpellMissileMotion joined the build at pack format 34, so a database
        built before that has the CSV in `.cache/<build>/` but no table.
        Both are read, newest first, because neither is guaranteed.
        """
        got = {int(i): n for i, n in
               self.q('SELECT "ID", "Name" FROM {V}."SpellMissileMotion"') if n}
        if got:
            return got
        path = CACHE / self.build / "SpellMissileMotion.csv"
        if not path.exists():
            return {}
        with open(path, encoding="utf-8", errors="replace") as fh:
            got = {int(r["ID"]): r["Name"] for r in csv.DictReader(fh)
                   if r.get("ID", "").isdigit() and r.get("Name")}
        if got:  # the CSV answered, so the missing table cost nothing to report
            self.absent.discard("SpellMissileMotion")
        return got

    def _attr_names(self) -> dict[int, dict[str, Any]]:
        """bit -> {name, label, handler} for the 449 spell attribute flags.

        `ref.spell_attribute` first, then the checked-in enum the database is
        itself built from — same "both are read, newest first" rule as
        _motion_names, so a database built before the table existed still names
        its bits instead of printing bare indices.
        """
        got = {int(b): {"name": n, "label": lb, "handler": h}
               for b, n, lb, h in
               self._ref("SELECT bit, name, label, handler FROM ref.spell_attribute")}
        if got:
            return got
        path = ROOT / "build" / "enums" / "spell_attributes.json"
        if not path.exists():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        got = {int(b): {"name": m["name"], "label": m.get("label", m["name"]),
                        "handler": m.get("handler")}
               for b, m in data["values"].items()}
        if got:
            self.absent.discard("ref.spell_attribute")
        return got

    # -------------------------------------------------------------- name search
    def find(self, text: str, limit: int = 20) -> tuple[list[dict[str, Any]], int]:
        """Spells whose name contains `text`, exact matches first. (rows, total)."""
        like = f"%{text.lower()}%"
        total = self.q('SELECT count(*) FROM {V}."spells" WHERE lower(name) LIKE ?', like)
        found = self.rows(
            'SELECT n.spell_id AS id, n.name AS name, s."NameSubtext_lang" AS subtext,'
            '       EXISTS(SELECT 1 FROM {V}."SpellXSpellVisual" x '
            '              WHERE x."SpellID" = n.spell_id) AS renders '
            'FROM {V}."spells" n LEFT JOIN {V}."Spell" s ON s."ID" = n.spell_id '
            'WHERE lower(n.name) LIKE ? '
            'ORDER BY (lower(n.name) = ?) DESC, length(n.name), n.spell_id '
            'LIMIT ?', like, text.lower(), limit)
        return found, int(total[0][0]) if total else 0

    # -------------------------------------------------------------- entities
    # WHICH EFFECT/AURA MAKES EffectMiscValue POINT AT WHAT. MiscValue is a
    # DIFFERENT ID SPACE PER EFFECT -- the same per-category collision the main
    # project records for `ref` -- so it is only ever resolved through this
    # table, never guessed from the number. {effect: (kind, which misc slot)}
    EFFECT_MISC = {
        28: ("creature", 0), 56: ("creature", 0), 85: ("creature", 0),
        188: ("creature", 0), 260: ("creature", 0), 199: ("creature", 0),
        76: ("gameobject", 0), 104: ("gameobject", 0), 171: ("gameobject", 0),
        86: ("gameobject", 0), 87: ("gameobject", 0), 88: ("gameobject", 0),
    }
    # TRANSFORM/MOUNTED TAKE A CREATURE **ENTRY**, NOT A DISPLAY ID, and the
    # first cut of this file had TRANSFORM wrong. It looked plausible --
    # Polymorph's 16372 IS a valid CreatureDisplayInfo row -- and resolved to
    # `character/gnome/female/gnomefemale_hd.m2`, a gnome, for a sheep spell.
    # As an ENTRY, 16372 is "Polymorphed Sheep". TrinityCore settles it:
    # HandleAuraTransform does GetCreatureTemplate(GetMiscValue()) and then
    # ChooseDisplayId. THE WRONG ID SPACE STILL RESOLVES -- that is the whole
    # danger of MiscValue, and why a route gets checked against a spell whose
    # answer you already know.
    AURA_MISC = {
        56: ("creature", 0),  # TRANSFORM
        78: ("creature", 0),  # MOUNTED
        487: ("creature", 0),  # COSMETIC_MOUNTED
        296: ("vehicle", 0),  # SET_VEHICLE_ID
        36: ("shapeshift", 0),  # MOD_SHAPESHIFT
    }

    def creature(self, entry: Any) -> dict[str, Any] | None:
        """TDB creature entry -> name, and on to its display(s) and model file.

        TWO MODEL ROUTES, and the modern one has to be tried first: recent TDB
        dumps leave `creature_template.modelid1..4` at 0 and put the displays in
        `creature_template_model` instead (Imp, entry 416, is the worked case --
        modelid1 is 0 and the real display is in the side table). Older dumps
        only have the columns, so both are read.
        """
        if not entry:
            return None
        d: dict[str, Any] = {"entry": int(entry)}
        r = self.q('SELECT name, modelid1, modelid2, modelid3, modelid4 '
                   'FROM {V}."tdb_creature_template" WHERE entry=?', int(entry))
        if not r:
            d["note"] = ("no TrinityCore world dump for this pack"
                         if "tdb_creature_template" in self.absent
                         else "not in the TDB world dump (spawns nothing in game)")
            return d
        d["name"] = r[0][0]
        ids = [x for x, in self.q('SELECT "CreatureDisplayID" FROM '
                                  '{V}."tdb_creature_template_model" WHERE "CreatureID"=? '
                                  'ORDER BY "Idx"', int(entry))]
        ids = ids or [v for v in r[0][1:] if v]
        disp = [x for x in (self.creature_display(i) for i in ids) if x]
        if disp:
            d["displays"] = disp
        return d

    def creature_display(self, did: Any) -> dict[str, Any] | None:
        """CreatureDisplayInfo -> CreatureModelData -> the actual .m2."""
        if not did:
            return None
        d: dict[str, Any] = {"display_id": int(did)}
        r = self.rows('SELECT * FROM {V}."CreatureDisplayInfo" WHERE "ID"=?', int(did))
        if not r:
            return d
        c = r[0]
        d["scale"] = c.get("CreatureModelScale")
        d["alpha"] = c.get("CreatureModelAlpha")
        d["particle_color_id"] = c.get("ParticleColorID") or None
        d["npc_sound_id"] = c.get("NPCSoundID") or None
        d["state_kit_id"] = c.get("StateSpellVisualKitID") or None
        d["anim_replacement_set"] = c.get("AnimReplacementSetID") or None
        m = self.rows('SELECT * FROM {V}."CreatureModelData" WHERE "ID"=?', c.get("ModelID"))
        if m:
            d["model"] = self.file_ref(m[0].get("FileDataID"))
        return d

    def gameobject(self, entry: Any) -> dict[str, Any] | None:
        """TDB gameobject entry -> name/type -> GameObjectDisplayInfo -> .m2."""
        if not entry:
            return None
        d: dict[str, Any] = {"entry": int(entry)}
        r = self.q('SELECT name, "displayId", type FROM {V}."tdb_gameobject_template" '
                   'WHERE entry=?', int(entry))
        if not r:
            d["note"] = ("no TrinityCore world dump for this pack"
                         if "tdb_gameobject_template" in self.absent
                         else "not in the TDB world dump (spawns nothing in game)")
            return d
        d["name"], did, d["type"] = r[0][0], r[0][1], r[0][2]
        d["type_name"] = self.enum.get("GameObjectType", {}).get(int(d["type"] or 0))
        if did:
            g = self.rows('SELECT * FROM {V}."GameObjectDisplayInfo" WHERE "ID"=?', did)
            d["display_id"] = int(did)
            if g:
                d["model"] = self.file_ref(g[0].get("FileDataID"))
        return d

    def item(self, iid: Any) -> dict[str, Any] | None:
        """Item id -> its searchable name, and on to its display/visual kits."""
        if not iid:
            return None
        d: dict[str, Any] = {"item_id": int(iid)}
        r = self.q('SELECT "Display_lang","OverallQualityID","ItemLevel" '
                   'FROM {V}."ItemSearchName" WHERE "ID"=?', int(iid))
        if r:
            d["name"], quality, d["item_level"] = r[0][0], r[0][1], r[0][2]
            d["quality"] = self.enum.get("ItemQuality", {}).get(int(quality or 0))
        else:
            # ItemSearchName is the SEARCHABLE-item table and does not cover
            # every id -- quest and internal items are absent. Say so rather
            # than printing a name-shaped "?".
            d["note"] = "no row in ItemSearchName (quest/internal item)"
        a = self.q('SELECT "ItemAppearanceID" FROM {V}."ItemModifiedAppearance" '
                   'WHERE "ItemID"=?', int(iid))
        if a and a[0][0]:
            ap = self.q('SELECT "ItemDisplayInfoID" FROM {V}."ItemAppearance" '
                        'WHERE "ID"=?', a[0][0])
            if ap and ap[0][0]:
                di = self.rows('SELECT * FROM {V}."ItemDisplayInfo" WHERE "ID"=?', ap[0][0])
                if di:
                    x = di[0]
                    d["display"] = {
                        "display_info_id": ap[0][0],
                        "item_visual_id": x.get("ItemVisual") or None,
                        "particle_color_id": x.get("ParticleColorID") or None,
                        "models": [self.file_ref(x.get(f"ModelResourcesID_{i}")) for i in (0, 1)],
                        "state_kit_id": x.get("StateSpellVisualKitID") or None,
                        "sheathed_kit_id": x.get("SheathedSpellVisualKitID") or None,
                        "unsheathed_kit_id": x.get("UnsheathedSpellVisualKitID") or None,
                    }
        return d

    RIDER_ANIM_COLUMNS = {
        "EnterAnimStart": "enter", "EnterAnimLoop": "enter",
        "RideAnimStart": "sit", "RideAnimLoop": "sit",
        "RideUpperAnimStart": "sit", "RideUpperAnimLoop": "sit",
        "ExitAnimStart": "exit", "ExitAnimLoop": "exit", "ExitAnimEnd": "exit",
    }
    """The rider's animation columns under the role each plays in.

    The same split the pack ships as `spellPassengerAnims.roles`. Repeated
    rather than imported because no tool may reach into the build package, and
    a dossier that named the columns without the roles would describe a seat
    the pack no longer describes that way.
    """

    def vehicle(self, vid: Any) -> dict[str, Any] | None:
        """Vehicle -> its seats -> the M2 attachment each rider hangs off, and
        what the rider plays entering, seated and leaving."""
        if not vid:
            return None
        d: dict[str, Any] = {"vehicle_id": int(vid), "seats": []}
        v = self.rows('SELECT * FROM {V}."Vehicle" WHERE "ID"=?', int(vid))
        if not v:
            return d
        for i in range(8):
            seat_id = int(v[0].get(f"SeatID_{i}") or 0)
            if not seat_id:
                continue
            s = self.rows('SELECT * FROM {V}."VehicleSeat" WHERE "ID"=?', seat_id)
            if s:
                played: dict[str, list[int]] = {}
                for column, role in self.RIDER_ANIM_COLUMNS.items():
                    anim = int(s[0].get(column) or 0)
                    if anim > 0 and anim not in played.setdefault(role, []):
                        played[role].append(anim)
                d["seats"].append({"seat_id": seat_id,
                                   "attachment": self._attach(s[0].get("AttachmentID")),
                                   "rider_anims": played})
        return d

    def shapeshift(self, fid: Any) -> dict[str, Any] | None:
        """SpellShapeshiftForm -> up to four creature displays (one per race)."""
        if not fid:
            return None
        r = self.rows('SELECT * FROM {V}."SpellShapeshiftForm" WHERE "ID"=?', int(fid))
        if not r:
            return {"form_id": int(fid)}
        f = r[0]
        return {"form_id": int(fid), "name": f.get("Name_lang"),
                "creature_type": f.get("CreatureType"),
                "displays": [self.creature_display(f.get(f"CreatureDisplayID_{i}"))
                             for i in range(4) if f.get(f"CreatureDisplayID_{i}")]}

    def mount(self, sid: int) -> dict[str, Any] | None:
        """A spell that IS a mount: Mount.SourceSpellID -> its displays."""
        r = self.rows('SELECT * FROM {V}."Mount" WHERE "SourceSpellID"=?', sid)
        if not r:
            return None
        m = r[0]
        disp = [self.creature_display(d) for d, in
                self.q('SELECT "CreatureDisplayInfoID" FROM {V}."MountXDisplay" '
                       'WHERE "MountID"=?', m["ID"])]
        return {"mount_id": m["ID"], "name": m.get("Name_lang"),
                "source_text": m.get("SourceText_lang"),
                "special_kit_id": m.get("MountSpecialSpellVisualKitID") or None,
                "special_rider_anim_kit": m.get("MountSpecialRiderAnimKitID") or None,
                "displays": [d for d in disp if d]}

    def animkit(self, akid: Any) -> dict[str, Any] | None:
        """AnimKit -> its ordered segments -> named animations."""
        if not akid:
            return None
        d: dict[str, Any] = {"anim_kit_id": int(akid), "segments": []}
        k = self.rows('SELECT * FROM {V}."AnimKit" WHERE "ID"=?', int(akid))
        if k:
            d["one_shot_duration_ms"] = k[0].get("OneShotDuration") or None
        for s in self.rows('SELECT * FROM {V}."AnimKitSegment" '
                           'WHERE "ParentAnimKitID"=? ORDER BY "OrderIndex"', int(akid)):
            d["segments"].append({"order": s.get("OrderIndex"),
                                  "anim": self._anim(s.get("AnimID")),
                                  "speed": s.get("Speed"),
                                  "start_time_ms": s.get("AnimStartTime")})
        return d

    @staticmethod
    def rgb(packed: Any) -> dict[str, Any] | None:
        """Colours are packed 0xRRGGBB, high byte red (the project's own note)."""
        if packed is None:
            return None
        p = int(packed) & 0xFFFFFF
        return {"packed": int(packed), "r": (p >> 16) & 0xFF,
                "g": (p >> 8) & 0xFF, "b": p & 0xFF, "hex": f"#{p:06x}"}

    def enum_ref(self, enum: str, v: Any) -> dict[str, Any] | None:
        """{value, name} if the enum knows it, else {value}."""
        if v is None:
            return None
        d: dict[str, Any] = {"value": int(v)}
        n = self.enum.get(enum, {}).get(int(v))
        if n:
            d["name"] = n
        return d

    def _gob_displays(self) -> dict[int, int]:
        """Model file id -> the id `.gob spawn` takes, negated as the command wants.

        From the vendored table rather than the mirror, which holds game tables
        and not a private server's. A missing file is not an error, so a
        checkout without it still prints every other route.
        """
        path = ROOT / "build" / "sources" / "epsilon-gameobject-displays.csv.gz"
        if not path.exists():
            return {}
        with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
            return {int(r["fid"]): -int(r["display"]) for r in csv.DictReader(handle)}

    def file_ref(self, fid: Any) -> dict[str, Any] | None:
        """A FileDataID with its listfile path."""
        if not fid:
            return None
        d: dict[str, Any] = {"fid": int(fid)}
        p = self.path.get(int(fid))
        if p:
            d["path"] = p
        # what `.gob spawn` takes to place this model on Epsilon
        gob = self.gob_display.get(int(fid))
        if gob:
            d["epsilon_gob"] = gob
        return d

    def spell_ref(self, sid: Any) -> dict[str, Any] | None:
        if not sid:
            return None
        r = self.q('SELECT name FROM {V}."spells" WHERE spell_id=?', int(sid))
        d: dict[str, Any] = {"id": int(sid)}
        if r and r[0][0]:
            d["name"] = r[0][0]
            d["url"] = EPSILOOK.format(build=self.build, id=int(sid))
        return d

    # ------------------------------------------------------------------ sections
    def identity(self, sid: int) -> dict[str, Any]:
        nm = self.q('SELECT name FROM {V}."spells" WHERE spell_id=?', sid)
        sp = self.rows('SELECT * FROM {V}."Spell" WHERE "ID"=?', sid)
        return {
            "id": sid,
            "name": nm[0][0] if nm else None,
            "pack": {"build": self.build, "label": self.label, "schema": self.ver},
            "subtext": (sp[0].get("NameSubtext_lang") if sp else None) or None,
            # ⚠ THE RAW TEMPLATE, NOT WHAT THE PACK SHIPS. Since format 43 the
            # pack carries these cooked to placeholder-free prose by
            # the cooker in build/pack/derive/spelltext.py — `$@spelldesc159001` there is a whole
            # paragraph here. This tool reads the game tables rather than the
            # pack, so what it prints is the input to that step; the key names
            # say so rather than letting the two be mistaken for each other.
            "description_raw": (sp[0].get("Description_lang") if sp else None) or None,
            "aura_description_raw": (sp[0].get("AuraDescription_lang") if sp else None) or None,
            "links": {"epsilook": EPSILOOK.format(build=self.build, id=sid),
                      "wowhead": WOWHEAD.format(prefix=wowhead_prefix(self.build), id=sid)},
        }

    def era(self, sid: int) -> dict[str, Any]:
        """Which cached packs carry this id at all - first seen, and retired.

        The answer is only as good as the database: a pack that has never been
        loaded cannot be distinguished from one that lacks the spell, so the
        packs actually consulted are reported beside the verdict.
        """
        order = [(p["id"], p.get("label") or p["id"]) for p in packs()]
        checked = [(b, lbl) for b, lbl in order if schema_name(b) in self.schemas]
        present = []
        for build, label in checked:
            hit = self.con.execute(f'SELECT count(*) FROM "{schema_name(build)}"."spells" '
                                   'WHERE spell_id = ?', [sid]).fetchone()
            if hit and hit[0]:
                present.append(label)
        newest = checked[-1][1] if checked else None
        return {"first_seen": present[0] if present else None,
                "versions": present,
                # The AUTHORITATIVE answer to the same question. "first_seen"
                # above is only the oldest pack we happen to ship and cache —
                # for anything pre-Legion that is a Classic re-release, which is
                # a modern rebuild and cannot date a spell. This one comes from
                # the original era clients via build/expansion_ids.json.gz.
                "expansion": expansion_of(sid),
                "packs_checked": len(checked),
                "packs_known": len(order),
                "retired": bool(present) and newest is not None and newest not in present}

    def misc(self, sid: int) -> dict[str, Any] | None:
        r = self.rows('SELECT * FROM {V}."SpellMisc" WHERE "SpellID"=?', sid)
        if not r:
            return None
        m = r[0]
        # The row's OWN Attributes_N columns, not a fixed count: builds ship
        # between 14 and 17 of them, so a hardcoded range silently drops the
        # high bits on the widest ones (TBC and MoP Classic both have 17).
        words = sorted(
            (int(k.split("_")[1]), int(m.get(k) or 0))
            for k in m if k.startswith("Attributes_") and k.split("_")[1].isdigit())
        names = self._attr_names()
        attrs = []
        for w, v in words:
            for b in range(32):
                if (v >> b) & 1:
                    index = w * 32 + b
                    meta = names.get(index, {})
                    attrs.append({
                        "word": w, "bit": b, "index": index,
                        "name": meta.get("name"), "label": meta.get("label"),
                        # set = this bit is one the pack ships as a pill
                        "handler": meta.get("handler"),
                    })
        mask = int(m.get("SchoolMask") or 0)
        return {
            "schools": [SCHOOLS[b] for b in range(8) if (mask >> b) & 1],
            "school_mask": mask,
            "icon": self.file_ref(m.get("SpellIconFileDataID")),
            "casting_time_index": m.get("CastingTimeIndex"),
            "duration_index": m.get("DurationIndex"),
            # the two indexes above RESOLVED — an index is unreadable on its own
            # and this is the route the delivery line ships (DATA_ROUTES §3s-ter)
            "delivery": self.delivery(sid, m, {a["index"] for a in attrs if a["index"] is not None}),
            "range_index": m.get("RangeIndex"),
            "speed": m.get("Speed"),
            "launch_delay": m.get("LaunchDelay"),
            "attributes": attrs,
            "attribute_count": len(attrs),
        }

    def delivery(self, sid: int, misc: dict[str, Any], bits: set[int]) -> dict[str, Any]:
        """How the spell is delivered — the resolved cast time and channel.

        Mirrors the build's delivery route: it is NOT a partition, so a
        spell can carry both a cast time and a channel (3,148 do on 9.2.7, and
        they cast and THEN channel — verified in game). `cast_ms` 0 means no cast
        bar, including the -1000000 "ranged weapon speed" sentinel, which Epsilon
        fires with no bar. `channel_ms` -1 = no limit, 0 = flagged as a channel
        but shipping no duration row (674 on 9.2.7 — NOT the same thing).
        """
        cast = self._lookup_int("SpellCastTimes", "Base", misc.get("CastingTimeIndex"))
        channelled = bool(bits & {34, 38})  # IsChannelled / IsSelfChannelled
        out: dict[str, Any] = {
            "cast_ms": cast if cast and cast > 0 else 0,
            "weapon_speed_cast": cast == -1000000,
            "channelled": channelled,
            "channel_ms": 0,
            "breaks_on_move": False,
        }
        if channelled:
            raw = self._lookup_int("SpellDuration", "Duration", misc.get("DurationIndex"))
            if raw is not None:
                out["channel_ms"] = -1 if raw < 0 or raw > 100_000_000 else raw
            # the CHANNEL column, so SpellInterruptFlags — movement is bit 3
            # there, and bit 0 in the DIFFERENT enum the cast column uses
            r = self.rows('SELECT * FROM {V}."SpellInterrupts" WHERE "SpellID"=? '
                          'ORDER BY "DifficultyID"', sid)
            for row in r:
                cols = [int(row.get(k) or 0) for k in row
                        if k.startswith("ChannelInterruptFlags")]
                if any((w >> 3) & 1 for w in cols[:1]):
                    out["breaks_on_move"] = True
                    break
        return out

    def areas(self, sid: int) -> list[dict[str, Any]]:
        """WHERE the spell may be cast — the area gate (DATA_ROUTES §3t).

        The one gate the pack ships, because it is one of only two Epsilon
        enforces on `.cast` (the other is spell focus). Two flat hops with no
        decoder: RequiredAreasID -> AreaGroupMember.AreaID -> AreaTable.

        The area's OWN name, never its parent's — a group almost never covers a
        whole zone, so rolling up to the parent would assert something false.
        `root` is reported because it is what Wowhead has a page for.
        """
        # asked directly rather than through _lookup_int, which keys on "ID"
        r = self.rows('SELECT "RequiredAreasID" AS g FROM {V}."SpellCastingRequirements" '
                      'WHERE "SpellID"=?', sid)
        gid = int(r[0]["g"] or 0) if r else 0
        if not gid:
            return []
        out = []
        for row in self.rows(
                'SELECT a."ID" AS id, a."AreaName_lang" AS name, a."ParentAreaID" AS parent '
                'FROM {V}."AreaGroupMember" m JOIN {V}."AreaTable" a ON a."ID"=m."AreaID" '
                'WHERE m."AreaGroupID"=? ORDER BY a."AreaName_lang"', gid):
            aid = int(row["id"])
            root, seen = aid, set()
            while root not in seen:
                seen.add(root)
                p = self.rows('SELECT "ParentAreaID" AS p FROM {V}."AreaTable" '
                              'WHERE "ID"=?', root)
                nxt = int(p[0]["p"] or 0) if p else 0
                if not nxt:
                    break
                root = nxt
            out.append({"id": aid, "name": row["name"], "root": root, "group": gid})
        return out

    def _lookup_int(self, table: str, column: str, key: Any) -> int | None:
        """One integer column out of an index table, or None if it resolves to
        no row (index 0 usually does — these tables start at ID 1)."""
        if key in (None, ""):
            return None
        r = self.rows(f'SELECT "{column}" AS v FROM {{V}}."{table}" WHERE "ID"=?', int(key))
        return int(r[0]["v"]) if r and r[0]["v"] is not None else None

    def effects(self, sid: int) -> list[dict[str, Any]]:
        out = []
        for e in self.rows('SELECT * FROM {V}."SpellEffect" WHERE "SpellID"=? '
                           'ORDER BY "EffectIndex"', sid):
            tg = [self.enum_ref("Target", e[k]) for k in ("ImplicitTarget_0", "ImplicitTarget_1")
                  if e.get(k)]
            eff, aura = int(e.get("Effect") or 0), int(e.get("EffectAura") or 0)
            misc = [e.get("EffectMiscValue_0"), e.get("EffectMiscValue_1")]
            row: dict[str, Any] = {
                "index": e.get("EffectIndex"),
                "effect": self.enum_ref("SpellEffect", e.get("Effect")),
                "aura": self.enum_ref("SpellEffectAura", aura) if aura else None,
                "aura_period_ms": e.get("EffectAuraPeriod") or None,
                "targets": tg,
                "mechanic": e.get("EffectMechanic") or None,
                "radius_index": [e[k] for k in ("EffectRadiusIndex_0", "EffectRadiusIndex_1")
                                 if e.get(k)] or None,
                "base_points": e.get("EffectBasePointsF"),
                "misc_values": misc,
                "trigger_spell": self.spell_ref(e.get("EffectTriggerSpell")),
                "chain_targets": e.get("EffectChainTargets") or None,
            }
            # ---- the ENTITY the misc value points at, dispatched by effect/aura
            kind_slot = self.AURA_MISC.get(aura) if aura else self.EFFECT_MISC.get(eff)
            if kind_slot:
                kind, slot = kind_slot
                by_kind: dict[str, Callable[[Any], dict[str, Any] | None]] = {
                    "creature": self.creature,
                    "creature_display": self.creature_display,
                    "gameobject": self.gameobject,
                    "vehicle": self.vehicle,
                    "shapeshift": self.shapeshift,
                }
                resolved = by_kind[kind](misc[slot])
                if resolved:
                    row["entity"] = {"kind": kind, **resolved}
            # a SUMMON's second misc slot is its SummonProperties
            if eff in (28, 56) and misc[1]:
                sp = self.rows('SELECT * FROM {V}."SummonProperties" WHERE "ID"=?', misc[1])
                if sp:
                    row["summon_properties"] = {
                        "id": misc[1],
                        "control": self.enum_ref("SummonPropertiesControl", sp[0].get("Control")),
                        "title": sp[0].get("Title"),
                        "slot": self.enum_ref("SummonPropertiesSlot", sp[0].get("Slot"))}
            if e.get("EffectItemType"):
                row["creates_item"] = self.item(e["EffectItemType"])
            out.append(row)
        return out

    # ------------------------------------------------------------- visual chain
    def _chain_ids(self, beam_effect_id: Any) -> list[int]:
        """The chain ids one `BeamEffect.ID` draws, nesting expanded.

        `SpellVisualKitEffect.Effect` FOR TYPE 13 IS A `BeamEffect.ID`, NOT A
        CHAIN ID. Joining it straight onto SpellChainEffects does not fail --
        both id spaces are small integers -- it silently returns a DIFFERENT
        beam's textures. `Chain Heal` [1064] draws BeamEffect 100 -> chain 5242,
        nesting 5243 and 5244, and used to report chain 100's.
        """
        seen: set[int] = set()
        todo = [int(b) for b, in
                self.q('SELECT "BeamID" FROM {V}."BeamEffect" WHERE "ID"=?', beam_effect_id)
                if b]
        while todo:
            cid = todo.pop()
            if cid in seen:
                continue
            seen.add(cid)
            for c in self.rows('SELECT * FROM {V}."SpellChainEffects" WHERE "ID"=?', cid):
                for i in range(11):
                    sub = int(c.get(f"SpellChainEffectID_{i}") or 0)
                    if sub and sub not in seen:
                        todo.append(sub)
        return sorted(seen)

    def kit(self, kid: Any) -> dict[str, Any]:
        out: dict[str, Any] = {"id": int(kid), "effects": [], "attachments": []}
        for k in self.rows('SELECT * FROM {V}."SpellVisualKitEffect" '
                           'WHERE "ParentSpellVisualKitID"=?', kid):
            t = int(k["EffectType"])
            kind, _note = self.kit_kind.get(t, (f"type {t}", ""))
            ent: dict[str, Any] = {"effect_type": t, "becomes": kind,
                                   "effect_id": k["Effect"]}
            if t == 5:  # SoundKit
                ent["sounds"] = [self.file_ref(f) for f, in self.q(
                    'SELECT "FileDataID" FROM {V}."SoundKitEntry" WHERE "SoundKitID"=?',
                    k["Effect"])]
                # Blizzard's own name for the kit, where one exists. Universal
                # table (ref), because no 9.x+ build ships SoundKitName at all —
                # see builddb.ref.sound_kit_name.
                ent["sound_kit_name"] = self.sound_kit_name(k["Effect"])
            elif t == 6:  # SpellVisualAnim
                for a in self.rows('SELECT * FROM {V}."SpellVisualAnim" WHERE "ID"=?',
                                   k["Effect"]):
                    ent["initial_anim"] = self._anim(a.get("InitialAnimID"))
                    ent["loop_anim"] = self._anim(a.get("LoopAnimID"))
                    ent["anim_kit"] = self.animkit(a.get("AnimKitID"))
            elif t == 1:  # SpellProceduralEffect -- dispatched AGAIN by Type
                for p in self.rows('SELECT * FROM {V}."SpellProceduralEffect" WHERE "ID"=?',
                                   k["Effect"]):
                    ent.update(self.proc(p))
            elif t == 13:  # BeamEffect -> BeamID -> SpellChainEffects (+ nesting)
                chains = [c for cid in self._chain_ids(k["Effect"])
                          for c in self.rows(
                        'SELECT * FROM {V}."SpellChainEffects" WHERE "ID"=?', cid)]
                if chains:
                    ent["chain"] = [{
                        "id": c["ID"],
                        "colour": self.rgb((int(c["Red"] or 0) << 16)
                                           | (int(c["Green"] or 0) << 8) | int(c["Blue"] or 0)),
                        "alpha": c["Alpha"],
                        "textures": [self.file_ref(c[f"TextureFileDataID_{i}"]) for i in range(3)
                                     if c.get(f"TextureFileDataID_{i}")],
                        "particle_texture": self.file_ref(c.get("TextureParticleFileDataID")),
                        "sound_kit_id": c.get("SoundKitID") or None} for c in chains]
            elif t == 7:  # ShadowyEffect -- the ghost look, two packed colours
                for s in self.rows('SELECT * FROM {V}."ShadowyEffect" WHERE "ID"=?',
                                   k["Effect"]):
                    ent["shadowy"] = {"primary": self.rgb(s.get("PrimaryColor")),
                                      "secondary": self.rgb(s.get("SecondaryColor")),
                                      "attach": self._attach(s.get("AttachPos")),
                                      "duration": s.get("Duration")}
            elif t == 8:  # SpellEffectEmission -> SpellVisualKitAreaModel -> model
                for e2 in self.rows('SELECT * FROM {V}."SpellEffectEmission" WHERE "ID"=?',
                                    k["Effect"]):
                    am = self.rows('SELECT * FROM {V}."SpellVisualKitAreaModel" WHERE "ID"=?',
                                   e2.get("AreaModelID"))
                    ent["emission"] = {"rate": e2.get("EmissionRate"),
                                       "model_scale": e2.get("ModelScale"),
                                       "area_model": self.file_ref(am[0].get("ModelFileDataID"))
                                       if am else None}
            elif t == 11:  # DissolveEffect -> TextureBlendSet -> textures
                for dv in self.rows('SELECT * FROM {V}."DissolveEffect" WHERE "ID"=?',
                                    k["Effect"]):
                    bs = self.rows('SELECT * FROM {V}."TextureBlendSet" WHERE "ID"=?',
                                   dv.get("TextureBlendSetID"))
                    ent["dissolve"] = {
                        "attach": self._attach(dv.get("AttachID")),
                        "duration": dv.get("Duration"), "scale": dv.get("Scale"),
                        "textures": [self.file_ref(bs[0][f"TextureFileDataID_{i}"])
                                     for i in range(3)
                                     if bs and bs[0].get(f"TextureFileDataID_{i}")]}
            elif t == 12:  # EdgeGlowEffect -- the rim light
                for g in self.rows('SELECT * FROM {V}."EdgeGlowEffect" WHERE "ID"=?',
                                   k["Effect"]):
                    ent["edge_glow"] = {
                        "colour": self.rgb((int(g["GlowRed"] or 0) << 16)
                                           | (int(g["GlowGreen"] or 0) << 8)
                                           | int(g["GlowBlue"] or 0)),
                        "alpha": g.get("GlowAlpha"), "duration": g.get("Duration")}
            elif t == 17:  # BarrageEffect -> SpellVisualEffectName -> model
                for br in self.rows('SELECT * FROM {V}."BarrageEffect" WHERE "ID"=?',
                                    k["Effect"]):
                    ven = self.rows('SELECT * FROM {V}."SpellVisualEffectName" WHERE "ID"=?',
                                    br.get("SpellVisualEffectNameID"))
                    ent["barrage"] = {
                        "attach": self._attach(br.get("AttachmentPoint")),
                        "count": [br.get("ModelCountMin"), br.get("ModelCountMax")],
                        "cone_angle": br.get("ConeAngle"), "range": br.get("Range"),
                        "model": self.file_ref(ven[0].get("ModelFileDataID")) if ven else None}
            elif t == 19:  # SpellVisualScreenEffect -> ScreenEffect -> FullScreenEffect
                for sc in self.rows('SELECT * FROM {V}."SpellVisualScreenEffect" '
                                    'WHERE "ID"=?', k["Effect"]):
                    ent["screen_effect"] = self.screen(sc.get("ScreenEffectID"))
            out["effects"].append(ent)
        for a in self.rows('SELECT * FROM {V}."SpellVisualKitModelAttach" '
                           'WHERE "ParentSpellVisualKitID"=?', kid):
            ven = self.rows('SELECT * FROM {V}."SpellVisualEffectName" WHERE "ID"=?',
                            a["SpellVisualEffectNameID"])
            v = ven[0] if ven else {}
            out["attachments"].append({
                "attach_point": self._attach(a.get("AttachmentID")),
                "scale": a.get("Scale"),
                "positioner_id": a.get("PositionerID") or None,
                "anim_kit": self.animkit(a.get("AnimKitID")),
                "effect_name_id": a.get("SpellVisualEffectNameID"),
                "model": self.file_ref(v.get("ModelFileDataID")),
                "texture": self.file_ref(v.get("TextureFileDataID")),
                "effect_name_type": self.enum_ref("SpellVisualEffectNameType", v.get("Type")),
                "base_missile_speed": v.get("BaseMissileSpeed") or None,
                "dissolve_effect_id": v.get("DissolveEffectID") or None,
            })
        return out

    def proc(self, p: dict[str, Any]) -> dict[str, Any]:
        """SpellProceduralEffect: Type decides what Value_0..3 MEAN.

        The decode is the main project's, verified against 9.2.7 -- packed
        colours are 0xRRGGBB with the high byte red, and INT_MIN is "unset".
        A Type with no entry here keeps its raw values rather than being
        guessed at.
        """
        t = int(p["Type"])
        vals = [p[f"Value_{i}"] for i in range(4)]
        ent: dict[str, Any] = {"proc_type": t, "proc_meaning": self.proc_kind.get(t),
                               "proc_values": vals}
        if t in (0, 12, 26):  # chain / beam
            c = self.rows('SELECT * FROM {V}."SpellChainEffects" WHERE "ID"=?', vals[0])
            if c:
                ent["chain_effect"] = {
                    "id": vals[0],
                    "textures": [self.file_ref(c[0][f"TextureFileDataID_{i}"]) for i in range(3)
                                 if c[0].get(f"TextureFileDataID_{i}")]}
        elif t in (1, 22, 23):  # tint / CustomMaterial recolour
            ent["colour"] = self.rgb(vals[0] if t == 1 else vals[3])
        elif t == 2:
            ent["scale_pct"] = vals[0]
        elif t == 7:  # stand/walk/run anim replacement
            ent["replacement_anims"] = [self._anim(v) for v in vals[:3] if v]
        elif t == 9:  # Blizzard / area model
            am = self.rows('SELECT * FROM {V}."SpellVisualKitAreaModel" WHERE "ID"=?', vals[0])
            if am:
                ent["area_model"] = self.file_ref(am[0].get("ModelFileDataID"))
        elif t == 14:
            ent["alpha"] = vals[0]
        elif t == 17:  # AddItemVisual -> a real item
            ent["item"] = self.item(vals[1])
        elif t == 21:
            ent["desaturate_strength"] = vals[2]
        elif t == 27:  # modern weapon trail
            wt = self.rows('SELECT * FROM {V}."WeaponTrail" WHERE "ID"=?', vals[0])
            if wt:
                ent["weapon_trail"] = {
                    "model": self.file_ref(wt[0].get("FileDataID")),
                    "textures": [self.file_ref(wt[0][f"TextureFileDataID_{i}"]) for i in range(3)
                                 if wt[0].get(f"TextureFileDataID_{i}")]}
        return ent

    def screen(self, sid: Any) -> dict[str, Any] | None:
        """ScreenEffect -> FullScreenEffect: the whole-screen wash."""
        if not sid:
            return None
        d: dict[str, Any] = {"screen_effect_id": int(sid)}
        s = self.rows('SELECT * FROM {V}."ScreenEffect" WHERE "ID"=?', int(sid))
        if not s:
            return d
        d["name"] = s[0].get("Name")
        d["sound_ambience_id"] = s[0].get("SoundAmbienceID") or None
        d["zone_music_id"] = s[0].get("ZoneMusicID") or None
        f = self.rows('SELECT * FROM {V}."FullScreenEffect" WHERE "ID"=?',
                      s[0].get("FullScreenEffectID"))
        if f:
            x = f[0]
            d["full_screen"] = {
                "saturation": x.get("Saturation"),
                "gamma": [x.get("GammaRed"), x.get("GammaGreen"), x.get("GammaBlue")],
                "colour_multiply": [x.get("ColorMultiplyRed"), x.get("ColorMultiplyGreen"),
                                    x.get("ColorMultiplyBlue")],
                "colour_addition": [x.get(f"ColorAddition{c}") for c in
                                    ("Red", "Green", "Blue")],
            }
        return d

    def sound_kit_name(self, kit_id: Any) -> str | None:
        """Blizzard's name for a SoundKit, or None.

        Sparse by nature: only kits named on or before build 8.3.0 have one, so
        a miss is the normal case for Shadowlands-and-later content rather than
        a gap to chase. Reads ref.sound_kit_name, which is universal.
        """
        if not kit_id or int(kit_id) <= 0:
            return None
        rows = self.q('SELECT name FROM ref.sound_kit_name WHERE sound_kit_id=?', int(kit_id))
        return rows[0][0] if rows else None

    def _anim_emotes(self) -> dict[int, dict[str, int]]:
        """Which Epsilon emote performs each animation, one-shot and looping.

        Read from the checked-in table rather than the mirror: the mirror holds
        game tables, and this one is Epsilon's. A missing file is not an error,
        so a checkout without it still prints every other route.
        """
        path = ROOT / "build" / "enums" / "epsilon_emotes.json"
        if not path.exists():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        return {int(a): pair for a, pair in data["values"].items()}

    def _anim(self, a: Any) -> dict[str, Any] | None:
        if not a or int(a) < 0:
            return None
        d: dict[str, Any] = {"id": int(a)}
        n = self.anim.get(int(a))
        if n:
            d["name"] = n
        # the Epsilon emote a player performs this animation with; the id
        # `.mod anim` and `.mod standstate` both take, neither taking an
        # AnimationData id
        emote = self.anim_emote.get(int(a))
        if emote:
            d["epsilon_emote"] = dict(emote)
        return d

    def _attach(self, a: Any) -> dict[str, Any] | None:
        """An M2 attachment id.

        -1 IS NOT "unset" -- on these columns it means the WHOLE BODY (the main
        project's own note, from the Dissolve/Shadowy/Barrage attach columns
        where it is 70-77% of rows). -2 is a third state nobody has explained;
        it is reported as itself rather than folded into -1.
        """
        if a is None:
            return None
        a = int(a)
        d: dict[str, Any] = {"id": a}
        if a == -1:
            d["name"] = "full body"
        elif a == -2:
            d["name"] = "unexplained (-2)"
        else:
            n = self.attach.get(a)
            if n:
                d["name"] = n
        return d

    def visuals(self, sid: int) -> list[dict[str, Any]]:
        out = []
        for x in self.rows('SELECT * FROM {V}."SpellXSpellVisual" WHERE "SpellID"=?', sid):
            vid = x["SpellVisualID"]
            sv = self.rows('SELECT * FROM {V}."SpellVisual" WHERE "ID"=?', vid)
            v = sv[0] if sv else {}
            entry: dict[str, Any] = {
                "spell_visual_id": vid,
                "priority": x.get("Priority"),
                "probability": x.get("Probability"),
                "missile_attachment": self._attach(v.get("MissileAttachment")),
                "missile_destination": self._attach(v.get("MissileDestinationAttachment")),
                "events": [],
                "missiles": [],
            }
            for ev in self.rows('SELECT * FROM {V}."SpellVisualEvent" '
                                'WHERE "SpellVisualID"=? ORDER BY "StartEvent"', vid):
                entry["events"].append({
                    "starts_at": self.enum_ref("SpellVisualEventEvent", ev.get("StartEvent")),
                    "ends_at": self.enum_ref("SpellVisualEventEvent", ev.get("EndEvent")),
                    "target_type": self.enum_ref("SpellVisualEventTargetType", ev.get("TargetType")),
                    "kit": self.kit(ev["SpellVisualKitID"]) if ev.get("SpellVisualKitID")
                    else None,
                })
            mset = v.get("SpellVisualMissileSetID")
            if mset:
                for m in self.rows('SELECT * FROM {V}."SpellVisualMissile" '
                                   'WHERE "SpellVisualMissileSetID"=?', mset):
                    ven = self.rows('SELECT * FROM {V}."SpellVisualEffectName" WHERE "ID"=?',
                                    m["SpellVisualEffectNameID"])
                    mv = ven[0] if ven else {}
                    motion_id = int(m.get("SpellMissileMotionID") or 0)
                    entry["missiles"].append({
                        "model": self.file_ref(mv.get("ModelFileDataID")),
                        "texture": self.file_ref(mv.get("TextureFileDataID")),
                        "flight_path": ({"id": motion_id,
                                         "name": self.motion.get(motion_id)}
                                        if motion_id else None),
                        "from": self._attach(m.get("Attachment")),
                        "to": self._attach(m.get("DestinationAttachment")),
                        "speed": mv.get("BaseMissileSpeed") or None,
                        "follow_ground": m.get("FollowGroundApproach") or None,
                        "anim_kit": self.animkit(m.get("AnimKitID")),
                    })
            out.append(entry)
        return out

    def shapeshift_bar(self, sid: int) -> dict[str, Any] | None:
        """SpellShapeshift: which forms this spell is usable in / excluded from."""
        r = self.rows('SELECT * FROM {V}."SpellShapeshift" WHERE "SpellID"=?', sid)
        if not r:
            return None
        s = r[0]
        return {"bar_order": s.get("StanceBarOrder"),
                "mask": [s.get("ShapeshiftMask_0"), s.get("ShapeshiftMask_1")],
                "exclude": [s.get("ShapeshiftExclude_0"), s.get("ShapeshiftExclude_1")]}

    @staticmethod
    def assets(doc: dict[str, Any]) -> dict[str, Any]:
        """Every file the spell reaches, anywhere in the document, deduped.

        WALKS THE FINISHED STRUCTURE RATHER THAN THE ROUTES. The first cut
        hand-listed the places a file could appear (attachments, missiles,
        chain textures) and therefore silently missed every route added after
        it -- creature models, area models, barrage models, dissolve masks,
        weapon trails, item models. Anything shaped {"fid": ..., "path": ...} is
        a file, wherever it turns up, so a new route is included for free.

        Sorted by kind from the path, because the leaf tells you what it is and
        the route it arrived by does not.
        """
        seen: dict[int, dict[str, Any]] = {}

        def walk(o: Any) -> None:
            if isinstance(o, dict):
                if "fid" in o and len(o) <= 2:
                    seen[o["fid"]] = o
                else:
                    for v in o.values():
                        walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)

        walk({k: v for k, v in doc.items() if k != "assets"})
        out: dict[str, Any] = {"models": [], "textures": [], "sounds": [], "other": []}
        for f in seen.values():
            p = (f.get("path") or "").lower()
            k = ("models" if p.endswith(".m2") else
                 "textures" if p.endswith(".blp") else
                 "sounds" if p.endswith((".ogg", ".mp3", ".wav")) else "other")
            out[k].append(f)
        out["counts"] = {k: len(v) for k, v in out.items() if k != "counts"}
        return out

    def build_doc(self, sid: int) -> dict[str, Any]:
        doc = self.identity(sid)
        doc["era"] = self.era(sid)
        doc["misc"] = self.misc(sid)
        doc["areas"] = self.areas(sid)
        doc["effects"] = self.effects(sid)
        doc["visuals"] = self.visuals(sid)
        doc["mount"] = self.mount(sid)
        doc["shapeshift_bar"] = self.shapeshift_bar(sid)
        doc["assets"] = self.assets(doc)
        doc["summary"] = {
            "effects": len(doc["effects"]),
            "auras": sum(1 for e in doc["effects"] if e["aura"]),
            "visuals": len(doc["visuals"]),
            "kits": sum(len(v["events"]) for v in doc["visuals"]),
            "missiles": sum(len(v["missiles"]) for v in doc["visuals"]),
            "renders": doc["assets"]["counts"]["models"] > 0
                       or doc["assets"]["counts"]["sounds"] > 0,
            "files": sum(v for v in doc["assets"]["counts"].values()),
        }
        # Reported LAST, so it covers every table any section tried to read.
        doc["absent_tables"] = sorted(self.absent)
        return doc


# ---------------------------------------------------------------- readable form
def show(d: dict[str, Any], full: bool = False) -> None:
    cap = None if full else 4
    print(f"\n{'=' * 92}")
    print(f"  {BOLD}{d['name']}{RESET}  [{d['id']}]"
          + (f"  - {d['subtext']}" if d.get("subtext") else "")
          + f"   {DIM}{d['pack']['label']}{RESET}")
    print(f"{'=' * 92}")
    print(f"  {d['links']['epsilook']}")
    e = d["era"]
    era_note = "" if e["packs_checked"] == e["packs_known"] else \
        f" (only {e['packs_checked']} of {e['packs_known']} packs cached)"
    if e.get("expansion"):
        print(f"  added in {GOLD}{e['expansion']}{RESET}")
    print(f"  first seen {GOLD}{e['first_seen'] or '?'}{RESET}"
          f"  in {len(e['versions'])} packs{era_note}"
          + (f"  {GOLD}[RETIRED]{RESET}" if e["retired"] else ""))
    m = d["misc"] or {}
    print(f"  school {', '.join(m.get('schools') or ['-'])}   "
          f"{m.get('attribute_count', 0)} attribute flags   "
          f"icon {(m.get('icon') or {}).get('path', '-')}")
    dl = m.get("delivery") or {}
    if dl:
        segs = []
        if dl.get("cast_ms"):
            segs.append(f"{delivery_secs(dl['cast_ms'])} sec cast")
        if dl.get("channelled"):
            ms = int(dl.get("channel_ms", 0))
            segs.append("unlimited channel" if ms < 0
                        else f"{delivery_secs(ms)} sec channel" if ms else "channel")
        if dl.get("breaks_on_move"):
            segs.append("breaks on move")
        # the sentinel ANNOTATES the answer, it does not replace it: these
        # spells are instant in Epsilon, and the note says why there is no number
        line = " · ".join(segs) or "Instant"
        if dl.get("weapon_speed_cast"):
            line += f"  {DIM}(no cast bar — cast time is the ranged weapon speed){RESET}"
        print(f"  {GOLD}delivery{RESET} {line}")
    # WHERE it may be cast. Printed in full rather than clamped: the whole point
    # of the gate is which places are on the list, and 65% of gated spells name
    # exactly one.
    areas = d.get("areas") or []
    if areas:
        names = [a["name"] or f"#{a['id']}" for a in areas]
        print(f"  {GOLD}only in{RESET} {', '.join(names)}"
              f"  {DIM}(area group {areas[0]['group']}){RESET}")
    # The flags the app SHIPS as pills are called out by name, because they are
    # the ones that answer "why does this spell behave like that" — the rest are
    # a 449-bit haystack and stay behind --full.
    attrs = m.get("attributes") or []
    shipped = [a for a in attrs if a.get("handler")]
    if shipped:
        print(f"  {GOLD}flags{RESET} " + ", ".join(
            f"{a['name']} ({a['index']})" for a in shipped))
    if full and attrs:
        named = [a for a in attrs if a.get("name")]
        for i in range(0, len(named), 3):
            print("    " + DIM + "  ".join(
                f"{a['index']:>3} {a['name'][:26]:<26}" for a in named[i:i + 3]) + RESET)
    s = d["summary"]
    print(f"  {s['effects']} effects ({s['auras']} auras) - {s['visuals']} visuals, "
          f"{s['kits']} kit events, {s['missiles']} missiles - "
          f"{'RENDERS' if s['renders'] else 'renders NOTHING'}")
    if d["absent_tables"]:
        print(f"  {DIM}absent from this pack: {', '.join(d['absent_tables'])}{RESET}")

    print(f"\n  {BOLD}EFFECTS{RESET}")
    for x in d["effects"]:
        bits = [f"#{x['index']}", (x["effect"] or {}).get("name", "?")]
        if x["aura"]:
            bits.append(f"aura {x['aura'].get('name', x['aura']['value'])}")
        if x["targets"]:
            bits.append("-> " + ", ".join(t.get("name", str(t["value"])) for t in x["targets"]))
        if x["trigger_spell"]:
            bits.append(f"triggers {x['trigger_spell'].get('name', x['trigger_spell']['id'])}")
        print("    " + "  ".join(bits))
        ent = x.get("entity")
        if ent:
            nm = ent.get("name") or ent.get("note") or ent.get("form_id") or ""
            head = (f"{ent['kind']} "
                    f"{ent.get('entry', ent.get('display_id', ent.get('vehicle_id', '')))}")
            print(f"        -> {head}  {nm}")
            for dsp in (ent.get("displays") or ([ent] if ent.get("model") else [])):
                if dsp.get("model"):
                    print(f"           display {dsp.get('display_id', '?')}: "
                          f"{dsp['model'].get('path', dsp['model']['fid'])}")
            if ent.get("model"):
                print(f"           model: {ent['model'].get('path', ent['model']['fid'])}")
            for seat in (ent.get("seats") or [])[:cap]:
                print(f"           seat {seat['seat_id']} at "
                      f"{(seat.get('attachment') or {}).get('name', '?')}")
                for role, anims in (seat.get("rider_anims") or {}).items():
                    print(f"             rider {role}: "
                          + ", ".join(str(anim) for anim in anims))
        if x.get("summon_properties"):
            sp = x["summon_properties"]
            print(f"        -> summon properties: "
                  f"{(sp.get('control') or {}).get('name', '?')} / title {sp.get('title')}")
        if x.get("creates_item"):
            it = x["creates_item"]
            print(f"        -> creates item {it.get('item_id')}  "
                  + (f"{it['name']}  [{it.get('quality', '?')}]" if it.get("name")
                     else it.get("note", "unresolved")))

    print(f"\n  {BOLD}VISUAL CHAIN{RESET}")
    for v in d["visuals"]:
        print(f"    visual {v['spell_visual_id']}")
        for ev in v["events"]:
            k = ev.get("kit") or {}
            kinds = ", ".join(sorted({e2["becomes"] for e2 in k.get("effects", [])})) or "-"
            tt = ev.get("target_type") or {}
            tt_name = tt.get("name") or (f"tt{tt['value']}" if "value" in tt else "-")
            print(f"      {(ev['starts_at'] or {}).get('name', '?'):>16} "
                  f"-> {(ev['ends_at'] or {}).get('name', '?'):<16} kit {k.get('id', '-')}"
                  f"  on {tt_name:<12} [{kinds}]  {len(k.get('attachments', []))} attach")
            for a in k.get("attachments", [])[:cap]:
                if a.get("model"):
                    print(f"{'':24}  {(a['attach_point'] or {}).get('name', '?')}: "
                          f"{a['model'].get('path', a['model']['fid'])}")
        for mi in v["missiles"]:
            fp = (mi.get("flight_path") or {}).get("name") or "-"
            print(f"      missile {(mi.get('model') or {}).get('path', '?')}"
                  f"  {(mi.get('from') or {}).get('name', '?')} -> "
                  f"{(mi.get('to') or {}).get('name', '?')}  [{fp}]")

    a = d["assets"]
    print(f"\n  {BOLD}ASSETS{RESET}  {a['counts']['models']} models, "
          f"{a['counts']['textures']} textures, {a['counts']['sounds']} sounds")
    for k in ("models", "textures", "sounds", "other"):
        for x in a[k][:cap]:
            print(f"    {k[:-1]:8s} {x.get('path', x['fid'])}")
        if cap and len(a[k]) > cap:
            print(f"    {DIM}{'':8s} ... {len(a[k]) - cap} more (--full){RESET}")


def show_matches(text: str, found: list[dict[str, Any]], total: int) -> None:
    print(f"\n  {total} spell{'' if total == 1 else 's'} match {text!r}"
          + (f", showing {len(found)}" if total > len(found) else ""))
    for r in found:
        mark = "" if r["renders"] else f"  {DIM}(renders nothing){RESET}"
        sub = f"  - {r['subtext']}" if r["subtext"] else ""
        print(f"    {r['id']:>7}  {r['name']}{sub}{mark}")


def diff(a: dict[str, Any], b: dict[str, Any]) -> None:
    """Two dossiers side by side -- the comparison half of the job.

    Set-compares the things that decide whether two spells are alike, and says
    which side each difference is on: shared assets are why a pair looks alike,
    and unshared ones are why it does not.
    """

    def fids(d: dict[str, Any], k: str) -> set[str]:
        return {str(x.get("path", x["fid"])) for x in d["assets"][k]}

    def eff(d: dict[str, Any]) -> set[str]:
        return {(e["effect"] or {}).get("name", "?")
                + (f"/{e['aura']['name']}" if e.get("aura") and "name" in e["aura"] else "")
                for e in d["effects"]}

    def tgt(d: dict[str, Any]) -> set[str]:
        return {t.get("name", str(t["value"])) for e in d["effects"] for t in e["targets"]}

    def phases(d: dict[str, Any]) -> set[str]:
        return {(ev["starts_at"] or {}).get("name", "?")
                for v in d["visuals"] for ev in v["events"]}

    def attrs(d: dict[str, Any]) -> set[Any]:
        # Name where the decode has one, bare index where it does not, so a
        # difference reads as "one has PreventsAnim" rather than "one has 50".
        return {x.get("name") or x["index"]
                for x in (d["misc"] or {}).get("attributes", [])}

    print(f"\n{'=' * 96}")
    print(f"  {BOLD}{a['name']} [{a['id']}]   vs   {b['name']} [{b['id']}]{RESET}")
    print(f"{'=' * 96}")
    rows: list[tuple[str, set[Any], set[Any]]] = [
        ("school", set((a["misc"] or {}).get("schools", [])),
         set((b["misc"] or {}).get("schools", []))),
        ("effects", eff(a), eff(b)),
        ("targets", tgt(a), tgt(b)),
        ("cast phases", phases(a), phases(b)),
        ("models", fids(a, "models"), fids(b, "models")),
        ("sounds", fids(a, "sounds"), fids(b, "sounds")),
        ("textures", fids(a, "textures"), fids(b, "textures")),
        ("attribute bits", attrs(a), attrs(b)),
    ]
    for label, sa, sb in rows:
        both, only_a, only_b = sa & sb, sa - sb, sb - sa
        if not (sa or sb):
            continue
        j = len(both) / max(len(sa | sb), 1)
        print(f"\n  {BOLD}{label.upper()}{RESET}   shared {len(both)}/{len(sa | sb)}  "
              f"(Jaccard {j:.2f})")
        if both:
            print(f"    {GOLD}BOTH:{RESET}   "
                  f"{', '.join(str(x)[:58] for x in sorted(both, key=str)[:6])}")
        if only_a:
            print(f"    only {a['name'][:20]}: "
                  f"{', '.join(str(x)[:52] for x in sorted(only_a, key=str)[:5])}")
        if only_b:
            print(f"    only {b['name'][:20]}: "
                  f"{', '.join(str(x)[:52] for x in sorted(only_b, key=str)[:5])}")


# ------------------------------------------------------------------------- cli
def resolve(d: Dossier, words: list[str]) -> list[int]:
    """Spell ids from the command line: numbers as-is, anything else a name.

    A name that matches EXACTLY takes the lowest such id and says so - that is
    what makes `dossier.py fireball` land on 133 rather than on a shortlist.
    Anything else prints the matches and stops, because guessing between 4,000
    substring hits is not a service.
    """
    if all(w.isdigit() for w in words):
        return [int(w) for w in words]
    text = " ".join(words)
    found, total = d.find(text)
    if not found:
        sys.exit(f"no spell name contains {text!r} in {d.label}")
    exact = [r for r in found if r["name"].lower() == text.lower()]
    if exact:
        if len(exact) > 1 or total > 1:
            others = ", ".join(str(r["id"]) for r in exact[1:6])
            print(f"  {DIM}{total} spells match {text!r}; taking the lowest exact id"
                  + (f" (also {others}{', ...' if len(exact) > 6 else ''})" if others else "")
                  + f"{RESET}")
        return [int(exact[0]["id"])]
    show_matches(text, found, total)
    sys.exit(f"\n{text!r} is not an exact spell name - pick an id from the list above")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Everything the data knows about one spell, followed to the leaves.",
        epilog="reads .cache/epsilook.duckdb (build it with tools/builddb.py)")
    ap.add_argument("spell", nargs="*", help="spell ids, or a name to look up")
    ap.add_argument("--version", metavar="V",
                    help="pack to read, by build-id prefix (default: the manifest default)")
    ap.add_argument("--json", nargs="?", const="-", metavar="PATH",
                    help="emit JSON instead of the summary; bare = stdout")
    ap.add_argument("--print", action="store_true", dest="readable",
                    help="the readable summary as well as --json")
    ap.add_argument("--diff", action="store_true", help="compare exactly two spells")
    ap.add_argument("--full", action="store_true", help="do not truncate the lists")
    ap.add_argument("--list", action="store_true", dest="list_only",
                    help="list the name matches and stop")
    ap.add_argument("--packs", action="store_true", help="list the cached packs and stop")
    args = ap.parse_args()

    if args.packs:
        every = packs()
        con = duckdb.connect(str(DB_PATH), read_only=True) if DB_PATH.exists() else None
        cached = {s for s, in con.execute(
            "SELECT DISTINCT table_schema FROM information_schema.tables "
            "WHERE table_name = 'spells'").fetchall()} if con else set()
        print(f"\n  {DB_PATH}"
              + ("" if con else f"  {DIM}(not built - run tools/builddb.py){RESET}"))
        for e in every:
            here = schema_name(e["id"]) in cached
            flag = "default" if e.get("default") else ""
            print(f"    {'*' if here else ' '} {e['id']:<20} {e['label']:<26}"
                  f" {schema_name(e['id']):<15} {flag}")
        print(f"\n  {DIM}* = in the database; --version takes any id prefix{RESET}")
        return

    if not args.spell:
        ap.error("give a spell id or a name (or --packs)")

    d = Dossier(select_pack(args.version))

    if args.list_only:
        text = " ".join(args.spell)
        found, total = d.find(text, limit=40)
        show_matches(text, found, total)
        return

    ids = resolve(d, args.spell)
    if args.diff and len(ids) != 2:
        ap.error("--diff needs exactly two spell ids")

    docs = []
    for sid in ids:
        doc = d.build_doc(sid)
        if doc["name"] is None and not doc["effects"] and not doc["visuals"]:
            # stderr, so a warning can never land inside piped --json output
            print(f"no spell {sid} in {d.label}", file=sys.stderr)
            continue
        docs.append(doc)
    if not docs:
        sys.exit(1)
    if args.diff and len(docs) != 2:
        sys.exit("--diff needs two spells that exist in this pack")

    if args.json:
        payload: Any = docs if len(docs) > 1 else docs[0]
        text = json.dumps(payload, indent=1, default=str)
        if args.json == "-":
            print(text)
        else:
            out = Path(args.json)
            out.write_text(text, encoding="utf-8")
            print(f"-> {out}  ({out.stat().st_size:,} bytes)")
    if args.readable or not args.json:
        for doc in docs:
            show(doc, args.full)
    if args.diff:
        diff(docs[0], docs[1])


if __name__ == "__main__":
    main()
