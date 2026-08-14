"""Reading members out of a 7-Zip archive.

The TDB releases ship as one solid LZMA2 block, so reaching a member means
decompressing everything in front of it. Piping the member to stdout keeps
hundreds of megabytes of SQL off the filesystem.
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

    Decoding matches the extracted file: same encoding, undecodable bytes
    replaced, newlines translated. Exits when the member matches nothing, which
    7-Zip otherwise reports by writing "no files to process" and exiting zero.
    """
    # stderr goes to a temporary file rather than a second pipe: a pipe nobody
    # is draining fills at 64 KB and deadlocks the extraction.
    with tempfile.TemporaryFile() as complaints:
        process = subprocess.Popen(  # pylint: disable=consider-using-with
            [find_7z(), "x", "-so", str(archive), member],
            stdout=subprocess.PIPE, stderr=complaints)
        stream = process.stdout
        assert isinstance(stream, io.BufferedReader)
        try:
            # `peek` blocks until the first byte arrives and leaves it in the
            # buffer: the only way to ask whether anything is coming.
            if not stream.peek(1):
                sys.exit(f"error: 7z found no member {member} in {archive.name}")
            yield io.TextIOWrapper(stream, encoding="utf-8", errors="replace")
        except BaseException:
            # Closing stdout kills 7-Zip with a broken pipe, so checking its
            # exit status here would hide the caller's own error.
            stream.close()
            process.kill()
            process.wait()
            raise
        stream.close()
        if process.wait() != 0:
            complaints.seek(0)
            said = complaints.read().decode("utf-8", "replace")
            sys.exit(f"error: 7z could not read {member} from {archive.name}: {said[-500:]}")
