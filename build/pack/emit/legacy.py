"""The single-file artifact, which is the module set with one module in it.

The app today fetches one document holding `meta` and every section. That is
not a different artifact from the module set -- it is the degenerate case of
it, one module named for the whole pack -- so it is written by the same
serializer and differs only in how the sections are grouped and what order the
keys come out in.

Both orders are declared here rather than left to fall out of registration.
A document's key order is not something a later reader can rederive, and the
one this artifact has was fixed by the builder being replaced; reproducing it
exactly is what makes the replacement provable.

This module is SCHEDULED FOR DELETION, and the trigger is the app reading the
module set. Until then it is the only artifact the site can load, so it stays;
after then it is a second shape of the same pack, and a second shape is a
second thing to keep in step. Do not invest here -- a change that would improve
these two lists belongs in the modules instead, which need no key order at all
because each one is named by its own content.
"""

from __future__ import annotations

import gzip
import io
import json
from collections.abc import Mapping, Sequence
from pathlib import Path

META = "meta"
"""The header key, which always comes first."""

SECTION_ORDER: tuple[str, ...] = (
    "spells", "spellText", "expansions", "iconNames", "iconFids", "files",
    "spellModels", "missileMotions", "items", "itemIconNames",
    "itemQualityNames", "attachmentNames", "modelCatNames", "targetNames",
    "spellSounds", "soundKitNames", "spellAnimKits", "animKitAnims",
    "bonesetNames", "animKitAnimBoneset", "spellReplaceAnims",
    "spellVisualAnims", "animNames", "animEmoteOneshots", "animEmoteLoops",
    "spellMechanics", "effectNames", "auraNames", "implicitTargetNames",
    "implicitTargetBits", "spellKeybinds", "keybinds", "spellLinks", "spellFx",
    "fxChains", "fxTextures", "spellDissolves", "dissolves",
    "dissolveTextures", "spellGlows", "glows", "spellShadowies", "shadowies",
    "spellGhostMats", "ghostMats", "spellTints", "tints", "spellDesaturates",
    "spellTransparencies", "spellFreezes", "spellCamos", "spellAttrs",
    "spellDelivery", "spellAreas", "areas", "spellScreens", "screens",
    "screenTextures", "spellMorphs", "morphs", "morphDisplays", "spellMounts",
    "mounts", "spellShapeshifts", "shapeshifts", "shapeshiftDisplays",
    "spellSummons", "summons", "summonControlNames", "spellObjects", "objects",
    "spellVehicles", "spellInvis", "spellDetects", "spellSpeeds",
    "spellScales", "vehicles", "vehicleSeats", "spellPassengerAnims",
    "spellVehicleAnims", "spellVehicleAnimKits",
)
"""Every section, in the order the artifact carries them."""

COUNT_ORDER: tuple[str, ...] = (
    "spells", "files", "gobModels", "spellDescriptions", "descriptionTexts",
    "spellEncounterNotes", "spellAuraTexts", "auraTexts", "encounterTexts",
    "spellModels", "spellDisplayModels", "spellItemModels",
    "spellMissileMotions", "missileMotions", "items", "namedItems",
    "spellWeaponModels", "spellSounds", "soundKitNames", "spellAnimKits",
    "animKitAnims", "animKitAnimBoneset", "animEmotes", "spellMechanics",
    "implicitTargets", "spellKeybinds", "keybinds", "spellLinks", "linkKinds",
    "spellFx", "spellMorphs", "morphs", "morphDisplays", "spellMounts",
    "mounts", "spellShapeshifts", "shapeshiftDisplays", "spellSummons",
    "summons", "spellObjects", "objects", "spellVehicles", "vehicles",
    "vehicleSeats", "spellInvis", "spellAreas", "areas", "spellDetects",
    "invisChannels", "spellSpeeds", "spellScales", "spellPassengerAnims",
    "spellVehicleAnims", "spellVehicleAnimKits", "fxChains", "spellDissolves",
    "dissolves", "spellGlows", "glows", "spellShadowies", "shadowies",
    "spellGhostMats", "ghostMats", "spellTints", "tints", "spellDesaturates",
    "spellTransparencies", "spellFreezes", "spellCamos",
    "spellAttrs.actionsduringchannel", "spellAttrs.auraisdebuff",
    "spellAttrs.preventsanim", "spellAttrs.tracktargetinchannel",
    "spellAttrs.unbreakablechannel", "expansion.vanilla", "expansion.tbc",
    "expansion.wotlk", "expansion.cata", "expansion.mop", "expansion.wod",
    "expansion.legion", "expansion.bfa", "expansion.shadowlands",
    "expansion.dragonflight", "expansion.tww", "expansion.midnight",
    "expansion.unknown", "spellDelivery", "delivery.casttime",
    "delivery.channelled", "delivery.both", "delivery.breaksOnMove",
    "delivery.instant", "spellReplaceAnims", "spellVisualAnims",
    "spellScreens", "screens", "icons",
)
"""Every `meta.counts` key, in the order the artifact carries them.

The family keys are listed as they stand today. A rung or a flag added later
lands after them rather than in the middle, which is visible and harmless --
and is one of the things the module split retires.
"""


def document(meta: Mapping[str, object],
             produced: Mapping[str, object]) -> dict[str, object]:
    """The whole pack as one ordered document.

    A section the build switched off is simply absent, exactly as it is in the
    artifact this reproduces.
    """
    ordered: dict[str, object] = {META: meta}
    ordered.update({name: produced[name] for name in SECTION_ORDER
                    if name in produced})
    # Anything produced but unordered still ships: dropping it would lose a
    # route's whole output to a list this module happens to be missing a line
    # from, which is a worse failure than an unfamiliar key at the end.
    ordered.update({name: payload for name, payload in produced.items()
                    if name not in ordered})
    return ordered


def serialize(pack: Mapping[str, object]) -> bytes:
    """The document as the gzipped bytes that land on disk.

    Deterministic by construction: no timestamp in the header and one fixed
    level, so an unchanged pack rebuilds byte-identical and git stores no new
    blob for it.
    """
    raw = json.dumps(pack, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as handle:
        handle.write(raw)
    return buf.getvalue()


def unordered(produced: Sequence[str]) -> list[str]:
    """Which produced sections `SECTION_ORDER` does not name, sorted.

    Nothing fails on it -- `document` ships them anyway -- but a build that
    starts reporting one has grown a section whose place in the artifact nobody
    has decided.
    """
    return sorted(set(produced) - set(SECTION_ORDER))


def write(pack: Mapping[str, object], destination: Path) -> int:
    """Write the pack, and answer how many bytes landed."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = serialize(pack)
    destination.write_bytes(payload)
    return len(payload)
