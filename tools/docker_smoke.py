#!/usr/bin/env python3
"""Prove the container actually serves Epsilook.

    python tools/docker_smoke.py                  # build the image, run it, check it
    python tools/docker_smoke.py --no-build       # check an image that already exists
    python tools/docker_smoke.py --image ghcr.io/natans8/epsilook:latest
    python tools/docker_smoke.py --keep           # leave the container running

Deliberately NOT part of tools/check.py. check.py is the ~15 s gate before
every commit and must run on a machine that has never installed Docker - the
same reasoning that keeps tools/builddb.py out of it. This is the command you
run when you touched docker/Dockerfile, docker/nginx.conf or anything they
and it is what .github/workflows/docker.yml runs so that CI and a laptop agree
on what "the image works" means.

What it checks is the difference between a static host that happens to return
200 and one that serves THIS site correctly:

  - the two indexes (index.html, versions.json) are never cached, and the URLs
    they point at are immutable. Getting that backwards serves new markup
    against a cached stylesheet - the failure this repo keeps meeting, and one
    that is invisible on the machine that already holds the new files.
  - a pack arrives byte-for-byte, verified against the sha256 prefix in
    versions.json. That is one assertion covering an unresolved LFS pointer, a
    truncated copy and a proxy that decided to transcode it.
  - a pack is NOT sent with Content-Encoding: gzip. data.ts gunzips the body
    itself; a transport-encoded pack would be decoded twice and the loading
    meter would count decoded bytes against a compressed Content-Length.
  - the 404 page's assets resolve, which on Pages means /Epsilook/... and in
    the container means docker/nginx.conf's prefix rewrite is doing its job.

Exit status is 0 when nothing FAILED.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
# check.py owns the reporting shape and the one parser for index.html's ?v=
# references — this script asserts against the same reading of them
from check import DIM, GREEN, RED, RESET, Report, asset_versions  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
CONTAINER = "epsilook-smoke"
IMMUTABLE = "public, max-age=31536000, immutable"


class Response:
    """The parts of an HTTP response the checks below actually ask about."""

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body

    def header(self, name: str) -> str:
        return self.headers.get(name.lower(), "")


def fetch(url: str, accept_gzip: bool = False, method: str = "GET") -> Response:
    """One request, with redirects and error statuses reported rather than raised."""
    request = urllib.request.Request(url, method=method)
    # urllib sends Accept-Encoding: identity by default, so gzip is opt-in here
    # and the transport encoding of each response is a deliberate assertion
    if accept_gzip:
        request.add_header("Accept-Encoding", "gzip")
    try:
        with urllib.request.urlopen(request, timeout=30) as resp:
            headers = {k.lower(): v for k, v in resp.headers.items()}
            return Response(resp.status, headers, resp.read())
    except urllib.error.HTTPError as exc:
        headers = {k.lower(): v for k, v in exc.headers.items()}
        return Response(exc.code, headers, exc.read())


def docker(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args], cwd=ROOT, capture_output=True, encoding="utf-8", errors="replace", check=check
    )


def free_port() -> int:
    """A port the OS just confirmed is free. Racy in theory, fine in practice."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_health(base: str, container: str, timeout: float = 60.0) -> str | None:
    """Poll /healthz until it answers. Returns an error string, or None when up."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if fetch(f"{base}/healthz").status == 200:
                return None
        except (urllib.error.URLError, ConnectionError, socket.timeout):
            pass
        if docker("inspect", "-f", "{{.State.Running}}", container, check=False).stdout.strip() != "true":
            logs = docker("logs", "--tail", "20", container, check=False)
            return f"container exited: {(logs.stdout + logs.stderr).strip()[:400]}"
        time.sleep(0.5)
    return f"no answer on {base}/healthz within {timeout:.0f}s"


# ------------------------------------------------------------------ the checks


def check_index(rep: Report, base: str) -> None:
    """The one page: served, typed, and never held by a cache."""
    resp = fetch(f"{base}/")
    if resp.status != 200:
        rep.fail("index.html", f"GET / is HTTP {resp.status}")
        return
    if b"<title>Epsilook" not in resp.body:
        rep.fail("index.html", "GET / is not the app's markup")
        return
    if not resp.header("content-type").startswith("text/html"):
        rep.fail("index.html", f"content-type is {resp.header('content-type')}")
        return
    # it carries the ?v= that busts everything else, so it must revalidate
    if "no-cache" not in resp.header("cache-control"):
        rep.fail(
            "index.html",
            f"cache-control is {resp.header('cache-control')!r}, want no-cache"
            " - a held index.html pins the site to an old deploy",
        )
        return
    rep.ok("index.html", f"{len(resp.body)} bytes, no-cache")


def check_assets(rep: Report, base: str) -> None:
    """The css and the bundle: present at the ?v= index.html asks for, immutable,
    and compressed on the wire."""
    html = (SITE / "index.html").read_text(encoding="utf-8")
    refs = asset_versions(html)
    if not refs:
        rep.fail("assets", "index.html references no versioned css/js")
        return

    for path, version in refs:
        url = f"{base}/{path}?v={version}"
        resp = fetch(url, accept_gzip=True)
        if resp.status != 200:
            rep.fail(f"asset {path}", f"HTTP {resp.status}")
            continue
        if resp.header("cache-control") != IMMUTABLE:
            rep.fail(f"asset {path}", f"cache-control is {resp.header('cache-control')!r}, want {IMMUTABLE!r}")
            continue
        if resp.header("content-encoding") != "gzip":
            rep.fail(f"asset {path}", "not gzipped on the wire")
            continue
        # urllib does not decode for us, which is what makes the assertion above
        # meaningful — so unwrap it here and compare against the file on disk.
        # site/js is gitignored build output and absent on a fresh checkout, so
        # that half only runs where a local build exists; when it does, it also
        # says the two esbuild runs agreed.
        served = gzip.decompress(resp.body)
        local = SITE / path
        if local.exists() and served != local.read_bytes():
            rep.fail(f"asset {path}", f"{len(served)} bytes served, {local.stat().st_size} on disk")
            continue
        saved = 100 - round(100 * len(resp.body) / len(served))
        matched = "matches disk" if local.exists() else "not built locally"
        rep.ok(f"asset {path}", f"{len(served)} bytes, gzip -{saved}%, immutable, {matched}")


def check_security_headers(rep: Report, base: str) -> None:
    """add_header does not inherit: one added inside a location drops every
    header set on the server. So assert them where a location IS in play."""
    wanted = {"x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin"}
    probes = ["/", "/css/app.css", "/data/versions.json", "/healthz"]
    missing = [
        f"{name} on {path}"
        for path in probes
        for name, value in wanted.items()
        if fetch(f"{base}{path}").header(name) != value
    ]
    if missing:
        rep.fail("security headers", "; ".join(missing[:3]))
    else:
        rep.ok("security headers", f"{len(wanted)} headers on {len(probes)} paths")


def check_manifest(rep: Report, base: str) -> list[dict[str, Any]]:
    """versions.json: fresh, parseable, and the same file that is on disk."""
    resp = fetch(f"{base}/data/versions.json")
    if resp.status != 200:
        rep.fail("versions.json", f"HTTP {resp.status}")
        return []
    if "no-cache" not in resp.header("cache-control"):
        rep.fail(
            "versions.json",
            f"cache-control is {resp.header('cache-control')!r}, want no-cache"
            " - a held manifest hides every rebuilt pack",
        )
        return []
    try:
        entries = json.loads(resp.body)
    except json.JSONDecodeError as exc:
        rep.fail("versions.json", f"unparseable: {exc}")
        return []
    if resp.body != (SITE / "data" / "versions.json").read_bytes():
        rep.fail("versions.json", "served bytes differ from site/data/versions.json")
        return []
    default = [e.get("id") for e in entries if e.get("default")]
    rep.ok("versions.json", f"{len(entries)} packs, no-cache, default={default[0] if default else '?'}")
    return list(entries)


def check_packs(rep: Report, base: str, entries: list[dict[str, Any]]) -> None:
    """Every pack, byte for byte, against the hash the manifest names.

    One assertion covering an unresolved LFS pointer, a truncated copy and a
    host that transcoded the body. It downloads ~48 MB over loopback, which
    costs about a second and is the whole point of the exercise.
    """
    problems: list[str] = []
    total = 0
    for entry in entries:
        name, url_path = entry.get("id", "?"), entry.get("file", "")
        resp = fetch(f"{base}/{url_path}?v={entry.get('hash', '')}", accept_gzip=True)
        if resp.status != 200:
            problems.append(f"{name}: HTTP {resp.status}")
            continue
        # the body must be the pack itself, not a transport-gzipped copy of it:
        # data.ts gunzips what it reads and counts raw bytes against
        # Content-Length for the loading meter
        if resp.header("content-encoding"):
            problems.append(f"{name}: content-encoding {resp.header('content-encoding')}")
            continue
        if resp.header("content-length") != str(len(resp.body)):
            problems.append(
                f"{name}: content-length {resp.header('content-length')!r} but {len(resp.body)} bytes arrived"
            )
            continue
        if not resp.body.startswith(b"\x1f\x8b"):
            problems.append(f"{name}: not gzip - {resp.body[:16]!r}")
            continue
        actual = hashlib.sha256(resp.body).hexdigest()[:10]
        if actual != entry.get("hash"):
            problems.append(f"{name}: manifest says {entry.get('hash')}, served {actual}")
            continue
        total += len(resp.body)
    if problems:
        rep.fail("data packs", "; ".join(problems[:3]))
    else:
        rep.ok("data packs", f"{len(entries)} packs, {total / 1e6:.1f} MB, hashes match, no transport gzip")


def check_not_found(rep: Report, base: str) -> None:
    """A missing path returns the 404 page — WITH its stylesheet.

    site/404.html names /Epsilook/... because Pages serves the project there and
    the page is returned at any depth. docker/nginx.conf maps that prefix onto
    the same root so the page keeps working here; this is that rewrite's test.
    """
    resp = fetch(f"{base}/no/such/path")
    if resp.status != 404:
        rep.fail("404 page", f"a missing path is HTTP {resp.status}, want 404")
        return
    if b"<h1>404</h1>" not in resp.body:
        rep.fail("404 page", "the body is not site/404.html")
        return
    if b"/Epsilook/css/app.css" not in resp.body:
        rep.fail(
            "404 page", "site/404.html no longer names /Epsilook/ - the prefix rewrite in docker/nginx.conf can go"
        )
        return
    aliased = fetch(f"{base}/Epsilook/css/app.css")
    if aliased.status != 200:
        rep.fail(
            "404 page", f"its stylesheet /Epsilook/css/app.css is HTTP {aliased.status} - the 404 page renders unstyled"
        )
        return
    root = fetch(f"{base}/Epsilook/")
    if root.status != 200 or b"<title>Epsilook" not in root.body:
        rep.fail("404 page", f"its back-link /Epsilook/ is HTTP {root.status}")
        return
    rep.ok("404 page", "served with its stylesheet and back-link")


def check_app_boots(rep: Report, base: str) -> None:
    """The bundle the page loads is the bundle that was built for it.

    Not a substitute for looking at the running app — it cannot be. It catches
    the mechanical half: a stale ?v=, or a bundle that never made it in.
    """
    html = fetch(f"{base}/").body.decode("utf-8", "replace")
    versions = {v for _, v in asset_versions(html)}
    if len(versions) != 1:
        rep.fail("bundle wiring", f"{len(versions)} different ?v= strings served")
        return
    resp = fetch(f"{base}/js/app.js?v={versions.pop()}", accept_gzip=True)
    body = gzip.decompress(resp.body) if resp.header("content-encoding") == "gzip" else resp.body
    # the IIFE format is load-bearing: index.html must keep opening from
    # file://, where <script type="module"> is blocked by CORS. esbuild emits
    # `"use strict";(()=>{...})();` for it — an ESM build would start with an
    # import instead, and would be silently broken only on file://
    if b"(()=>" not in body[:200]:
        rep.fail("bundle wiring", f"js/app.js does not open as an IIFE: {body[:60]!r}")
        return
    rep.ok("bundle wiring", f"{len(body)} bytes of IIFE at the ?v= index.html asks for")


# -------------------------------------------------------------------- driving


def build_image(rep: Report, image: str) -> bool:
    proc = docker("build", "-f", "docker/Dockerfile", "-t", image, ".", check=False)
    if proc.returncode != 0:
        output = (proc.stdout + proc.stderr).strip().splitlines()
        rep.fail("docker build", output[-1] if output else f"exit {proc.returncode}")
        for line in output[-14:-1]:
            print(f"        {DIM}{line}{RESET}")
        return False
    rep.ok("docker build", image)
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", default="epsilook:smoke", help="image to build and/or run")
    ap.add_argument("--no-build", action="store_true", help="run the image as it is (CI builds it in its own step)")
    ap.add_argument("--keep", action="store_true", help="leave the container running")
    ap.add_argument("--quiet", action="store_true", help="print only failures and warnings")
    args = ap.parse_args()

    rep = Report(quiet=args.quiet)
    try:
        docker("version", "--format", "{{.Server.Version}}")
    except (subprocess.CalledProcessError, FileNotFoundError):
        print(f"{RED}docker is not available{RESET} - start Docker Desktop, or run the rest with tools/check.py")
        return 1

    if not args.no_build and not build_image(rep, args.image):
        return 1

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    docker("rm", "-f", CONTAINER, check=False)
    run = docker("run", "-d", "--name", CONTAINER, "-p", f"127.0.0.1:{port}:80", args.image, check=False)
    if run.returncode != 0:
        rep.fail("docker run", (run.stdout + run.stderr).strip().splitlines()[-1])
        return 1

    try:
        problem = wait_for_health(base, CONTAINER)
        if problem:
            rep.fail("container start", problem)
            return 1
        rep.ok("container start", f"{args.image} on {base}")

        check_index(rep, base)
        check_assets(rep, base)
        check_security_headers(rep, base)
        entries = check_manifest(rep, base)
        if entries:
            check_packs(rep, base, entries)
        check_not_found(rep, base)
        check_app_boots(rep, base)
    finally:
        if args.keep:
            print(f"\n{DIM}container {CONTAINER} left running on {base} - docker rm -f {CONTAINER}{RESET}")
        else:
            docker("rm", "-f", CONTAINER, check=False)

    print()
    if rep.failed:
        print(f"{RED}{rep.failed} check(s) failed{RESET}" + (f", {rep.warned} warning(s)" if rep.warned else ""))
        return 1
    print(f"{GREEN}the image serves Epsilook{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
