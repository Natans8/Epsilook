"""The roster manifest: which packs exist, and what busts their caches."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from pack.emit.versions import entry, update, version_key


def read(manifest: Path) -> list[dict[str, object]]:
    """The manifest as the app would read it."""
    loaded = json.loads(manifest.read_text(encoding="utf-8"))
    assert isinstance(loaded, list)
    return loaded


def test_a_pack_is_hashed_over_the_bytes_that_ship() -> None:
    """The hash is the whole cache-busting mechanism, so it has to be taken
    over the artifact itself rather than over anything describing it.
    """
    made = entry("9.2.7.45745", "Shadowlands 9.2.7", "2026-08-14", b"payload")
    assert made["hash"] == hashlib.sha256(b"payload").hexdigest()[:10]


def test_an_unchanged_pack_keeps_its_hash() -> None:
    """A rebuild that changes no data must not make every browser refetch, and
    the pack is written deterministically precisely so this holds.
    """
    first = entry("9.2.7.45745", "Shadowlands 9.2.7", "2026-08-14", b"payload")
    later = entry("9.2.7.45745", "Shadowlands 9.2.7", "2026-08-15", b"payload")
    assert first["hash"] == later["hash"]


def test_a_flag_is_absent_rather_than_false(tmp_path: Path) -> None:
    """The app tests for the key, so writing a false one would mark every
    ordinary pack as carrying a property it does not have.
    """
    made = entry("9.2.7.45745", "Shadowlands 9.2.7", "2026-08-14", b"payload")
    assert "hidden" not in made
    assert "default" not in made


def test_rebuilding_one_pack_replaces_only_its_own_entry(tmp_path: Path) -> None:
    """Every other pack on the roster is untouched on disk, so its entry has to
    survive a neighbour being rebuilt.
    """
    manifest = tmp_path / "versions.json"
    update(manifest, entry("9.2.7.45745", "Shadowlands", "2026-08-01", b"old"))
    update(manifest, entry("10.2.7.55664", "Dragonflight", "2026-08-01", b"df"))
    update(manifest, entry("9.2.7.45745", "Shadowlands", "2026-08-14", b"new"))

    kept = read(manifest)
    assert [one["id"] for one in kept] == ["9.2.7.45745", "10.2.7.55664"]
    assert [one["built"] for one in kept] == ["2026-08-14", "2026-08-01"]


def test_only_one_pack_is_ever_the_default(tmp_path: Path) -> None:
    """Two defaults is not a worse default, it is an undefined one: the app
    takes the first it finds, so which pack it serves would depend on roster
    order rather than on anything anyone declared.
    """
    manifest = tmp_path / "versions.json"
    update(manifest, entry("9.2.7.45745", "Shadowlands", "2026-08-01", b"sl", default=True))
    update(manifest, entry("10.2.7.55664", "Dragonflight", "2026-08-01", b"df", default=True))

    defaults = [one["id"] for one in read(manifest) if one.get("default")]
    assert defaults == ["10.2.7.55664"]


def test_a_hidden_pack_stays_hidden_across_a_neighbours_rebuild(tmp_path: Path) -> None:
    """Hidden means nobody downloads it without asking for it by name, which
    stops being true the moment the flag is dropped by something else.
    """
    manifest = tmp_path / "versions.json"
    update(manifest, entry("12.1.0-ptr.69273", "Midnight PTR", "2026-08-01", b"ptr", hidden=True))
    update(manifest, entry("9.2.7.45745", "Shadowlands", "2026-08-01", b"sl", default=True))

    hidden = [one["id"] for one in read(manifest) if one.get("hidden")]
    assert hidden == ["12.1.0-ptr.69273"]


def test_a_build_sorts_by_number_and_not_as_text() -> None:
    """Sorted as text a ten comes before a nine, and the app takes the newest
    visible pack when no version is named.
    """
    assert version_key("10.2.7.55664") > version_key("9.2.7.45745")


def test_a_test_line_sorts_beside_the_build_it_shadows(tmp_path: Path) -> None:
    """Its id keys identically to that build, so without the tie-break the
    order would depend on which of the two was rebuilt last.
    """
    manifest = tmp_path / "versions.json"
    update(manifest, entry("12.1.0-ptr.69273", "Midnight PTR", "2026-08-01", b"ptr", hidden=True))
    update(manifest, entry("12.1.0.69273", "Midnight", "2026-08-01", b"live"))

    assert [one["id"] for one in read(manifest)] == ["12.1.0.69273", "12.1.0-ptr.69273"]


def test_the_first_pack_built_creates_the_manifest(tmp_path: Path) -> None:
    """A checkout with no manifest is where a fresh clone starts, and the build
    is what puts one there.
    """
    manifest = tmp_path / "versions.json"
    update(manifest, entry("9.2.7.45745", "Shadowlands", "2026-08-14", b"sl"))
    assert read(manifest)[0]["file"] == "data/9.2.7.45745/manifest.json"
