"""When a private client's extracted tables count as current.

A private client's operator pushes new content under a build number that never
moves, so the extraction is current only for the configuration the service
publishes now. The service is stood in for by the one answer the test needs:
which configuration it names.
"""

from pathlib import Path

import pytest

from pack.sources import client
from pack.sources.casc import EPSILON
from pack.sources.client import STAMP, ClientTables
from pack.sources.listfile import listfile_source

BUILD = "9.2.7.45745"
PUSHED, LATER = "aa" * 16, "bb" * 16


def extraction(into: Path) -> ClientTables:
    """Two tables of the Epsilon client, extracted into a directory of the test's own."""
    return ClientTables(
        name="tables",
        service=EPSILON,
        version=BUILD,
        tables=("Map", "Emotes"),
        into=into,
        listfile=listfile_source(),
        definitions=into,
    )


def publishing(monkeypatch: pytest.MonkeyPatch, build_config: str) -> None:
    """Have the service name this configuration as the one it is on."""
    monkeypatch.setattr(client, "published", lambda _service: {"BuildConfig": build_config})


def stamped(into: Path, *lines: str) -> None:
    (into / STAMP).write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_an_extraction_of_the_configuration_published_now_is_current(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    publishing(monkeypatch, PUSHED)
    stamped(tmp_path, BUILD, PUSHED, "Emotes", "Map")
    assert extraction(tmp_path).complete()


def test_a_push_under_the_same_build_number_makes_it_stale(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The number is the same on both sides, and the tables are not."""
    publishing(monkeypatch, LATER)
    stamped(tmp_path, BUILD, PUSHED, "Emotes", "Map")
    assert not extraction(tmp_path).complete()


def test_a_stamp_that_names_no_configuration_is_stale(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A directory stamped by the build number alone cannot say which push it holds."""
    publishing(monkeypatch, PUSHED)
    stamped(tmp_path, BUILD, "Emotes", "Map")
    assert not extraction(tmp_path).complete()


def test_a_directory_with_no_stamp_is_stale_without_asking_the_service(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def asked(_service: object) -> dict[str, str]:
        pytest.fail("an absent stamp answers the question by itself")

    monkeypatch.setattr(client, "published", asked)
    assert not extraction(tmp_path).complete()
