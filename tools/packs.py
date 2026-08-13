#!/usr/bin/env python3
"""THE PACK ROSTER — the one place a shipped game version is declared.

    python tools/packs.py                   # what we ship
    python tools/packs.py --check           # ... and whether a newer build exists
    python tools/packs.py --bump vanilla    # take the current live build (EXPLICIT ONLY)

⚠ "BEHIND" MEANS A NEW PATCH, NOT A NEW BUILD (the user's call). Blizzard
reissues builds inside a patch constantly — hotfixes, regional respins — and
chasing each would re-ship ~50 MB of LFS and eleven packs for data that did not
meaningfully move. So 1.15.8 -> 1.15.9 is reported as something to do, while
…69109 -> …69200 is reported as INFORMATION and nothing more. `--bump` is the
door for acting on the second kind, and only a human opens it: nothing calls it,
not `check.py` and not the weekly workflow.

⚠ AND A NEWER BUILD IS NOT AUTOMATICALLY A BUILDABLE ONE. `--check` probes two
things before you touch anything, because both change what the bump costs:
whether **wago** has ingested the build (it lags Blizzard by hours to days, and
a rebuild against a build it lacks 404s partway through every table) and whether
a **TDB** release covers the patch (without one the build succeeds with morph
displays empty and no hotfix overlay — Midnight ships exactly that way).

WHY IT EXISTS. A pack's identity (build id, label, default flag) used to be an
ARGUMENT to build_data.py and nowhere else, recovered afterwards by reading
site/data/versions.json — the file build_data.py itself WRITES. So the input was
recovered from the output, and bumping a patch meant: run the build with a
hand-typed label, then hand-delete the previous entry and its data directory,
because write_pack() replaces by EXACT build id and a bump changes that id.
Miss either step and the old pack ships forever beside the new one.

Here the roster is the INPUT and versions.json is a pure projection of it:

    bumping a patch version = editing ONE `build=` string below.

Everything else follows — the label carries the patch number, tools/rebuild.py
retires the pack the bump replaced, and `--check` says when a bump is due.

⚠ THE BUILD IS PINNED ON PURPOSE, and "just build the newest" is the wrong
shape however tempting. tools/rebuild.py --verify asserts that rebuilding an
unchanged pack reproduces it byte for byte; resolving "newest" at build time
would make that oracle fail every time Blizzard shipped a hotfix, and the packs
would stop being reproducible artifacts. So: `--check` TELLS you, a human bumps.

⛔ PICK THE PRODUCT, NOT THE BUILD NUMBER, AND NEVER THE CHINA LINE. Blizzard
ships region-exclusive clients on their own product lines, and the one to avoid
is `wow_classic_titan` — "Classic Titan Reforged", marked (China) on the wiki's
own Template:Current builds, versioned 3.80.x so it does not even look like a
WoW patch. Every product named below is global. Reference:
https://warcraft.wiki.gg/wiki/Public_client_builds

⚠ NEVER TAKE THE BUILD FROM THE WIKI. A patch page (e.g. Patch_1.15.9) lists the
build the patch SHIPPED with — 68824 — while the line keeps hotfixing under the
same patch number. Pinning that number ships a client dozens of hotfixes stale
while looking perfectly correct. The split is: the wiki is the authority on
which lines are PUBLIC and which is China-only, and Blizzard's version service
(below) is the authority on the current build of one.
"""

from __future__ import annotations

import argparse
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from repo import CACHE, survive_console_encoding

survive_console_encoding()

# BLIZZARD'S OWN VERSION SERVICE — Ribbit V2 over HTTPS, which is what Agent and
# the game clients themselves use as of 2025. No key, no account, no scraping.
#
# ⚠ USE V2/HTTPS AND NOTHING ELSE, because three plausible-looking routes are
# all wrong now (wowdev.wiki/Ribbit is the reference):
#   * Ribbit V1 on TCP 1119 — DEPRECATED in 2025, and a raw TCP protocol rather
#     than HTTP, so it is unreachable from a sandboxed or proxied network.
#   * http://<region>.patch.battle.net:1119/<product>/versions — the legacy TACT
#     HTTP system. It still answers, but only by PROXYING V2, so it is a hop
#     with nothing to recommend it. Note it is also HTTP-only and on port 1119;
#     plain https://us.patch.battle.net just hangs.
#   * a per-product poll to discover new lines — the wiki says outright to use
#     the summary file "instead of checking all individual products".
SUMMARY_URL = "https://us.version.battle.net/v2/summary"
VERSIONS_URL = "https://us.version.battle.net/v2/products/{product}/versions"
UA = {"User-Agent": "Epsilook-build (github.com/Natans8/Epsilook)"}

# The cheapest table build_data.py reads (a ~500-row index), used only to ask
# whether wago can serve a build at all. Same URL shape as the real fetch.
WAGO_PROBE_URL = "https://wago.tools/db2/SpellCastTimes/csv?build={build}"

# Product lines that are NOT a shippable public client, and why. Anything the
# summary publishes that is neither here nor tracked by a pack below is reported
# by --check as an unrecognised line — which is how a NEW Classic line launching
# gets noticed without anyone watching for it.
#
# ⛔ `wow_classic_titan` is the China-exclusive one ("Classic Titan Reforged",
# versioned 3.80.x). It is a real, live, public client — it is excluded for
# REGION, not for being a test realm, so it must never be pattern-matched away
# with the internals below. See the module docstring.
IGNORED_PRODUCTS = {
    "wow_classic_titan": "China-exclusive (Titan Reforged)",
    "wowxptr": "retail PTR 2",
    "wow_beta": "retail alpha/beta",
    "wow_classic_ptr": "Classic PTR",
    "wow_classic_beta": "Classic beta",
    "wow_classic_era_ptr": "Classic Era PTR",
    "wow_classic_era_beta": "Classic Era beta",
    "wowz": "internal",
}

# ⚠ BLIZZARD'S OWN SUMMARY LISTS THE INTERNAL LINES TOO, and there are far more
# of them than of real clients — 33 against 5 the day this was written. They are
# vendor/dev/QA branches (`wowdev3` 12.0.5.66521, `wownev5` 5.5.4.69155,
# `wowv3` 12.1.5.69199 ...); several carry builds AHEAD of live, so treating one
# as a public line would "bump" a pack to a client nobody can download. Most
# 404 on the versions endpoint even though summary lists them.
#
# This is the cost of the official source over a curated mirror, and it is worth
# paying: the mirror simply omitted these, which also meant it would have
# omitted a new PUBLIC line until someone added it.
INTERNAL_PREFIXES = ("wowdev", "wownev", "wowv", "wowe", "wowlivetest")


def is_internal(product: str) -> bool:
    """A vendor/dev/QA branch rather than something a player can install."""
    return any(product.startswith(prefix) for prefix in INTERNAL_PREFIXES)


# `product` answers ONE question: where do I ask whether a newer build exists.
#
# FROZEN means "do not ask", and it is the answer for most of the roster —
# NOT because those clients are unimportant but because their product line
# MOVED ON. `wow_classic` is the progressing Classic line and is on MoP today,
# so asking it about our WotLK 3.4.3 pack answers "5.5.4.69155", which is not a
# newer WotLK at all. `wow` is on Midnight (12.x), so it would tell the same lie
# about all five pinned retail packs. Only a pack whose line is still shipping
# ITS patch may name a product; everything else is a historical artifact.
FROZEN = "frozen"

# Where the bytes come from. wago serves CASC-era builds only — its oldest of
# any kind is 1.13.0.28211 — so a genuine pre-Cata client comes from the
# wow.tools DBC mirror instead. See tools/expansions.py, which already reads it.
WAGO = "wago"
ARCHIVE = "archive"


def schema_name(pack_id: str) -> str:
    """The database schema a pack's tables live in, from its id.

    A free function as well as a `Pack` property, because both databases also
    name schemas for builds that are not roster rows -- the pinned sound-kit
    build among them.
    """
    return "v" + "_".join(pack_id.split(".")[:3]).replace("-", "_")


@dataclass(frozen=True)
class Pack:
    """One shipped game version. A patch bump edits `build` and nothing else."""

    key: str  # stable short name; what you type on the CLI
    name: str  # "Vanilla Classic" — the label is this plus the patch
    product: str  # wago product line to check for updates, or FROZEN
    build: str  # THE ONE FIELD A PATCH BUMP TOUCHES
    default: bool = False  # the pack the app loads when the URL names none
    hidden: bool = False  # resolvable by ?v= but kept out of the dropdown
    source: str = WAGO  # WAGO or ARCHIVE — which downloader reads it
    tag: str = ""  # marks a pack whose PATCH another pack also ships (see `id`)

    @property
    def patch(self) -> str:
        """`"1.15.9.69109"` -> `"1.15.9"`. The label's version half."""
        return ".".join(self.build.split(".")[:3])

    @property
    def schema(self) -> str:
        """`"9.2.7.45745"` -> `"v9_2_7"`. The pack's schema in either database.

        Derived from the roster row rather than spelled out per database, so
        the SOURCE mirror and the PACK mirror cannot disagree about where a
        build lives -- which is the only thing that lets the two be joined.
        They did disagree: one turned `12.1.0-ptr` into `v12_1_0-ptr`, a
        hyphen no unquoted SQL identifier may carry.

        Major.minor.patch, because it is unique across the roster and a schema
        you have to type needs to be short. The build number lives in
        `ref.game_build`.
        """
        return schema_name(self.id)

    @property
    def id(self) -> str:
        """The pack's identity: its data directory, manifest id and `?v=` value.

        Normally the build id. A `tag` marks it — `12.1.0-ptr.69273` — and that
        is not decoration: the app's clean URL is the PATCH (`?v=12.1.0`), so
        two packs sharing a patch resolve to one another. A PTR line sits on the
        live patch whenever it has not moved ahead yet, which is exactly when it
        is most confusable, so the tag rides in the patch segment permanently
        rather than appearing and vanishing with each divergence.
        """
        if not self.tag:
            return self.build
        return f"{self.patch}-{self.tag}.{self.build.split('.')[3]}"

    @property
    def label(self) -> str:
        """What the version dropdown shows. Derived, so a bump cannot desync it."""
        return f"{self.name} {self.patch}"


# ---------------------------------------------------------------- the roster
#
# Ordered oldest to newest, which is also the order versions.json sorts into.
PACKS: tuple[Pack, ...] = (
    # The three still shipping their own patch — these are the ones `--check`
    # can actually answer for, and the only ones a routine bump touches.
    Pack("vanilla", "Vanilla Classic", "wow_classic_era", "1.15.9.69109"),
    Pack("tbc", "TBC Classic", "wow_anniversary", "2.5.6.69110"),
    Pack("mop", "MoP Classic", "wow_classic", "5.5.4.69155"),
    Pack("midnight", "Midnight", "wow", "12.1.0.69273"),
    # The retail test line. It runs AHEAD of live most of the time and level
    # with it the rest, so it is tagged rather than told apart by its build —
    # see Pack.id. Its links go to Wowhead's own /ptr/ section.
    #
    # ⚠ WHILE IT IS LEVEL WITH LIVE the two builds are the same bytes, so the
    # shipped manifest points this entry at midnight's pack file by hand rather
    # than carrying a second copy. Rebuilding it writes its own directory back;
    # re-point `file` (and `hash`) in site/data/versions.json, or leave the
    # duplicate once the lines diverge and the data genuinely differs.
    Pack("midnight-ptr", "Midnight PTR", "wowt", "12.1.0.69273", tag="ptr"),
    # Lines that moved on, and pinned retail. Historical artifacts: their build
    # is final, so FROZEN rather than a product that would answer about a
    # different expansion entirely.
    Pack("wotlk", "WotLK Classic", FROZEN, "3.4.3.58936"),
    Pack("cata", "Cataclysm Classic", FROZEN, "4.4.2.60895"),
    Pack("legion", "Legion", FROZEN, "7.3.5.26972"),
    Pack("bfa", "Battle for Azeroth", FROZEN, "8.3.7.35662"),
    Pack("shadowlands", "Shadowlands", FROZEN, "9.2.7.45745", default=True),
    Pack("dragonflight", "Dragonflight", FROZEN, "10.2.7.55664"),
    Pack("tww", "The War Within", FROZEN, "11.2.7.65299"),
)

# Exactly one default, and keys/builds are unique — a duplicate would make
# `select()` ambiguous and silently rebuild the wrong pack.
assert sum(p.default for p in PACKS) == 1, "exactly one pack must be the default"
assert len({p.key for p in PACKS}) == len(PACKS), "duplicate pack key"
assert len({p.id for p in PACKS}) == len(PACKS), "duplicate pack id"


# A per-build download cache directory, e.g. `.cache/9.2.7.45745`. Anything
# else under .cache/ is shared or long-lived (dbd, enums, expansions,
# listfile, the DuckDB file) and is never a rotation candidate.
BUILD_DIR_RE = re.compile(r"^\d+\.\d+\.\d+\.\d+$")
TDB_DIR_RE = re.compile(r"^tdb-(.+)$")


def builds() -> list[str]:
    """Every build the roster names, deduplicated and in roster order.

    A BUILD is not a pack: two packs can ship one build (retail and its PTR
    while the test line is level with live). Anything keyed on the game data
    rather than on what the app serves — the download cache, the exploration
    database — wants this rather than the pack list.
    """
    seen: dict[str, None] = {}
    for pack in PACKS:
        seen.setdefault(pack.build, None)
    return list(seen)


def _build_data():
    """build/build_data.py as a module, or None. It is not on the path by default."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "build"))
        import build_data
    except ImportError:
        return None
    return build_data


def stale_cache() -> list[tuple[Path, int]]:
    """Cache directories no pack in the roster needs, newest-first by size.

    ⚠ THE CACHE DOES NOT ROTATE ON ITS OWN, AND NOTHING USED TO NOTICE. Every
    patch bump leaves the previous build's tables behind — 300 MB for a retail
    one — and the pack directory it fed is retired the same day, so the bytes
    sit there unreferenced and invisible. Seven such directories had accumulated
    to ~427 MB before anyone looked. Hence a function rather than a habit:
    tools/rebuild.py sweeps after every successful build and tools/check.py
    reports what is left, so neither depends on a human remembering.

    ⛔ A BUILD NO PACK NAMES IS NOT AUTOMATICALLY STALE. build_data.py pins
    SoundKitName to a frozen 8.3.0 build (see SOUNDKITNAME_BUILD) that no Pack
    row mentions and re-downloading it costs 5 MB for nothing, so the pinned
    builds are read from the builder rather than assumed absent. TDB dumps are
    keyed by RELEASE TAG and shared between packs, so they are matched through
    the same mapping the build uses instead of by name.
    """
    if not CACHE.is_dir():
        return []
    module = _build_data()
    keep = set(builds())
    if module is not None:
        keep.add(getattr(module, "SOUNDKITNAME_BUILD", ""))
    keep_tdb = {tdb_tag(build) for build in builds()} - {""}

    stale = []
    for directory in sorted(CACHE.iterdir()):
        if not directory.is_dir():
            continue
        tdb = TDB_DIR_RE.match(directory.name)
        if tdb:
            if module is None or tdb.group(1) in keep_tdb:
                continue  # unknown mapping: keep, rather than guess it away
        elif not BUILD_DIR_RE.match(directory.name) or directory.name in keep:
            continue
        size = sum(f.stat().st_size for f in directory.rglob("*") if f.is_file())
        stale.append((directory, size))
    return sorted(stale, key=lambda item: -item[1])


def version_key(build: str) -> tuple[int, ...]:
    """Componentwise, so 10.x sorts after 9.x rather than before it."""
    return tuple(int(part) for part in build.split(".") if part.isdigit())


def patch_key(build: str) -> tuple[int, ...]:
    """`"1.15.9.69109"` -> `(1, 15, 9)`. WHAT "BEHIND" IS MEASURED ON.

    The user's call, and it governs the whole update routine: bump for a PATCH
    (1.15.8 -> 1.15.9), never for a microbuild (…69109 -> …69200). Blizzard
    reissues builds within a patch constantly — hotfixes, regional respins — and
    chasing each one would mean re-shipping ~50 MB of LFS and eleven packs for
    data that did not meaningfully move, while training everyone to ignore the
    warning that said so.
    """
    return version_key(build)[:3]


def select(wanted: str | None) -> list[Pack]:
    """All packs, or those matching a key or a build prefix."""
    if not wanted:
        return list(PACKS)
    hits = [p for p in PACKS if p.key == wanted or p.id.startswith(wanted)]
    if not hits:
        known = ", ".join(f"{p.key} ({p.id})" for p in PACKS)
        sys.exit(f"no pack matches {wanted!r}\nknown: {known}")
    return hits


def fetch_bpsv(url: str) -> list[dict[str, str]]:
    """Fetch one BPSV document and return its rows as dicts. `[]` on failure.

    BPSV is the pipe-separated format every TACT/Ribbit endpoint speaks: a
    header naming the columns as `Name!TYPE:len`, a `## seqn = N` line, then the
    rows. Both files this module reads share it, so it is parsed once here.

        Region!STRING:0|BuildConfig!HEX:16|...|VersionsName!String:0|...
        ## seqn = 3941253
        us|96db...|d2a7...|68974|12.0.7.68974|5302...
    """
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA),
                                    timeout=60) as response:
            body = response.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, OSError) as exc:
        print(f"could not reach {url}: {exc}", file=sys.stderr)
        return []

    rows: list[dict[str, str]] = []
    columns: list[str] = []
    for line in body.splitlines():
        if line.startswith("##") or not line.strip():
            continue
        fields = line.split("|")
        if not columns:  # the header is always the first non-comment line
            columns = [c.split("!")[0] for c in fields]
            continue
        rows.append(dict(zip(columns, fields)))
    return rows


def live_build(product: str) -> str:
    """The build Blizzard is CURRENTLY serving for one product. "" if unknown.

    Regions normally carry identical builds, but they do diverge during a
    staggered rollout, so one is chosen rather than assumed unique: `us` first,
    since that is the region Epsilon's audience patches against.
    """
    rows = fetch_bpsv(VERSIONS_URL.format(product=product))
    if not rows:
        return ""
    chosen = next((r for r in rows if r.get("Region") == "us"), rows[0])
    return chosen.get("VersionsName", "").strip()


def wago_has(build: str) -> bool | None:
    """Has wago ingested this build yet? None when the question can't be asked.

    BLIZZARD SHIPPING A BUILD AND WAGO CARRYING IT ARE DIFFERENT EVENTS, hours
    to days apart, and only the second one makes a rebuild possible. Without
    this, "a newer build exists" reads as "go bump it" — you edit the roster,
    start a rebuild, and it 404s partway through every table.

    Probed with the smallest table the build actually reads, through the exact
    URL build_data.py will use, so a 200 here means that build is fetchable
    rather than merely listed somewhere.
    """
    url = WAGO_PROBE_URL.format(build=build)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA),
                                    timeout=60) as response:
            return response.status == 200
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        return None
    except (urllib.error.URLError, OSError):
        return None


def tdb_tag(build: str) -> str:
    """The TDB release tag covering this build's PATCH, or "".

    Imported from build_data.py rather than restated — two copies of this
    mapping would drift, and the whole point is to answer the same question the
    build will answer. Matching is per patch (the user's call): a TDB tracks
    9.2.7, not 9.2.7.45745, so a hotfix bump keeps its server-side data.
    """
    module = _build_data()
    if module is None:
        return ""
    return (module.tdb_release(build) or {}).get("tag", "")


def availability(build: str) -> str:
    """`"  [wago: yes, TDB: TDB927.22111]"` — can this build be built at all?

    Answered BEFORE anyone edits the roster, because both answers change what
    the bump costs. No wago means a rebuild 404s partway through; no TDB means
    it succeeds with morph displays empty and hotfixes unapplied, which is a
    real gap (Midnight ships that way) and much better known in advance than
    discovered in a build log.
    """
    wago = wago_has(build)
    wago_word = {True: "yes", False: "NOT YET", None: "unknown"}[wago]
    tag = tdb_tag(build)
    # ASCII only: this lands in a Windows console that is often cp1252, where a
    # middot comes out as "?" and makes the line look corrupted.
    return f"  [wago: {wago_word}, TDB: {tag or 'none'}]"


def bump(keys: list[str]) -> int:
    """Rewrite `build=` for the named packs to whatever Blizzard serves now.

    ⛔ EXPLICIT ONLY, AND THAT IS THE POINT (the user's call). `--check` reports
    a microbuild move as information and never as a reason to act; this is the
    door for acting on it, and it opens only when a human names a pack. Nothing
    calls it — not the weekly workflow, not check.py.

    It edits THIS file, which is the whole reason a bump is one line: the roster
    is the input, so rewriting the string here is the entire change.
    """
    source_path = Path(__file__).resolve()
    source = source_path.read_text(encoding="utf-8")
    changed = []

    for key in keys:
        pack = next((p for p in PACKS if p.key == key), None)
        if pack is None:
            print(f"no pack named {key!r}", file=sys.stderr)
            return 1
        if pack.product in (FROZEN, ARCHIVE):
            print(f"{key} is {pack.product} — its line does not ship new builds",
                  file=sys.stderr)
            return 1

        live = live_build(pack.product)
        if not live:
            print(f"{key}: could not reach Blizzard's version service", file=sys.stderr)
            return 1
        if live == pack.build:
            print(f"{key:<13} already on {live}")
            continue
        if wago_has(live) is False:
            print(f"{key:<13} {live} is not on wago yet — a rebuild would 404. "
                  f"Not bumping.", file=sys.stderr)
            return 1

        # Anchored on this pack's own Pack(...) row, so a build string that
        # happens to appear elsewhere in the file cannot be hit by accident.
        pattern = re.compile(rf'(Pack\("{re.escape(key)}",[^)]*?")'
                             rf'{re.escape(pack.build)}(")')
        source, count = pattern.subn(rf"\g<1>{live}\g<2>", source, count=1)
        if count != 1:
            print(f"{key}: could not locate its build string in {source_path.name}",
                  file=sys.stderr)
            return 1
        changed.append((key, pack.build, live, tdb_tag(live)))

    if not changed:
        return 0

    source_path.write_text(source, encoding="utf-8")
    for key, old, new, tag in changed:
        print(f"{key:<13} {old} -> {new}   [TDB: {tag or 'none'}]")
    print(f"\nedited {source_path.name}. Now: python tools/rebuild.py "
          f"{' '.join(k for k, *_ in changed)}")
    return 0


def wow_products() -> set[str]:
    """Every WoW product line Blizzard currently publishes.

    From the summary file, which the wiki names as the right way to spot a
    change rather than polling each product. It lists every Blizzard game, so
    it is filtered to the WoW family — a new Classic flavour appears here the
    day it goes live, which is what makes --check self-detecting.
    """
    return {row["Product"] for row in fetch_bpsv(SUMMARY_URL)
            if row.get("Product", "").startswith("wow")}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="ask Blizzard whether a newer build exists for each pack")
    ap.add_argument("--bump", nargs="+", metavar="KEY",
                    help="rewrite build= for these packs to the current live "
                         "build (explicit only; nothing does this for you)")
    args = ap.parse_args()

    if args.bump:
        return bump(args.bump)

    behind = 0
    for pack in PACKS:
        flags = " ".join(f for f, on in
                         (("default", pack.default), ("hidden", pack.hidden)) if on)
        line = f"{pack.key:<14} {pack.id:<17} {pack.label:<28} {flags}"
        if args.check and pack.product not in (FROZEN, ARCHIVE):
            available = live_build(pack.product)
            if available and patch_key(available) > patch_key(pack.build):
                behind += 1
                line += f"  <- NEW PATCH: {available}{availability(available)}"
            elif available and available != pack.build:
                # Same patch, different build: a hotfix or a regional respin.
                # Reported so it is visible, never counted as behind.
                line += f"  up to date  (live microbuild {available})"
            elif available:
                line += "  up to date"
            else:
                line += "  (could not check)"
        print(line.rstrip())

    if args.check:
        # A live line nobody declared. Either a new Classic flavour launched or
        # Blizzard renamed a product — both need a human, and neither announces
        # itself if --check only ever looks at what we already track.
        published = wow_products()
        tracked = {p.product for p in PACKS}
        unknown = sorted(p for p in published - tracked - set(IGNORED_PRODUCTS)
                         if not is_internal(p))
        if unknown:
            print("\nUNRECOGNISED product line(s) — new, renamed, or region-locked:")
            for product in unknown:
                print(f"  {product:<22} {live_build(product) or '?'}")
            print("  Decide per line: add a Pack row, or an IGNORED_PRODUCTS reason.")
            behind += len(unknown)

    if args.check and behind:
        print(f"\n{behind} item(s) need attention. Edit the `build=` string in "
              f"tools/packs.py, then: python tools/rebuild.py <key>")
    return 1 if (args.check and behind) else 0


if __name__ == "__main__":
    sys.exit(main())
