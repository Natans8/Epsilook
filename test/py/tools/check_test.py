"""The repo guards' own guard: a run that spanned two trees reports neither."""

from check import OUTDATED_LINE, serves, straddle_report

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
