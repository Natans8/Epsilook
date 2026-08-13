"""Build progress output.

A build takes minutes and is watched while it runs, so every line is flushed
as it is written rather than when the buffer fills.
"""

from __future__ import annotations


def log(message: str) -> None:
    """Print one line of build progress."""
    print(message, flush=True)
