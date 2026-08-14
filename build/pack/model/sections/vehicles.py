"""Vehicles and their seats, and the per-spell modifiers that carry a number.

The vehicle routes and the numeric ones share nothing but this module; they are
here together because each is small and each is the same idea -- a value a
spell sets on its subject.
"""

from __future__ import annotations

from collections import Counter

from ...derive import Reads, spell_rows
from ...measure import numeric_domain
from ..registry import register
from ..section import Count, Domain, Section, SectionColumns


def screens(reads: Reads) -> SectionColumns:
    """Each screen effect a spell grades the frame with.

    Two routes reach one: an aura naming the effect, and a visual kit playing
    it. They are unioned here because they are the same fact about the spell --
    the frame is graded either way -- and a reader given them apart would have
    to union them itself to answer the only question anyone asks.

    The audience comes from the aura, which is the route that records one. A
    kit-sourced screen carries the walk's mask, which is a better answer and
    not yet the shipped one.
    """
    reached = {(spell, screen)
               for spell, ids in reads.effects.screens.ids.items()
               for screen in ids}
    reached |= {(spell, screen)
                for spell, screens_of in reads.visuals.screens.items()
                for screen in screens_of}
    rows = sorted(reached)
    return {"spellIds": [row[0] for row in rows],
            "screenIds": [row[1] for row in rows],
            "targets": [reads.effects.screens.masks.get(row, 0) for row in rows]}


def screen_payloads(reads: Reads) -> SectionColumns:
    """What each used screen effect paints, and how it is shaped."""
    from ...routes.colors import hue_words  # noqa: PLC0415  (one caller)
    ids = sorted(reads.references.screens)
    rows = [reads.fx.screens[screen] for screen in ids]
    return {"ids": ids,
            "names": [row.name for row in rows],
            "fogColors": [row.fog for row in rows],
            "fogAlphas": [row.fog_alpha for row in rows],
            "mulColors": [row.mul for row in rows],
            "addColors": [row.add for row in rows],
            # The radial vignette shaping the coverage; a size of zero means
            # the row has no full-screen entry at all.
            "maskOffsetY": [row.mask[0] for row in rows],
            "maskSize": [row.mask[1] for row in rows],
            "maskPower": [row.mask[2] for row in rows],
            "hues": [hue_words((row.fog, row.mul, row.add)) for row in rows]}


def screen_textures(reads: Reads) -> SectionColumns:
    """The textures each screen effect draws, art before mask."""
    rows = sorted((screen, role, fid)
                  for screen in sorted(reads.references.screens)
                  for fid, role in reads.fx.screens[screen].textures)
    return {"screenIds": [row[0] for row in rows],
            "roles": [row[1] for row in rows],
            "fids": [row[2] for row in rows]}


def channels(payload: str, gate: str):
    """One side of the invisibility pairing, keeping only channels that exist.

    A channel is materialised only where it has an invisible side. That one
    rule is the whole asymmetry: an invisibility spell always shows a pill even
    when nothing can reveal it, and a detection spell shows one only when its
    type has something to reveal.
    """

    def produce(reads: Reads) -> SectionColumns:
        kinds = {kind for kinds in reads.effects.invis.ids.values()
                 for kind in kinds}
        source = getattr(reads.effects, payload)
        rows = sorted((spell, kind) for spell, kinds_of in source.ids.items()
                      for kind in kinds_of if gate != "invis" or kind in kinds)
        return {"spellIds": [row[0] for row in rows],
                "types": [row[1] for row in rows],
                "targets": [source.masks.get(row, 0) for row in rows]}

    return produce


def speeds(reads: Reads) -> SectionColumns:
    """Every movement a spell scales, and by how much."""
    rows = sorted((spell, movement, percent)
                  for spell, mods in reads.effects.speeds.items()
                  for movement, percent in mods)
    return {"spellIds": [row[0] for row in rows],
            "movements": [row[1] for row in rows],
            "percents": [row[2] for row in rows],
            "targets": [reads.effects.speed_targets.get(row, 0) for row in rows]}


def scales(reads: Reads) -> SectionColumns:
    """Every size change a spell applies."""
    rows = sorted((spell, percent) for spell, percents_of
                  in reads.effects.scales.items() for percent in percents_of)
    return {"spellIds": [row[0] for row in rows],
            "percents": [row[1] for row in rows],
            "targets": [reads.effects.scale_targets.get(row, 0) for row in rows]}


SPELL_SCREENS = register(Section(
    name="spellScreens",
    doc="Which screen effect a spell grades the frame with.",
    module="core",
    produce=screens,
    columns=("spellIds", "screenIds", "targets"),
    reads=("effects", "visuals"),
    counts=(Count("spellScreens", lambda columns, _r: len(columns["spellIds"])),),
))

SCREENS = register(Section(
    name="screens",
    doc="What each screen effect paints, and the vignette that shapes it.",
    module="core",
    produce=screen_payloads,
    columns=("ids", "names", "fogColors", "fogAlphas", "mulColors", "addColors",
             "maskOffsetY", "maskSize", "maskPower", "hues"),
    reads=("references", "fx"),
    counts=(Count("screens", lambda columns, _r: len(columns["ids"])),),
))

SCREEN_TEXTURES = register(Section(
    name="screenTextures",
    doc="The textures each screen effect draws, finished art before flat mask.",
    module="core",
    produce=screen_textures,
    columns=("screenIds", "roles", "fids"),
    reads=("references", "fx"),
))

SPELL_VEHICLES = register(Section(
    name="spellVehicles",
    doc="Which vehicle a spell turns its caster into.",
    module="core",
    produce=lambda reads: {
        "spellIds": [row[0] for row in reads.rows.vehicles],
        "vehicleIds": [row[1] for row in reads.rows.vehicles],
        "targets": [reads.effects.vehicles.masks.get(row, 0)
                    for row in reads.rows.vehicles]},
    columns=("spellIds", "vehicleIds", "targets"),
    reads=("rows", "effects"),
    counts=(Count("spellVehicles", lambda columns, _r: len(columns["spellIds"])),),
))

SPELL_INVIS = register(Section(
    name="spellInvis",
    doc="Which invisibility channel a spell hides its subject on.",
    module="core",
    produce=channels("invis", "none"),
    columns=("spellIds", "types", "targets"),
    reads=("effects",),
    counts=(Count("spellInvis", lambda columns, _r: len(columns["spellIds"])),
            Count("invisChannels",
                  lambda columns, _r: len(set(columns["types"])))),
    domains=(Domain("invis", lambda columns, _r: numeric_domain(columns["types"])),),
))

SPELL_DETECTS = register(Section(
    name="spellDetects",
    doc="Which invisibility channel a spell can see through.",
    module="core",
    produce=channels("detect", "invis"),
    columns=("spellIds", "types", "targets"),
    reads=("effects",),
    counts=(Count("spellDetects", lambda columns, _r: len(columns["spellIds"])),),
))

SPELL_SPEEDS = register(Section(
    name="spellSpeeds",
    doc="Every movement a spell scales, and by how much.",
    module="core",
    produce=speeds,
    columns=("spellIds", "movements", "percents", "targets"),
    reads=("effects",),
    counts=(Count("spellSpeeds", lambda columns, _r: len(columns["spellIds"])),),
    domains=(Domain("speed",
                    lambda columns, _r: numeric_domain(columns["percents"])),),
))

SPELL_SCALES = register(Section(
    name="spellScales",
    doc="Every size change a spell applies.",
    module="core",
    produce=scales,
    columns=("spellIds", "percents", "targets"),
    reads=("effects",),
    counts=(Count("spellScales", lambda columns, _r: len(columns["spellIds"])),),
    domains=(Domain("scale",
                    lambda columns, _r: numeric_domain(columns["percents"])),),
))

VEHICLES = register(Section(
    name="vehicles",
    doc="How many seats each reached vehicle has.",
    module="core",
    produce=lambda reads: {
        "vehicleIds": list(reads.rows.vehicle_ids),
        "seats": [len(reads.vehicles.seats[vehicle])
                  for vehicle in reads.rows.vehicle_ids]},
    columns=("vehicleIds", "seats"),
    reads=("rows", "vehicles"),
    counts=(Count("vehicles", lambda columns, _r: len(columns["vehicleIds"])),),
))

VEHICLE_SEATS = register(Section(
    name="vehicleSeats",
    doc="One row per seat, naming where on the model it sits.",
    module="core",
    produce=lambda reads: {
        "vehicleIds": [vehicle for vehicle in reads.rows.vehicle_ids
                       for _name in reads.vehicles.seats[vehicle]],
        "attachments": [name for vehicle in reads.rows.vehicle_ids
                        for name in reads.vehicles.seats[vehicle]]},
    columns=("vehicleIds", "attachments"),
    reads=("rows", "vehicles"),
    counts=(Count("vehicleSeats",
                  lambda columns, _r: len(columns["vehicleIds"])),),
    domains=(Domain("seat", lambda columns, _r: numeric_domain(
        Counter(columns["vehicleIds"]).values())),),
))

SPELL_PASSENGER_ANIMS = register(Section(
    name="spellPassengerAnims",
    doc="The rider's own animations while entering, seated and leaving.",
    module="core",
    produce=lambda reads: {
        "spellIds": [row[0] for row in spell_rows(
            reads.vehicles.passenger_anims, reads.rows.vehicles,
            len(reads.anim_names))],
        "animIds": [row[1] for row in spell_rows(
            reads.vehicles.passenger_anims, reads.rows.vehicles,
            len(reads.anim_names))]},
    columns=("spellIds", "animIds"),
    reads=("rows", "vehicles", "anim_names"),
    counts=(Count("spellPassengerAnims",
                  lambda columns, _r: len(columns["spellIds"])),),
))

SPELL_VEHICLE_ANIMS = register(Section(
    name="spellVehicleAnims",
    doc="The vehicle's own animations, which are not the rider's.",
    module="core",
    produce=lambda reads: {
        "spellIds": [row[0] for row in spell_rows(
            reads.vehicles.vehicle_anims, reads.rows.vehicles,
            len(reads.anim_names))],
        "animIds": [row[1] for row in spell_rows(
            reads.vehicles.vehicle_anims, reads.rows.vehicles,
            len(reads.anim_names))]},
    columns=("spellIds", "animIds"),
    reads=("rows", "vehicles", "anim_names"),
    counts=(Count("spellVehicleAnims",
                  lambda columns, _r: len(columns["spellIds"])),),
))

SPELL_VEHICLE_ANIMKITS = register(Section(
    name="spellVehicleAnimKits",
    doc="The anim kits a seat names, which resolve like any other kit.",
    module="core",
    produce=lambda reads: {
        "spellIds": [row[0] for row in spell_rows(
            reads.vehicles.animkits, reads.rows.vehicles)],
        "animKitIds": [row[1] for row in spell_rows(
            reads.vehicles.animkits, reads.rows.vehicles)]},
    columns=("spellIds", "animKitIds"),
    reads=("rows", "vehicles"),
    counts=(Count("spellVehicleAnimKits",
                  lambda columns, _r: len(columns["spellIds"])),),
))
