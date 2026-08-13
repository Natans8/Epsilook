"""Reading members out of a 7-Zip archive.

The TDB releases ship as one solid LZMA2 block, so there is no cheap way to
reach a member without decompressing everything in front of it. Streaming is
still worth doing: piping a member to stdout keeps hundreds of megabytes of
SQL out of the filesystem entirely, which is the whole reason the extracted
dumps used to be deleted immediately after they were read.
"""

from __future__ import annotations

import io
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import TextIO


def find_7z() -> str:
    """Locate the 7-Zip executable, or exit with an actionable message."""
    for candidate in (shutil.which("7z"), r"C:\Program Files\7-Zip\7z.exe", "/usr/bin/7z"):
        if candidate and Path(candidate).exists():
            return candidate
    sys.exit("error: 7-Zip (7z) is required to extract the TDB archive — install it "
             "or place the extracted .sql files in the cache tdb dir yourself")


@contextmanager
def read_member(archive: Path, member: str) -> Iterator[TextIO]:
    """Yield a member's text, line by line, without writing it to disk.

    Decoding matches what reading the extracted file would give: the same
    encoding, undecodable bytes replaced rather than fatal, and newlines
    translated.

    An empty result is always an error. 7-Zip reports a member that matches
    nothing by writing "no files to process" and exiting zero, so a mistyped
    member name would otherwise stream cleanly to the caller as a dump
    containing no tables at all.
    """
    # stderr goes to a temporary file rather than a second pipe. 7-Zip writes
    # its banner and any warning there while stdout is still streaming, and a
    # pipe nobody is draining fills at 64 KB and deadlocks the extraction.
    with tempfile.TemporaryFile() as complaints:
        process = subprocess.Popen(  # pylint: disable=consider-using-with
            [find_7z(), "x", "-so", str(archive), member],
            stdout=subprocess.PIPE, stderr=complaints)
        # A byte pipe, so `peek` is available -- which is the only way to ask
        # whether anything is coming without consuming it.
        stream = process.stdout
        assert isinstance(stream, io.BufferedReader)
        try:
            # Blocks until the first byte arrives or the member turns out to be
            # empty, and leaves it in the buffer for the caller to read.
            if not stream.peek(1):
                sys.exit(f"error: 7z found no member {member} in {archive.name}")
            yield io.TextIOWrapper(stream, encoding="utf-8", errors="replace")
        except BaseException:
            # The caller failed, and its reason is the one worth seeing. Closing
            # stdout kills 7-Zip with a broken pipe, so checking its exit status
            # here would replace a real error with an extraction error.
            stream.close()
            process.kill()
            process.wait()
            raise
        stream.close()
        if process.wait() != 0:
            complaints.seek(0)
            said = complaints.read().decode("utf-8", "replace")
            sys.exit(f"error: 7z could not read {member} from {archive.name}: {said[-500:]}")
