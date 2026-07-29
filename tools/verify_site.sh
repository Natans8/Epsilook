#!/bin/sh
# Prove an assembled document root is actually servable.
#
#   sh tools/verify_site.sh docs        # after npm run build
#   sh tools/verify_site.sh /site       # inside the container image build
#
# Every failure here is one this repo has already been bitten by, and every one
# of them is INVISIBLE at the time: the deploy goes green and the site serves
# something that cannot load.
#
#   - a pack that is still a ~130-byte LFS pointer, because the checkout (or
#     the clone) never smudged it. GitHub Pages cannot resolve pointers at all,
#     and `docker build` copies whatever is in the working tree, so both
#     consumers of docs/ need this same guard.
#   - a missing bundle, because docs/js is gitignored BUILD OUTPUT and a deploy
#     that forgot to build it would ship markup with no app behind it.
#   - an empty or absent manifest, which is the one file the app fetches before
#     it can fetch anything else.
#
# POSIX sh, no coreutils: it runs on the ubuntu runner and in a busybox alpine
# stage. `wc -c` rather than `stat` for the same reason.
#
# Used by .github/workflows/pages.yml and by the Dockerfile's `site` stage, so
# the two deploys cannot disagree about what a servable site is.

set -eu

root=${1:-docs}

# An LFS pointer is ~130 bytes; the smallest real pack is ~720 KB. Anything in
# between is not a judgement call, it is a stub.
MIN_PACK_BYTES=100000

fail=0

note() { printf '  ok   %s\n' "$1"; }
bad() {
    printf 'FAIL   %s\n' "$1" >&2
    fail=1
}

size_of() { wc -c <"$1" | tr -d ' '; }

if [ ! -d "$root" ]; then
    printf 'FAIL   %s is not a directory\n' "$root" >&2
    exit 1
fi

printf 'verifying %s\n' "$root"

# --- the markup and the bundle -------------------------------------------

for required in index.html 404.html css/app.css js/app.js; do
    path="$root/$required"
    if [ ! -f "$path" ]; then
        bad "$required is missing"
    elif [ "$(size_of "$path")" -lt 512 ]; then
        bad "$required is $(size_of "$path") bytes — truncated or a placeholder"
    else
        note "$required  $(size_of "$path") bytes"
    fi
done

# index.html must load the bundle it was built alongside. The ?v= string itself
# is check.py's business; here it is only that the reference exists at all.
if [ -f "$root/index.html" ] && ! grep -q 'js/app\.js' "$root/index.html"; then
    bad "index.html never loads js/app.js"
fi

# --- the manifest and the packs ------------------------------------------

manifest="$root/data/versions.json"
if [ ! -s "$manifest" ]; then
    bad "data/versions.json is missing or empty"
else
    note "data/versions.json  $(size_of "$manifest") bytes"
fi

packs=0
for pack in "$root"/data/*/*.gz; do
    [ -e "$pack" ] || break
    packs=$((packs + 1))
    bytes=$(size_of "$pack")
    name=${pack#"$root"/}
    if [ "$bytes" -lt "$MIN_PACK_BYTES" ]; then
        bad "$name is $bytes bytes — an unresolved LFS pointer, not a pack (git lfs pull)"
    else
        note "$name  $bytes bytes"
    fi
done

if [ "$packs" -eq 0 ]; then
    bad "no data packs found under $root/data"
fi

if [ "$fail" -ne 0 ]; then
    printf '\n%s is not servable\n' "$root" >&2
    exit 1
fi

printf '\n%s is servable — %s packs\n' "$root" "$packs"
