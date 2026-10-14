"""The repo guards' own guard: a run that spanned two trees reports neither."""

import shutil

import pytest

from check import (
    FLOOR,
    OUTDATED_LINE,
    WORKFLOW_PYTHON,
    next_minor,
    python_next_blockers,
    python_next_line,
    serves,
    straddle_report,
)

STILL = "0432111abcd"
MOVED = "611c88dfeed"


def test_a_tree_that_held_still_is_reported_as_nothing() -> None:
    """The ordinary run, where HEAD is where it was."""
    assert straddle_report(STILL, STILL) is None


def test_a_head_that_moved_under_the_run_is_reported() -> None:
    """Both ends are named, because which commits they were is the finding.

    A full run takes minutes and a shared checkout has siblings committing
    inside them, so this is a race that happens rather than one that could.
    """
    report = straddle_report(STILL, MOVED)
    assert report is not None
    assert STILL[:9] in report
    assert MOVED[:9] in report


def test_git_that_cannot_answer_stands_down() -> None:
    """An empty answer is git declining, not a tree moving.

    Outside a repository, or with git absent, there is no question to answer
    and a run refused for want of one would be a worse instrument than a run
    that said nothing.
    """
    assert straddle_report("", MOVED) is None
    assert straddle_report(STILL, "") is None
    assert straddle_report("", "") is None


DUCKDB_314 = [
    "duckdb-1.5.6-cp314-cp314-manylinux_2_26_x86_64.manylinux_2_28_x86_64.whl",
    "duckdb-1.5.6-cp314-cp314-win_amd64.whl",
]


def test_a_wheel_built_for_one_minor_serves_that_minor_alone() -> None:
    """The case that holds the interpreter back: a compiled wheel names its CPython."""
    assert serves(DUCKDB_314, 14, "Windows")
    assert serves(DUCKDB_314, 14, "Linux")
    assert not serves(DUCKDB_314, 15, "Windows")
    assert not serves(DUCKDB_314, 15, "Linux")


def test_a_wheel_serves_only_the_platform_it_names() -> None:
    """A Linux wheel is no answer for this machine, nor a Windows one for CI."""
    assert not serves(DUCKDB_314[:1], 14, "Windows")
    assert not serves(DUCKDB_314[1:], 14, "Linux")
    assert not serves(["duckdb-1.5.6-cp314-cp314-manylinux_2_26_aarch64.whl"], 14, "Linux")


def test_a_wheel_free_of_the_interpreter_serves_every_minor() -> None:
    """Pure wheels, platform wheels with no ABI, and the stable ABI from its floor up."""
    assert serves(["pyflakes-4.0.3-py3-none-any.whl"], 15, "Windows")
    assert serves(["ruff-0.17.0-py3-none-win_amd64.whl"], 15, "Windows")
    assert not serves(["ruff-0.17.0-py3-none-win_amd64.whl"], 15, "Linux")
    assert serves(["ast_serialize-0.12.1-cp312-abi3-win_amd64.whl"], 15, "Windows")
    assert serves(["ast_serialize-0.12.1-cp315-abi3.abi3t-win_amd64.whl"], 15, "Windows")
    assert not serves(["ast_serialize-0.12.1-cp316-abi3-win_amd64.whl"], 15, "Windows")


def test_uv_reports_an_outdated_dependency_with_its_group() -> None:
    """The tree drawing, the version and any group all sit before the latest release."""
    tree = (
        "epsilook-build v0\n"
        "├── duckdb v1.5.5 (latest: v1.5.6)\n"
        "├── lupa v2.8 (group: dev)\n"
        "└── mypy v2.3.0 (group: dev) (latest: v2.4.0)\n"
    )
    found = {m["name"]: (m["locked"], m["latest"]) for m in OUTDATED_LINE.finditer(tree)}
    assert found == {"duckdb": ("1.5.5", "1.5.6"), "mypy": ("2.3.0", "2.4.0")}


def test_a_blocked_minor_is_named_with_what_blocks_it() -> None:
    """The one sentence the check and the weekly issue share, in both of its states."""
    assert python_next_line(15, ["duckdb 1.5.6 (Windows, Linux)"]) == (
        "3.14 stays: no 3.15 wheel for duckdb 1.5.6 (Windows, Linux)"
    )
    assert "3.15 is installable" in python_next_line(15, [])


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv lists the interpreters")
def test_the_minor_the_lock_was_resolved_for_blocks_on_nothing() -> None:
    """Every locked wheel serves the interpreter it was locked on, so no package reaches PyPI.

    This is the whole question answered end to end without the network: if it
    named a blocker here, the readiness check would never turn.
    """
    assert python_next_blockers(next_minor() - 1) == []


def test_a_workflow_names_its_interpreter_by_version_or_by_file() -> None:
    """Both spellings are read, so a step that still points at a pin file is caught rather than skipped."""
    steps = (
        "      - uses: astral-sh/setup-uv@v10.3.0\n"
        "        with:\n"
        '          python-version: "3.14"\n'
        "      - uses: actions/setup-python@v7\n"
        "        with:\n"
        "          python-version-file: .python-version\n"
    )
    found = [(m["file"] is not None, m["value"]) for m in WORKFLOW_PYTHON.finditer(steps)]
    assert found == [(False, "3.14"), (True, ".python-version")]


def test_the_floor_is_a_plain_lower_bound() -> None:
    """A range or an exact pin is not a floor, and the guard refuses rather than guessing which end to read."""
    assert FLOOR.fullmatch(">=3.14") is not None
    assert FLOOR.fullmatch(">=3.14,<3.16") is None
    assert FLOOR.fullmatch("==3.14") is None
