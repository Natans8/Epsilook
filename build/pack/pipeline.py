"""The wiring: which provider a route reads, and in what order they run.

Every other layer is written to know as little as possible about the ones
around it -- a route is handed a `Tables` and never asks where it came from, a
section is handed a `Reads` and never asks which route filled it. Something has
to hold both ends, and this is it: the one module that names a source and a
route in the same breath.

That is also why it sits above every layer rather than inside one. Putting the
wiring in `routes/` would make a reader choose its own source, which is the
weld the provider seam exists to cut.

The order below is a dependency order, not a preference: a route appearing
before another is one whose bundle the next one reads.
"""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence

from .build import Build, Line
from .declarations import Declarations
from .derive import (DeriveContext, build_icon_index, build_rows,
                     collect_references, cook_text, resolve_displays,
                     walk_spells)
from .drift import OPTIONAL_TABLES
from .emit.manifest import manifest
from .emit.meta import gathered, meta
from .emit.module import Module, absent_sections, assemble
from .encode import FEWEST_BYTES, encode_section
from .model import SECTIONS, Cardinality, Encoding, Section, SectionColumns
from .progress import log
from .routes import (implicit_target_bits, read_anim_replacements,
                     read_animkit_anims, read_animkit_bonesets,
                     read_area_gates, read_creature_models, read_fx_payloads,
                     read_gameobjects, read_item_models, read_keybound_overrides,
                     read_kit_effects, read_missile_motions, read_missiles,
                     read_model_sources, read_mounts, read_override_names,
                     read_proc_effects, read_shapeshift_forms,
                     read_soundkit_files, read_spell_attributes,
                     read_spell_delivery, read_spell_effect_rows,
                     read_spell_names, read_spell_properties, read_spell_text,
                     read_spell_values, read_vehicle_seats, read_visual_graph,
                     resolve_paths)
from .routes.anims import read_anim_emotes
from .sources import (Sources, fetch_sources, load_expansions,
                      load_local_enum, read_anim_names, read_enum_names)
from .sources.cache import CACHE_DIR
from .sources.gobs import read_gob_displays
from .sources.listfile import release_tag
from .sources.scaling import read_scaling, scaling_source
from .sources.tdb import tdb_release
from .tables import (CsvTables, ListfileTables, OverlaidTables, Tables,
                     hotfix_overlays)

SOUNDKIT_NAME_TABLE = "SoundKitName"
"""The pinned build's table of human names for sound kits.

Read from `SOUNDKITNAME_BUILD` whatever pack is building: no later client ships
it, so the alternative to another build's copy is no names at all.
"""


class Providers:
    """Every source one build reads, wired and ready to hand to a route.

    Held together rather than passed one by one because which provider a route
    gets is the decision this module exists to make, and a caller assembling
    them itself would be making it again.
    """

    def __init__(self, sources: Sources, *, build: int) -> None:
        """Wire the providers for one build.

        Args:
            sources: where acquisition left each source.
            build: the client build being packed, which decides how far down
                the hotfix stamp a revision is still accepted.

        TODO: compose the listfile with the vendored asset-name supplement.
            It is an `Overlay` admitted `above(SUPPLEMENT_FLOOR)`, and turning
            it on names ~95k more assets -- so it lands as its own explained
            change, not inside the stage that has to reproduce a pack built
            before it existed.
        """
        self.base: Tables = CsvTables(sources.tables)
        """The client's own tables, unrevised. What a printed number reads."""

        self.tables: Tables = CsvTables(sources.tables)
        self.pinned: Tables = CsvTables(sources.pinned_tables)
        self.world: Tables | None = None
        if sources.tdb is not None:
            world = CsvTables(sources.tdb)
            self.world = world
            # The hotfixes revise the client's own tables, so the overlay wraps
            # the build's provider rather than standing beside it: a route
            # reading `SpellEffect` cannot tell whether a row was revised, and
            # that is the point.
            self.tables = OverlaidTables(base=self.base,
                                         overlays=hotfix_overlays(build),
                                         source=world)
        self.listfile: Tables = ListfileTables(sources.listfile)

    def named(self, fids: set[int]) -> set[int]:
        """Which of `fids` name a real asset.

        Handed to the model routes so they can tell a placeholder from a file,
        without any of them learning what a listfile is.
        """
        return set(resolve_paths(self.listfile, fids))


def read_kit_names(pinned: Tables, used: set[int]) -> list[tuple[int, str]]:
    """The names of the sound kits this pack reaches, sorted.

    Purely additive: a kit keeps its id and its files, and one with no name
    renders exactly as it would without this. Kits added after the pinned build
    have no name anywhere and are left unnamed rather than given a made-up one.
    """
    return sorted((kit, name.strip()) for kit, name in (
        (int(kit_id), name)
        for kit_id, name in pinned.rows(SOUNDKIT_NAME_TABLE, ["ID", "Name"]))
                  if name.strip() and kit in used)


def read_all(providers: Providers, build: Build,
             ladder: tuple[list[dict], dict[int, int]],
             scaling: Mapping[int, Mapping[str, float]]) -> DeriveContext:
    """Run every route and every derivation, and return what a section reads.

    The order is the dependency graph: creature displays before the model
    sources that resolve against them, the payload tables before the kits that
    dispatch into them, and the graph walk after everything it unions.
    """
    tables, world = providers.tables, providers.world

    log("Reading spell names ...")
    names = read_spell_names(tables)

    log("Reading spell visual chain tables ...")
    graph = read_visual_graph(tables)
    creatures = read_creature_models(tables, world)
    items = read_item_models(tables)
    mounts = read_mounts(tables, names.names, creatures)
    objects = read_gameobjects(tables, world)
    models = read_model_sources(tables, creatures, items, providers.named)
    missiles = read_missiles(tables, models)
    motions = read_missile_motions(tables)
    procs = read_proc_effects(tables, models)
    fx = read_fx_payloads(tables)
    kits = read_kit_effects(tables, models, procs, fx)
    soundkit_files = read_soundkit_files(tables)

    anim_names = read_anim_names()
    oneshots, loops = read_anim_emotes(anim_names)
    animkit_anims = read_animkit_anims(tables, anim_names)
    animkit_bonesets = read_animkit_bonesets(tables)
    anim_replacements = read_anim_replacements(tables, anim_names)

    keybinds = read_keybound_overrides(tables)
    effects = read_spell_effect_rows(
        tables, names.names,
        {"screens": fx.screens, "keybounds": keybinds},
        implicit_target_bits(build.version))
    alt_names = read_override_names(tables, effects.altnames)
    props = read_spell_properties(tables, names.names)
    attributes = read_spell_attributes(props.attribute_words)
    delivery = read_spell_delivery(tables, props)
    areas = read_area_gates(tables)
    forms = read_shapeshift_forms(tables)
    vehicles = read_vehicle_seats(tables)
    templates = read_spell_text(tables)

    log("Cooking spell descriptions ...")
    # The COOKED numbers come from the client alone, never the server's
    # revisions. A hotfix table prints a float at six significant digits and
    # carries only the integer spelling of an amount, so on a build whose
    # client exports only the float column the overlay would replace a precise
    # value with a coarse one -- a degradation, not a correction. The overlaid
    # provider is right for everything that asks what a spell IS; this asks
    # what number to print.
    prose = cook_text(templates,
                      read_spell_values(providers.base, level=build.max_level,
                                        scaling=scaling),
                      names)

    log("Walking spell -> model/sound/animkit/chain chains ...")
    visuals = walk_spells(names.names, graph, missiles, kits, soundkit_files,
                          fx, effects)
    displays = resolve_displays(effects, creatures, forms)
    references = collect_references(visuals, effects, fx, displays, mounts,
                                    objects, items, props.icon_fid)

    wanted = references.assets | references.icons
    log(f"Resolving {len(wanted):,} referenced file ids against the listfile ...")
    paths = resolve_paths(providers.listfile, wanted)

    log("Assembling pack ...")
    spell_ids = sorted(names.names)
    rungs, era_of = ladder
    return DeriveContext(
        build=build, spell_ids=spell_ids,
        names=names, props=props, templates=templates, effects=effects,
        graph=graph, creatures=creatures, items=items, mounts=mounts,
        objects=objects, models=models, procs=procs, fx=fx, kits=kits,
        forms=forms, vehicles=vehicles, areas=areas,
        missiles=missiles, motions=motions, soundkit_files=soundkit_files,
        animkit_anims=animkit_anims, animkit_bonesets=animkit_bonesets,
        anim_replacements=anim_replacements, keybinds=keybinds,
        delivery=delivery, attributes=attributes, alt_names=alt_names,
        kit_names=read_kit_names(providers.pinned,
                                 {kit for pairs in visuals.sounds.values()
                                  for kit, _file in pairs}),
        rows=build_rows(visuals, effects, vehicles),
        visuals=visuals, icons=build_icon_index(spell_ids, props.icon_fid, paths),
        paths=paths, references=references, displays=displays, prose=prose,
        declared=Declarations(
            anim_names=anim_names, anim_emote_oneshots=oneshots,
            anim_emote_loops=loops, gobs=read_gob_displays(),
            expansions=rungs, era_of=era_of,
            effect_names=read_enum_names("SpellEffect", build.version),
            aura_names=read_enum_names("SpellEffectAura", build.version),
            target_names=read_enum_names("Target", build.version),
            target_bits=implicit_target_bits(build.version),
            item_quality_names=load_local_enum("item_quality"),
            attachment_names=load_local_enum("m2_attachments"),
            summon_control_names=load_local_enum("summon_properties_control")))


def switched_off(section: Section, tables: Tables) -> bool:
    """Whether this build lacks a table the section cannot do without."""
    return any(not tables.available(table) for table in section.needs)


def produce(context: DeriveContext, tables: Tables,
            policy: Mapping[Cardinality, Encoding] = FEWEST_BYTES
            ) -> tuple[dict[str, SectionColumns], dict[str, object]]:
    """Every section this build ships: what it produced, and what it encodes to.

    A section whose `needs` this build lacks is left out rather than shipped
    empty: an empty column reads as "nothing matches", which is a different
    claim from "this build never had it".

    Returns:
        The produced columns and the encoded payloads, both by section name.
        The columns travel too because that is what a count is computed from --
        counting the encoded form would count a deduped pool rather than the
        rows it stands for.
    """
    columns: dict[str, SectionColumns] = {}
    encoded: dict[str, object] = {}
    for section in SECTIONS:
        if switched_off(section, tables):
            continue
        produced = section.produce(context.reads(section.reads))
        columns[section.name] = produced
        encoded[section.name] = encode_section(section, produced, policy)
    return columns, encoded


def absent_tables(tables: Tables) -> list[str]:
    """The declared-optional tables this build predates, sorted.

    Reported up front so a thin pack reads as "the game had no such table yet"
    rather than as a build that broke.
    """
    absent = sorted(table for table in OPTIONAL_TABLES
                    if not tables.available(table))
    if absent:
        log(f"Absent tables ({len(absent)}) — these features switch off:")
        for table in absent:
            log(f"  - {table}: {OPTIONAL_TABLES[table]}")
    return absent


def level_cap(version: str, rungs: Sequence[Mapping[str, object]]) -> int:
    """The level cap of the expansion this build belongs to, or zero.

    Matched on the game major version, which is what a rung declares and what
    a build id starts with. A Classic re-release lands on the rung it
    re-implements, which is right: its cap is that expansion's, whatever client
    it runs on.

    Zero when no rung claims the major -- a build newer than the ladder. The
    cooker reads that as "elide", so an unclaimed build loses the level rather
    than printing another expansion's.
    """
    major = int(version.split(".")[0])
    for rung in rungs:
        if rung["major"] == major:
            return int(str(rung.get("maxLevel", 0)))
    return 0


def build_for(version: str, tables: Tables, rungs: Sequence[Mapping[str, object]],
              *, key: str = "", line: Line = Line.RETAIL) -> Build:
    """The `Build` value for one pack, once its sources have been probed.

    What a build IS to the code, rather than the version string every layer
    used to look its own corner of the truth up from.
    """
    patch = ".".join(version.split(".")[:3])
    release = tdb_release(version)
    return Build(key=key or patch, version=version, patch=patch, line=line,
                 tdb=(release or {}).get("tag"),
                 absent_tables=frozenset(absent_tables(tables)),
                 max_level=level_cap(version, rungs))


def packed(version: str, label: str, *, refresh: bool = False,
           policy: Mapping[Cardinality, Encoding] = FEWEST_BYTES,
           key: str = "", line: Line = Line.RETAIL
           ) -> tuple[dict[str, object], dict[str, object]]:
    """Build one pack, from acquiring its sources to its encoded sections.

    Everything up to the point where the artifact takes a shape, which is the
    one thing this does not decide: `modules` groups these into files.

    Args:
        version: the build id to pack.
        label: the human name the version picker shows.
        refresh: re-fetch every source even where a cached copy would do.
        policy: how a column's declared kind becomes a layout.
        key: the roster key, when the caller has one.
        line: which distribution line the build ships on.

    Returns:
        The header and the encoded sections, both by name.
    """
    sources = fetch_sources(version, refresh)
    providers = Providers(sources, build=int(version.rsplit(".", 1)[-1]))
    ladder = load_expansions()
    build = build_for(version, providers.tables, ladder[0], key=key, line=line)

    scaling = read_scaling(scaling_source(version, CACHE_DIR).acquire(refresh))
    context = read_all(providers, build, ladder, scaling)
    columns, encoded = produce(context, providers.tables, policy)
    counts, domains = gathered(columns, context)
    log(f"  {len(encoded)} sections, {len(counts)} counts, {len(domains)} domains")
    return meta(build, label, release_tag(), counts, domains), encoded


def modules(version: str, label: str, *, refresh: bool = False,
            policy: Mapping[Cardinality, Encoding] = FEWEST_BYTES,
            key: str = "", line: Line = Line.RETAIL, pack_id: str = "",
            location: str = "") -> tuple[list[Module], dict[str, object]]:
    """Build one pack as the module set it ships as.

    Args:
        version: the build id to pack.
        label: the human name the version picker shows.
        refresh: re-fetch every source even where a cached copy would do.
        policy: how a column's declared kind becomes a layout.
        key: the roster key, when the caller has one.
        line: which distribution line the build ships on.
        pack_id: the pack's identity, when it is not the build id -- a test
            line sharing a patch with live.
        location: where the writer will put the modules, relative to the site
            root, so the manifest can name them where they actually are.

    Returns:
        The modules, each named by its own content, and the manifest naming
        them. A module whose bytes match another build's IS that build's file:
        nothing here arranges the sharing, and nothing has to.
    """
    started = time.monotonic()
    header, encoded = packed(version, label, refresh=refresh, policy=policy,
                             key=key, line=line)
    assembled = assemble(SECTIONS, encoded)
    absent = absent_sections(SECTIONS, encoded)
    log(f"  {len(encoded)} sections in {len(assembled)} modules "
        f"[{time.monotonic() - started:.1f}s]")
    return assembled, manifest(pack_id or version, assembled, header,
                               absent=absent, location=location)


