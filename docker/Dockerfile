# syntax=docker/dockerfile:1
#
# Epsilook in a container — the same static site GitHub Pages serves, behind
# nginx, for anyone who would rather host it themselves. A Synology NAS is the
# case that prompted it.
#
#   docker build -f docker/Dockerfile -t epsilook .
#   docker run --rm -p 8378:80 epsilook
#   python tools/docker_smoke.py            # build, run, and prove it serves
#
# This is a SECOND CONSUMER of site/, not a fork of it. Nothing about the app
# knows it is in a container: data.ts fetches "data/versions.json" relatively,
# so the site works at any base path, and the only file that names the Pages
# URL space (404.html) is handled in docker/nginx.conf rather than copied and
# edited here.
#
# Building needs the LFS packs SMUDGED — `docker build` copies the working
# tree, so a clone without `git lfs pull` would otherwise bake ten 130-byte
# pointer files into the image and every game version would fail to load. The
# `docroot` stage refuses to do that; see tools/verify_site.sh.

ARG NODE_VERSION=24-alpine
ARG ALPINE_VERSION=3.22
ARG NGINX_VERSION=1.29-alpine


# --- the bundle ------------------------------------------------------------
# Pinned to $BUILDPLATFORM: JavaScript is architecture-independent, so an
# arm64 image is cross-built at the builder's native speed instead of running
# npm under QEMU.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION} AS build

WORKDIR /app

# the manifests alone first, so a source-only change reuses the install layer
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY tools/build.mjs ./tools/
COPY src/ ./src/

# esbuild only — no tsc, exactly as in .github/workflows/pages.yml: a type
# error must not be able to block a deploy (CI is the alarm for those). What
# this DOES fail on is an unparseable source or a module the import graph never
# reaches, because then there is no bundle worth serving.
RUN npm run build


# --- the document root -----------------------------------------------------
# Assembled and verified in one place, so the runtime stage receives a tree
# that is already known to be servable.
FROM --platform=$BUILDPLATFORM alpine:${ALPINE_VERSION} AS docroot

WORKDIR /docroot

# site/js is gitignored build output and the ignore file excludes it, so the
# bundle can only come from the stage above — never from a stale local build
COPY site/ ./
COPY --from=build /app/site/js/ ./js/

RUN --mount=type=bind,source=tools/verify_site.sh,target=/verify_site.sh \
    sh /verify_site.sh .


# --- what actually runs ----------------------------------------------------
# NOTE: no RUN in this stage, on purpose. A pure-COPY final stage is what lets
# buildx assemble the linux/arm64 image without QEMU emulation. Adding a RUN
# here means the docker workflow needs docker/setup-qemu-action back.
FROM nginx:${NGINX_VERSION} AS runtime

# No image.licenses label: the repo declares no licence, and a label is not the
# place to invent one. Add a LICENSE file first if that should change.
# docker/metadata-action overwrites title/description/source on the published
# image anyway (from the repo's own metadata); these are for a local build.
LABEL org.opencontainers.image.title="Epsilook" \
      org.opencontainers.image.description="Search WoW spells by how they look and sound — a companion for Epsilon WoW" \
      org.opencontainers.image.source="https://github.com/Natans8/Epsilook"

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=docroot /docroot /usr/share/nginx/html

EXPOSE 80

# busybox wget is already in the image; /healthz is a literal return in the
# server block, so this proves nginx is answering without touching the disk
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1/healthz || exit 1
