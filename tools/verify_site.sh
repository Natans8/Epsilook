#!/bin/sh
# Prove an assembled document root is actually servable.
#
#   sh tools/verify_site.sh site        # after npm run build
#   sh tools/verify_site.sh /site       # inside the container image build
#
# Every failure here is one this repo has already been bitten by, and every one
# of them is INVISIBLE at the time: the deploy goes green and the site serves
# something that cannot load.
#
#   - a pack that is still a ~130-byte LFS pointer, because the checkout (or
#     the clone) never smudged it. GitHub Pages cannot resolve pointers at all,
#     and `docker build` copies whatever is in the working tree, so both
#     consumers of site/ need this same guard.
#   - a missing bundle, because site/js is gitignored BUILD OUTPUT and a deploy
#     that forgot to build it would ship markup with no app behind it.
#   - an empty or absent manifest, which is the one file the app fetches before
#     it can fetch anything else.
#
# POSIX sh, no coreutils: it runs on the ubuntu runner and in a busybox alpine
# stage. `wc -c` and `od` rather than `stat` or `file` for the same reason.
#
# Used by .github/workflows/pages.yml and by the Dockerfile's `site` stage, so
# the two deploys cannot disagree about what a servable site is.

set -eu

root=${1:-site}

# A pointer is caught by its CONTENT, not its size: a locale overlay is
# legitimately tiny (an enUS one is 283 bytes, since it diffs English against
# English), so "small" stopped meaning "stub" the moment overlays existed.
#
# The floor applies to a MODULE, and it is low because modules are not all one
# size: `universal` is the eleven build-independent vocabularies and comes to
# about 25 KB, where `core` is megabytes. What it still catches is the failure
# it was written for — a file that is a few bytes of nothing rather than data.
MIN_PACK_BYTES=4096

fail=0

note() { printf '  ok   %s\n' "$1"; }
bad() {
    printf 'FAIL   %s\n' "$1" >&2
    fail=1
}

size_of() { wc -c <"$1" | tr -d ' '; }

# The first two bytes, as hex. A real gzip is 1f8b; an LFS pointer is a text
# file starting "version https://git-lfs..." (7665), which is what a checkout
# that never smudged leaves behind.
magic_of() { od -An -tx1 -N2 <"$1" 2>/dev/null | tr -d ' \n'; }

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

# A pack is a manifest naming module files, so both halves are checked: a
# manifest with no modules beside it serves an index to nothing.
packs=0
for pack in "$root"/data/*/manifest.json; do
    [ -e "$pack" ] || break
    name=${pack#"$root"/}
    if [ ! -s "$pack" ]; then
        bad "$name is empty"
        continue
    fi
    packs=$((packs + 1))
    note "$name  $(size_of "$pack") bytes"
done

modules=0
overlays=0
for pack in "$root"/data/modules/*.gz "$root"/data/*/spelldata.*.json.gz; do
    [ -e "$pack" ] || continue
    bytes=$(size_of "$pack")
    name=${pack#"$root"/}
    # A module carries a pack's data and has a meaningful size floor; a
    # spelldata.<locale>.json.gz is a sparse overlay on one and does not.
    case "$pack" in
        */data/modules/*) is_base=1; modules=$((modules + 1)) ;;
        *) is_base=0; overlays=$((overlays + 1)) ;;
    esac

    if [ "$(magic_of "$pack")" != "1f8b" ]; then
        if head -c 23 <"$pack" 2>/dev/null | grep -q 'version https://git-lfs'; then
            bad "$name is an unresolved LFS pointer, not gzip (git lfs pull)"
        else
            bad "$name is $bytes bytes and does not start with the gzip magic — corrupt"
        fi
    elif [ "$is_base" -eq 1 ] && [ "$bytes" -lt "$MIN_PACK_BYTES" ]; then
        bad "$name is $bytes bytes — truncated, not a pack"
    else
        note "$name  $bytes bytes"
    fi
done

if [ "$packs" -eq 0 ]; then
    bad "no pack manifests found under $root/data"
fi
if [ "$modules" -eq 0 ]; then
    bad "no module files found under $root/data/modules"
fi

if [ "$fail" -ne 0 ]; then
    printf '\n%s is not servable\n' "$root" >&2
    exit 1
fi

printf '\n%s is servable — %s packs over %s modules, %s locale overlays\n' \
    "$root" "$packs" "$modules" "$overlays"
