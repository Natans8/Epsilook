"""Which rows a supplementary source is allowed to contribute.

A supplement is a second source that adds rows to a first and revises the
columns it carries: the server's hotfixes over the client's db2, an asset-name
supplement over the community listfile. Every one of them needs the same
question answered per row -- does this row count here? -- and the answers differ
only in what they read and what they compare it to:

    hotfixes    the row names the client build it was verified against, and a
                row verified against an older client describes something that
                client already shipped
    asset names a supplement may only name ids the base cannot, which for the
                custom asset space is a floor on the id itself

So the rule is declared as a predicate over one field's text, closed over its
bound at the point the source is wired rather than carried as a separate value
for the merge to remember. That is what lets one merge serve both, and it
removes a failure mode: a bound that arrives separately can arrive missing, and
a comparison against a missing bound admits everything.

Text in, because a provider hands back the source's own text (see
``tables.provider``) and a supplement is judged before anything types it.
"""

from __future__ import annotations

from collections.abc import Callable

Admits = Callable[[str], bool]
"""Whether one supplied row counts, given the text of the field it is judged on.

Unreadable text is refused rather than passed: a field that cannot be compared
is not evidence that the row belongs.
"""


def always(_text: str) -> bool:
    """Admit every row. For a supplement whose rows are all in scope."""
    return True


def at_least(bound: int) -> Admits:
    """Admit a row whose field reads as a number at or above ``bound``.

    Args:
        bound: the inclusive floor.

    Returns:
        The predicate, which refuses text it cannot read as an integer.
    """

    def admits(text: str) -> bool:
        try:
            return int(text) >= bound
        except ValueError:
            return False

    return admits


def above(bound: int) -> Admits:
    """Admit a row whose field reads as a number strictly above ``bound``.

    The exclusive form, for a supplement confined to a range the base cannot
    reach: an id at the boundary belongs to the base, so admitting it would let
    the supplement overwrite a name the base already has. Every value these
    rules read is an integer, so there is nothing between the two bounds and
    the exclusive form is the inclusive one a step up.

    Args:
        bound: the exclusive floor.

    Returns:
        The predicate, which refuses text it cannot read as an integer.
    """
    return at_least(bound + 1)
