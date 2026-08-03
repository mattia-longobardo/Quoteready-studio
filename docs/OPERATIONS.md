# Operations runbook

## Scope and operating assumptions

This runbook covers the four-service QuoteReady Studio Compose stack — the
application, its Postgres workspace store, its MinIO blob store and the one-shot
bucket bootstrap — together with its Traefik route and its outbound provider
dependencies.

Operate **one application replica**. The Postgres driver serialises workspace
mutations with a row lock, so the *data* is safe under concurrency, but rate
limits, single-flight locks and background-job de-duplication are in-memory and
process-local. A second replica would not corrupt the store; it would silently
double every limit.

The normal production topology is:

```mermaid
flowchart LR
    B[User browser] -->|HTTPS| C[Cloudflare tunnel]
    C -->|HTTP on web entrypoint| T[Traefik]
    T -->|proxy_public : 3000| Q[quoteredy-studio]
    Q -->|row-locked JSONB writes| D[(quoteredy-db<br/>Postgres 18)]
    Q -->|S3 PUT / GET / DELETE| M[(quoteredy-minio)]
    Q -->|HTTPS + WSS| Z[api.zoo.dev]
    Q -->|HTTPS, user's own key| O[api.openai.com]
    D --> DV[./postgres]
    M --> MV[./minio]
```

In prose: the browser reaches the public hostname through the existing edge and
Traefik layers, and only Traefik can reach the application, over the external
`proxy_public` network. The application reaches Postgres and MinIO over
`quoteredy_internal`, which is declared `internal: true` and therefore has no
inbound or outbound internet path; both persist to host bind mounts. The
application itself makes outbound calls to Zoo (HTTPS and WSS) and, when a user
has stored their own key, to OpenAI. No service publishes a host port.

## Service inventory

| Item | `quoteredy-studio` | `quoteredy-db` | `quoteredy-minio` | `quoteredy-minio-init` |
|---|---|---|---|---|
| Image | built from `./Dockerfile` (`quoteredy-studio:latest`) | `postgres:18` | `minio/minio:latest` | `minio/mc:latest` |
| Role | Next.js standalone server + Chromium | Workspace store | Blob store | Bucket bootstrap |
| User | `1000:1000` | `1000:1000` | `1000:1000` | image default |
| Internal ports | `3000/tcp` | `5432/tcp` | `9000/tcp` API, `9001/tcp` console | — |
| Networks | `proxy_public`, `quoteredy_internal` | `quoteredy_internal` | `quoteredy_internal` | `quoteredy_internal` |
| Host bind mount | `./data` → `/app/data` | `./postgres` → `/var/lib/postgresql` | `./minio` → `/data` | — |
| Healthcheck | `wget` on `/api/health`, 15 s / 30 s start | `pg_isready`, 10 s / 30 s start | `curl /minio/health/live`, 10 s / 30 s start | — |
| Restart policy | `unless-stopped` | `unless-stopped` | `unless-stopped` | `no` |
| Autoheal label | — | `autoheal=true` | `autoheal=true` | — |
| Memory / CPU | `2g` / `"2.0"` | `1g` / `"1.0"` | `512m` / `"0.5"` | `128m` / `"0.25"` |
| Log rotation | json-file, 10 MiB × 3 | json-file, 10 MiB × 3 | json-file, 10 MiB × 3 | — |
| Expected state | running, healthy | running, healthy | running, healthy | **exited 0** |

Additional application properties: `init: true`,
`security_opt: no-new-privileges:true`, `cap_drop: ALL`, and no host port
bindings anywhere in the stack. The MinIO console on 9001 is reachable only from
inside `quoteredy_internal`; it is not routed by Traefik.

`quoteredy-minio-init` exiting with code 0 is the success state. Only a non-zero
exit code is an incident.

## Persistent state map

Three host directories hold runtime state; all three are in `.gitignore`. In the
default (Compose) configuration the user data is in `./postgres` and `./minio`,
**not** in `./data`.

| Directory | Holds | Populated when |
|---|---|---|
| `./postgres` | The `quoteready_workspaces` table: results, documents, parts, drawings, folders, machines, tags, and each user's sealed secrets | `QUOTEREADY_STORAGE_DRIVER=postgres` (Compose default) |
| `./minio` | Uploaded CAD, archived analysed CAD and drawings, glTF previews, result attachments | `QUOTEREADY_BLOB_DRIVER=s3` (Compose default) |
| `./data` | `platform.json` (JSON driver) and `blobs/` (fs driver) | Only with `QUOTEREADY_STORAGE_DRIVER=json` / `QUOTEREADY_BLOB_DRIVER=fs` |

The code defaults are the opposite of the Compose defaults: `json` and `fs`, and
`QUOTEREADY_PERSIST_UPLOADS` unset (false). Compose sets `postgres`, `s3` and
`true`. A stack started with the shipped `.env` therefore writes essentially
nothing to `./data` — an operator who backs up only `./data` has backed up
nothing.

All three directories must be owned by `1000:1000` and should be mode 700:

```bash
stat -c '%U:%G %a %n' .env data postgres minio
```

## Configuration inventory

All deployment values belong in `.env` (mode 600). Never place credentials in
the Compose file, the image, source files, screenshots or issue reports.

### Required

| Variable | Purpose | Change impact |
|---|---|---|
| `QUOTEREADY_HOST` | Host matched by the Traefik router | Requires DNS/tunnel and OAuth redirect alignment |
| `TZ` | Container timezone (all four services) | Operational timestamps only; per-user display timezone is a user setting |
| `ZOO_OAUTH_CLIENT_ID` | Public Zoo OAuth client ID | Existing sessions continue until refresh; refresh then fails |
| `ZOO_OAUTH_REDIRECT_URI` | Exact registered callback; also the origin used to build the post-login redirect | A mismatch prevents sign-in entirely |
| `QUOTE_READY_SESSION_SECRET` | ≥ 32 chars. AES-256-GCM key material for session cookies, OAuth transaction cookies **and every stored user secret** | Rotation signs everyone out *and* permanently destroys all stored Zoo API tokens and OpenAI keys — see [Rotating the session secret](#rotating-the-session-secret) |

### Workspace persistence

| Variable | Purpose | Change impact |
|---|---|---|
| `QUOTEREADY_STORAGE_DRIVER` | `postgres` (Compose default) or `json` (code default) | Switching drivers does not migrate data; the workspace appears empty until you switch back |
| `QUOTEREADY_DB_USER` | Postgres role; also used by the `pg_isready` healthcheck | Read by `postgres:18` **only at first initialisation**; changing it later only breaks the connection string |
| `QUOTEREADY_DB_NAME` | Database name | Same as above |
| `DB_QUOTEREADY_PASSWORD` | Postgres password | Same as above; rotate with `ALTER ROLE`, then update `.env`, then recreate both services |
| `QUOTEREADY_DATABASE_URL` | Full connection string. **Compose builds this** from the three values above; set it manually only when running outside Compose | Wrong value → the application throws a store configuration error on first workspace access |

`DATABASE_URL` is accepted as a fallback name by the code if
`QUOTEREADY_DATABASE_URL` is absent.

### Blob storage

| Variable | Purpose | Change impact |
|---|---|---|
| `QUOTEREADY_BLOB_DRIVER` | `s3` (Compose default) or `fs` (code default) | Existing blob keys are not migrated; previews, archived CAD and attachments stop resolving |
| `QUOTEREADY_PERSIST_UPLOADS` | `true` archives the analysed CAD and drawing beside each result. Compose sets `true`; the code default is `false` | With `false`, re-runs and drawing generation both fail with a `409` because no CAD is archived |
| `QUOTEREADY_S3_REGION` | S3 region, default `us-east-1` | Cosmetic for MinIO; significant for real AWS |
| `QUOTEREADY_S3_BUCKET` | Bucket name, default `quoteredy`; also the bucket `quoteredy-minio-init` creates | Changing it needs a matching bucket, or every blob write fails |
| `QUOTEREADY_MINIO_ROOT_USER` | MinIO root user; Compose reuses it as the S3 access key ID | Read at MinIO initialisation; rotate through MinIO, not by editing `.env` alone |
| `QUOTEREADY_MINIO_ROOT_PASSWORD` | MinIO root password; Compose reuses it as the S3 secret key | Same as above |

Optional overrides, for pointing the application at an external S3 service
instead of the bundled MinIO:

| Variable | Purpose |
|---|---|
| `QUOTEREADY_S3_ENDPOINT` | Custom endpoint. Compose sets `http://quoteredy-minio:9000`; plain HTTP is acceptable only because that hop never leaves the internal network |
| `QUOTEREADY_S3_ACCESS_KEY_ID` | Access key. Compose sets it from `QUOTEREADY_MINIO_ROOT_USER` |
| `QUOTEREADY_S3_SECRET_ACCESS_KEY` | Secret key. Compose sets it from `QUOTEREADY_MINIO_ROOT_PASSWORD` |
| `QUOTEREADY_S3_FORCE_PATH_STYLE` | Defaults to `true`, which is what MinIO and most self-hosted S3 servers expect. Set to `false` only for virtual-host-style providers |

### Read by the code, set by the image or Compose

| Variable | Purpose |
|---|---|
| `QUOTE_READY_DATA_DIR` | Root for the JSON store and `fs` blobs. Compose sets `/app/data` |
| `QUOTEREADY_DATA_DIR` | Alternative spelling of the same setting; takes precedence when both are present |
| `PUPPETEER_EXECUTABLE_PATH` | Chromium binary for PDF rendering. The image sets `/usr/bin/chromium-browser`; the code also probes `/usr/bin/chromium` and `/usr/bin/google-chrome` |

### Not an environment variable

The **personal Zoo API token** and the **OpenAI API key** are per-user values
entered in the in-app Settings page, sealed with AES-256-GCM and stored in the
workspace. There is deliberately no deployment-wide `ZOO_API_TOKEN`; a shared
token was removed on purpose (see
[Zoo API notes](ZOO_API_NOTES.md#authentication-and-scopes)). An operator cannot
provision these for users, and cannot read them back.

Generate secrets on a trusted host:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"  # session secret
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"  # DB / MinIO passwords
```

## Standard start and update procedure

Run all commands from the stack directory. Compose derives the project name from
that directory; `container_name` is pinned in the Compose file, so container
names never change. If you pin the project name with `-p`, do it in every
command.

```bash
docker network inspect proxy_public >/dev/null
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
```

Do not create a second `proxy_public` network with a Compose-scoped name. It is
shared external infrastructure and must already exist. `quoteredy_internal` is
owned by this stack.

If a parent aggregate Compose file includes this stack, its `include:` entry
must name this directory exactly. A stale entry pointing at a directory that no
longer exists breaks every `docker compose` command in the parent directory, for
every stack in that aggregate.

## Health verification

### Layer 1: Compose state

```bash
docker compose ps
docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' \
  quoteredy-studio quoteredy-db quoteredy-minio
```

Expected: `running healthy` for all three after their 30-second start periods.
`quoteredy-minio-init` should read `exited 0`.

### Layer 2: application liveness

```bash
docker exec quoteredy-studio wget -qO- http://127.0.0.1:3000/api/health
```

Expected body:

```json
{"status":"ok","service":"quoteredy-studio"}
```

**This is a static literal.** `/api/health` does not query Postgres, does not
contact MinIO, and does not call Zoo. It proves the Node process is answering
HTTP — nothing more. A healthy container with a broken database is a state this
endpoint cannot detect, which is why layer 3 exists.

### Layer 3: data layer

```bash
docker exec quoteredy-db pg_isready -U "$QUOTEREADY_DB_USER" -d "$QUOTEREADY_DB_NAME"
docker exec quoteredy-db psql -U "$QUOTEREADY_DB_USER" -d "$QUOTEREADY_DB_NAME" -c \
  "SELECT count(*) AS workspaces, pg_size_pretty(sum(pg_column_size(data))) AS stored
     FROM quoteready_workspaces;"
docker exec quoteredy-minio curl -sf http://127.0.0.1:9000/minio/health/live && echo minio-ok
du -sh postgres minio data
```

The `quoteready_workspaces` table is created lazily on the first workspace
access, so `relation does not exist` before anyone has signed in is normal, not
a fault.

### Layer 4: public route

```bash
curl --fail --show-error --silent "https://${QUOTEREADY_HOST}/api/health"
curl --fail --silent --show-error --head "https://${QUOTEREADY_HOST}/"
```

Layer 4 validates DNS, tunnel, Traefik matching and the application. Review CSP,
HSTS, frame, MIME, permissions/referrer and cross-origin headers on the document
response after any framework or proxy change; do not assume an upstream default
matches the application policy.

### Layer 5: functional smoke test

There is **no anonymous access** — every platform view redirects to `/login`.
Run the smoke test inside a real session:

1. Open the public origin in a clean browser session; confirm you land on
   `/login`.
2. Connect Zoo and confirm the session view shows the expected account.
3. Run the fixed-geometry sample from **02 Planning** and confirm a
   deterministic report appears.
4. Open **03 Zoo library** and confirm a bounded project list loads — this
   exercises the personal Zoo API token.
5. Upload a small synthetic CAD file and run a live analysis.
6. Open **04 Parts** and confirm the glTF preview renders — this exercises the
   blob store.
7. Reload the page and confirm the result is still listed — this exercises
   Postgres.
8. Export one PDF — this exercises Chromium.

Use synthetic, non-confidential geometry for operational checks.

## Logs and diagnosis

```bash
docker compose logs --tail=200 quoteredy-studio
docker compose logs --follow quoteredy-studio
docker compose logs --tail=100 quoteredy-db quoteredy-minio
docker logs quoteredy-minio-init
```

Docker rotates each JSON log at 10 MiB and retains three files. Application logs
must not contain OAuth tokens, session cookie contents, personal Zoo API tokens,
OpenAI keys, uploaded CAD or drawing bytes, or the session secret. Treat any
accidental appearance as a security incident.

Useful read-only diagnostics:

```bash
docker inspect quoteredy-studio --format '{{json .State.Health}}'
docker stats --no-stream quoteredy-studio quoteredy-db quoteredy-minio
docker network inspect quoteredy_internal --format '{{.Internal}}'
docker exec quoteredy-studio /usr/bin/chromium-browser --version
du -sh postgres minio data
stat -c '%U:%G %a %n' data postgres minio
```

Per-user store size, which is what the 64 MiB ceiling applies to:

```bash
docker exec quoteredy-db psql -U "$QUOTEREADY_DB_USER" -d "$QUOTEREADY_DB_NAME" -c \
  "SELECT user_id, pg_size_pretty(pg_column_size(data)::bigint) AS size, updated_at
     FROM quoteready_workspaces ORDER BY pg_column_size(data) DESC LIMIT 10;"
```

## Backup

### What a backup contains

A backup of this stack is **secret-bearing**. The workspace store holds each
user's personal Zoo API token and OpenAI API key, sealed with AES-256-GCM using
`QUOTE_READY_SESSION_SECRET` (`aiApiKeySealed` and `zooApiTokenSealed` in
`packages/core/src/types.ts`, sealed in `apps/web/lib/user-settings.ts`).

Three consequences:

- a backup is only as protected as the file permissions and storage you give
  it, and it must follow the same access and retention rules as production
  data;
- a restored backup decrypts its sealed secrets **only** with the matching
  `QUOTE_READY_SESSION_SECRET`. Back up the secret separately, in a password
  manager or secret store — never in the same archive as the data;
- the blob store additionally holds customers' CAD geometry and drawings.

OAuth access and refresh tokens are **not** in the store — they live only in the
user's browser cookie.

### Full backup (default Postgres + MinIO configuration)

The clean procedure takes a short maintenance window so the database dump and
the object copy describe the same moment.

1. Announce the brief pause.
2. Stop only the application; leave the data services running.
3. Dump Postgres and mirror MinIO.
4. Record checksums and restrict permissions.
5. Restart the application and re-run the health layers.

```bash
install -d -m 700 backups
STAMP="$(date +%Y%m%d-%H%M%S)"

docker compose stop quoteredy-studio

# 1. Workspace store
docker exec quoteredy-db pg_dump -U "$QUOTEREADY_DB_USER" -d "$QUOTEREADY_DB_NAME" \
  --format=custom > "backups/workspace-${STAMP}.dump"

# 2. Blob store (cold copy of the bind mount; MinIO is idle with the app stopped)
tar -C minio -cf "backups/blobs-${STAMP}.tar" .

docker compose start quoteredy-studio

sha256sum "backups/workspace-${STAMP}.dump" "backups/blobs-${STAMP}.tar" \
  > "backups/manifest-${STAMP}.sha256"
chmod 600 backups/*
```

Online alternative for the blob store, if a maintenance window is not
acceptable — run `mc` on the internal network and pass the credentials through
the environment rather than the command line:

```bash
docker run --rm --network quoteredy_internal \
  -e MC_HOST_quoteredy="http://${QUOTEREADY_MINIO_ROOT_USER}:${QUOTEREADY_MINIO_ROOT_PASSWORD}@quoteredy-minio:9000" \
  -v "$PWD/backups:/backup" --entrypoint /bin/sh minio/mc:latest -c \
  "mc mirror --overwrite quoteredy/${QUOTEREADY_S3_BUCKET} /backup/blobs-live"
```

Also back up, separately and to a different place:

- `.env` (it holds the database and MinIO credentials);
- `QUOTE_READY_SESSION_SECRET`, without which the sealed per-user secrets in the
  dump are unrecoverable.

Store backups outside the repository directory for real disaster recovery.

### Backup with the JSON and filesystem drivers

Only relevant when `QUOTEREADY_STORAGE_DRIVER=json` and/or
`QUOTEREADY_BLOB_DRIVER=fs` — for example a local development instance. The
workspace is then a single file written with an atomic rename, and the blobs are
plain files:

```bash
docker compose stop quoteredy-studio
install -d -m 700 backups
cp --preserve=mode,timestamps data/platform.json \
  "backups/platform-$(date +%Y%m%d-%H%M%S).json"
tar -C data -cf "backups/blobs-$(date +%Y%m%d-%H%M%S).tar" blobs
docker compose start quoteredy-studio
sha256sum backups/platform-*.json backups/blobs-*.tar
chmod 600 backups/*
```

An operator copy taken while the application is running can race the next write,
which is why the application is stopped first. The same secret-bearing warning
applies: `platform.json` contains the sealed Zoo and OpenAI credentials.

### Backup verification

A backup nobody has restored is a hypothesis. At least once per release, restore
the dump into a throwaway database and confirm it loads:

```bash
docker exec -i quoteredy-db psql -U "$QUOTEREADY_DB_USER" -d postgres \
  -c 'CREATE DATABASE restore_check;'
docker exec -i quoteredy-db pg_restore -U "$QUOTEREADY_DB_USER" -d restore_check \
  < "backups/workspace-${STAMP}.dump"
docker exec quoteredy-db psql -U "$QUOTEREADY_DB_USER" -d restore_check \
  -c 'SELECT count(*) FROM quoteready_workspaces;'
docker exec quoteredy-db psql -U "$QUOTEREADY_DB_USER" -d postgres \
  -c 'DROP DATABASE restore_check;'
```

## Restore

Restoring replaces current workspace and blob state. Confirm the target, and
keep a recovery copy of the current state before proceeding — even when the
current state is believed to be broken.

### Preflight

```bash
test -f "backups/workspace-${STAMP}.dump"
test -f "backups/blobs-${STAMP}.tar"
sha256sum --check "backups/manifest-${STAMP}.sha256"
docker exec -i quoteredy-db pg_restore --list < "backups/workspace-${STAMP}.dump" | head
```

Confirm you still hold the `QUOTE_READY_SESSION_SECRET` that was in force when
the backup was taken. Restoring data under a different secret leaves every
user's stored Zoo API token and OpenAI key permanently undecryptable, and the
Settings page will still report them as present.

### Procedure

1. Stop the application (leave the data services running):
   `docker compose stop quoteredy-studio`.
2. Snapshot the current state to a recovery location (dump + `tar` of `minio`),
   even if it is the state you are discarding.
3. Restore the workspace store:

   ```bash
   docker exec -i quoteredy-db pg_restore -U "$QUOTEREADY_DB_USER" \
     -d "$QUOTEREADY_DB_NAME" --clean --if-exists \
     < "backups/workspace-${STAMP}.dump"
   ```

4. Restore the blob store. Stop MinIO first so nothing is holding the files,
   replace the contents of `./minio`, then start it again:

   ```bash
   docker compose stop quoteredy-minio
   rm -rf minio.broken && mv minio minio.broken && install -d -m 700 minio
   tar -C minio -xf "backups/blobs-${STAMP}.tar"
   docker compose start quoteredy-minio
   ```

5. Start the application and run all five health layers, including one
   authenticated workspace load, one 3D preview and one PDF export.
6. Keep `minio.broken` and the pre-restore dump until the restore is accepted.

With the JSON driver, the equivalent is: validate the candidate file (regular
file, below 64 MiB, parses as JSON), stop the application, keep the current
file, install the candidate as `data/platform.json` owned `1000:1000`, and
start:

```bash
test "$(stat -c %s backups/platform-YYYYMMDD-HHMMSS.json)" -le 67108864
node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log('valid JSON')" \
  backups/platform-YYYYMMDD-HHMMSS.json
```

Do not merge two workspace snapshots by hand, in either driver. IDs, folder
parents, `sourceResultId` revision chains, selected routes, attachment blob
references and per-user quotas all carry cross-field invariants, and the blob
store must agree with the rows that reference it.

## Rotating the session secret

`QUOTE_READY_SESSION_SECRET` is not only the session cookie key. The same
AES-256-GCM envelope seals each user's personal Zoo API token and OpenAI API key
before they are written to the workspace store.

Rotating it therefore does two things, not one:

1. every session and OAuth transaction cookie stops validating, so all users are
   signed out — intended, and the reason to rotate after a suspected cookie
   exposure;
2. **every stored Zoo API token and OpenAI key becomes permanently
   undecryptable.** The sealed values remain in the store, so the Settings page
   keeps reporting `hasZooApiToken` / `hasAiApiKey` as `true`, while the
   features that use them fail. Users must re-enter both secrets.

Because of point 2, treat rotation as a user-visible event:

1. decide whether the incident actually requires it — a leaked cookie does, a
   routine restart does not;
2. notify users that they will be signed out **and** must re-enter their API
   keys in Settings;
3. take a backup first, and record which secret it belongs to;
4. update `.env`, then `docker compose up -d --force-recreate quoteredy-studio`;
5. confirm sign-in works, then confirm one user can save and use a fresh
   personal Zoo API token;
6. archive the previous secret for as long as you retain backups sealed with it.

There is no re-encryption tooling. Restoring an old backup under a new secret
does not recover the old secrets.

## Capacity and quota management

### Per-workspace object quotas

Enforced in `packages/storage/src/model.ts` (`STORE_LIMITS`) for both drivers.

| Resource | Ceiling | Operator response |
|---|---:|---|
| Analysis results | 250 | Archive is not enough — emptying the results trash is what frees slots |
| Report documents | 250 | Same: trash, then empty the documents trash |
| Parts | 250 | Rolling: the oldest part that is not currently `analyzing` is evicted automatically, so uploads do not fail on this quota |
| Drawing tables | 100 | Delete obsolete drawings (`DELETE /api/drawings?id=…`) |
| Folders | 200 | Consolidate, or delete folders with `mode=release` to keep their contents |
| Machines | 100 | Remove obsolete profiles from **08 My factory** |
| Attachments per result | 20 | Detach material that is no longer needed |
| Attachment note text | 4 000 characters | Shorten the note |
| Report-document HTML | 500 KiB | The generator refuses larger output; regenerate with a smaller scope |
| Tags | 10 per item, 30 characters each | Normalised and de-duplicated automatically |
| Complete workspace store | 64 MiB serialised | Checked before every commit. On Postgres it applies per user row; with the JSON driver it applies to the whole file |

Permanent deletion **does** exist, contrary to what earlier revisions of this
runbook stated. Archiving and trashing are reversible states that still consume
quota; the following operations actually reclaim it:

| Operation | Effect |
|---|---|
| `DELETE /api/reports?scope=trash` | Permanently deletes every trashed result |
| `DELETE /api/documents?scope=trash` | Permanently deletes every trashed document |
| `DELETE /api/reports?folderId=…&mode=purge` | Deletes the folder **and** the results and documents filed in it |
| `DELETE /api/parts?id=…` | Deletes a part record and its part-scoped blobs |
| `DELETE /api/drawings?id=…` | Deletes a drawing table |
| `DELETE /api/factory?id=…` | Deletes a machine profile |
| `DELETE /api/reports/attachments?resultId=…&attachmentId=…` | Detaches material, and deletes the bytes when no other result references the same blob |

Guide users to these through the product UI. Never delete rows from
`quoteready_workspaces`, or objects from the bucket, as a routine operation:
results reference blobs, re-runs share attachment blobs, and superseded parts
are deliberately retained so older results still resolve their geometry.

### Rate and concurrency limits

All windows are 60 seconds and are keyed per Zoo user (the sample endpoint falls
back to a normalised client address when the caller is anonymous). Counters are
in-memory, so they reset on restart and do not span replicas.

| Key | Limit/min | Routes |
|---|---:|---|
| `demo` | 10 | `POST /api/analyze?mode=demo` |
| `analysis` | 6 | `POST /api/analyze` |
| `rerun` | 4 | `POST /api/reports/rerun` |
| `result-part` | 6 | `POST /api/reports/part` |
| `result-attachment` | 30 | `POST /api/reports/attachments` |
| `report-doc` | 3 | `POST /api/documents` |
| `drawings` | 4 | `POST /api/drawings` |
| `drawing-chat` | 6 | `POST /api/drawings/chat` |
| `pdf` | 6 | `GET /api/documents/{id}?format=pdf`, `GET /api/drawings/pdf` |
| `factory` | 30 | `POST` / `DELETE /api/factory` |
| `reports` | 40 | `POST` / `PATCH /api/reports` |
| `parts` | 40 | `PATCH /api/parts` |
| `zoo-upload` | 5 | `POST /api/zoo/upload` |

Single-flight keys admit one in-process execution each and answer `409`
otherwise:

| Key | Shared by |
|---|---|
| `analysis:{userId}` | `POST /api/analyze` **and** `POST /api/reports/rerun` |
| `report-doc:{userId}` | `POST /api/documents` |
| `drawings:{userId}` | `POST /api/drawings` |
| `drawing-chat:{userId}:{drawingId}` | `POST /api/drawings/chat` |

The process keeps at most 10 000 rate identities; a new identity receives `503`
when a full map has nothing to reclaim. Investigate only sustained, unexpected
rates — an occasional `429` during a demo is the control working.

### Disk

Monitor `./postgres`, `./minio` and image/log growth together. There is no
retention worker and no quota dashboard: the 64 MiB store ceiling bounds
metadata per user, but blob growth is bounded only by the object quotas and the
20 MiB per-CAD upload limit.

```bash
du -sh postgres minio data
df -h .
```

## Common incidents

### Application container is unhealthy

1. Inspect health output and the last 200 log lines.
2. Confirm `quoteredy-db` and `quoteredy-minio` are themselves healthy — the
   application starts only after both pass, but it does not restart when they
   later fail.
3. Check that `/app/data` is writable by UID 1000.
4. Confirm the process listens on port 3000 inside the container.
5. Recreate only after preserving all three bind mounts.

### `quoteredy-db` is unhealthy or restarting

The `pg_isready` healthcheck fails, `autoheal` restarts the container, and every
workspace read and write fails while it is down. The application's own
healthcheck keeps reporting `ok`, because `/api/health` never touches the
database.

1. `docker logs quoteredy-db --tail=100`.
2. Ownership: `stat -c '%u:%g' postgres` must be `1000:1000`. Postgres refuses
   to initialise or open a data directory it cannot write.
3. Disk: a full filesystem shows as write errors in the log.
4. Confirm `QUOTEREADY_DB_USER` / `QUOTEREADY_DB_NAME` in `.env` still match
   what the data directory was initialised with — they are only read on first
   start, and a later edit makes both the healthcheck and the application's
   connection string wrong while the database itself is fine.
5. If the data directory is corrupt, restore rather than re-initialise: deleting
   `./postgres` silently creates an empty database and loses every workspace.

Symptom in the UI: signed-in users see the workspace fail to load; new analyses
return a `500`.

### `quoteredy-minio` is unavailable

Metadata still works; anything touching bytes does not. Expect failures in 3D
previews (`GET /api/parts/model`), attachment downloads, CAD archival, drawing
generation and any re-run.

1. `docker logs quoteredy-minio --tail=100` and
   `docker exec quoteredy-minio curl -sf http://127.0.0.1:9000/minio/health/live`.
2. Ownership of `./minio` must be `1000:1000`; check free disk.
3. From the application's side, confirm the endpoint resolves:
   `docker exec quoteredy-studio wget -qO- http://quoteredy-minio:9000/minio/health/live`.
4. Confirm `QUOTEREADY_S3_ACCESS_KEY_ID` / `QUOTEREADY_S3_SECRET_ACCESS_KEY`
   still match the MinIO root credentials — Compose derives them from
   `QUOTEREADY_MINIO_ROOT_USER` / `QUOTEREADY_MINIO_ROOT_PASSWORD`, so editing
   one without recreating both services produces authentication failures.

### Bucket bootstrap failed

`quoteredy-minio-init` exiting non-zero leaves a stack that looks entirely
healthy — the application does **not** declare a dependency on it — until the
first blob write fails with a missing-bucket error.

1. `docker logs quoteredy-minio-init`.
2. Re-run just the bootstrap: `docker compose up quoteredy-minio-init`. The
   command is `mc mb --ignore-existing` and is safe to repeat.
3. Confirm the bucket: `ls minio/` should list `${QUOTEREADY_S3_BUCKET}`.
4. If the credentials were wrong, fix `.env` and recreate `quoteredy-minio`
   before re-running the bootstrap.

### PDF export returns 503

Both PDF routes — `GET /api/documents/{id}?format=pdf` (A4) and
`GET /api/drawings/pdf` (ISO A3 landscape) — answer `503` with
`PdfUnavailableError` when no Chromium binary can be resolved or the browser
fails to launch. Everything else in the product keeps working; the HTML views
remain available.

1. Confirm the binary exists:
   `docker exec quoteredy-studio /usr/bin/chromium-browser --version`.
2. Confirm `PUPPETEER_EXECUTABLE_PATH` is set (the image sets
   `/usr/bin/chromium-browser`; the code also probes `/usr/bin/chromium` and
   `/usr/bin/google-chrome`).
3. Check the application log for the launch error. Known causes:
   - the runtime image was rebuilt without the `chromium` apk package;
   - `HOME` is not `/home/quoteredy`, so the crashpad handler aborts;
   - the process could not create a temp profile — Chromium's `--user-data-dir`,
     `--crash-dumps-dir` and `--disk-cache-dir` are all redirected into a
     private `mkdtemp` directory;
   - memory pressure. Chromium is the reason the limit is 2 GiB; check
     `docker stats` during a render.
4. The browser is a process-wide singleton that is reset after a failed launch,
   so the next request retries. A restart of `quoteredy-studio` clears a wedged
   browser.

Do not "fix" this by re-adding the Mesa/LLVM packages the Dockerfile deletes —
rendering always runs with `--disable-gpu` and never loads them.

### A user cannot use the library, upload, drawings or drawing chat

Symptom: a `409` naming the personal Zoo API token, or a `502` whose `detail`
explains that Zoo's Projects API does not accept third-party OAuth tokens.

This is expected behaviour, not a deployment fault. Zoo's OAuth scopes
(`user:read modeling`) do not cover `/file/*`, `/user/projects` or the ML
copilot socket; third-party OAuth tokens get HTTP 403 from all of them.
`resolveProjectsToken()` therefore prefers a **personal Zoo API token** stored
in the user's Settings — verified against `GET /user` and cached for 10
minutes — and falls back to the OAuth token only where it can work.

1. Ask the user to open **09 Settings** and paste a personal token from the Zoo
   dashboard.
2. If the token is present and still rejected, it is invalid, revoked, or
   belongs to a different Zoo account than the signed-in session. Ownership
   verification is deliberate: one user's token can never act for another.
3. The verification result is cached for 10 minutes, so a token replaced after a
   failure can take that long to take effect for calls that reuse the cached
   answer.
4. There is no operator-side fix and no environment fallback — the previous
   deployment-wide `ZOO_API_TOKEN` was removed on purpose. See
   [OAuth setup](OAUTH_SETUP.md#personal-zoo-api-token) and
   [Zoo API notes](ZOO_API_NOTES.md#authentication-and-scopes).

### AI detailed reports fail or are refused

`POST /api/documents` calls `https://api.openai.com/v1/chat/completions` with a
180-second timeout and a 2 MiB response ceiling, using the **user's own** key.

| Symptom | Cause | Resolution |
|---|---|---|
| `409` before generation starts | AI reports disabled, or no key stored in Settings | The user enables the feature and adds a key in **09 Settings** |
| Document flips to `failed` with an authentication error | Key revoked, expired, or out of quota at OpenAI | The user replaces the key |
| Document flips to `failed` after the model name changed | `aiModel` names a model the key cannot access | Set a model the account can use |
| `hasAiApiKey` is `true` but every generation fails to authenticate | `QUOTE_READY_SESSION_SECRET` was rotated, so the sealed key can no longer be opened | The user re-enters the key; see [Rotating the session secret](#rotating-the-session-secret) |
| All users fail at once | Egress to `api.openai.com` blocked, or an OpenAI outage | Check egress, then the provider status |

A document stuck in `generating` is treated as stale after 10 minutes, after
which a new generation for the same result is accepted.

### Zoo credits exhausted

The usage badge in the top bar reads `GET /user/payment/balance` and shows the
remaining monthly plus stable credits as minutes, cached five minutes per user.
When an account runs out, Zoo starts refusing the metered calls.

- Geometry metrics fail individually and become `failed` entries in the report's
  `apiTrace`; the report is still produced, and a missing volume blocks
  readiness.
- CAD→glTF conversion degrades the part to "no preview", and a drawing generated
  from that part prints its reason with scale `NTS`.
- Copilot prompts fail and the deterministic plan is kept with a visible
  `fallbackReason`.

Nothing here is an application fault, and no restart helps. Confirm the balance
for the affected account, then top it up or wait for the monthly reset. The
badge disappearing entirely (all-`null` fields, HTTP 200) means the balance call
itself failed — usually a token problem rather than a credit problem.

### Public URL fails but internal liveness works

1. Confirm `QUOTEREADY_HOST` expanded correctly in `docker compose config`.
2. Inspect `proxy_public` attachment for both Traefik and the application.
3. Confirm the router uses entrypoint `web`, service port `3000` and
   `traefik.docker.network=proxy_public`.
4. Check tunnel and DNS routing for the same hostname.
5. Do not add a host `ports:` mapping as a workaround.

### OAuth reports an invalid scope

The application requests `user:read modeling` (`ZOO_OAUTH_SCOPE` in
`apps/web/lib/oauth.ts`). Confirm the Zoo application has both enabled, then
start a fresh authorization flow. See [OAuth setup](OAUTH_SETUP.md).

### OAuth returns to `0.0.0.0`

Confirm `ZOO_OAUTH_REDIRECT_URI` contains the public HTTPS origin and that the
exact value is registered at Zoo. The post-login redirect is built from this
variable specifically to avoid internal container addresses. Recreate the
container after editing `.env`.

### Workspace writes fail

Check, in order:

1. `quoteredy-db` health, ownership of `./postgres`, and free disk;
2. per-user object ceilings (`StoreQuotaError` messages name the limit);
3. the 64 MiB per-workspace ceiling — see the per-user size query above;
4. whether another replica or a stray container is writing the same data;
5. for the JSON driver only: file integrity and the atomic-rename temp file.

A quota failure is a clean rejection: the mutation is not committed. Do not let
the application start from an empty store after a corruption without first
preserving the failed state and deciding how the data will be recovered.

### Zoo geometry partially fails

Metric operations are independent and share one 45-second deadline. A report
keeps its successful metrics and records the failed ones in the trace. Missing
solid volume blocks readiness; missing surface area or centre of mass is shown
as unavailable. Retry with a small known-good synthetic CAD file before treating
it as an application regression.

### Zoo copilot is unavailable or its answer is rejected

The report still completes on the deterministic plan and shows fallback
provenance with a stored `fallbackReason`. Confirm the fallback is bounded and
readable. Copilot availability is not required for the analysis endpoint to
return a safe plan. Drawing generation and drawing chat, by contrast, have no
deterministic fallback — they fail as `failed` records with a bounded error.

## Security incident procedure

For suspected token, secret, workspace or upload exposure:

1. preserve logs and deployment metadata without copying sensitive values into
   public channels;
2. limit access to the affected host, the bind mounts and the backup location;
3. rotate `QUOTE_READY_SESSION_SECRET` if session cookies may be exposed —
   understanding that this also destroys every stored Zoo API token and OpenAI
   key (see [Rotating the session secret](#rotating-the-session-secret));
4. ask affected users to revoke their personal Zoo API tokens and OpenAI keys at
   the provider, and to sign out so their OAuth grants are revoked;
5. replace any compromised deployment secret — `.env` holds the Postgres and
   MinIO credentials, so a leaked `.env` means rotating those too;
6. determine which data and time range were affected, including which backups
   were taken with the compromised secret;
7. fix and verify the cause before restoring public access;
8. document the event and follow the disclosure process in
   [Security](SECURITY.md).

## Rollback

Application rollback and data rollback are separate decisions.

- For a code-only regression, redeploy a known-good source revision against the
  current store, after reviewing any data-model change.
- For a corrupt write or an incompatible data mutation, stop the service and use
  the [restore](#restore) procedure — remembering that the workspace rows and
  the blob objects must be restored to the same point in time.
- Never assume a previous image understands a newer stored workspace shape.
- Keep the failed image, the logs and a data snapshot until the cause is
  understood.

After a rollback, run all five health layers and document the deployed source
revision, the image ID, the backup used, and the reason.

## Routine checklist

### Daily during the contest or demo window

- all three long-running containers are `healthy`;
- the public health URL returns 200;
- `du -sh postgres minio` shows expected growth and the filesystem has headroom;
- no repeated OAuth, Zoo, Postgres, MinIO or persistence errors in the logs;
- one sample report completes inside a signed-in session;
- one PDF export succeeds (this is the only routine proof that Chromium works);
- the OAuth redirect still uses the public origin.

### Before every demonstration

- confirm the Zoo account has credits remaining (the badge in the top bar);
- confirm the demo account's personal Zoo API token is present and valid;
- confirm the OpenAI key is present if detailed reports are part of the script;
- use a small known-good CAD file with no confidential design data;
- keep sample mode available as the deterministic recovery path;
- verify persistence with a page reload, and export one PDF in advance;
- keep the limitations statement ready and accurate.

## Related documents

- [Deployment](DEPLOYMENT.md) — first deployment, upgrade and rollback.
- [OAuth setup](OAUTH_SETUP.md) — sign-in flow and the personal-token
  requirement.
- [Internal HTTP API](API.md) — every route, limit and status code.
- [Architecture](ARCHITECTURE.md) — components and trust boundaries.
- [Security](SECURITY.md) · [Security review](SECURITY_REVIEW.md).
