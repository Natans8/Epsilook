"""The roster's own invariants, which nothing else can state.

A pack's identity is derived -- from its build, and from the line it says it
is. What the derivation must never do is collapse two packs onto one name: the
id is a directory under `site/data/`, a `?v=` value and a database schema, so
two packs agreeing on it is one silently overwriting the other.
"""

from __future__ import annotations

from collections import Counter

import pytest

import packs as roster
from packs import FLAVOURS, PACKS, TEST_LINES, Pack, listed, schema_name, table_sets


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
    no reason, and the id is the one thing a bump must not move.

    The test slots are exempt for the second half of that same reason. A slot
    converges onto live's build and diverges again every patch, so a mark that
    appeared only while it actually collided would move the id twice a cycle.
    Theirs is permanent instead -- the reasoning is on Pack.id.
    """
    shared = {p.build for p in PACKS if sum(1 for other in PACKS if other.build == p.build) > 1}
    for pack in PACKS:
        if pack.build not in shared and pack.flavour not in TEST_LINES:
            assert not pack.mark, f"{pack.key} is marked but shares no build"


def test_every_test_slot_is_marked() -> None:
    """The positive half, which is what keeps a slot's id stable.

    An unmarked slot would be indistinguishable from retail the moment it
    landed on live's build, and its id would then have to change to say so.
    """
    for pack in PACKS:
        if pack.flavour in TEST_LINES:
            assert pack.mark, f"{pack.key} is a test slot with no mark"


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


# A test slot earns its place in the dropdown by leading live. The rule reads
# the roster alone, so these build a roster rather than reaching the network.


def _slot(flavour: str, build: str) -> Pack:
    """One test-line pack, named for the line so failures read plainly."""
    return Pack(flavour, flavour.upper(), flavour, build, tracked=True)


def _roster(monkeypatch: pytest.MonkeyPatch, live: str, *slots: Pack) -> None:
    """Stand up a roster of one retail line and the slots under test."""
    retail = Pack("live", "Live", "wow", live, tracked=True, default=True)
    monkeypatch.setattr(roster, "PACKS", (retail, *slots))


def test_version_compares_as_numbers_not_as_text() -> None:
    """The comparison the rule is built on.

    String order puts "12.1.10" before "12.1.5", which would hide the slot
    that is actually further ahead.
    """
    assert Pack("a", "A", "wow", "12.1.10.1").version > Pack("b", "B", "wow", "12.1.5.1").version


def test_a_slot_level_with_live_is_hidden(monkeypatch: pytest.MonkeyPatch) -> None:
    """It would be a second entry for data the retail pack already ships."""
    slot = _slot("wowt", "12.1.0.69273")
    _roster(monkeypatch, "12.1.0.69273", slot)
    assert not listed(slot)


def test_a_slot_behind_live_is_hidden(monkeypatch: pytest.MonkeyPatch) -> None:
    """Between cycles a slot sits on the patch that already shipped, so it is
    staler than retail rather than a preview of anything."""
    slot = _slot("wowxptr", "11.2.7.65299")
    _roster(monkeypatch, "12.0.0.68000", slot)
    assert not listed(slot)


def test_a_slot_ahead_of_live_is_listed(monkeypatch: pytest.MonkeyPatch) -> None:
    """The whole point of shipping a test line."""
    slot = _slot("wowxptr", "12.1.5.69594")
    _roster(monkeypatch, "12.1.0.69273", slot)
    assert listed(slot)


def test_slots_tied_on_a_build_list_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both slots have carried one patch at the same time. Their packs are
    byte-identical, so listing both offers the same data under two names."""
    first, second = _slot("wowt", "10.2.0.52393"), _slot("wowxptr", "10.2.0.52393")
    _roster(monkeypatch, "10.1.7.52188", first, second)
    assert listed(first)
    assert not listed(second)


def test_slots_leading_on_different_patches_are_both_listed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Never yet observed, and the rule still has to answer for it: two
    genuinely different previews are two different things to offer."""
    first, second = _slot("wowt", "10.2.0.52393"), _slot("wowxptr", "10.2.5.52800")
    _roster(monkeypatch, "10.1.7.52188", first, second)
    assert listed(first)
    assert listed(second)


def test_a_declared_hidden_still_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    """`hidden` is the staging flag and the rule may not overrule it."""
    slot = Pack("wowt", "T", "wowt", "12.1.5.69594", tracked=True, hidden=True)
    _roster(monkeypatch, "12.1.0.69273", slot)
    assert not listed(slot)


def test_a_pack_off_the_test_lines_is_always_listed(monkeypatch: pytest.MonkeyPatch) -> None:
    """The rule narrows to the test slots. A frozen pack is older than live by
    construction and must not be swept up by the same comparison."""
    frozen = Pack("legion", "Legion", "wow", "7.3.5.26972")
    _roster(monkeypatch, "12.1.0.69273", frozen)
    assert listed(frozen)


def test_exactly_one_retail_line_is_tracked() -> None:
    """`retail()` returns the first match, so a second tracked retail row
    would make what a slot is measured against depend on roster order."""
    tracked = [p.key for p in PACKS if p.flavour == "wow" and p.tracked]
    assert len(tracked) == 1, tracked
