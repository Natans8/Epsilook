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
from collections.abc import Container, Iterable, Mapping, Sequence
from functools import cached_property

from .build import Build
from .declarations import Declarations
from .derive import (CONTEXT_FIELDS, DEFAULT_LOCALE, LOCALES, CookedText,
                     DeriveContext, IconIndex, Locale, PackRows, References,
                     ResolvedDisplays, Spoken, SpellVisuals,
                     build_icon_index, build_rows, collect_references, cook_text,
                     locale_of, resolve_displays, walk_spells)
from .drift import OPTIONAL_TABLES, TDB_OPTIONAL_TABLES
from .emit.manifest import manifest
from .emit.meta import gathered, meta
from .emit.module import Module, absent_sections, assemble
from .encode import (EMPTY_SLOT, FEWEST_BYTES, encode_column,
                     encode_section, layout_for)
from .model import SECTIONS, Cardinality, Encoding, Section, SectionColumns
from .progress import log, phase, step, timed
from .routes import (AreaGates, CreatureModels, Delivery, FxPayloads,
                     GameObjectData, ItemModels, KeyboundOverride, KitEffects,
                     MissileMotion, ModelSources, MountData, ProcEffects,
                     Reach, ShapeshiftForms, SpellEffectRows, SpellNames,
                     SpellProperties, SpellText,
                     VehicleSeats, VisualGraph, VisualMissiles,
                     implicit_target_bits, read_anim_replacements,
                     read_animkit_anims, read_animkit_bonesets,
                     read_area_gates, read_creature_models, read_fx_payloads,
                     read_gameobjects, read_item_models, read_keybound_overrides,
                     read_kit_effects, read_missile_motions, read_missiles,
                     read_model_sources, read_mounts, read_override_names,
                     read_proc_effects, read_shapeshift_forms,
                     read_soundkit_files, read_spell_attributes,
                     read_spell_delivery, read_spell_effect_rows,
                     read_spell_names, read_spell_properties, read_spell_reach,
                     read_spell_text, read_spell_values, read_vehicle_seats,
                     read_visual_graph,
                     read_zone_maps, resolve_paths)
from .routes.anims import read_anim_emotes
from .routes.sounds import read_kit_names, read_kit_types, sound_type_names
from .routes.values import DescriptionValues
from .sources import (Sources, fetch_sources, load_expansions,
                      load_local_enum, read_anim_names, read_enum_names)
from .sources.cache import CACHE_DIR
from .sources.client import CLIENTS
from .sources.gobs import read_gob_displays
from .sources.listfile import SUPPLEMENT, SUPPLEMENT_FLOOR, release_tag
from .sources.scaling import read_scaling, scaling_source
from .sources.tdb import TDB_TABLES, tdb_release
from .sources.wago import LOCALIZED_TABLES
from .tables import (CsvTables, ListfileTables, OverlaidTables, Provider,
                     SqlTables, Tables, hotfix_overlays, locale_overlays,
                     supplement_overlay, translated_exports)

PROVIDERS: dict[str, Provider] = {"csv": CsvTables, "sql": SqlTables}
"""The implementations a build may be read through, by the name it is asked for.

A roster rather than a branch: the seam's whole claim is that these are peers,
so choosing one is a lookup and adding one is an entry.
"""


class Providers:
    """Every source one build reads, wired and ready to hand to a route.

    Held together rather than passed one by one because which provider a route
    gets is the decision this module exists to make, and a caller assembling
    them itself would be making it again.
    """

    def __init__(self, sources: Sources, *, build: int, locale: str = "",
                 provider: Provider = CsvTables) -> None:
        """Wire the providers for one build, in one language.

        Args:
            sources: where acquisition left each source.
            build: the client build being packed, which decides how far down
                the hotfix stamp a revision is still accepted.
            locale: the language to read the translated tables in, or empty for
                the build's own export. Naming one composes two more sources in
                under the ones already here, so that every route above still
                asks for a table and gets one.
            provider: the implementation every directory of game tables here
                is served by. One for all of them, because a pack read half one
                way and half the other proves nothing about either. The
                listfile is not among them: it is a different format, and
                `ListfileTables` is what reads it whichever of these is chosen.
        """
        client: Tables = provider(sources.tables)
        if locale:
            # UNDER the hotfix overlay rather than over it, which is what keeps
            # the two languages' row sets identical: the server's rows are
            # unioned in either way, so a spell the client lacks and the dump
            # supplies exists in both, carrying the one name anybody wrote for
            # it. Restating on top would have dropped it from the translated
            # pass alone, and the two halves of a section no longer line up.
            client = OverlaidTables(
                base=client, overlays=translated_exports(LOCALIZED_TABLES),
                source=provider(sources.locale_tables[locale]))

        self.base: Tables = client
        """The client's own tables, unrevised. What a printed number reads."""

        self.tables: Tables = client
        self.pinned: Tables = provider(sources.pinned_tables)
        self.world: Tables | None = None
        if sources.tdb is not None:
            world: Tables = provider(sources.tdb)
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
        # The community list names what Blizzard ships; the supplement names
        # what a private client added, and the two never claim the same id --
        # the overlay admits nothing below the floor a client allocates its own
        # assets from. So this is additive for every pack and decisive for one:
        # a build off a private client's tables references the ids only the
        # supplement can name.
        self.listfile: Tables = OverlaidTables(
            base=ListfileTables(sources.listfile),
            overlays=supplement_overlay(SUPPLEMENT_FLOOR),
            source=ListfileTables(SUPPLEMENT))

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


def client_keys() -> list[str]:
    """The private clients a pack may be built from, sorted.

    Read through the wiring rather than off the declaration, because the entry
    point above may not reach into the acquisition layer -- and what it wants
    is the roster of choices, not the services behind them.
    """
    return sorted(CLIENTS)


class Derivations:
    """Every context field, computed on first ask and remembered.

    One method per field, and a field asking for another is an ordinary
    attribute access -- so the dependency graph IS the call graph, and there is
    no second account of it to keep in step. That is the whole reason this is
    not a straight-line function any more: a build asked for one module has to
    know that wanting `visuals` means wanting the graph, the missiles, the kits
    and the effects, and the only place that was ever written down was the
    ORDER of the statements that produced them.

    Nothing here is a route's business: a route is still handed a `Tables` and
    still knows nothing about what else is being read.
    """

    def __init__(self, providers: Providers, build: Build,
                 ladder: tuple[list[dict], dict[int, int]],
                 values: DescriptionValues,
                 zone_maps: Mapping[int, int]) -> None:
        """Hold what every derivation reads from, and derive nothing yet."""
        self.providers = providers
        self.build = build
        self.ladder = ladder
        self.values = values
        self.zone_maps = zone_maps
        self.tables = providers.tables
        self.world = providers.world

    # The routes, each timed under its own name.

    @cached_property
    def names(self) -> SpellNames:
        with phase("read spell names"):
            return read_spell_names(self.tables)

    @cached_property
    def spell_ids(self) -> list[int]:
        return sorted(self.names.names)

    @cached_property
    def graph(self) -> VisualGraph:
        with phase("read visual graph"):
            return read_visual_graph(self.tables)

    @cached_property
    def creatures(self) -> CreatureModels:
        with phase("read creature models"):
            return read_creature_models(self.tables, self.world)

    @cached_property
    def items(self) -> ItemModels:
        with phase("read item models"):
            return read_item_models(self.tables)

    @cached_property
    def mounts(self) -> MountData:
        with phase("read mounts"):
            return read_mounts(self.tables, self.names.names, self.creatures)

    @cached_property
    def objects(self) -> GameObjectData:
        with phase("read gameobjects"):
            return read_gameobjects(self.tables, self.world)

    @cached_property
    def models(self) -> ModelSources:
        with phase("read model sources"):
            return read_model_sources(self.tables, self.creatures, self.items,
                                      self.providers.named)

    @cached_property
    def missiles(self) -> dict[int, VisualMissiles]:
        with phase("read missiles"):
            return read_missiles(self.tables, self.models)

    @cached_property
    def motions(self) -> Mapping[int, MissileMotion]:
        with phase("read missile motions"):
            return read_missile_motions(self.tables)

    @cached_property
    def procs(self) -> ProcEffects:
        with phase("read proc effects"):
            return read_proc_effects(self.tables, self.models)

    @cached_property
    def fx(self) -> FxPayloads:
        with phase("read fx payloads"):
            return read_fx_payloads(self.tables)

    @cached_property
    def kits(self) -> KitEffects:
        with phase("read kit effects"):
            return read_kit_effects(self.tables, self.models, self.procs, self.fx)

    @cached_property
    def soundkit_files(self) -> dict[int, set[int]]:
        with phase("read soundkit files"):
            return read_soundkit_files(self.tables)

    @cached_property
    def anim_names(self) -> list[str]:
        """Not a context field: the three animation routes and the declarations
        all resolve ids through it, and it is a checked-in list rather than a
        table."""
        with phase("read anim names"):
            return read_anim_names()

    @cached_property
    def emotes(self) -> tuple[list[int], list[int]]:
        """The one-shot and looping emote columns, which arrive together."""
        with phase("read anim emotes"):
            return read_anim_emotes(self.anim_names)

    @cached_property
    def animkit_anims(self) -> dict[int, set[int]]:
        with phase("read animkit anims"):
            return read_animkit_anims(self.tables, self.anim_names)

    @cached_property
    def animkit_bonesets(self) -> dict[int, dict[int, list[str]]]:
        with phase("read animkit bonesets"):
            return read_animkit_bonesets(self.tables)

    @cached_property
    def anim_replacements(self) -> dict[int, set[tuple[int, int]]]:
        with phase("read anim replacements"):
            return read_anim_replacements(self.tables, self.anim_names)

    @cached_property
    def keybinds(self) -> dict[int, KeyboundOverride]:
        with phase("read keybound overrides"):
            return read_keybound_overrides(self.tables)

    @cached_property
    def effects(self) -> SpellEffectRows:
        with phase("read spell effect rows"):
            return read_spell_effect_rows(
                self.tables, self.names.names,
                {"screens": self.fx.screens, "keybounds": self.keybinds},
                implicit_target_bits(self.build.version),
                self.build.version)

    @cached_property
    def alt_names(self) -> dict[int, str]:
        with phase("read override names"):
            return read_override_names(self.tables, self.effects.altnames)

    @cached_property
    def props(self) -> SpellProperties:
        with phase("read spell properties"):
            return read_spell_properties(self.tables, self.names.names)

    @cached_property
    def attributes(self) -> dict[str, list[int]]:
        with phase("read spell attributes"):
            return read_spell_attributes(self.props.attribute_words)

    @cached_property
    def delivery(self) -> list[Delivery]:
        with phase("read spell delivery"):
            return read_spell_delivery(self.tables, self.props)

    @cached_property
    def reach(self) -> list[Reach]:
        with phase("read spell reach"):
            return read_spell_reach(self.tables, self.props)

    @cached_property
    def areas(self) -> AreaGates:
        with phase("read area gates"):
            return read_area_gates(self.tables, self.zone_maps)

    @cached_property
    def forms(self) -> ShapeshiftForms:
        with phase("read shapeshift forms"):
            return read_shapeshift_forms(self.tables)

    @cached_property
    def vehicles(self) -> VehicleSeats:
        with phase("read vehicle seats"):
            return read_vehicle_seats(self.tables)

    @cached_property
    def templates(self) -> SpellText:
        with phase("read spell text"):
            return read_spell_text(self.tables)

    # What this layer derives from them.

    @cached_property
    def prose(self) -> CookedText:
        with phase("cook descriptions"):
            return cook_text(self.templates, self.values, self.names)

    @cached_property
    def visuals(self) -> SpellVisuals:
        with phase("walk_spells"):
            return walk_spells(self.names.names, self.graph, self.missiles,
                               self.kits, self.soundkit_files, self.fx,
                               self.effects)

    @cached_property
    def displays(self) -> ResolvedDisplays:
        with phase("resolve_displays"):
            return resolve_displays(self.effects, self.creatures, self.forms)

    @cached_property
    def references(self) -> References:
        with phase("collect_references"):
            return collect_references(self.visuals, self.effects, self.fx,
                                      self.displays, self.mounts, self.objects,
                                      self.items, self.creatures,
                                      self.props.icon_fid)

    @cached_property
    def paths(self) -> dict[int, str]:
        wanted = self.references.wanted
        log(f"Resolving {len(wanted):,} referenced file ids against the listfile ...")
        with phase("resolve paths (listfile)"):
            return resolve_paths(self.providers.listfile, wanted)

    @cached_property
    def declared(self) -> Declarations:
        rungs, era_of = self.ladder
        oneshots, loops = self.emotes
        with phase("read declarations"):
            return Declarations(
                anim_names=self.anim_names, anim_emote_oneshots=oneshots,
                anim_emote_loops=loops, gobs=read_gob_displays(),
                expansions=rungs, era_of=era_of,
                effect_names=read_enum_names("SpellEffect", self.build.version),
                aura_names=read_enum_names("SpellEffectAura", self.build.version),
                target_names=read_enum_names("Target", self.build.version),
                target_bits=implicit_target_bits(self.build.version),
                item_quality_names=load_local_enum("item_quality"),
                attachment_names=load_local_enum("m2_attachments"),
                summon_control_names=load_local_enum("summon_properties_control"))

    @cached_property
    def rows(self) -> PackRows:
        # After the declarations, because the flattening names the edges between
        # spells and the words it names them with are resolved per build.
        with phase("build_rows"):
            return build_rows(self.visuals, self.effects, self.vehicles,
                              self.declared.effect_names,
                              self.declared.aura_names, self.animkit_bonesets)

    @cached_property
    def icons(self) -> IconIndex:
        with phase("build_icon_index"):
            return build_icon_index(self.spell_ids, self.props.icon_fid, self.paths)

    @cached_property
    def kit_names(self) -> list[tuple[int, str]]:
        with phase("read kit names"):
            return read_kit_names(self.providers.pinned, self._used_kits)

    @cached_property
    def _used_kits(self) -> set[int]:
        """The sound kits this pack reaches, which both kit reads are scoped to."""
        return {kit for pairs in self.visuals.sounds.values() for kit, _file in pairs}

    @cached_property
    def kit_types(self) -> dict[int, int]:
        with phase("read kit types"):
            return read_kit_types(self.providers.tables, self._used_kits)

    @cached_property
    def sound_type_names(self) -> dict[int, str]:
        return sound_type_names()


DERIVED_FIELDS = CONTEXT_FIELDS - {"build"}
"""Every context field a build produces, which is all of them but the build id.

`build` is handed in rather than derived, so it is the one field that is not a
property on `Derivations` and the one a caller always supplies.
"""


def selected(want: Sequence[str] = ()) -> tuple[Section, ...]:
    """The sections landing in the named modules, or every section.

    Raises:
        ValueError: a module nothing declares, which is a typo rather than an
            empty build -- the alternative is producing nothing and reporting
            success.
    """
    if not want:
        return tuple(SECTIONS)
    known = {section.module for section in SECTIONS}
    unknown = sorted(set(want) - known)
    if unknown:
        raise ValueError(f"no section ships in {', '.join(unknown)}; "
                         f"the modules are {', '.join(sorted(known))}")
    return tuple(section for section in SECTIONS if section.module in want)


def declared_reads(sections: Iterable[Section]) -> frozenset[str]:
    """The context fields these sections declared, unioned.

    Only what they NAMED: everything those fields are derived from comes with
    them, because `Derivations` resolves a dependency by asking for it. That is
    the whole reason this can be a union rather than a graph -- the graph is
    already the call graph.
    """
    return frozenset(name for section in sections for name in section.reads)


def read_all(providers: Providers, build: Build,
             ladder: tuple[list[dict], dict[int, int]],
             values: DescriptionValues,
             zone_maps: Mapping[int, int],
             wanted: Iterable[str] | None = None) -> DeriveContext:
    """Derive what a section reads, and no more than that.

    `wanted` names the context fields the selected sections declared; anything
    they depend on comes with them, because `Derivations` resolves a dependency
    by asking for it. Naming none derives everything, which is what a whole
    pack needs.

    `values` and `zone_maps` arrive rather than being read here because they
    are what the language cannot touch: a number is a number in every language,
    and a map id is a map id. Reading them once is what lets a second language
    cost the nine routes that do change rather than all of them.
    """
    derive = Derivations(providers, build, ladder, values, zone_maps)
    asked = DERIVED_FIELDS if wanted is None else DERIVED_FIELDS & set(wanted)
    log(f"Deriving {len(asked)} of {len(DERIVED_FIELDS)} context fields ...")
    return DeriveContext(build=build,
                         **{name: getattr(derive, name) for name in sorted(asked)})


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


def unavailable_tables(build: Build, world: Tables | None) -> frozenset[str]:
    """Every declared-optional table this build cannot read, client or server.

    The client's own absences were probed once when the `Build` was made. The
    server's are the release's: a build with no dump at all lacks every world
    table, which is what makes a section naming one degrade on the four packs
    that ship without one.
    """
    absent = set(build.absent_tables)
    if world is None:
        absent |= set(TDB_TABLES["world"]) | set(TDB_OPTIONAL_TABLES)
    else:
        absent |= {table for table in TDB_OPTIONAL_TABLES
                   if not world.available(table)}
    return frozenset(absent)


def switched_off(section: Section, unavailable: frozenset[str]) -> bool:
    """Whether this build lacks a table the section cannot do without."""
    return bool(set(section.needs) & unavailable)


def degraded_sections(sections: Iterable[Section], produced: Container[str],
                      unavailable: frozenset[str]) -> dict[str, list[str]]:
    """Which shipped sections are thinner than usual, and what thinned each.

    The difference `absentSections` cannot state: these sections ship, holding
    less than they would -- morph names falling back to raw ids on a build with
    no server dump. Only the shipped ones are reported, since a section that is
    absent outright is already named where absence is.
    """
    return {section.name: missing for section in sections
            if section.name in produced
            and (missing := sorted(set(section.degraded_without) & unavailable))}


def produce(context: DeriveContext, unavailable: frozenset[str],
            policy: Mapping[Cardinality, Encoding] = FEWEST_BYTES,
            sections: Sequence[Section] = SECTIONS
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
    for section in sections:
        if switched_off(section, unavailable):
            continue
        with timed("produce sections", section.name):
            produced = section.produce(context.reads(section.reads))
        columns[section.name] = produced
        with timed("encode columns", section.name):
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
        with timed("produce language", section.name):
            produced = section.produce(context.reads(section.reads))
        check_parallel(section, produced, built[section.name])
        with timed("encode language", section.name):
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
    release = tdb_release(version)
    return Build(version=version,
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
           locales: Sequence[Locale] = LOCALES, client: str = "",
           provider: Provider = CsvTables, want: Sequence[str] = ()
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
        client: the private client to read this build's tables out of, or empty
            for one somebody published an export of.
        provider: the `Tables` implementation to read every source through.
            Peers by construction, so this decides how the build reads and
            nothing about what it produces.
        want: which artifact modules to build, by name. Empty means all of
            them. Naming one derives only what its sections declared reading,
            plus whatever that transitively needs -- so a prose-only rebuild
            skips the graph walk and the listfile pass rather than repeating
            them to change two files.

    Returns:
        The header, and what each language produced, by language code. The
        default language's entry holds every encoded section; each further
        one holds its localizable columns alone, since everything else about
        the build is the same in all of them.
    """
    beside = beside_default(locales)
    with phase("acquire sources"):
        sources = fetch_sources(version, refresh, beside, client)
    build_id = int(version.rsplit(".", 1)[-1])
    with phase("wire providers"):
        providers = Providers(sources, build=build_id, provider=provider)
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

    chosen = selected(want)
    asked = set(declared_reads(chosen))
    # The locale pass below reads the build's own effect rows for the override
    # names each spell can take. That consumer is not a section, so no
    # section's declaration brings the field in -- and an underived field
    # defaults to empty, which here would mean every language silently losing
    # its alternate names.
    if sources.locale_tables:
        asked.add("effects")
    context = read_all(providers, build, ladder, values, zone_maps, asked)
    unavailable = unavailable_tables(build, providers.world)
    columns, encoded = produce(context, unavailable, policy, chosen)
    degraded = degraded_sections(chosen, encoded, unavailable)
    with phase("gather counts and domains"):
        counts, domains = gathered(columns, context)
    log(f"  {len(encoded)} sections, {len(counts)} counts, {len(domains)} domains"
        + (f", {len(degraded)} degraded" if degraded else ""))

    # Whatever landed beside the build's own tables IS the set of further
    # languages: acquisition asked for the ones the roster named and reports
    # what came back, so there is nothing here to decide again.
    produced = {DEFAULT_LOCALE: encoded}
    for code in sources.locale_tables:
        locale = locale_of(code)
        with phase("wire providers"):
            spoken_providers = Providers(sources, build=build_id, locale=code,
                                         provider=provider)
        said = read_spoken(spoken_providers, locale, values=values,
                           altnames=context.effects.altnames,
                           zone_maps=zone_maps)
        produced[code] = produce_spoken(context.spoken_in(said), columns, policy)
        log(f"  {code}: {len(produced[code])} sections of language")
    return meta(build, label, release_tag(), counts, domains,
                degraded=degraded), produced


def acquire(version: str, *, refresh: bool = False,
            locales: Sequence[Locale] = LOCALES, client: str = "") -> None:
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
    fetch_sources(version, refresh, beside_default(locales), client)
    scaling_source(version, CACHE_DIR).acquire(refresh)


def modules(version: str, label: str, *, refresh: bool = False,
            policy: Mapping[Cardinality, Encoding] = FEWEST_BYTES,
            pack_id: str = "", location: str = "",
            locales: Sequence[Locale] = LOCALES, client: str = "",
            provider: Provider = CsvTables, want: Sequence[str] = ()
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
        client: the private client to read this build's tables out of, if any.
        provider: the `Tables` implementation to read every source through.
        want: which modules to build. Empty means all of them; naming some
            derives only what they read, and the manifest that comes back
            names only what was built.

    Returns:
        The modules, each named by its own content, and the manifest naming
        them. A module whose bytes match another build's IS that build's file:
        nothing here arranges the sharing, and nothing has to.
    """
    started = time.monotonic()
    header, produced = packed(version, label, refresh=refresh, policy=policy,
                              locales=locales, client=client, provider=provider,
                              want=want)
    assembled = [module for code, sections in produced.items()
                 for module in assemble(SECTIONS, sections, locale=code)]
    # Off the build's own pass alone, over the sections that were asked for. A
    # further language produces the sections that ship language and no others,
    # so asking one what is absent would name every section that merely has
    # nothing to translate -- and a partial build left out whole modules on
    # purpose, so only the chosen sections can be reported at all.
    absent = absent_sections(selected(want), produced[DEFAULT_LOCALE])
    log(f"  {len(produced[DEFAULT_LOCALE])} sections in {len(assembled)} modules "
        f"[{time.monotonic() - started:.1f}s]")
    return assembled, manifest(pack_id or version, assembled, header,
                               absent=absent, location=location)
