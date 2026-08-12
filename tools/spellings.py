"""Generates the regional-spelling fold table from VarCon, kept to the pairs this app's corpus can meet.

VarCon (Variant Conversion Info, part of the SCOWL/aspell wordlist project, https://wordlist.aspell.net/varcon/)
maps American, British and Canadian forms of the same word, inflections included. This script reads it from the
pinned `varcon` npm package, keeps the well-attested American/British SPELLING pairs, intersects them with the
vocabulary of the default pack's searchable text (names, descriptions, file paths, area names), and writes the
survivors to src/search/spelling-folds.ts.

The spelling-versus-vocabulary distinction is the SOURCE's, not this script's: VarCon ships vocabulary
correspondences (different words for one thing) in a separate voc.tab, which this script never reads, so nothing
here needs to judge what counts as a spelling. Three mechanical filters remain:

- Only variants under a bare preferred tag; the v/V/-/x suffixes mark forms a dictionary lists but does not prefer.
- Only lowercase source words at cluster level 70 or below: capitalised entries are proper nouns, and the levels
  above 70 are VarCon's own rare-and-technical tiers, where a fold can only false-merge.
- Only pairs the corpus can meet: one it cannot can never change a match, so shipping it would cost regex size for
  nothing. The two sides of a pair meet the corpus differently, because folding is word-bounded while matching is
  substring: the AMERICAN side counts when it occurs anywhere inside a corpus word (a folded query word then
  substring-reaches it, glued asset paths included — dishonour finds dishonorable), while the BRITISH side counts
  only as a whole corpus word (a glued british fragment never folds, so a pair it alone justifies is dead weight).
  The output is checked in, so drift shows as a diff.

Re-run after a default-pack bump if spelling coverage looks off.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VARCON = ROOT / "node_modules" / "varcon" / "varcon.txt"
OUT = ROOT / "src" / "search" / "spelling-folds.ts"
DB = ROOT / "build" / "cache" / "epsilook.duckdb"

# A variant is kept only under a bare category tag (or the equal-variants dot): the v/V/-/x suffixes mark forms a
# dictionary lists but does not prefer, and folding those would merge words on weak evidence.
PREFERRED = re.compile(r"^[ABZ]\.?$")
WORD = re.compile(r"^[a-z]+$")
LEVEL = re.compile(r"^# .* \(level (\d+)\)")

# VarCon's cluster levels follow SCOWL's commonness tiers; above 70 sit the rare and technical words, where a fold
# can only false-merge (its own example: the soil term aeric against the name eric).
MAX_LEVEL = 70

# Within the last kept tier, the short entries are dominated by cross-language and obsolete fragments (aet, cre,
# poe) whose folds collide with names, while the words worth keeping there run long (dematerialise, multicolour).
OBSCURE_LEVEL = 70
OBSCURE_MIN_LENGTH = 6


def parse_pairs(text: str) -> dict[str, str]:
    """Extracts british -> american spelling pairs from varcon.txt.

    Each data line holds ` / `-separated variants, each as space-separated tags, a colon, and the word. American is
    tag A; British is B (ise) and Z (ize), with B implying Z when no Z variant is on the line. A `# word (level N)`
    header carries the cluster's commonness until the next header. Capitalised source words are proper nouns and
    are skipped before lowercasing.
    """
    pairs: dict[str, str] = {}
    level = 0
    for line in text.splitlines():
        header = LEVEL.match(line)
        if header is not None:
            level = int(header.group(1))
            continue
        line = line.split("#", 1)[0].strip()
        if " / " not in line or ": " not in line or level > MAX_LEVEL:
            continue
        american: str | None = None
        british: list[str] = []
        for variant in line.split(" / "):
            tags, _, word = variant.partition(": ")
            word = word.strip()
            if not WORD.fullmatch(word):
                continue
            kept = [t for t in tags.split() if PREFERRED.fullmatch(t)]
            if any(t.startswith("A") for t in kept) and american is None:
                american = word
            if any(t.startswith(("B", "Z")) for t in kept):
                british.append(word)
        if american is None:
            continue
        for word in british:
            if word == american or word in pairs:
                continue
            if level >= OBSCURE_LEVEL and len(word) < OBSCURE_MIN_LENGTH:
                continue
            pairs[word] = american
    if pairs.get("colour") != "color":
        raise SystemExit("varcon.txt did not yield colour -> color; the format assumption is broken")
    return pairs


def corpus_words() -> set[str]:
    """Returns every lowercase word occurring in the default pack's searchable text, extracted inside DuckDB."""
    try:
        import duckdb  # type: ignore[import-not-found]  # optional, dev-tool-only, like builddb.py
    except ImportError:
        raise SystemExit("tools/spellings.py needs DuckDB: python -m pip install duckdb") from None

    sources = [
        'SELECT "Name_lang" AS t FROM v9_2_7."SpellName"',
        'SELECT "Description_lang" AS t FROM v9_2_7."Spell"',
        'SELECT "AuraDescription_lang" AS t FROM v9_2_7."Spell"',
        'SELECT "AreaName_lang" AS t FROM v9_2_7."AreaTable"',
        "SELECT path AS t FROM ref.listfile",
    ]
    union = " UNION ALL ".join(sources)
    sql = (
        "SELECT DISTINCT word FROM ("
        f"  SELECT unnest(regexp_split_to_array(lower(t), '[^a-z]+')) AS word FROM ({union})"
        ") WHERE word <> ''"
    )
    con = duckdb.connect(str(DB), read_only=True)
    try:
        return {row[0] for row in con.execute(sql).fetchall()}
    finally:
        con.close()


def emit(pairs: dict[str, str]) -> None:
    """Writes the generated table, sorted for stable diffs."""
    rows = "\n".join(f'    ["{b}", "{a}"],' for b, a in sorted(pairs.items()))
    OUT.write_text(
        "/**\n"
        " * @file Regional spelling pairs the corpus can meet, british form first.\n"
        " *\n"
        " * Generated by tools/spellings.py from VarCon (the SCOWL/aspell wordlist project,\n"
        " * https://wordlist.aspell.net/varcon/, data copyright Kevin Atkinson and contributors under its own\n"
        " * permissive licence, via the pinned `varcon` npm package) intersected with the default pack's\n"
        " * searchable text. Spelling variants only, never vocabulary correspondences. Do not edit by hand;\n"
        " * re-run the generator instead.\n"
        " */\n\n"
        "/** British spelling to the American spelling the game data uses. */\n"
        "export const SPELLING_FOLDS: readonly (readonly [string, string])[] = [\n"
        f"{rows}\n"
        "];\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> None:
    if not VARCON.exists():
        raise SystemExit("node_modules/varcon/varcon.txt is missing; run `npm install` first")
    pairs = parse_pairs(VARCON.read_text(encoding="latin-1"))
    words = corpus_words()
    blob = " ".join(words)
    kept = {b: a for b, a in pairs.items() if b in words or a in blob}
    emit(kept)
    print(f"varcon pairs: {len(pairs)}  corpus words: {len(words)}  kept: {len(kept)}  -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
