"""Build progress output, flushed per line so a running build can be watched."""

from __future__ import annotations


def log(message: str) -> None:
    """Print one line of build progress."""
    print(message, flush=True)
