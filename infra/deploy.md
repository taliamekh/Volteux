# Compile API — Deploy Notes

> **Status:** drafted; **NOT executed** in v0.1. The Compile API runs locally
> in v0.1 (`bun run compile:up`). VPS provisioning lands in v0.2.

This document captures the production deploy posture so v0.2 has a single
source for the operational decisions that v0.1 deliberately deferred.

## Target host

**Hetzner CX22 (Gen3)** — 2 vCPU shared, 4 GB RAM, 40 GB SSD, ~€6/mo.

Sizing rationale (carried from `docs/PLAN.md` § Pipeline Architecture):
- `arduino-cli` + AVR core + Servo image footprint ≈ 250 MB
- `/var/cache/volteux` cap ≈ 5 GB (per-archetype hex blobs)
- `/var/cache/arduino-build` (intermediate AVR-core objects) ≈ 1–2 GB
- arduino-cli compile peak RAM ≈ 200–400 MB; `p-limit(2)` headroom OK at 4 GB

v1.5 archetypes (ESP32, Pi Pico) push image size to 8–12 GB and peak RAM to
~1.5–2 GB; bump to a CX32 (8 GB / 80 GB) before adding those archetypes, or
split into per-board containers.

## Provisioning steps (v0.2; not yet run)

```text
1. ssh into the new CX22 instance.
2. apt-get install docker.io tini curl
3. Generate a new bearer secret per environment:
   openssl rand -hex 32 > /etc/volteux/compile-api.secret
   chmod 600 /etc/volteux/compile-api.secret
4. Pull the image (TBD: ghcr.io/<org>/volteux-compile:v0.2 vs `docker save | scp`):
   docker pull ghcr.io/...:v0.2   # or scp from a build host
5. Start the container under a systemd unit (sketch below).
6. Open port 8787 on the firewall, restricted to Cloudflare IPs (since the
   public ingress will sit behind a CF proxy in v0.2).
7. Verify health:
   curl https://compile.volteux.example/api/health
   # → {"ok":true,"toolchain_version_hash":"<sha256>"}
```

### systemd unit sketch

```text
[Unit]
Description=Volteux Compile API
After=docker.service
Requires=docker.service

[Service]
EnvironmentFile=/etc/volteux/compile-api.env   # NOT a Dockerfile ENV; loaded at runtime
ExecStart=/usr/bin/docker run --rm \
    --name volteux-compile \
    -p 8787:8787 \
    --env-file /etc/volteux/compile-api.env \
    --read-only \
    --tmpfs /tmp:rw,size=512m \
    -v /var/cache/volteux:/var/cache/volteux \
    -v /var/cache/arduino-build:/var/cache/arduino-build \
    --user 1000:1000 \
    ghcr.io/<org>/volteux-compile:v0.2
ExecStop=/usr/bin/docker stop volteux-compile
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Secret handling — DO and DO NOT

### DO

- Generate a fresh 32-byte secret per environment (local dev, v0.2 staging,
  v0.2 prod). Use `openssl rand -hex 32`.
- Pass the secret via `--env-file` (a 0600-owned file on the host) so it's
  not visible in the host process listing's argv. The `--env-file` form is
  preferable to `-e KEY=$VAL` for production.
- Rotate quarterly. Rotation = generate new secret + write env file +
  restart the container; the server's startup assertion (≥32 bytes) catches
  truncation/typo on rotation.
- Document the rotation procedure in your team's runbook so the rotation is
  not a single point of human error.

### DO NOT

- **NEVER bake the secret into the image** via `RUN ENV COMPILE_API_SECRET=…`
  or `ENV COMPILE_API_SECRET=…`. The value persists in the image layer
  history and any future `docker pull` or `docker save` exposes it. The
  Dockerfile in this repo deliberately has no `ENV` for the secret.
- **NEVER pass via `-e KEY=$VAL` in CI logs / shell history** for a public
  endpoint. `-e` itself is fine (the value reaches the container env), but
  the *invocation* leaks the value into the host's bash history and any
  process listing. `--env-file` keeps the value off argv.
- **NEVER log the Authorization header.** The Hono request logger
  middleware in `infra/server/compile-api.ts` is intentionally NOT enabled
  by default. If a future operator adds it for debugging, configure the
  redaction list to include `Authorization`.

### Threat model — v0.1 vs v0.2

v0.1 (localhost, single trusted developer): `-e COMPILE_API_SECRET=$X` via
`bun run compile:up` is acceptable. The secret is visible to the
developer's own user via `docker inspect` and `/proc/<pid>/environ`. Trust
boundary is the developer's machine; nothing crosses the network.

v0.2 (public Hetzner): the boundary is now the network. Anyone with shell
on the host can read the secret from `docker inspect`. The mitigation is
the SSH access policy + the Cloudflare proxy in front of the endpoint —
not stronger secret handling at the container level.

## CORS

Currently NOT configured. v0.1 has no UI; the only client is the local
pipeline (`pipeline/gates/compile.ts`).

**v1.0** (when Talia's UI integrates): add `cors()` middleware to the Hono
app with the explicit allowed origin (e.g. `https://volteux.app`). Do NOT
use `*` — the Compile API issues a real bearer token and a wildcard CORS
combined with `credentials: "include"` is a credential-leak surface.

The middleware addition is a single import + `app.use("/api/*", cors({ origin: ... }))`
once the UI's origin is known.

## Build cache (`/var/cache/arduino-build`) DoS surface

The `--build-cache-path` is shared across all requests by design (the AVR
core's compiled objects are reused across compiles for warm-cache wins).

A malicious sketch could in principle generate an exceptionally large
number of intermediate object files and fill `/var/cache/arduino-build`,
denying service to subsequent requests until eviction.

v0.2 mitigation: cron job that prunes the build cache when its size exceeds
a threshold (e.g., 2 GB). The same cron also handles `/var/cache/volteux`
LRU eviction (the artifact cache documented as ~5 GB cap in `docs/PLAN.md`).

```text
# /etc/cron.daily/volteux-cache-prune (sketch; not yet authored)
find /var/cache/arduino-build -atime +7 -delete
find /var/cache/volteux -atime +30 -delete
```

## Monitoring (v0.2 backlog)

Out of scope for v0.1; the server emits one structured stdout line on
startup (`event: "compile_api_started"`) and never logs request bodies.

For v0.2 add:
- Prometheus exporter (compile latency, cache hit rate, rate-limit
  rejections by `kind`).
- Alert if cache directory size exceeds 4 GB (the boot-time WARN the
  server already emits on stderr is the seed signal; promote to a Pager
  rule).
- Alert on any 5xx from the API endpoint.

## Rebuild discipline

A rebuild = new toolchain hash = entire artifact cache invalidated (by
design — see `infra/server/cache.ts` for the rationale). Rebuilds happen
when:
- arduino-cli version pin changes
- AVR core pin changes
- Servo library pin changes
- Bun version pin changes (rebuilds the bundled server)
- Any file under `pipeline/`, `schemas/`, or `components/` changes (those
  are `COPY`'d into the image)

The Dockerfile pins each dependency at the top so version bumps live in
one place. Bumping any of `ARDUINO_CLI_VERSION`, `AVR_CORE_VERSION`, or
`SERVO_VERSION` requires a rebuild + redeploy + cache wipe (the wipe is
automatic via the toolchain hash; the rebuild is manual until a CI job
exists to do it).
