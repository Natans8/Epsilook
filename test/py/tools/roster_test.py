"""The roster's own invariants, which nothing else can state.

A pack's identity is derived -- from its build, and from the line it says it
is. What the derivation must never do is collapse two packs onto one name: the
id is a directory under `site/data/`, a `?v=` value and a database schema, so
two packs agreeing on it is one silently overwriting the other.
"""

from __future__ import annotations

from collections import Counter

from packs import FLAVOURS, PACKS, schema_name, table_sets


def test_every_pack_names_a_declared_line() -> None:
    """A typo would otherwise be a pack nothing can find."""
    for pack in PACKS:
        assert pack.flavour in FLAVOURS, f"{pack.key} is {pack.flavour!r}"


def test_pack_ids_are_unique() -> None:
    """The id is a directory, a url and a schema. Two packs sharing one is one
    of them overwriting the other, in all three places."""
    repeated = [i for i, n in Counter(p.id for p in PACKS).items() if n > 1]
    assert not repeated, repeated


def test_schema_names_are_unique() -> None:
    """Distinct ids can still collapse: the schema keeps three dot-separated
    parts and turns a dash into an underscore, so it is a lossier name."""
    repeated = [s for s, n in Counter(schema_name(p.id) for p in PACKS).items() if n > 1]
    assert not repeated, repeated


def test_packs_sharing_a_build_are_told_apart_by_their_line() -> None:
    """The invariant the mark exists for.

    Two packs on one build are only distinguishable by the line they came
    from, so at most one of them may go unmarked -- and the marked ones must
    not agree either.
    """
    by_build: dict[str, list[str]] = {}
    for pack in PACKS:
        by_build.setdefault(pack.build, []).append(pack.mark)
    for build, marks in by_build.items():
        if len(marks) > 1:
            assert len(set(marks)) == len(marks), f"{build} has marks {marks}"


def test_a_line_that_never_shares_a_build_needs_no_mark() -> None:
    """A mark on a pack nothing collides with would put a word in a url for
    no reason, and the id is the one thing a bump must not move."""
    shared = {p.build for p in PACKS if sum(1 for other in PACKS if other.build == p.build) > 1}
    for pack in PACKS:
        if pack.build not in shared:
            assert not pack.mark, f"{pack.key} is marked but shares no build"


def test_a_table_set_is_where_the_bytes_came_from_not_which_line() -> None:
    """Retail and its PTR are two lines and one downloaded export, which is
    why their modules come out byte-identical; a private client's decode is a
    set of its own."""
    sets = table_sets()
    assert len(sets) == len({(p.build, p.client) for p in PACKS})
    assert len(sets) < len(PACKS), "nothing shares an export, so the roster changed"
    assert any(p.client for p in sets), "the client build is missing from the sets"


def test_only_a_tracked_pack_may_be_asked_for_a_newer_build() -> None:
    """`epsilon` is our own code and no version service answers for it, so
    polling it would be a request nobody can serve."""
    for pack in PACKS:
        if pack.flavour == "epsilon":
            assert not pack.tracked, f"{pack.key} would poll a service that has none"
