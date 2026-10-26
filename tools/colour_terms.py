#!/usr/bin/env python3
"""The English colour-word table, generated from a colour-naming model.

    uv run python tools/colour_terms.py            # report what the table holds
    uv run python tools/colour_terms.py --write    # rewrite src/search/vocabulary/colour-terms.json
    uv run python tools/colour_terms.py --check    # exit 1 where the committed table is stale

A colour word is matched by asking what people call a stored colour. The answer
comes from c3 (Heer and Stone, "Color Naming Models for Color Selection, Image
Editing and Palette Design", CHI 2012): counts of the names the xkcd colour
survey's respondents gave, per 5-unit CIELAB bin. Both inputs are vendored in
build/sources/ so the table is rebuilt rather than only trusted:

    c3-xkcd-model.json.gz       StanfordHCI/c3 at d3576c7, data/xkcd/c3_data.json, BSD-3-Clause
    xkcd-colour-names.txt.gz    xkcd.com/color/rgb.txt, the survey's published names, CC0

Everything a reading engine would otherwise have to work out is decided here,
once, so the engines only look things up:

- The words are the c3 names the published list spells as one word and never
  as several. A name with a modifier ("light purple") is a shade of the word it
  modifies rather than a colour of its own, and in the model it takes answers
  away from that word.
- A colour's names are the fewest words that together cover half of what people
  called it, so a colour can carry several.
- A word's broader words are the basic colour terms people use for the same
  colours, by the same half rule over c3's association between words. A basic
  term has none. This is what lets `purple` find a colour people call lavender.
- A colour is looked up by its sRGB cell, 32 to a channel, so an engine indexes
  by three divisions and does no colour arithmetic. A cell takes the names of the
  c3 bin its centre falls in, or of the nearest bin where that one is empty.
"""

import argparse
import gzip
import json
import math
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import NamedTuple

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "build" / "sources" / "c3-xkcd-model.json.gz"
PUBLISHED = ROOT / "build" / "sources" / "xkcd-colour-names.txt.gz"
TABLE = ROOT / "src" / "search" / "vocabulary" / "colour-terms.json"

BASIC = ("black", "white", "grey", "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown")
"""Berlin and Kay's eleven basic colour terms, spelled as c3 spells them."""

HALF = 0.5
"""The share of people's answers a set of names has to cover to stand for them."""

CELLS = 32
"""Lookup cells per sRGB channel; each spans 256 / CELLS values."""

BIN = 5
"""The width of a c3 bin in each CIELAB coordinate."""

WHITE = (0.95047, 1.0, 1.08883)
"""The D65 reference white c3 bins its colours under."""


class Model(NamedTuple):
    """c3's colour-name table, read once."""

    bins: list[tuple[int, int, int]]
    """Each bin's CIELAB centre, in the model's order."""

    terms: list[str]
    """Every name the model counts, in its order."""

    counts: list[dict[int, int]]
    """Per bin, how many times people gave each name, by the name's index."""

    association: list[float]
    """c3's association between names, row-major: the cell for (i, w) is how
    strongly the colours called w are also called i."""


def load_model(path: Path = MODEL) -> Model:
    """The vendored c3 model."""
    with gzip.open(path, "rt", encoding="utf-8") as file:
        raw = json.load(file)
    colour = raw["color"]
    terms: list[str] = raw["terms"]
    bins = [(colour[i], colour[i + 1], colour[i + 2]) for i in range(0, len(colour), 3)]
    counts: list[dict[int, int]] = [{} for _ in bins]
    flat = raw["T"]
    for i in range(0, len(flat), 2):
        at, count = divmod(flat[i], len(terms)), flat[i + 1]
        counts[at[0]][at[1]] = count
    return Model(bins, terms, counts, raw["A"])


def single_words(path: Path = PUBLISHED) -> set[str]:
    """The names the survey published as one word and never as several.

    The list carries some names both ways, `lightblue` beside `light blue`, and
    c3 strips the space from every name, so a name spelled anywhere with a
    space or a mark is a phrase whatever else the list says.
    """
    with gzip.open(path, "rt", encoding="utf-8") as file:
        names = {line.split("\t", 1)[0].strip() for line in file if line.strip() and not line.startswith("#")}
    squashed = {"".join(char for char in name if char.isalpha()) for name in names if not name.isalpha()}
    return {name for name in names if name.isalpha() and name not in squashed}


def leading(shares: Iterable[tuple[str, float]], order: Mapping[str, int]) -> list[str]:
    """The fewest names that together cover half the answers, the likeliest first.

    Ties are broken by the model's own order of names, so the table never
    depends on how a sort happened to settle.
    """
    total = 0.0
    picked: list[str] = []
    for name, share in sorted(shares, key=lambda item: (-item[1], order[item[0]])):
        picked.append(name)
        total += share
        if total >= HALF:
            break
    return picked


def normalised(weights: Mapping[str, float]) -> list[tuple[str, float]]:
    """Weights scaled to shares of their sum; empty where nothing weighs anything."""
    total = sum(weights.values())
    return [(name, weight / total) for name, weight in weights.items() if weight > 0] if total > 0 else []


def broader(model: Model, words: Sequence[str]) -> dict[str, list[str]]:
    """Each word that is not a basic term, mapped to the basic terms it sits under."""
    index = {term: at for at, term in enumerate(model.terms)}
    width = len(model.terms)
    out: dict[str, list[str]] = {}
    for word in words:
        if word in BASIC:
            continue
        column = index[word]
        weights = {basic: model.association[index[basic] * width + column] for basic in BASIC}
        out[word] = leading(normalised(weights), index)
    return out


def lab(red: int, green: int, blue: int) -> tuple[float, float, float]:
    """An sRGB colour in CIELAB under D65."""

    def linear(channel: int) -> float:
        value = channel / 255
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4

    r, g, b = linear(red), linear(green), linear(blue)
    x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE[0]
    y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / WHITE[1]
    z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / WHITE[2]

    def f(t: float) -> float:
        return t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116

    return 116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))


def bin_of(model: Model, where: Mapping[tuple[int, int, int], int], colour: tuple[float, float, float]) -> int:
    """The c3 bin a CIELAB colour falls in, or the nearest one that people named."""
    snapped = tuple(BIN * round(value / BIN) for value in colour)
    hit = where.get((snapped[0], snapped[1], snapped[2]))
    if hit is not None:
        return hit
    return min(where.values(), key=lambda at: math.dist(model.bins[at], colour))


def generate(model: Model, singles: set[str]) -> dict[str, object]:
    """The table: the words, what each sits under, the distinct sets of names, and each cell's set."""
    order = {term: at for at, term in enumerate(model.terms)}
    words = [term for term in model.terms if term in singles]
    kept = set(words)
    # A bin no single word was given for names nothing, so it is never the
    # nearest bin a cell borrows from.
    where = {
        centre: at
        for at, centre in enumerate(model.bins)
        if any(model.terms[term] in kept for term in model.counts[at])
    }
    names_by_bin: dict[int, tuple[str, ...]] = {}
    for at in where.values():
        weights = {model.terms[term]: float(count) for term, count in model.counts[at].items()}
        names_by_bin[at] = tuple(leading(normalised({w: v for w, v in weights.items() if w in kept}), order))

    sets: dict[tuple[str, ...], int] = {}
    cells: list[int] = []
    span = 256 // CELLS
    for red in range(CELLS):
        for green in range(CELLS):
            for blue in range(CELLS):
                centre = lab(red * span + span // 2, green * span + span // 2, blue * span + span // 2)
                names = names_by_bin[bin_of(model, where, centre)]
                cells.append(sets.setdefault(names, len(sets)))
    return {
        "words": words,
        "basic": [word for word in BASIC if word in kept],
        "broader": broader(model, words),
        "names": [list(names) for names in sets],
        "cells": cells,
    }


def written(table: Mapping[str, object]) -> str:
    """The table as JSON laid out for a reader: one set per line, one row of cells per line."""
    cells = table["cells"]
    if not isinstance(cells, list):
        raise TypeError("cells must be a list")
    head = {key: value for key, value in table.items() if key not in ("names", "cells")}
    lines = ["{"]
    for key, value in head.items():
        lines.append(f"  {json.dumps(key)}: {json.dumps(value)},")
    names = table["names"]
    if not isinstance(names, list):
        raise TypeError("names must be a list")
    lines.append('  "names": [')
    lines.extend(f"    {json.dumps(entry)}{',' if at < len(names) - 1 else ''}" for at, entry in enumerate(names))
    lines.append("  ],")
    lines.append('  "cells": [')
    rows = [cells[at : at + CELLS] for at in range(0, len(cells), CELLS)]
    lines.extend(
        f"    {', '.join(str(cell) for cell in row)}{',' if at < len(rows) - 1 else ''}" for at, row in enumerate(rows)
    )
    lines.append("  ]")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main() -> None:
    """Report, write or check the table."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="rewrite the committed table")
    mode.add_argument("--check", action="store_true", help="exit 1 where the committed table is stale")
    args = parser.parse_args()

    text = written(generate(load_model(), single_words()))
    if args.check:
        current = TABLE.read_text(encoding="utf-8") if TABLE.exists() else ""
        if current != text:
            sys.exit(f"error: {TABLE.relative_to(ROOT)} is stale; run python tools/colour_terms.py --write")
        return
    if args.write:
        TABLE.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {TABLE.relative_to(ROOT)}")
        return
    table = json.loads(text)
    print(f"{len(table['words'])} words, {len(table['names'])} distinct sets of names, {len(table['cells'])} cells")
    for word, above in table["broader"].items():
        print(f"  {word:12} under {', '.join(above)}")


if __name__ == "__main__":
    main()
