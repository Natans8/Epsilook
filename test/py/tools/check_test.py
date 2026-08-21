"""The repo guards' own guard: a run that spanned two trees reports neither."""

from __future__ import annotations

from check import straddle_report

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
