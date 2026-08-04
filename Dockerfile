# =============================================================================
# wigolo container image — three build targets:
#   default (slim): OS libraries for the browser engine baked at build time;
#                   the browser binary and on-device models download on FIRST USE
#                   into the /data volume. Smallest image; ideal for MCP stdio use.
#   full:           Playwright AND patchright browser binaries preinstalled at
#                   build time. Larger image; ideal for JS-render-heavy or
#                   ephemeral `--rm` runs with no persistent volume, and required
#                   for the patchright stealth driver.
#   vnc:            `full` plus Xvfb + x11vnc + noVNC, so the human-solve rung
#                   has a visible surface a person can actually reach. Largest
#                   image and the widest attack surface — build it only for
#                   human-in-the-loop solving.
# Build the default target:  docker build --pull --target default -t wigolo-local:reviewed .
# Build the full target:     docker build --pull --target full -t wigolo-local:reviewed-full .
# Build the vnc target:      docker build --pull --target vnc -t wigolo-local:reviewed-vnc .
# =============================================================================

# Keep the runtime base immutable. Renovate/Dependabot (or a deliberate manual
# review) should update this digest rather than silently taking a new image on
# every build. This is the multi-platform digest for node:22-bookworm-slim as
# published 2026-07-14.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

# ---- builder: compile TypeScript to dist/ ----
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# Copy only build inputs. In particular, host credentials, agent configuration,
# git metadata, and local .env files never enter the build stage.
COPY tsconfig.json tsconfig.build.json tsup.config.ts ./
COPY src/ ./src/
RUN npm run build

# ---- deps: install production node_modules once, shared by both targets ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- base: shared runtime layout with the browser engine's OS libraries baked ----
# `playwright install-deps chromium` installs the OS shared libraries the browser
# engine needs (deps ONLY, NOT the browser binary) as ROOT at build time. Without
# them, a first-use lazy install as the non-root `node` user cannot add system
# libs (no passwordless sudo) and the browser-engine launch smoke-test fails,
# degrading that tier permanently. With them baked, the lazy path works: the first
# JS-render fetch downloads only the browser binary into the /data volume and
# launches cleanly.
#
# No sudo in the image: the first-use deps-strategy probe treats its absence as
# the 'skip' strategy (the baked libraries make the deps step unnecessary anyway).
# No python either — it is only needed by the opt-in native search-engine
# sidecar. The hardened Compose profile supplies a separate pinned container.
# Start from a CLEAN slim base (not `FROM deps`) so node_modules lands in the
# image exactly once, via a single --chown COPY. `FROM deps` + a second COPY +
# `chown -R /app` would triplicate the ~750MB node_modules layer.
FROM ${NODE_IMAGE} AS base
ENV NODE_ENV=production \
    WIGOLO_DATA_DIR=/data \
    WIGOLO_PLUGINS_DIR=/app/disabled-plugins \
    WIGOLO_SEARCH=core \
    PLAYWRIGHT_BROWSERS_PATH=/data/browsers \
    HOME=/data/home \
    XDG_CACHE_HOME=/data/xdg-cache \
    XDG_CONFIG_HOME=/data/xdg-config \
    XDG_STATE_HOME=/data/xdg-state \
    TMPDIR=/tmp \
    WIGOLO_TELEMETRY=0 \
    WIGOLO_WARM_ENGINES=0 \
    WIGOLO_EAGER_WARMUP=1 \
    WIGOLO_TLS_TIER=auto \
    WIGOLO_FETCH_ALLOW_PRIVATE=0 \
    WIGOLO_SERVE_ALLOW_UNAUTHENTICATED=0 \
    WIGOLO_SERVE_ALLOW_LOCAL_TARGETS=0
WORKDIR /app
# --chown at copy time avoids a costly `chown -R` layer that would duplicate the
# whole node_modules tree.
COPY --chown=1000:1000 --from=deps /app/node_modules ./node_modules
COPY --chown=1000:1000 --from=builder /app/dist ./dist
COPY --chown=1000:1000 package.json README.md LICENSE SKILL.md ./
COPY --chown=1000:1000 skills/ ./skills/
COPY --chown=1000:1000 assets/blocks/ ./assets/blocks/
COPY --chown=1000:1000 assets/legacy-skill-hashes.json ./assets/legacy-skill-hashes.json
# Bake the browser engine's OS libraries via the LOCAL playwright CLI (already in
# node_modules) so the version matches the runtime and no throwaway playwright is
# downloaded. install-deps runs apt-get itself (we are root at build time).
RUN ./node_modules/.bin/playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Writable location for the local cache, on-device models, browser binary, and
# encrypted keys. The volume persists all of these across container runs.
RUN install -d -o 1000 -g 1000 -m 0700 \
      /data \
      /data/browsers \
      /data/home \
      /data/xdg-cache \
      /data/xdg-config \
      /data/xdg-state
VOLUME ["/data"]

# stdio MCP server by default. No image-level HEALTHCHECK: the default command
# speaks the stdio MCP protocol and exposes no HTTP endpoint, so a baked
# healthcheck would mark every container permanently unhealthy. For `serve` mode
# use packaging/compose.serve.yml, which adds a daemon HTTP healthcheck.
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["mcp"]

# ---- default: slim image, browser binary + models download on first use ----
FROM base AS default
LABEL org.opencontainers.image.title="wigolo" \
      org.opencontainers.image.description="Local-first web intelligence MCP server. The browser engine binary and on-device models download on first use into the /data volume." \
      org.opencontainers.image.source="https://github.com/KnockOutEZ/wigolo"
USER 1000:1000

# ---- full: browser binary preinstalled at build for --rm / no-volume use ----
FROM base AS full
LABEL org.opencontainers.image.title="wigolo" \
      org.opencontainers.image.description="Local-first web intelligence MCP server with the browser engine preinstalled. On-device models download on first use." \
      org.opencontainers.image.source="https://github.com/KnockOutEZ/wigolo"
# Preinstall the browser binary into an image-baked path (not the volume) so
# JS-render works with no first-use download and no volume. Installed as root,
# then made readable by the node user.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
USER root
# Install browsers for BOTH drivers into the same baked path. At the currently
# pinned versions patchright resolves to the same chromium revision playwright
# does (verified: both report /opt/browsers/chromium-1223/chrome-linux64/chrome),
# so this step is presently a no-op in disk terms. It is kept because patchright
# is an independently versioned fork: the moment its pinned revision diverges
# from playwright's, `playwright install` alone would leave
# stealthDriver=patchright with no binary and it would silently fall back to the
# standard driver. Running both installs makes that failure mode impossible
# rather than dependent on the two pins staying aligned.
RUN mkdir -p /opt/browsers \
    && ./node_modules/.bin/playwright install chromium \
    && ./node_modules/.bin/patchright install chromium \
    && chown -R node:node /opt/browsers
USER 1000:1000

# ---- vnc: `full` plus a viewable display for the human-solve rung ----
# The human-solve rung hard no-ops without a visible surface, so a container
# that should ever hand a challenge to a person needs a display and a way to
# reach it. Adds Xvfb (virtual display), x11vnc (VNC server) and noVNC (browser
# client) on top of `full`. Strictly larger and strictly more attack surface
# than `full` — build this target only when you actually want human-in-the-loop
# solving; otherwise use `full` and leave WIGOLO_HUMAN_SOLVE=off.
FROM full AS vnc
LABEL org.opencontainers.image.title="wigolo" \
      org.opencontainers.image.description="Local-first web intelligence MCP server with the browser engine preinstalled and a noVNC-viewable display for human-in-the-loop challenge solving." \
      org.opencontainers.image.source="https://github.com/KnockOutEZ/wigolo"
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         xvfb \
         x11vnc \
         novnc \
         websockify \
    && rm -rf /var/lib/apt/lists/*
# Debian's novnc package ships vnc.html but no index.html, so the bare
# http://127.0.0.1:6080 would 404. Symlink it so the documented URL works.
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html
COPY --chown=root:root --chmod=0555 packaging/vnc-entrypoint.sh /usr/local/bin/vnc-entrypoint.sh
# Xvfb compiles a keymap into /var/lib/xkb; the runtime filesystem is read-only,
# so the directory must exist and be supplied as a tmpfs by Compose.
RUN install -d -o 1000 -g 1000 -m 0700 /var/lib/xkb
ENV DISPLAY=:99
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/vnc-entrypoint.sh"]
CMD ["mcp"]
