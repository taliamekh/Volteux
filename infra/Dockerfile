# volteux-compile — Compile API server image.
#
# Pinned toolchain (changing any of these invalidates every cache entry the
# server keys on `toolchain_version_hash`):
#   - arduino-cli  1.4.1
#   - arduino:avr  1.8.6
#   - Servo        1.2.2
#
# Base image: debian:bookworm-slim. Alpine breaks AVR-GCC's prebuilt binaries
# (musl); distroless can't run the Go runtime probes arduino-cli expects.
#
# At build time, a canary blink sketch is compiled to fail-closed on a broken
# core install. At runtime, the server's cache module ALSO asserts that the
# AVR core is present before computing toolchain_version_hash — the canary
# catches build-time breakage; the boot assertion catches runtime breakage
# (e.g., a volume mount that masks /home/volteux/.arduino15).
#
# Container runs as non-root user `volteux` (uid 1000); the cache directory
# (/var/cache/volteux) and the build cache (/var/cache/arduino-build) are
# chowned to that user. Defense-in-depth against any arduino-cli filesystem
# escape vuln.

FROM debian:bookworm-slim

ARG ARDUINO_CLI_VERSION=1.4.1
ARG AVR_CORE_VERSION=1.8.6
ARG SERVO_VERSION=1.2.2

# System deps: curl + ca-certificates for arduino-cli install; tini for PID1
# signal handling so Docker stop terminates the bun process cleanly; unzip is
# pulled in by some of arduino-cli's transitive install steps.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      tini \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Bun (used to run the Hono server and to bundle the compile-api.ts).
# Pinned to a recent stable; bump in lockstep with bun.lock.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.12" \
    && mv /root/.bun/bin/bun /usr/local/bin/bun

# Install arduino-cli at the pinned version. The official install script
# accepts `BINDIR` and `--default-version`.
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
      | BINDIR=/usr/local/bin sh -s "${ARDUINO_CLI_VERSION}"

# Create the unprivileged user that the server will run as. The user owns
# the arduino-cli config dir, the per-request temp dirs, and the cache.
RUN useradd --create-home --uid 1000 --shell /bin/bash volteux \
    && mkdir -p /var/cache/volteux /var/cache/arduino-build /opt/volteux \
    && chown -R volteux:volteux /var/cache/volteux /var/cache/arduino-build /opt/volteux

USER volteux
WORKDIR /opt/volteux

# Initialise arduino-cli config so subsequent commands write to the user's
# $HOME instead of trying to write under /root.
RUN arduino-cli config init --overwrite

# Install the AVR core + Servo library at pinned versions.
# Then run a canary compile to verify the toolchain works end-to-end at
# build time. A broken install fails the build, not the first runtime
# request.
RUN arduino-cli core update-index \
    && arduino-cli core install "arduino:avr@${AVR_CORE_VERSION}" \
    && arduino-cli lib install "Servo@${SERVO_VERSION}" \
    && mkdir -p /opt/volteux/canary \
    && printf 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(500); digitalWrite(13, LOW); delay(500); }\n' \
        > /opt/volteux/canary/canary.ino \
    && arduino-cli compile \
        --fqbn arduino:avr:uno \
        --output-dir /opt/volteux/canary-out \
        /opt/volteux/canary \
    && test -f /opt/volteux/canary-out/canary.ino.hex \
    && rm -rf /opt/volteux/canary /opt/volteux/canary-out

# Copy the source the server needs. Explicit COPY of each subtree (not a
# blanket `COPY . .`) so the image build doesn't pull node_modules, traces,
# or the docs/plans directory.
#
# Transitive closure of imports starting from infra/server/compile-api.ts:
#   infra/server/* -> pipeline/gates/library-allowlist.ts
#   pipeline/gates/library-allowlist.ts -> schemas/document.zod.ts
#   schemas/document.zod.ts references types from components/registry.ts
COPY --chown=volteux:volteux package.json bun.lock tsconfig.json ./
COPY --chown=volteux:volteux infra        ./infra
COPY --chown=volteux:volteux pipeline     ./pipeline
COPY --chown=volteux:volteux schemas      ./schemas
COPY --chown=volteux:volteux components   ./components

# Install the JS deps the server needs (Hono, p-limit, @hono/zod-validator,
# zod). Bun resolves these from package.json.
RUN bun install --frozen-lockfile --production

EXPOSE 8787

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "infra/server/compile-api.ts"]
