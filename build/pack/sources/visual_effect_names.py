"""What each visual effect is called, from a client old enough to still say.

`SpellVisualEffectName` carried a human name and a model path until the strings
were stripped out of it during Mists of Pandaria. Every build this repository
packs is later than that, so the table arrives here as an id and a model file id
and nothing a reader could search for.

A checked-in table of names, distilled once from a vendored client by
`tools/fxnames.py` rather than fetched, for the same reason the expansion ladder
is: no published archive serves a client from the window where the names were
last complete.

Nothing here decides which of these names is true of a pack. A name belongs to
an effect id, ids get reused between expansions, and whether this pack's row for
that id still means what it meant is a question only that pack's own data can
answer. The stem is what makes the question answerable, and the derivation that
asks it lives with the build rather than with the source.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import Mapping
from typing import NamedTuple, TypeAlias

from .cache import BUILD_DIR, tracked_source
from .source import Source

VISUAL_EFFECT_NAMES_FILE = BUILD_DIR / "visual_effect_names.json.gz"


class VisualEffectName(NamedTuple):
    """One recovered name, and the evidence for keeping it."""

    name: str
    """What the client called the effect."""

    stem: str
    """The bare filename of the model it drew, folded for comparison.

    Kept beside the name because it is the whole of the corroboration: a pack
    earns this name only where its own row for the same id still points at an
    asset whose path ends in this. An id reused for something else fails that
    test, which is the failure the name would otherwise assert confidently.
    """


VisualEffectNames: TypeAlias = Mapping[int, VisualEffectName]
"""Effect id to its recovered name. Total over what the vendored client knew,
which is a subset of what any modern pack references."""


def visual_effect_names_source() -> Source:
    """The checked-in table: in the checkout, or nowhere.

    No fetch can produce it -- it was distilled once from a vendored client --
    so acquiring it is the check that it is there.
    """
    return tracked_source("visual effect names", VISUAL_EFFECT_NAMES_FILE)


def load_visual_effect_names() -> VisualEffectNames:
    """Load the checked-in names.

    Returns:
        Effect id to its name and the model stem that vouches for it.

    Raises:
        ValueError: if the three columns are not the same length, which would
            pair a name with another effect's evidence and corroborate the
            wrong thing.
    """
    with gzip.open(VISUAL_EFFECT_NAMES_FILE, "rt", encoding="utf-8") as f:
        data = json.load(f)
    ids, names, stems = data["ids"], data["names"], data["stems"]
    if not len(ids) == len(names) == len(stems):
        raise ValueError(
            f"{VISUAL_EFFECT_NAMES_FILE.name}: {len(ids)} ids, {len(names)} names "
            f"and {len(stems)} stems -- the columns are not parallel")
    return {int(effect): VisualEffectName(name, stem)
            for effect, name, stem in zip(ids, names, stems)}
