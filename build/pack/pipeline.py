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

A build has two axes and both are wired here. The version decides which tables
are read; the language decides which copy of the nine translated ones. A
language costs a second pass over those nine routes and nothing else -- the
graph walk, the listfile resolution and every id in the pack are one build's,
read once, and `check_parallel` is what proves the second pass did not move
them.
"""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence

from .build import Build
from .declarations import Declarations
from .derive import (DEFAULT_LOCALE, LOCALES, DeriveContext, Locale, Spoken,
                     build_icon_index, build_rows, collect_references, cook_text,
                     locale_of, resolve_displays, walk_spells)
from .drift import OPTIONAL_TABLES
from .emit.manifest import manifest
from .emit.meta import gathered, meta
from .emit.module import Module, absent_sections, assemble
from .encode import (EMPTY_SLOT, FEWEST_BYTES, encode_column,
                     encode_section, layout_for)
from .model import SECTIONS, Cardinality, Encoding, Section, SectionColumns
from .progress import detail, log, phase, step
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
                     read_zone_maps, resolve_paths)
from .routes.anims import read_anim_emotes
from .routes.values import DescriptionValues
from .sources import (Sources, fetch_sources, load_expansions,
                      load_local_enum, read_anim_names, read_enum_names)
from .sources.cache import CACHE_DIR
from .sources.gobs import read_gob_displays
from .sources.listfile import release_tag
from .sources.scaling import read_scaling, scaling_source
from .sources.tdb import tdb_release
from .sources.wago import LOCALIZED_TABLES
from .tables import (CsvTables, ListfileTables, OverlaidTables, Tables,
                     hotfix_overlays, locale_overlays, translated_exports)

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

    def __init__(self, sources: Sources, *, build: int, locale: str = "") -> None:
        """Wire the providers for one build, in one language.

        Args:
            sources: where acquisition left each source.
            build: the client build being packed, which decides how far down
                the hotfix stamp a revision is still accepted.
            locale: the language to read the translated tables in, or empty for
                the build's own export. Naming one composes two more sources in
                under the ones already here, so that every route above still
                asks for a table and gets one.

        TODO: compose the listfile with the vendored asset-name supplement.
            It is an `Overlay` admitted `above(SUPPLEMENT_FLOOR)`, and turning
            it on names ~95k more assets -- so it lands as its own explained
            change, not inside the stage that has to reproduce a pack built
            before it existed.
        """
        client: Tables = CsvTables(sources.tables)
        if locale:
            # UNDER the hotfix overlay rather than over it, which is what keeps
            # the two languages' row sets identical: the server's rows are
            # unioned in either way, so a spell the client lacks and the dump
            # supplies exists in both, carrying the one name anybody wrote for
            # it. Restating on top would have dropped it from the translated
            # pass alone, and the two halves of a section no longer line up.
            client = OverlaidTables(
                base=client, overlays=translated_exports(LOCALIZED_TABLES),
                source=CsvTables(sources.locale_tables[locale]))

        self.base: Tables = client
        """The client's own tables, unrevised. What a printed number reads."""

        self.tables: Tables = client
        self.pinned: Tables = CsvTables(sources.pinned_tables)
        self.world: Tables | None = None
        if sources.tdb is not None:
            world: Tables = CsvTables(sources.tdb)
            if locale:
                # The creature and object names are the server's alone, so the
                # language they are read in is the server's too. Its own
                # `*_locale` tables hold every language at once, and reading one
                # is refusing the rest.
                world = OverlaidTables(base=world, overlays=locale_overlays(locale),
                                       source=world)
            self.world = world
            # The hotfixes revise the client's own tables, so the overlay wraps
            # the build's provider rather than standing beside it: a route
            # reading `SpellEffect` cannot tell whether a row was revised, and
            # that is the point.
            self.tables = OverlaidTables(base=client,
                                         overlays=hotfix_overlays(build),
                                         source=world)
        self.listfile: Tables = ListfileTables(sources.listfile)

    def named(self, fids: set[int]) -> set[int]:
        """Which of `fids` name a real asset.

        Handed to the model routes so they can tell a placeholder from a file,
        without any of them learning what a listfile is.
        """
        # Timed under the same name as the pack's own resolution because it is
        # the same work over the same source: the phase table should say what
        # the listfile costs this build, not what one of its two readers did.
        with phase("resolve paths (listfile)"):
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
             values: DescriptionValues,
             zone_maps: Mapping[int, int]) -> DeriveContext:
    """Run every route and every derivation, and return what a section reads.

    The order is the dependency graph: creature displays before the model
    sources that resolve against them, the payload tables before the kits that
    dispatch into them, and the graph walk after everything it unions.

    `values` and `zone_maps` arrive rather than being read here because they
    are what the language cannot touch: a number is a number in every language,
    and a map id is a map id. Reading them once is what lets a second language
    cost the nine routes that do change rather than all of them.
    """
    tables, world = providers.tables, providers.world

    with step("read spell names", "Reading spell names ..."):
        names = read_spell_names(tables)

    with step("read visual chain", "Reading spell visual chain tables ..."):
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

    with step("read animations", "Reading animation tables ..."):
        anim_names = read_anim_names()
        oneshots, loops = read_anim_emotes(anim_names)
        animkit_anims = read_animkit_anims(tables, anim_names)
        animkit_bonesets = read_animkit_bonesets(tables)
        anim_replacements = read_anim_replacements(tables, anim_names)

    with step("read spell rows", "Reading spell effect and property tables ..."):
        keybinds = read_keybound_overrides(tables)
        effects = read_spell_effect_rows(
            tables, names.names,
            {"screens": fx.screens, "keybounds": keybinds},
            implicit_target_bits(build.version))
        alt_names = read_override_names(tables, effects.altnames)
        props = read_spell_properties(tables, names.names)
        attributes = read_spell_attributes(props.attribute_words)
        delivery = read_spell_delivery(tables, props)
        areas = read_area_gates(tables, zone_maps)
        forms = read_shapeshift_forms(tables)
        vehicles = read_vehicle_seats(tables)
        templates = read_spell_text(tables)

    log("Cooking spell descriptions ...")
    with phase("cook descriptions"):
        prose = cook_text(templates, values, names)

    log("Walking spell -> model/sound/animkit/chain chains ...")
    with phase("walk_spells"):
        visuals = walk_spells(names.names, graph, missiles, kits, soundkit_files,
                              fx, effects)
    with phase("resolve_displays"):
        displays = resolve_displays(effects, creatures, forms)
    with phase("collect_references"):
        references = collect_references(visuals, effects, fx, displays, mounts,
                                        objects, items, props.icon_fid)

    wanted = references.wanted
    log(f"Resolving {len(wanted):,} referenced file ids against the listfile ...")
    with phase("resolve paths (listfile)"):
        paths = resolve_paths(providers.listfile, wanted)

    log("Assembling pack ...")
    spell_ids = sorted(names.names)
    rungs, era_of = ladder
    # Hoisted out of the constructor call below so each is a phase of its own.
    # They are the two most expensive arguments it takes, and inside the call
    # they would be timed as whatever surrounds it.
    with phase("read declarations"):
        declared = Declarations(
            anim_names=anim_names, anim_emote_oneshots=oneshots,
            anim_emote_loops=loops, gobs=read_gob_displays(),
            expansions=rungs, era_of=era_of,
            effect_names=read_enum_names("SpellEffect", build.version),
            aura_names=read_enum_names("SpellEffectAura", build.version),
            target_names=read_enum_names("Target", build.version),
            target_bits=implicit_target_bits(build.version),
            item_quality_names=load_local_enum("item_quality"),
            attachment_names=load_local_enum("m2_attachments"),
            summon_control_names=load_local_enum("summon_properties_control"))
    # After the declarations, because the flattening names the edges between
    # spells and the words it names them with are resolved per build.
    with phase("build_rows"):
        rows = build_rows(visuals, effects, vehicles, declared.effect_names,
                          declared.aura_names)
    with phase("build_icon_index"):
        icons = build_icon_index(spell_ids, props.icon_fid, paths)
    with phase("read kit names"):
        kit_names = read_kit_names(providers.pinned,
                                   {kit for pairs in visuals.sounds.values()
                                    for kit, _file in pairs})

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
        kit_names=kit_names, rows=rows,
        visuals=visuals, icons=icons,
        paths=paths, references=references, displays=displays, prose=prose,
        declared=declared)


def read_spoken(providers: Providers, locale: Locale, *,
                altnames: Mapping[int, set[int]],
                zone_maps: Mapping[int, int],
                values: DescriptionValues) -> Spoken:
    """Read everything the language changes, and nothing else.

    The second half of `read_all`, and a much smaller one: nine routes carry
    every word the game translates, and the rest of the build says the same
    thing whoever is reading it. So a language is these routes over
    locale-qualified tables, and the ids, the graph walk and the listfile
    resolution are the build's own, read once.

    Args:
        providers: the sources wired for this language.
        locale: which language, and the wording the cooker contributes to it.
        altnames: which override names each spell can take, from the build's
            own effect rows. Which names -- the text of them is what localizes,
            and that is read here.
        zone_maps: each area's map, as the build's own read resolved it. It is
            an id, and it comes from comparing two translated names, so a
            language deriving its own would sometimes open a different map for
            the same place.
        values: the numbers a description asks for, read once for the build.

    Returns:
        The slice of the derive context this language replaces.
    """
    tables, world = providers.tables, providers.world

    with step(f"read {locale.code} names",
              f"Reading the tables the game writes in {locale.code} ..."):
        names = read_spell_names(tables)
        creatures = read_creature_models(tables, world)
        items = read_item_models(tables)
        mounts = read_mounts(tables, names.names, creatures)
        objects = read_gameobjects(tables, world)
        forms = read_shapeshift_forms(tables)
        areas = read_area_gates(tables, zone_maps)
        alt_names = read_override_names(tables, altnames)
        templates = read_spell_text(tables)

    with phase(f"cook {locale.code} descriptions"):
        prose = cook_text(templates, values, names, locale.text)

    return Spoken(names=names, alt_names=alt_names, templates=templates,
                  creatures=creatures, items=items, mounts=mounts,
                  objects=objects, forms=forms, areas=areas, prose=prose)


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
        with phase("produce sections"), detail("produce sections", section.name):
            produced = section.produce(context.reads(section.reads))
        columns[section.name] = produced
        with phase("encode columns"), detail("encode columns", section.name):
            encoded[section.name] = encode_section(section, produced, policy)
    return columns, encoded


def check_parallel(section: Section, spoken: SectionColumns,
                   built: SectionColumns) -> None:
    """Fail unless a language pass produced the structure the build did.

    The two halves of a split section ship in different files and are joined by
    position under one section name, so a language may change what a column
    SAYS and never how many entries it has or what the entries beside it are.
    Everything that could break that is upstream and quiet -- a translated
    export with a row the build's own has not, a route that filters on a name
    -- and the failure it produces is a pack whose names belong to other ids.

    Raises:
        ValueError: a column the language does not touch came out different,
            or one it does came out a different length.
    """
    for column in section.columns:
        if column in section.localizable:
            if len(spoken[column]) != len(built[column]):
                raise ValueError(
                    f"{section.name}.{column}: the language pass produced "
                    f"{len(spoken[column])} entries against the build's "
                    f"{len(built[column])}; the two would not line up")
        elif spoken[column] != built[column]:
            raise ValueError(
                f"{section.name}.{column} is not language and came out "
                f"different anyway; the language pass has moved something the "
                f"pack joins on")


def produce_spoken(context: DeriveContext, built: Mapping[str, SectionColumns],
                   policy: Mapping[Cardinality, Encoding] = FEWEST_BYTES
                   ) -> dict[str, object]:
    """Every section that ships language, re-produced in one, encoded.

    Which sections this build has is read off `built` rather than asked of the
    language's provider: a provider reading a language answers `available` from
    the build's own tables, so the two could only ever agree, and asking twice
    would leave a `KeyError` waiting on the day they somehow did not.

    Args:
        context: the build's context with this language's routes spliced in.
        built: what the build's own pass produced, to check each section
            against.
        policy: how a column's declared kind becomes a layout.

    Returns:
        The localizable columns alone, by section name. A section is PRODUCED
        whole, because that is what makes the check possible; only the columns
        that ship are laid out, since encoding the rest would be per-language
        work on a quarter of a million rows that nothing writes down.
    """
    encoded: dict[str, object] = {}
    for section in SECTIONS:
        if not section.localizable or section.name not in built:
            continue
        with phase("produce language"), detail("produce language", section.name):
            produced = section.produce(context.reads(section.reads))
        check_parallel(section, produced, built[section.name])
        with phase("encode language"), detail("encode language", section.name):
            encoded[section.name] = {
                name: encode_column(produced[name],
                                    layout_for(section, name, policy),
                                    section.absent.get(name, EMPTY_SLOT))
                for name in section.localizable}
    return encoded


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


def build_for(version: str, tables: Tables,
              rungs: Sequence[Mapping[str, object]]) -> Build:
    """The `Build` value for one pack, once its sources have been probed.

    What a build IS to the code, rather than the version string every layer
    used to look its own corner of the truth up from.
    """
    patch = ".".join(version.split(".")[:3])
    release = tdb_release(version)
    return Build(version=version, patch=patch,
                 tdb=release["tag"] if release else None,
                 absent_tables=frozenset(absent_tables(tables)),
                 max_level=level_cap(version, rungs))


def beside_default(locales: Sequence[Locale]) -> list[str]:
    """The languages that need sources of their own.

    Every one but the default, whose tables the build already downloaded: an
    exporter asked for no language answers in that one, so it costs no request
    and no second read.
    """
    return [locale.code for locale in locales if locale.code != DEFAULT_LOCALE]


def packed(version: str, label: str, *, refresh: bool = False,
           policy: Mapping[Cardinality, Encoding] = FEWEST_BYTES,
           locales: Sequence[Locale] = LOCALES
           ) -> tuple[dict[str, object], dict[str, dict[str, object]]]:
    """Build one pack, from acquiring its sources to its encoded sections.

    Everything up to the point where the artifact takes a shape, which is the
    one thing this does not decide: `modules` groups these into files.

    Args:
        version: the build id to pack.
        label: the human name the version picker shows.
        refresh: re-fetch every source even where a cached copy would do.
        policy: how a column's declared kind becomes a layout.
        locales: the languages to build. The default one is the build's own
            pass whether or not it is named, so naming none builds that alone.

    Returns:
        The header, and what each language produced, by language code. The
        default language's entry holds every encoded section; each further
        one holds its localizable columns alone, since everything else about
        the build is the same in all of them.
    """
    beside = beside_default(locales)
    with phase("acquire sources"):
        sources = fetch_sources(version, refresh, beside)
    build_id = int(version.rsplit(".", 1)[-1])
    with phase("wire providers"):
        providers = Providers(sources, build=build_id)
    with phase("load expansions"):
        ladder = load_expansions()
    with phase("probe absent tables"):
        build = build_for(version, providers.tables, ladder[0])
    with phase("read scaling table"):
        scaling = read_scaling(scaling_source(version, CACHE_DIR).acquire(refresh))
    # The COOKED numbers come from the client alone, never the server's
    # revisions. A hotfix table prints a float at six significant digits and
    # carries only the integer spelling of an amount, so on a build whose
    # client exports only the float column the overlay would replace a precise
    # value with a coarse one -- a degradation, not a correction. The overlaid
    # provider is right for everything that asks what a spell IS; this asks
    # what number to print.
    with phase("read spell values"):
        values = read_spell_values(providers.base, level=build.max_level,
                                   scaling=scaling)
    # An id derived by matching two translated names, so it is the build's
    # answer and every language is handed it. See `read_zone_maps`.
    with phase("read zone maps"):
        zone_maps = read_zone_maps(providers.tables)

    context = read_all(providers, build, ladder, values, zone_maps)
    columns, encoded = produce(context, providers.tables, policy)
    with phase("gather counts and domains"):
        counts, domains = gathered(columns, context)
    log(f"  {len(encoded)} sections, {len(counts)} counts, {len(domains)} domains")

    # Whatever landed beside the build's own tables IS the set of further
    # languages: acquisition asked for the ones the roster named and reports
    # what came back, so there is nothing here to decide again.
    produced = {DEFAULT_LOCALE: encoded}
    for code in sources.locale_tables:
        locale = locale_of(code)
        with phase("wire providers"):
            spoken_providers = Providers(sources, build=build_id, locale=code)
        said = read_spoken(spoken_providers, locale, values=values,
                           altnames=context.effects.altnames,
                           zone_maps=zone_maps)
        produced[code] = produce_spoken(context.spoken_in(said), columns, policy)
        log(f"  {code}: {len(produced[code])} sections of language")
    return meta(build, label, release_tag(), counts, domains), produced


def acquire(version: str, *, refresh: bool = False,
            locales: Sequence[Locale] = LOCALES) -> None:
    """Fetch everything one build reads, and produce nothing.

    Acquisition separated from execution, so that builds may then run at the
    same time. Concurrent builds share sources -- the listfile, the pinned
    sound-kit table,
    the enum lists, and for two packs on one patch the client tables and the TDB
    as well -- and a download is the one step they must not both take: two
    writers into one cache path race, and the loser goes on to read a
    half-written file as if it were the source. Running this serially over every
    pack first leaves the fan-out with nothing left to fetch, only to read.

    It follows the same order and the same policies an ordinary build does,
    because it IS the build's own acquisition: nothing here decides separately
    what a version needs.
    """
    fetch_sources(version, refresh, beside_default(locales))
    scaling_source(version, CACHE_DIR).acquire(refresh)


def modules(version: str, label: str, *, refresh: bool = False,
            policy: Mapping[Cardinality, Encoding] = FEWEST_BYTES,
            pack_id: str = "",
            location: str = "", locales: Sequence[Locale] = LOCALES
            ) -> tuple[list[Module], dict[str, object]]:
    """Build one pack as the module set it ships as.

    Args:
        version: the build id to pack.
        label: the human name the version picker shows.
        refresh: re-fetch every source even where a cached copy would do.
        policy: how a column's declared kind becomes a layout.
        pack_id: the pack's identity, when it is not the build id -- a test
            line sharing a patch with live.
        location: where the writer will put the modules, relative to the site
            root, so the manifest can name them where they actually are.
        locales: the languages to build.

    Returns:
        The modules, each named by its own content, and the manifest naming
        them. A module whose bytes match another build's IS that build's file:
        nothing here arranges the sharing, and nothing has to.
    """
    started = time.monotonic()
    header, produced = packed(version, label, refresh=refresh, policy=policy,
                              locales=locales)
    assembled = [module for code, sections in produced.items()
                 for module in assemble(SECTIONS, sections, locale=code)]
    # Off the build's own pass alone. A further language produces the sections
    # that ship language and no others, so asking one what is absent would name
    # every section that merely has nothing to translate.
    absent = absent_sections(SECTIONS, produced[DEFAULT_LOCALE])
    log(f"  {len(produced[DEFAULT_LOCALE])} sections in {len(assembled)} modules "
        f"[{time.monotonic() - started:.1f}s]")
    return assembled, manifest(pack_id or version, assembled, header,
                               absent=absent, location=location)
