# Deployment guide

## What you are deploying

QuoteReady Studio is not a single container. `docker-compose.yml` defines a
four-service stack: the application, its workspace database, its object store,
and a one-shot bucket bootstrap.

| Compose service | Image | Role | Networks | Host bind mount |
|---|---|---|---|---|
| `quoteredy-studio` | built from `./Dockerfile` | Next.js standalone server plus the bundled Chromium used for PDF export | `proxy_public`, `quoteredy_internal` | `./data` → `/app/data` |
| `quoteredy-db` | `postgres:18` | Workspace store — one JSONB document per Zoo user | `quoteredy_internal` | `./postgres` → `/var/lib/postgresql` |
| `quoteredy-minio` | `minio/minio:latest` | S3-compatible blob store for CAD, glTF previews and attachments | `quoteredy_internal` | `./minio` → `/data` |
| `quoteredy-minio-init` | `minio/mc:latest` | Creates the bucket once (`mc mb --ignore-existing`), then exits | `quoteredy_internal` | — |

Only `quoteredy-studio` joins the external `proxy_public` network, so only it is
reachable through Traefik. `quoteredy_internal` is declared `internal: true`:
the database and the object store have no route to or from the internet, not
even outbound. **No service publishes a host port.**

`quoteredy-minio-init` is expected to be in state `Exited (0)` after startup.
That is success, not a failure.

## Deployment topology

```mermaid
flowchart TB
    Internet((Internet))
    Edge[Cloudflare tunnel<br/>TLS termination]
    Proxy[Traefik on proxy_public]

    subgraph Stack[Compose stack in this directory]
      App[quoteredy-studio<br/>Next.js + Chromium<br/>uid 1000:1000, caps dropped]
      subgraph Internal[quoteredy_internal - internal: true]
        DB[(quoteredy-db<br/>Postgres 18)]
        Minio[(quoteredy-minio<br/>S3-compatible)]
        Init[quoteredy-minio-init<br/>one-shot]
      end
    end

    subgraph Host[Host bind mounts]
      Data[./data]
      PgData[./postgres]
      MinioData[./minio]
    end

    Zoo[api.zoo.dev<br/>HTTPS + WSS]
    OpenAI[api.openai.com<br/>HTTPS]

    Internet --> Edge --> Proxy --> App
    App --> DB --> PgData
    App --> Minio --> MinioData
    Init --> Minio
    App -.->|only with the json/fs drivers| Data
    App -->|outbound| Zoo
    App -->|outbound, user's own key| OpenAI
```

In prose: public traffic terminates at the Cloudflare tunnel, reaches Traefik on
the `web` entrypoint, and is routed to `quoteredy-studio` on port 3000 over
`proxy_public`. The application reaches Postgres and MinIO on the isolated
`quoteredy_internal` network; those two services persist to host bind mounts and
cannot themselves reach the internet. The application makes exactly two classes
of outbound connection: HTTPS and WSS to `api.zoo.dev`, and HTTPS to
`api.openai.com` when a user has supplied their own OpenAI key. `./data` is only
written when the JSON workspace driver or the filesystem blob driver is
selected; with the Compose defaults it stays essentially empty.

## Prerequisites

- Docker Engine with the Compose plugin;
- the existing external Docker network `proxy_public`;
- Traefik attached to that network, with Docker discovery and the `web`
  entrypoint;
- a public hostname routed through the tunnel to Traefik;
- a Zoo OAuth application with the exact callback URI registered;
- host UID/GID 1000 able to write `./data`, `./postgres` and `./minio`;
- outbound HTTPS/WSS egress to `api.zoo.dev` and, optionally,
  `api.openai.com`;
- disk for image layers (the runtime image carries Chromium), Postgres data,
  MinIO objects, and rotated logs.

Verify the prerequisites without changing the host:

```bash
docker version
docker compose version
docker network inspect proxy_public >/dev/null
id 1000
```

If `proxy_public` is absent on a new host, create it once as shared
infrastructure before deployment:

```bash
docker network create proxy_public
```

Do not let Compose create a project-scoped replacement. `quoteredy_internal` is
created by this stack and needs no manual step.

## Repository layout on the host

The stack lives in one directory, which is also the repository root:

```text
<stack-dir>/
├── docker-compose.yml   the four services
├── Dockerfile           three-stage build, Alpine + Chromium runtime
├── .env                 deployment values, mode 600, never committed
├── data/                JSON store and fs blobs (unused with the defaults)
├── postgres/            Postgres 18 data directory
└── minio/               MinIO object data
```

`data/*`, `postgres/` and `minio/` are all in `.gitignore`. All three hold
runtime state, and two of them hold user data — treat them together, not just
`./data`.

All commands in this document run from that directory and use the Compose
project name derived from it. `container_name` is fixed in the Compose file, so
container names never depend on the project name. If you prefer to pin the
project name explicitly, add `-p quoteready-studio` to *every* command in this
document; mixing pinned and unpinned commands makes Compose treat the stack as
two separate projects.

## Configure the deployment

```bash
cp .env.example .env
chmod 600 .env
install -d -m 700 data postgres minio
```

`.env.example` is annotated and ships the Compose-oriented defaults. It also
ships a real default hostname; replace it. Populate at least:

```dotenv
QUOTEREADY_HOST=quoteready.example.com
TZ=Europe/Rome

ZOO_OAUTH_CLIENT_ID=your-public-client-id
ZOO_OAUTH_REDIRECT_URI=https://quoteready.example.com/api/auth/callback
QUOTE_READY_SESSION_SECRET=

QUOTEREADY_STORAGE_DRIVER=postgres
QUOTEREADY_DB_USER=quoteredy
QUOTEREADY_DB_NAME=quoteredy
DB_QUOTEREADY_PASSWORD=

QUOTEREADY_BLOB_DRIVER=s3
QUOTEREADY_PERSIST_UPLOADS=true
QUOTEREADY_S3_REGION=us-east-1
QUOTEREADY_S3_BUCKET=quoteredy
QUOTEREADY_MINIO_ROOT_USER=quoteredy-admin
QUOTEREADY_MINIO_ROOT_PASSWORD=
```

Generate the three secrets rather than inventing them:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"  # QUOTE_READY_SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"  # DB_QUOTEREADY_PASSWORD
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"  # QUOTEREADY_MINIO_ROOT_PASSWORD
```

The complete variable inventory — every name, whether it is required, and what
changing it costs — is in
[Operations](OPERATIONS.md#configuration-inventory). Two properties matter
before you start the stack for the first time:

- `QUOTE_READY_SESSION_SECRET` is not only a cookie key. It also encrypts each
  user's stored Zoo API token and OpenAI key at rest. Choose it once and keep
  it; see [rotating the session secret](OPERATIONS.md#rotating-the-session-secret).
- `DB_QUOTEREADY_PASSWORD` and `QUOTEREADY_DB_USER`/`QUOTEREADY_DB_NAME` are
  read by `postgres:18` **only on the first start**, when the data directory is
  initialised. Changing them later does not change the database; it only breaks
  the connection string Compose builds for the application.

Then verify local state:

```bash
stat -c '%U:%G %a %n' .env data postgres minio
test "$(stat -c %u data)" -eq 1000 && test "$(stat -c %g data)" -eq 1000
test "$(stat -c %u postgres)" -eq 1000 && test "$(stat -c %u minio)" -eq 1000
```

If ownership is wrong, set it deliberately with administrator privileges before
starting the stack. All three services run as `1000:1000` and cannot repair a
host directory they do not own. Postgres in particular refuses to initialise a
data directory it cannot write.

## Register Zoo OAuth

Register exactly:

```text
https://quoteready.example.com/api/auth/callback
```

Enable the `user:read` and `modeling` scopes. Scheme, host, path, case and
trailing slash must match `ZOO_OAUTH_REDIRECT_URI` character for character. The
browser-facing redirect must never use the container bind address `0.0.0.0`.

OAuth establishes identity only. Library listing, CAD upload to Zoo, drawing
generation and drawing chat additionally require each user to paste a **personal
Zoo API token** into the in-app Settings page — there is deliberately no
deployment-wide token environment variable. Plan for this before a demo: a
freshly deployed stack signs in successfully and still refuses those four
features until the operator or the user configures a token. See
[OAuth setup](OAUTH_SETUP.md) for the full flow and the token rationale.

## Validate Compose expansion

Before a build, review the expanded configuration:

```bash
docker compose config --quiet
docker compose config
```

Confirm:

- the router hostname is the intended public host;
- no secret is hardcoded in the Compose source — every one comes from `.env`;
- no host port is published by any of the four services;
- `proxy_public` is `external: true` and `quoteredy_internal` is
  `internal: true`;
- `/app/data`, `/var/lib/postgresql` and `/data` map to `./data`, `./postgres`
  and `./minio`;
- `QUOTEREADY_DATABASE_URL` expanded into a complete
  `postgresql://user:password@quoteredy-db:5432/db` string;
- `QUOTEREADY_S3_ENDPOINT` is `http://quoteredy-minio:9000` — plain HTTP is
  correct here because the hop never leaves the internal network;
- the body-limit middleware is 33,554,432 bytes;
- all three long-running services run as `1000:1000`;
- memory and CPU limits are present on every service.

The expanded output contains deployment secrets. Do not paste it into public
issues without redaction.

## Build and start

```bash
docker compose build --pull
docker compose up -d
docker compose ps
```

Expected steady state: `quoteredy-studio`, `quoteredy-db` and
`quoteredy-minio` running and healthy; `quoteredy-minio-init` exited with code
0. The application declares `depends_on: service_healthy` for the database and
the object store, so it does not start until both pass their healthchecks.

### What the image contains

The Dockerfile has three stages:

1. `dependencies` — `npm ci` against the committed lockfile on `node:24-alpine`;
2. `builder` — the Next.js standalone production build;
3. `runner` — a plain `alpine:3.22` base with only the apk `nodejs` runtime, the
   standalone output, and a `quoteredy` user with uid 1000 and
   `HOME=/home/quoteredy`.

The runner stage also installs **Chromium** (`chromium`, `nss`, `freetype`,
`harfbuzz`, `ca-certificates`, `ttf-dejavu`) and sets
`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser`. Chromium is a first-class
runtime dependency, not an optional extra: it renders both PDF outputs. Two
build details are deliberate and should not be "cleaned up":

- Mesa's software-GL stack (`/usr/lib/libLLVM*`, the gallium libraries, roughly
  300 MB) is deleted, because `apps/web/lib/pdf.ts` always launches with
  `--disable-gpu` and never loads it;
- the `quoteredy` user is created with a real home directory. Without a passwd
  entry the unprivileged uid inherits `HOME=/`, which is not writable, and
  Chromium's crashpad handler aborts at startup.

Chromium is also the main reason the application's memory limit is 2 GiB rather
than the ~512 MiB a bare Next.js process needs.

## Deploying through the aggregate project

A parent aggregate Compose file may pull this stack in with `include:`. If you
use that path, the include entry must name **this directory exactly**, spaces
and all:

```yaml
include:
  - ./QuoteReady Studio/docker-compose.yml
```

> **Warning.** A stale include entry pointing at a directory that no longer
> exists makes every `docker compose` command in the parent directory fail, for
> every stack in that aggregate — not just this one. Verify with
> `docker compose config --quiet` in the parent directory after any rename.

Use either the standalone workflow (recommended, and the one this document
assumes) or the aggregate workflow — consistently. Both create containers named
`quoteredy-studio`, `quoteredy-db` and `quoteredy-minio`, so running both
produces a name collision rather than two stacks.

## Post-deployment verification

### Containers and healthchecks

```bash
docker compose ps
docker inspect --format '{{.Config.User}} {{.State.Status}} {{.State.Health.Status}}' \
  quoteredy-studio quoteredy-db quoteredy-minio
docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' quoteredy-minio-init
```

Expected: `1000:1000 running healthy` for the three long-running services, and
`exited 0` for the bootstrap.

### Application liveness

```bash
docker exec quoteredy-studio wget -qO- http://127.0.0.1:3000/api/health
```

Expected body:

```json
{"status":"ok","service":"quoteredy-studio"}
```

This response is a static literal. It proves the Node process answers HTTP and
nothing else — it does not touch Postgres, MinIO or Zoo. Verify the data layer
separately, as below.

### Data layer

```bash
docker exec quoteredy-db pg_isready -U "$QUOTEREADY_DB_USER" -d "$QUOTEREADY_DB_NAME"
docker exec quoteredy-db psql -U "$QUOTEREADY_DB_USER" -d "$QUOTEREADY_DB_NAME" \
  -c '\dt quoteready_workspaces'
docker logs quoteredy-minio-init
```

The `quoteready_workspaces` table is created lazily by the application on its
first workspace read or write, so an empty result before the first sign-in is
normal. `quoteredy-minio-init` must show a successful `mc mb` line; the
application does **not** depend on it, so a failed bucket creation leaves a
healthy-looking stack whose first upload fails. Confirm the bucket exists on
disk:

```bash
ls minio/
```

### Public route

```bash
curl --fail --show-error --silent "https://quoteready.example.com/api/health"
curl --fail --silent --show-error --head "https://quoteready.example.com/"
```

Confirm Content Security Policy, HSTS, frame denial, MIME-sniffing protection,
permissions/referrer policy and cross-origin opener/resource policy are present
on the document response. Test the public HTTPS origin: an internal HTTP
response cannot prove edge behaviour.

### PDF rendering

Chromium either works or every PDF route answers `503` with
`PdfUnavailableError`, while the rest of the product behaves normally. Verify it
explicitly rather than discovering it during a demo:

```bash
docker exec quoteredy-studio /usr/bin/chromium-browser --version
docker exec quoteredy-studio sh -c 'echo $PUPPETEER_EXECUTABLE_PATH'
```

Then exercise a real render once through the UI (Reports → *Download PDF*, or
Drawings → *Download PDF*). The first render launches the browser singleton and
is the slowest.

### Security posture

```bash
docker inspect quoteredy-studio --format '{{json .HostConfig.SecurityOpt}}'
docker inspect quoteredy-studio --format '{{json .HostConfig.CapDrop}}'
docker inspect quoteredy-studio --format '{{json .HostConfig.PortBindings}}'
docker inspect quoteredy-studio --format '{{json .HostConfig.LogConfig}}'
docker network inspect quoteredy_internal --format '{{.Internal}}'
```

Confirm `no-new-privileges:true`, `ALL` capabilities dropped, no host port
bindings on any service, `json-file` rotation at 10 MiB with three retained
files, and `true` for the internal network.

### Product smoke path

Every platform view is behind `/login`; there is no anonymous access to the
application. Run the smoke path inside a real session:

1. Load the public origin — you should land on `/login`.
2. Press **Connect Zoo** and complete the callback; you return to
   `/?auth=success`.
3. Open **09 Settings** and add a personal Zoo API token (and an OpenAI key if
   detailed reports are in scope for this deployment).
4. Run the fixed-geometry sample from **02 Planning** and confirm a
   deterministic report appears.
5. Run a live analysis with a small synthetic CAD file.
6. Open **03 Zoo library** and confirm a bounded project list loads — this is
   the check that the personal token is accepted.
7. Open **04 Parts** and confirm the glTF preview renders (this proves the blob
   store round-trips).
8. Reload the page and confirm the saved result is still there (this proves
   Postgres persistence).
9. Export one PDF.
10. Sign out and confirm the platform views redirect to `/login` again.

Use synthetic, non-confidential geometry for operational checks.

## Resource choices

| Service | `mem_limit` | `cpus` | Reasoning |
|---|---|---|---|
| `quoteredy-studio` | `2g` | `"2.0"` | One Next.js process plus a headless Chromium that renders A3 sheets; CAD bytes are held in memory long enough to send to Zoo |
| `quoteredy-db` | `1g` | `"1.0"` | One JSONB document per user, no analytical load |
| `quoteredy-minio` | `512m` | `"0.5"` | Object storage for CAD, glTF and attachments |
| `quoteredy-minio-init` | `128m` | `"0.25"` | Runs two `mc` commands and exits |

Observe peak memory during a live analysis and during a PDF export before
tuning. Raising limits does not remove the single-replica constraint: rate
limits, single-flight locks and background-job de-duplication are all
process-local.

## Reverse-proxy behaviour

The Traefik labels on `quoteredy-studio` define:

- router `quoteredy-studio-router`, matching `Host(${QUOTEREADY_HOST})`;
- entrypoint `web`, because TLS terminates upstream at the tunnel;
- explicit `traefik.docker.network=proxy_public`, required because the service
  is attached to two networks;
- service `quoteredy-studio-service` on container port 3000;
- middleware `quoteredy-studio-https`, which adds `X-Forwarded-Proto: https`;
- middleware `quoteredy-studio-body-limit`, buffering requests up to 33,554,432
  bytes (32 MiB) with a 1,048,576-byte (1 MiB) in-memory threshold.

The application independently enforces its own multipart ceilings (32 MiB total,
20 MiB CAD, 10 MiB drawing). Proxy and application limits are intentional
defence in depth: raising one without the other only moves where the request is
rejected.

## Outbound network requirements

The stack needs egress from `quoteredy-studio` only:

| Destination | Protocol | Used for |
|---|---|---|
| `api.zoo.dev` | HTTPS 443 | OAuth, `/user`, File API metrics, CAD→glTF conversion, projects, billing balance |
| `api.zoo.dev` | WSS 443 | `wss://api.zoo.dev/ws/ml/copilot` — pricing, drawing tables, drawing chat |
| `api.openai.com` | HTTPS 443 | AI detailed reports, only when a user has stored their own key |

If the environment enforces an egress allowlist, both hosts must be on it, and
the Zoo entry must permit WebSocket upgrades — a proxy that terminates HTTP but
not WSS silently disables every AI feature while leaving geometry working.

`quoteredy-db` and `quoteredy-minio` need no egress at all and, on the
`internal: true` network, have none.

## Upgrade procedure

1. Read the release changes and inspect dependency/security updates.
2. Take a full backup — Postgres **and** MinIO — using
   [Operations](OPERATIONS.md#backup). A backup of `./data` alone protects
   nothing in the default configuration.
3. Record the current source revision and image ID
   (`docker inspect quoteredy-studio --format '{{.Image}}'`).
4. Run the local quality gates:

   ```bash
   npm ci
   npm run check
   npm run build
   ```

5. Validate Compose expansion.
6. Build with `--pull` and recreate:

   ```bash
   docker compose build --pull
   docker compose up -d
   ```

7. Run the container, data-layer, public-route, PDF, OAuth and smoke checks.
8. Retain the backup until the release is accepted.

Recreating `quoteredy-studio` never requires touching `./postgres` or
`./minio`. Do not perform dependency updates implicitly during an incident.

## Rollback procedure

Application rollback and data rollback are separate decisions.

For an application regression:

1. preserve current logs, the image ID and a data snapshot;
2. verify the previous source revision is compatible with the current stored
   workspace shape;
3. build and deploy that known-good revision;
4. restore data **only** if the newer version changed it incompatibly;
5. execute the full post-deployment verification.

For a data incident, use the restore runbook in
[Operations](OPERATIONS.md#restore) rather than deleting a bind mount.
Container recreation never requires removing `./data`, `./postgres` or
`./minio`.

## Deployment failures

| Symptom | Likely cause | Corrective check |
|---|---|---|
| `quoteredy-db` restarts on first start | `./postgres` not writable by UID 1000, or pre-existing data from another user | `stat -c '%u:%g' postgres`, `docker logs quoteredy-db` |
| Application stuck in `Created`, never starts | A `depends_on` healthcheck is failing | `docker compose ps`, then the db/minio logs |
| Health remains `starting` | Build or runtime error, or slow start | `docker inspect --format '{{json .State.Health}}' quoteredy-studio` |
| Container exits with a permission error | `./data` not writable by UID 1000 | `stat -c '%u:%g %a' data` |
| Internal health works, public 404 | Host rule or tunnel mismatch | Inspect expanded Traefik labels and DNS |
| Uploads fail with a bucket error | `quoteredy-minio-init` failed; the app does not depend on it | `docker logs quoteredy-minio-init`, then re-run it |
| OAuth rejects the callback | Registered URI differs from `.env` | Compare the exact callback string |
| Callback lands on `0.0.0.0` | `ZOO_OAUTH_REDIRECT_URI` missing or internal | Set the public HTTPS callback and recreate |
| Library, upload or drawings refuse with 409 | No personal Zoo API token in Settings | [OAuth setup](OAUTH_SETUP.md#personal-zoo-api-token) |
| PDF routes return 503 | No Chromium binary resolved in the container | `docker exec quoteredy-studio /usr/bin/chromium-browser --version` |
| Request rejected near 32 MiB | Proxy or application ceiling | Reduce file size; do not raise only one layer |
| Results disappear after recreate | Wrong bind mount or a switched storage driver | Inspect the mounts and `QUOTEREADY_STORAGE_DRIVER` |
| Users must re-enter their API keys | `QUOTE_READY_SESSION_SECRET` changed | [Rotating the session secret](OPERATIONS.md#rotating-the-session-secret) |
| New results return `409` | Quota, size or invariant failure | Inspect the response and store capacity |

## Deployment acceptance checklist

- [ ] OAuth callback and scopes match the Zoo application exactly.
- [ ] `QUOTE_READY_SESSION_SECRET` is random, at least 32 characters, private,
      and recorded somewhere it will not be lost.
- [ ] `.env` is mode 600 and excluded from version control.
- [ ] `./data`, `./postgres` and `./minio` are UID/GID 1000 and mode 700.
- [ ] Postgres and MinIO are both included in the backup plan.
- [ ] `proxy_public` is external; `quoteredy_internal` is `internal: true`; no
      host port is published by any service.
- [ ] All three long-running services run as non-root with capabilities
      dropped.
- [ ] Resource limits, healthchecks, restart policy and log rotation are active
      on every service.
- [ ] `quoteredy-minio-init` exited 0 and the bucket exists.
- [ ] Liveness, data-layer, public-route and PDF checks all pass.
- [ ] The authenticated smoke path — sign-in, personal token, sample, live
      analysis, library, 3D preview, PDF, persistence, sign-out — was executed.
- [ ] Known limitations are included in the release or demo material.

## Related documents

- [Operations](OPERATIONS.md) — day-two runbook, backup, restore, incidents.
- [OAuth setup](OAUTH_SETUP.md) — Zoo application registration and diagnostics.
- [Architecture](ARCHITECTURE.md) — components and trust boundaries.
- [Security](SECURITY.md) — the full control set.
