# Security review

## Review objective

This review evaluates whether an anonymous user, malicious origin,
authenticated user, malformed upload, external response, generated document, or
persistence failure can violate confidentiality, integrity, or availability. It
records current controls and residual risks; it is not a claim that the
application is free from vulnerabilities.

## Scope

Reviewed surfaces:

- the nine authenticated views, the login gate, and session actions
  (`apps/web/components/platform-shell.tsx`: Overview, Planning, Zoo library,
  Parts, Drawings, Results, Reports, My factory, Settings);
- all 23 route handlers under `apps/web/app/api/`;
- OAuth/PKCE and encrypted-cookie helpers, and the same AES-256-GCM envelope
  reused to seal the user's stored Zoo and OpenAI secrets;
- streaming JSON and multipart readers;
- Zoo File API, CAD→glTF Conversion API, Projects/Billing, and ML copilot
  adapters, including drawing-table generation and drawing chat;
- OpenAI detailed-report generation, its HTML sanitiser, and the headless
  Chromium PDF pipeline;
- the CPU drafting pipeline (mesh → features → views → annotations → sheet);
- deterministic audit, manufacturing, and copilot-validation logic;
- workspace persistence on both drivers (JSON file and Postgres JSONB) and blob
  persistence on both drivers (filesystem and S3/MinIO), including the blob key
  layout and retention behaviour;
- result attachments, re-run revisions, and the permanent-deletion routes;
- the Dockerfile and the four-service Compose stack: exposure, networks,
  resources, storage, and healthchecks;
- automated tests and documentation contracts.

Out of scope:

- Zoo and OpenAI infrastructure internals;
- Postgres and MinIO internals beyond their Compose configuration;
- Cloudflare account configuration;
- host OS and Docker daemon hardening;
- Traefik configuration outside this stack;
- attacks requiring a compromised host or leaked deployment secret;
- destructive testing of a public service.

## Review method

The review traced untrusted input from ingress to authorization decisions,
outbound calls, computational work, rendering, and persistence. For each route
it checked:

1. exposure and authentication;
2. origin and tenant selection;
3. body, field, file, object-count, and response limits;
4. identifier ownership;
5. timeout, polling, rate, and concurrency behavior;
6. external response parsing and range validation;
7. what leaves the trust boundary towards a third party, and under whose
   credential;
8. error detail and secret flow;
9. storage consistency, retained bytes, and cross-user resource effects;
10. renderer isolation for generated markup;
11. deployment blast radius and recovery.

Validation remained read-only or bounded and local. No public load or abuse
testing is required to establish the controls documented here.

## Security architecture summary

| Layer | Current defensive invariant |
|---|---|
| Identity | Zoo user ID comes from an authenticated encrypted session |
| Browser mutation | Origin must match configured/forwarded/request origin |
| Input memory | JSON and multipart streams stop at explicit byte ceilings |
| Expensive analysis | Auth first, 6/minute, one in flight per user |
| Zoo calls | Fixed hosts, response ceilings, timeouts, global deadline |
| Recommendations | Deterministic candidates first; copilot output strictly constrained |
| Workspace store | Session-derived tenant, object quotas, 64 MiB serialised ceiling, row lock (Postgres) or serialised atomic replace (JSON) |
| Blob store | Strict key pattern, traversal rejection, filename sanitisation, path containment on the filesystem driver |
| Secrets at rest | Personal Zoo token and OpenAI key sealed with AES-256-GCM; the API reports only `hasZooApiToken` / `hasAiApiKey` |
| AI egress | Only with a user-supplied key, fixed host, 180 s timeout, 2 MiB ceiling |
| Generated HTML | Script/handler stripping, 500 KiB storage cap, sandboxed iframe, JavaScript disabled in the renderer |
| Browser policy | CSP, anti-framing, permission, referrer, MIME, HSTS, and cross-origin headers |
| Runtime | Non-root, capabilities dropped, no host port, CPU/RAM/log bounds; data services on an `internal: true` network |

## Controls strengthened during review

The current source includes the following material controls that must remain
covered by regression tests:

- live authentication before multipart parsing;
- streaming total/body/file limits rather than post-buffer checks;
- strict JSON content type and bounded chunked-body handling;
- same-origin verification on state changes;
- RFQ allowlists and length/numeric constraints;
- file-count, field-count, part-count, signature, and extension checks;
- user-scoped rate limits and live single-flight;
- global Zoo analysis deadline and finite poll count;
- response byte limits for OAuth, profile, projects, metrics, copilot frames,
  glTF conversion, and OpenAI output;
- bounded provider error details;
- machine, folder, report, document, part, drawing, attachment, and store
  quotas;
- validation of parent folder and selected route ownership;
- bounded report title, lifecycle timestamps, IDs, machine costs, and notes;
- absolute session lifetime and tamper rejection;
- sealing of the user's personal Zoo API token and OpenAI key before they reach
  the store, and boolean-only readback;
- blob-key pattern validation, filename sanitisation, and traversal rejection
  on both blob drivers;
- ownership-checked permanent deletion for results, folders, documents, parts,
  drawings, machines, and attachments;
- script/handler stripping and sandboxed-iframe rendering of AI-authored HTML,
  plus JavaScript disabled in the PDF renderer;
- repository-defined CSP and browser hardening headers;
- generic server errors for unexpected analysis failures.

## Residual risk register

| ID | Residual risk | Severity |
|---|---|---|
| SR-01 | Process-local rate, single-flight, and job state | medium |
| SR-02 | Whole-document persistence on the JSON driver | medium (`json`) / low (`postgres`) |
| SR-03 | Native CAD validation depth, and retention of the uploaded bytes | medium |
| SR-04 | Forwarded client identity for the anonymous demo | low |
| SR-05 | Recommendation-text authority | low |
| SR-06 | CSP allowances required by the 3D preview and the edge | low |
| SR-07 | Retention after deletion, and unaccounted blob bytes | low |
| SR-08 | Operational visibility | medium |
| SR-09 | Headless Chromium renders LLM-authored HTML without a sandbox | medium |
| SR-10 | Third-party LLM egress of user content | medium |
| SR-11 | Raw CAD bytes reach the Zoo ML copilot | low-to-medium |
| SR-12 | No blob retention policy or per-user byte accounting | medium |
| SR-13 | Data-layer deployment secrets and the MinIO console | low |

### SR-01 — Process-local rate and concurrency state

**Risk:** medium operational risk in a scaled deployment.

Rate buckets and single-flight keys live in one process
(`apps/web/lib/request-security.ts`), and both background generation flows
de-duplicate through a module-level in-flight set keyed `{userId}:{itemId}`
(`apps/web/lib/report-generation.ts`, `apps/web/lib/drawing-generation.ts`).
Expired buckets are swept and the map is capped at 10,000 identities with
fail-closed admission, but a restart still clears rate state. Multiple replicas
would enforce independent limits and could start the same background job twice.
The Postgres driver already makes the *store* safe under concurrent writers, so
coordination state is the remaining blocker to horizontal scaling.

**Current containment:** the reference stack runs exactly one application
replica (`quoteredy-studio`, 2 GiB / 2.0 CPU) beside three data-layer services
(`quoteredy-db`, `quoteredy-minio`, and the one-shot `quoteredy-minio-init`),
and nothing in the image starts a second application process.

**Recommended action:** move rate limiting, single-flight, and job
de-duplication to shared state (Redis or Postgres advisory locks) before
running more than one replica.

### SR-02 — Whole-document persistence on the JSON driver

**Risk:** medium availability and scalability risk with
`QUOTEREADY_STORAGE_DRIVER=json` (the code default); low with `postgres` (the
Compose default).

With the JSON driver every read parses and every mutation rewrites the complete
multi-user `data/platform.json`, and the 64 MiB `STORE_LIMITS.maximumBytes`
ceiling applies to that shared file. One user can therefore consume a
disproportionate share and increase latency for everyone else before writes are
rejected for everyone.

With the Postgres driver each user is one JSONB document in
`quoteready_workspaces`, taken under `SELECT … FOR UPDATE` inside a transaction
(`packages/storage/src/postgres-driver.ts`), and the same 64 MiB ceiling is
applied to that user's serialised document alone — so it is a real per-user
byte quota for workspace data. It does not cover blob bytes, which are
accounted only by object count (see SR-12).

**Current containment:** bounded RFQ/machine fields, per-user object counts,
memory/CPU limits, atomic temp-file rename (JSON) or transactional commit
(Postgres).

**Recommended action:** treat `json` as a single-user or development driver and
keep `postgres` for anything multi-tenant; add byte accounting for blobs to
close the remaining gap.

### SR-03 — Native CAD validation depth, and retention of the uploaded bytes

**Risk:** low-to-medium parser-boundary risk, plus a retention consequence that
the previous revision of this document described incorrectly.

The upload allowlist (`apps/web/lib/rfq.ts`) is ten extensions mapping to nine
upstream formats:

| Extension | Zoo source format | Positive content check |
|---|---|---|
| `.step`, `.stp` | `step` | `ISO-10303-21` within the first 4 KiB |
| `.ply` | `ply` | leading `ply` |
| `.obj` | `obj` | leading comment or `o`/`g`/`v`/`vt`/`vn`/`f` token |
| `.stl` | `stl` | leading `solid`, or at least 84 bytes (a binary header) |
| `.sldprt` | `sldprt` | none — extension only |
| `.ipt` | `inventor` | none — extension only |
| `.sat` | `acis` | none — extension only |
| `.x_t`, `.x_b` | `parasolid` | none — extension only |

Every format additionally rejects a PDF, PNG, or JPEG signature — the common
"user attached the drawing in the CAD slot" mistake — and rejects a ZIP
signature (`PK\x03\x04`) for all formats except `sldprt` and `ipt`, which are
themselves ZIP containers. The `stl` rule is a length check for binary files
rather than a structural one.

The file is forwarded to Zoo rather than parsed by a local CAD engine, but
malformed data still reaches an external parser, and the four formats accepted
on their extension alone carry the most residual risk.

**Correction to the previous review.** The claim that CAD and drawing bytes are
never written locally is no longer true. `apps/web/lib/artifacts.ts` and
`apps/web/lib/zoo-model.ts` write to the configured blob store — MinIO in the
Compose stack, `<dataDir>/blobs` with the `fs` driver:

| Bytes | Written by | Gated by `QUOTEREADY_PERSIST_UPLOADS` |
|---|---|---|
| glTF preview of the part | `storePartModel()` | no — always written |
| Result attachments (drawing/document uploads) | `storeResultAttachment()` | no — always written |
| CAD attached to an existing part via `POST /api/reports/part` | `storePartCad()` | no — always written |
| The analysed CAD and the uploaded drawing | `archiveReportArtifacts()` | yes (Compose sets `true`) |
| Source CAD of a Zoo-library upload | `archivePartCad()` | yes (Compose sets `true`) |

Key layout:

```text
users/{userId}/parts/{partId}/model.gltf                        glTF preview
users/{userId}/parts/{partId}/source/{fileName}                 archived part CAD
users/{userId}/reports/{reportId}/{fileName}                    analysed CAD + drawing
users/{userId}/reports/{reportId}/attachments/{uuid}/{fileName} result attachments
```

Archival is deliberate: re-runs (`POST /api/reports/rerun`) and drawing-table
generation (`POST /api/drawings`) both read the archived CAD back, and both
answer `409` with guidance when it is absent. The security consequence is that
a malformed or hostile upload is now *retained* until the owning object is
deleted, rather than existing only for the duration of one request.

**Current containment:** extension allowlist, total/per-file limits, fixed Zoo
host, timeouts, blob keys derived only from server-side identifiers with
sanitised segments, no execution path over stored bytes other than the glTF
parser (`apps/web/lib/gltf-mesh.ts`, capped at 250 000 triangles), and blob
delivery only through ownership-checked routes.

**Recommended action:** validate documented magic/container structures for
`sldprt`, `ipt`, `sat`, and Parasolid; maintain malformed synthetic fixtures per
format; and pair the retention with the lifecycle policy described in SR-12.

### SR-04 — Forwarded client identity for anonymous demo

**Risk:** low deployment-dependent rate-limit bypass.

Anonymous demo rate limiting prefers `CF-Connecting-IP`, falls back to the first
`X-Forwarded-For` value, and normalizes the key to address characters.
Correctness still depends on the trusted proxy removing attacker-supplied
forwarded headers.

**Current containment:** the service has no direct host port and is reached
through Traefik.

**Recommended action:** configure trusted-proxy sanitation explicitly or use a
server-derived address supplied by the platform.

### SR-05 — Recommendation-text authority

**Risk:** low integrity risk after current validation.

Free-form RFQ text, attachment captions, and attachment notes enter the copilot
and OpenAI prompts. Route identities, operations, and numeric envelopes are
guarded, but accepted rationale/summary text can still be misleading within
length limits.

**Current containment:** missing requirements stay explicit, IDs and numeric
bounds are validated, arrays normalized, deterministic fallback visible, and
prices and lead times clamped to 0.25×–4× of the deterministic baseline.

**Recommended action:** isolate user text as data, add adversarial instruction
tests, and consider deterministic summary templates for critical statements.

### SR-06 — CSP allowances and edge dependency

**Risk:** low residual browser-hardening risk.

The application defines CSP, anti-framing, cross-origin isolation, permissions,
referrer, HSTS, MIME-sniffing, and legacy frame-denial headers in
`apps/web/next.config.ts`. The policy currently allows more than `'self'` in
five places, each for a stated reason:

| Directive | Allowance | Reason |
|---|---|---|
| `script-src` | `'unsafe-inline'` | Next.js framework compatibility |
| `script-src` | `'wasm-unsafe-eval'` | `<model-viewer>` / three.js instantiate WebAssembly helpers |
| `script-src` | `https://static.cloudflareinsights.com` | edge analytics script |
| `style-src` | `'unsafe-inline'` | framework and inline component styles |
| `img-src`, `worker-src` | `blob:` | `<model-viewer>` renders the part preview from same-origin glTF |
| `connect-src` | `data:` | `THREE.GLTFLoader` fetches the glTF's embedded `data:` buffer |
| `connect-src` | `https://cloudflareinsights.com` | edge analytics beacon |

`'wasm-unsafe-eval'` permits WebAssembly compilation but not JavaScript `eval`;
`blob:` and `data:` are same-document sources. `'unsafe-inline'` in `script-src`
remains the weakest allowance. HSTS effectiveness also depends on the public
HTTPS edge.

**Current containment:** `default-src 'self'`; objects and foreign frames
denied; forms submit only to self; no browser-side Zoo or OpenAI call
exists; the service is reachable only through the managed proxy path.

**Recommended action:** move framework scripts/styles to nonce or hash-based
authorization, verify the analytics allowlist remains necessary, and test the
final headers at the public HTTPS origin on every framework/edge change.

### SR-07 — Retention after deletion, and unaccounted blob bytes

**Risk:** low privacy and retention-management gap. The permanent-deletion
recommendation of the previous review is **implemented**.

Ownership-checked permanent deletion is now exposed by:

| Route | Removes |
|---|---|
| `DELETE /api/reports?scope=trash` | every trashed result and document |
| `DELETE /api/reports?folderId=…&mode=purge` | a folder and its contents |
| `DELETE /api/reports?folderId=…&mode=release` | a folder, releasing its contents |
| `DELETE /api/documents?scope=trash` | every trashed report document |
| `DELETE /api/parts?id=…` | one part record |
| `DELETE /api/drawings?id=…` | one drawing table |
| `DELETE /api/factory?id=…` | one machine profile |
| `DELETE /api/reports/attachments?resultId=…&attachmentId=…` | one attachment |

What remains: archive and trash are still reversible states that occupy their
object quota until the user empties them, and a superseded part is hidden rather
than removed by design, so older results keep resolving their original geometry.
Blob bytes are counted only indirectly, through the object quotas of the records
that reference them (see SR-12).

**Recommended action:** document a retention and backup-expiry policy that
covers both the workspace store and the blob store, and add an explicit
"delete my data" flow that removes the records and their blobs together.

### SR-08 — Operational visibility

**Risk:** medium incident-detection gap for production.

The service has rotated logs and a healthcheck, but `GET /api/health` returns a
static literal — it does not probe the workspace store, the blob store, or Zoo.
There are no metrics for request rejection, rate limits, store size, queue
latency, Zoo or OpenAI latency, fallback frequency, background-job outcomes, or
quota exhaustion. The only user-facing telemetry is the remaining Zoo credit
balance surfaced by `GET /api/zoo/usage` (cached five minutes per user).

**Recommended action:** add structured redacted events and metrics, and turn
`/api/health` into a real readiness probe, before production traffic.

### SR-09 — Headless Chromium renders LLM-authored HTML

**Risk:** medium. This is the widest new attack surface in the current
revision.

`POST /api/documents` stores HTML authored by OpenAI, and
`GET /api/documents/{id}?format=pdf` and `GET /api/drawings/pdf` render HTML to
PDF with `puppeteer-core` against the system Chromium
(`apps/web/lib/pdf.ts`). Because the container runs as uid 1000 with all
capabilities dropped, the Chromium sandbox cannot be used: the browser is
launched with `--no-sandbox --disable-setuid-sandbox`. A Chromium renderer
exploit would therefore run with the application process's privileges rather
than inside a sandboxed child.

**Current containment:**

- `page.setJavaScriptEnabled(false)` before any content is loaded;
- a 30 s `setContent` timeout;
- `<script>` elements, inline event handlers, and `javascript:` URLs stripped in
  `apps/web/lib/report-ai.ts` before the HTML is ever stored;
- the system prompt forbids external resources, and the stored HTML is capped at
  500 KiB (`STORE_LIMITS.documentHtmlMaxBytes`);
- the browser view renders the same HTML in a fully sandboxed iframe
  (`<iframe sandbox="" srcDoc={…}>` in
  `apps/web/components/documents-view.tsx`);
- every directory Chromium writes to is redirected into a private temp profile
  (`--user-data-dir`, `--crash-dumps-dir`, `--disk-cache-dir`, plus `HOME` and
  the `XDG_*` variables);
- the drawing sheet is generated by repository code, not by a model;
- the browser is a process-wide singleton reset on launch failure, which bounds
  process count but means one wedged browser affects both PDF routes;
- the container itself is unprivileged, capability-free, and has no host port,
  so a renderer escape lands in the same restricted namespace.

**Recommended action:** run the renderer in a separate, network-isolated
container or a user-namespaced sandbox; keep Chromium patched through image
rebuilds; and consider rendering from a strict allowlisted subset of HTML rather
than sanitised model output.

### SR-10 — Third-party LLM egress of user content

**Risk:** medium confidentiality consideration, explicitly user-controlled.

`apps/web/lib/report-ai.ts` posts to
`https://api.openai.com/v1/chat/completions` with a 180 s timeout and a 2 MiB
response ceiling. The prompt carries the result title, the source file name,
the complete RFQ metadata, the full analysis JSON
(readiness checks, geometry metrics, questions, assumptions, manufacturing plan,
API trace), and the file names plus captions and notes of any attached material.
Attachment *bytes* are not sent. The call is made with the user's own key,
unsealed from the workspace store at request time.

`aiReports.enabled` defaults to `true` and the default model is `gpt-4o`, but no
request is made unless the user has stored an OpenAI key in Settings, so a
deployment where nobody stores a key never contacts OpenAI.

**Current containment:** fixed host; per-user credential; opt-in by key
presence; the key is sealed at rest and never returned to the browser; the
response is size-bounded and sanitised before storage.

**Recommended action:** state the egress in the Settings UI next to the key
field, allow an operator-level kill switch, and offer a self-hosted or
enterprise endpoint override for deployments that cannot send part data to a
third party.

### SR-11 — Raw CAD bytes reach the Zoo ML copilot

**Risk:** low-to-medium, and a correction to the previous review.

The *pricing* prompt (`packages/core/src/pricing.ts`) is metadata-only: the
copilot receives the RFQ, the measured scalars, the readiness score, the
deterministic candidates, and the workshop memory — never geometry bytes.

The *drawing* prompt is different. `apps/web/lib/drawing-generation.ts` passes
`currentFiles: { [part.fileName]: cadBytes }` to `runCopilotPrompt`, so the
archived CAD file is uploaded to the copilot as a project file so the drafting
agent can inspect the model. Drawing chat is text-only again (no CAD attached).
Any statement that the agent never receives CAD buffers applies to pricing only.

**Current containment:** fixed `wss://api.zoo.dev` host; the user's own Zoo
credential (drawing generation requires the personal API token); the bytes are
the same file the user already uploaded to Zoo's File API for measurement;
per-frame and cumulative response ceilings; a bounded, validated JSON contract
on the way back.

**Recommended action:** keep the distinction visible in the UI — a user should
know that generating a drawing table sends the model to Zoo's copilot, not only
its measurements.

### SR-12 — Blob retention and per-user byte accounting

**Risk:** medium storage-availability and privacy risk.

Blobs have no expiry, no bucket lifecycle rule, and no byte accounting. The
object quotas (250 results, 250 parts, 250 documents, 100 drawings, 20
attachments per result) bound the *number* of referenced blobs but not their
size: a workspace at quota can hold hundreds of 20 MiB CAD files and 10 MiB
drawings. Blob bytes do not count towards the 64 MiB workspace ceiling, which
covers only the JSON/JSONB document.

**Current containment:** per-file upload limits (20 MiB CAD, 10 MiB drawing,
32 MiB multipart total), Traefik request buffering at 32 MiB, object quotas,
`mem_limit`/`cpus` on every service, and blob reads only through
ownership-checked routes.

**Recommended action:** add per-user byte accounting alongside the object
quotas, set a bucket lifecycle rule for report artifacts, and delete the blobs
of a record when the record is permanently deleted.

### SR-13 — Data-layer deployment secrets and the MinIO console

**Risk:** low, contained by the network model.

The Compose stack introduces two new deployment secrets in `.env`:
`DB_QUOTEREADY_PASSWORD` (Postgres) and `QUOTEREADY_MINIO_ROOT_PASSWORD` (MinIO
root, reused by the application as its S3 access key). Compose builds
`QUOTEREADY_DATABASE_URL` and the S3 credentials from them. MinIO also serves
its administrative console on `:9001`, reachable from any container on
`quoteredy_internal`.

**Current containment:** `quoteredy_internal` is declared `internal: true`, so
it has no route to or from the internet; no host port is published for Postgres,
MinIO, or the console; only `quoteredy-studio` joins `proxy_public`; both data
services run as uid 1000 with their state on host bind mounts (`./postgres`,
`./minio`), which `.gitignore` excludes from the repository.

**Recommended action:** replace the root credential with a scoped MinIO service
account for the application, and document rotation for both secrets alongside
the session-secret rotation note below.

## Counterevidence and blast-radius limits

- There is no route that accepts another user's workspace ID; tenancy always
  comes from the sealed session.
- CAD, drawing, glTF, and attachment bytes **are** written to the blob store
  (see SR-03), but only under server-generated keys, and they are readable only
  through ownership-checked routes.
- Provider tokens never reach the browser. The OAuth tokens live in an
  AES-256-GCM sealed `HttpOnly` cookie; the user's personal Zoo API token and
  OpenAI key are sealed with the same envelope and **persisted in the workspace
  store** as `zooApiTokenSealed` / `aiApiKeySealed`
  (`packages/core/src/types.ts`, `apps/web/lib/user-settings.ts`), and the API
  reports only `hasZooApiToken` / `hasAiApiKey` booleans.
- Because both the session cookie and those stored secrets are keyed by
  `QUOTE_READY_SESSION_SECRET`, **rotating that secret invalidates every stored
  user secret, not only every session**: after a rotation each user must paste
  their Zoo API token and OpenAI key again. Plan a rotation accordingly.
- The Projects endpoint is fixed-host and response-bounded.
- Copilot route IDs and operations cannot be invented by a response, and prices
  and lead times cannot leave 0.25×–4× of the deterministic baseline.
- AI-authored HTML never executes: scripts and handlers are stripped at
  generation time, the browser renders it in a sandboxed iframe, and the PDF
  renderer loads it with JavaScript disabled.
- Container runtime is non-root, has no capabilities, no Docker socket, and no
  direct host port; the database and object store have no internet route at all.
- Failed metrics become explicit nulls/traces rather than silently trusted data.

These controls reduce severity; they do not eliminate shared-service
availability, retention, and operational risks.

## Verification required before a production release

- unit tests for every RFQ, JSON, multipart, quota, and copilot boundary;
- integration tests for same-origin rejection and session-derived tenancy;
- concurrent quota/single-flight tests, on both storage drivers;
- malformed file fixtures for each supported format, including the four
  extension-only formats;
- store corruption, oversize, backup, and restore drill for Postgres and for the
  JSON file;
- blob-store drill: ownership rejection, traversal rejection, missing-object
  behaviour, and bucket restore;
- PDF-renderer checks: hostile HTML fixture, Chromium-absent `503`, renderer
  timeout, and temp-profile cleanup;
- browser checks for token absence from responses, storage, and console;
- container inspection for user, capabilities, mounts, networks, and limits
  across all four services;
- dependency audit and container image scan, including the Chromium package;
- automated public-response header assertions plus manual proxy
  forwarded-header review.

## Release verification snapshot

Record the following for each reviewed release. Values are revision-specific,
never permanent guarantees; repeat the whole list after dependency, proxy,
framework, renderer, or policy changes.

| Check | Expected evidence |
|---|---|
| Test suite | `npm test` — 118 tests in 13 files, 117 passing and 1 skipped |
| Quality gate | `npm run check` (typecheck, ESLint zero warnings, tests, `format:check`) and `npm run build` both pass |
| Dependency audit | `npm audit` result recorded |
| Compose | `docker compose config --quiet` passes; all four services reach their expected state, the app reports healthy |
| Origin policy | a foreign `Origin` mutation is rejected with HTTP 403 |
| Headers | CSP and the complete response-header set present at the public HTTPS origin |
| Renderer | both PDF routes produce a document, or `503` where Chromium is absent |
| Browser | desktop and mobile checks without console errors or horizontal overflow; mobile navigation and Escape dismissal pass |

The last complete snapshot was taken on **2026-07-28** and is now historical: it
predates `puppeteer-core` and the Chromium PDF pipeline, the Postgres and S3
drivers, drawing chat, result attachments, re-run revisions, and the
permanent-deletion routes, and its "26/26 tests" figure was superseded by the
current 118-test suite. Treat it as evidence for that revision only, and re-run
the table above before the next release.

## Review conclusion

The current architecture has meaningful protections for its intended
single-replica deployment: authenticated tenant selection, bounded streaming
input, provider deadlines and response caps, a constrained copilot merge,
storage quotas with transactional persistence, sealed secrets at rest,
ownership-checked deletion, a repository-defined browser policy, and runtime
least privilege on a network that gives the data layer no internet route.

The largest remaining risks are structural rather than hidden: process-local
coordination, an unsandboxed Chromium rendering model-authored HTML, egress of
analysis content to a third-party LLM under the user's own key, CAD bytes
uploaded to the drafting copilot, retained upload artifacts with no lifecycle
policy or byte accounting, framework-driven inline CSP allowances, and limited
operational telemetry behind a health endpoint that probes nothing.

Production readiness requires addressing those items and running the complete
[Testing](TESTING.md) and [Operations](OPERATIONS.md) checklists.
