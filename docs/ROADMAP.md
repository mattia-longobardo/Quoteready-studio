# Product and engineering roadmap

## Roadmap principles

1. **Evidence before confidence.** New claims require measurable or declared
   evidence and visible provenance.
2. **Deterministic safety floor.** The Zoo copilot may enrich a decision but
   must not remove bounded validation and fallback.
3. **Manufacturing usefulness.** Prioritize information that changes process,
   risk, cost, lead time, or the next engineering question.
4. **No hidden automation.** Users must see assumptions, missing inputs, and
   provider/fallback state.
5. **Production foundations before scale.** Shared persistence, coordination,
   observability, and access control precede multiple replicas.
6. **Accessible by default.** New views must meet the design-system keyboard,
   focus, contrast, responsive, and content rules.

The phases are ordered by dependency and risk, not by promised date.

## Status markers

Every work item carries one of three markers. A capability may be marked
**Shipped** only when source, tests, user-visible behavior, operations,
limitations, and documentation agree; anything less is **Partial**, with the
missing half stated.

| Marker | Meaning |
|---|---|
| **Shipped** | Implemented, reachable in the product, and documented |
| **Partial** | Some of the outcome is delivered; the rest is named explicitly |
| **Open** | Not started, or prototyped without a user-visible path |

## Delivered since the first revision of this roadmap

The following items moved out of the future sections. They are listed here so
the phase text below stays readable and so nothing delivered is still described
as planned.

| Capability | Where it lives | Was |
|---|---|---|
| Server-side ISO A3 technical drawing sheet — first-angle orthographic views, section A-A, ISO 129 dimensions, ISO 5459 datum indicators, ISO 1101 GD&T frames, ISO 6433 balloons cross-referenced to the dimension table, ISO 7200 title block | `apps/web/lib/gltf-mesh.ts` → `drawing-features.ts` → `drawing-views.ts` → `drawing-annotations.ts` → `drawing-sheet.ts` → `GET /api/drawings/pdf` | Phase 2 / Phase 6 |
| Agent-chosen datum reference frame and tolerance rows, bounded (≤ 6 datums, ≤ 40 rows) | `POST /api/drawings`, `apps/web/lib/drawing-generation.ts` | Phase 2 |
| Conversational editing of the drawing table | `POST /api/drawings/chat` | new |
| Transactional database persistence, one row-locked JSONB document per user | `packages/storage/src/postgres-driver.ts` (Compose default) | Phase 5 |
| Object storage for uploaded and generated artifacts | `packages/storage/src/{s3,fs}-blob-store.ts`, gated by `QUOTEREADY_PERSIST_UPLOADS` | Phase 5 |
| Per-user byte ceiling — 64 MiB per user document on Postgres | `STORE_LIMITS.maximumBytes` applied per row | Phase 5 |
| Permanent deletion with ownership checks | `DELETE /api/reports?scope=trash`, `DELETE /api/reports?folderId=…&mode=purge\|release`, `DELETE /api/documents?scope=trash`, `DELETE /api/{parts,drawings,factory}?id=…`, `DELETE /api/reports/attachments` | Phase 5 |
| Server-created PDF export — A4 report documents and A3 drawing sheets, rendered by headless Chromium | `apps/web/lib/pdf.ts` | Phase 6 |
| Revision lineage — re-run a result as a new linked revision (`sourceResultId`, `revision`), history never overwritten | `POST /api/reports/rerun` | Phase 6 |
| Reviewer material on a result — attachments (20 per result) and 4 000-character notes, folded into every downstream prompt | `/api/reports/attachments`, `apps/web/lib/result-context.ts` | Phase 6 |
| Remaining Zoo credits surfaced in the UI, cached five minutes per user | `GET /api/zoo/usage` | Phase 7 |

What each of these still lacks is recorded in the phase it came from.

## Phase 0 — Contest release hardening

### Outcome

A judge or contributor can deploy the submitted revision, reproduce sample and
live paths, understand the result, and verify its safety boundaries.

### Work

- **Open** — complete route-level tests for authentication-before-body, rate
  limits, same-origin rejection, status mapping, and persistence outcomes; no
  test imports a handler from `apps/web/app/api/` yet;
- **Open** — browser coverage for sample, OAuth-mocked private views, live
  upload, route comparison, report history, mobile drawer, and keyboard
  navigation;
- **Open** — automated contrast and common accessibility checks;
- **Partial** — synthetic fixtures: the drawing pipeline has a deterministic
  mesh fixture (`apps/web/tests/fixtures/slotted-block.ts`) and the copilot
  tests replay recorded frames, but there is no malformed-file fixture per CAD
  format and no recorded Zoo File API corpus;
- **Shipped** — documentation commands verified on a clean checkout; the README
  setup, the `.env.local` minimum, and the Compose procedure agree;
- **Open** — audit bundle size, loading states, small text, overflow, and 200%
  zoom;
- **Partial** — persisted route selection: the selection is applied
  optimistically and a failed `PATCH /api/reports` renders the server message
  (`apps/web/components/planner.tsx`), but there is still no pending indicator,
  no saved confirmation, and no retry action;
- **Partial** — machine and folder surfaces: folder create, purge, and release
  are all exposed, and the machine editor covers name, capability, hourly rate,
  setup minutes, supported materials, and notes — but `MachineProfile.enabled`
  has no toggle in the UI, so a machine can only be created enabled or deleted;
- **Partial** — release evidence: the quality-gate output is reproducible with
  `npm run check`, and the demo script is written
  ([Demo](DEMO.md)); screenshots and the recorded walkthrough are still to be
  captured into `contest/`.

### Exit criteria

- `npm run check` and `npm run build` pass from a clean install;
- primary desktop and narrow workflows pass the manual matrix;
- sample and live scripts complete from the public deployment;
- no critical/high security issue remains open;
- every public limitation is consistent across UI and documentation.

## Phase 1 — Deeper design-for-manufacture evidence

**Status: Open**, with a partial foundation.

### Outcome

Route suggestions are driven by feature-level geometry constraints rather than
only scalar volume/surface/mass proxies.

### What already exists

The drawing pipeline derives real geometry from the Zoo glTF conversion: a
welded triangle mesh with a bounding box (`apps/web/lib/gltf-mesh.ts`), and
connected planar faces, recessed pockets/slots, and linear pocket arrays
(`apps/web/lib/drawing-features.ts`). None of it currently reaches route
selection, readiness scoring, or the price model — it feeds the drawing sheet
only. Wiring these signals into the audit is the cheapest first step of this
phase.

### Work

- **Open** — bounding-box dimensions and stock-envelope checks in the audit;
- **Open** — wall-thickness and minimum-feature analysis;
- **Open** — hole, thread, pocket, undercut, and surface recognition (the mesh
  code fits no cylinders today, so there is no hole, bore, thread, fillet, or
  diameter recognition);
- **Open** — tool-access and setup-direction reasoning;
- **Open** — sheet thickness, bend-line, radius, and flat-pattern checks;
- **Open** — additive overhang, support, orientation, and build-envelope checks;
- **Open** — topology/solid validity and repair guidance;
- **Open** — per-check metric precision, units, method, and Zoo operation
  provenance;
- **Open** — route-specific DFM checks that can block only the affected
  candidate.

### Dependency

Requires stable Zoo geometry/feature contracts or an explicitly versioned local
analysis layer. Scalar estimates remain available as a fallback but must not be
mislabeled as feature evidence.

## Phase 2 — Drawing and requirement reconciliation

**Status: Partial.** The product now *produces* a drawing; it still does not
*read* one.

### Outcome

The optional uploaded drawing becomes verified manufacturing evidence rather
than a presence flag.

### Delivered

- **Shipped** — a real ISO A3 sheet is generated from the part geometry, with
  the datum frame and the dimensional/geometric tolerance rows chosen by the Zoo
  copilot and rendered as ISO 5459 indicators, ISO 1101 feature control frames,
  ISO 129 dimensions, and ISO 6433 balloons whose numbers are the inspection
  table's row numbers;
- **Shipped** — the generated table is reviewable and editable in natural
  language through drawing chat, and exported as a PDF;
- **Shipped** — the sheet degrades visibly: a part with no usable glTF still
  produces a sheet, with the reason printed in the drawing area and `NTS` in the
  title block.

### Still open

- **Open** — extract dimensions, tolerances, datums, GD&T, threads, finishes,
  and notes from an *uploaded* drawing (today it is checked for file signature
  and presence only);
- **Open** — identify drawing revision and compare it with the selected
  CAD/project revision;
- **Open** — normalize units and tolerance expressions;
- **Open** — detect contradictory or missing requirements;
- **Open** — map drawing annotations to geometry features where evidence
  permits;
- **Open** — allow a reviewer to accept, reject, or correct extracted
  requirements;
- **Open** — retain a signed evidence digest of the source bytes;
- **Open** — extend the report with requirement-level provenance and review
  state;
- **Open** — validate the generated tolerances against process capability and
  gauging, and drive them from fitted features rather than a tessellated
  approximation.

### Safety rule

No extracted requirement affects price/readiness silently. The user must see the
source, confidence, normalization, and any conflict. The same rule already
governs the generated table: it is labelled a proposal, not a released drawing.

## Phase 3 — Direct Zoo project workflow

**Status: Open.**

### Outcome

A user can select an authorized Zoo project and revision, then run geometry
analysis without manually downloading and re-uploading the same file.

Today the library lists up to 50 projects and can push a local CAD file to Zoo
as a new draft project, but selecting a project only pre-fills planner context;
a live analysis still requires a local upload.

### Work

- **Open** — list project revisions with stable identifiers and timestamps;
- **Open** — select the exact geometry asset and format;
- **Open** — request analysis through an authorized project/file handoff;
- **Open** — preserve project, revision, operation, and unit provenance in the
  report;
- **Open** — detect a changed project revision before rerunning or reopening a
  report;
- **Open** — allow deliberate local-file override without losing source clarity;
- **Open** — cache only safe metadata and respect Zoo authorization/revocation.

This phase depends on a supported Zoo project-to-file contract. Until then,
project selection remains contextual and local upload remains explicit.

## Phase 4 — Calibrated quoting model

**Status: Open.**

### Outcome

Indicative estimates become explainable shop-specific planning ranges with
measured calibration and uncertainty.

### Work

- **Open** — machine envelope, axes, spindle, tolerance, tooling, and material
  constraints (the factory model is process, materials, hourly rate, and setup
  minutes only);
- **Open** — stock form/size, utilization, scrap, and minimum-order modeling;
- **Open** — operation setup count, batch strategy, inspection, deburr, and
  finishing;
- **Open** — shift calendars, queue/capacity, maintenance, and subcontract lead
  time;
- **Open** — currency, region, freight, tax, margin, and validity period;
- **Open** — dynamic geo-based pricing: convert and localize estimates into the
  user's preferred currency (already selectable in Settings) with dated FX rates
  and region-specific rate cards — today every calculation stays in EUR at the
  server's hosting region;
- **Partial** — historical estimate capture: per-user workshop memory
  (`packages/core/src/user-memory.ts`) already distils previously selected
  routes, frequent materials, and typical quantities into a bounded tie-breaking
  signal for the copilot. Estimate-versus-actual capture, controlled
  anonymization, and any influence on the deterministic baseline are open;
- **Open** — versioned deterministic formulas and calibration datasets;
- **Open** — uncertainty decomposition by missing input rather than one
  confidence number;
- **Open** — explicit estimate approval and supplier quotation handoff.

### Safety rule

Historical data cannot widen copilot permissions. Route identity and commercial
bounds remain enforced by deterministic/versioned policy — today, prices and
lead times outside 0.25×–4× of the baseline are rejected.

## Phase 5 — Production data and collaboration foundation

**Status: Partial.** The persistence half is delivered; the collaboration and
operations half is not.

### Outcome

The platform supports teams, durable history, controlled retention, and safe
horizontal scaling.

### Delivered

- **Shipped** — transactional database persistence: one JSONB document per user
  in `quoteready_workspaces`, read and written under `SELECT … FOR UPDATE` in a
  transaction, schema auto-created
  (`packages/storage/src/postgres-driver.ts`, the Compose default). Domain rules
  live above the driver in `WorkspaceStore`, so the JSON driver stays behaviour-
  compatible;
- **Shipped** — object storage: an S3-compatible driver (MinIO in the stack,
  also AWS/R2/Garage) and a filesystem driver, both with strict key patterns and
  traversal rejection;
- **Shipped** — per-tenant object quotas (250 results, 250 documents, 250 parts,
  100 drawings, 200 folders, 100 machines, 20 attachments per result) and a
  64 MiB per-user serialised-document ceiling;
- **Shipped** — permanent deletion with ownership checks for results, folders,
  documents, parts, drawings, machines, and attachments;
- **Shipped** — immutable report revisions: a re-run writes a *new* result
  carrying `sourceResultId` and `revision`, so history is never overwritten.

### Still open

- **Open** — migrations as versioned artifacts, plus constraints and indexed
  queries beyond the single-user-key lookup;
- **Open** — lifecycle rules and per-user **byte** accounting for blobs; object
  quotas bound the count, not the size, and archived/trashed items still occupy
  their quota;
- **Open** — shared rate limiting, distributed single-flight/jobs, and
  idempotency keys; rate buckets, single-flight keys, and the background-job
  in-flight sets are still process-local, which is the last blocker to running a
  second replica;
- **Open** — organisations, roles, projects, shared folders, and least-privilege
  access; the Zoo account is still the only tenant boundary;
- **Open** — signatures, approvals, and audit events on a revision;
- **Open** — retention policy documentation and administrator visibility;
- **Open** — encrypted backups, tested point-in-time recovery, and restore
  drills across the workspace store *and* the blob store;
- **Open** — session/device management and remote revocation;
- **Open** — data export and account deletion workflows that remove records and
  their blobs together;
- **Open** — multi-replica health/readiness checks.

### Migration approach

Add an explicit store-version migration and import verifier. Preserve report
IDs, folder parent relationships, selected route IDs, blob keys, and
provenance. Never silently discard invalid records — including the deprecated
`kcl*` fields on `StoredPart`, which are retained deliberately so older
workspaces still validate.

## Phase 6 — Reports and manufacturing handoff

**Status: Partial.**

### Outcome

Reports become controlled artifacts that can move from early engineering review
to internal approval and supplier discussion.

### Delivered

- **Shipped** — AI-authored detailed HTML reports with inline SVG illustrations,
  generated in the background under the user's own OpenAI key, and a
  server-rendered A4 PDF of the same document;
- **Shipped** — server-rendered A3 PDF of the technical drawing sheet;
- **Shipped** — revision lineage: `POST /api/reports/rerun` stores a new linked
  result with `sourceResultId` and `revision`, keeping the source's folder,
  tags, and attachments;
- **Shipped** — reviewer material on a result: up to 20 attachments and a
  4 000-character note per attachment, folded into the RFQ context so the
  re-run, the pricing prompt, and the AI report all reason on it.

### Still open

- **Open** — structured spreadsheet export;
- **Open** — machine-readable report schema with versioning;
- **Open** — side-by-side revision comparison and change summary in the UI; the
  lineage is stored, but nothing renders two revisions together;
- **Open** — reviewer assignments and approval gates; attachments and notes are
  the only collaboration primitives today;
- **Open** — supplier-ready RFQ package with deliberate attachment selection;
- **Open** — estimate validity, currency, terms, and disclaimer controls;
- **Open** — webhook/event integration for approved report states;
- **Open** — redaction profiles for internal versus external sharing;
- **Open** — export checksum and signature verification.

## Phase 7 — Operational excellence

**Status: Open**, with one delivered probe.

### Outcome

Operators can detect, diagnose, and recover failures before users lose trust.

### Work

- **Open** — a real readiness endpoint covering the workspace store, the blob
  store, and an optional Zoo probe; `GET /api/health` currently returns a static
  literal and passes even when Postgres is unreachable;
- **Partial** — dependency visibility: remaining Zoo credits are exposed through
  `GET /api/zoo/usage` (five-minute per-user cache) and shown in the top bar.
  No other dependency has a surfaced signal;
- **Open** — request/job metrics by outcome without sensitive payloads;
- **Open** — traces linking upload, Zoo operations, audit, planning, rendering,
  and persistence;
- **Open** — structured sanitized logs and correlation IDs;
- **Open** — latency/error/quota dashboards and actionable alerts;
- **Open** — dependency availability and deadline budgets;
- **Open** — backup automation, restore rehearsal, and retention reports for
  both the database and the object store;
- **Open** — capacity tests for upload concurrency, PDF rendering, and store
  migration;
- **Open** — incident runbooks with recovery-time/recovery-point objectives;
- **Open** — dependency and container-image vulnerability monitoring, including
  the Chromium package shipped in the runtime image.

## Candidate outcome metrics

Measure product usefulness without treating a high readiness score as success:

| Metric | Why it matters |
|---|---|
| Time from CAD intake to first report | Workflow speed |
| Reports that expose at least one actionable missing input | Evidence quality |
| Route alternatives reviewed before selection | Decision breadth |
| Factory route coverage rate | Capability-data completeness |
| Estimate range versus approved supplier outcome | Calibration quality |
| Fallback completion rate | Resilience |
| Zoo metric operation success/partial/failure rate | Integration health |
| Drawing tables accepted without a chat correction | Drafting quality |
| Results re-run at least once | Iteration value |
| Reports reopened or exported | Persistent value |
| Accessibility task completion | Inclusive usability |
| Restore drill success and duration | Operational readiness |

Metrics must avoid storing CAD/drawing contents or secret-bearing request data.

## Explicitly deferred ideas

The following are attractive but should not outrank evidence and production
foundations:

- public supplier marketplace;
- automatic purchasing;
- automatic production scheduling;
- unattended manufacturing approval;
- arbitrary user-authored pricing formulas without validation;
- multi-provider route generation that bypasses the copilot/deterministic
  bounds.

These expand liability, data sensitivity, and access-control requirements.

### Reversed decision — storing uploaded source files

Storing every uploaded source file by default used to be on this list. It is now
the deployed default: `docker-compose.yml` sets
`QUOTEREADY_PERSIST_UPLOADS=true`.

**Why the decision changed.** Two features that judges and users asked for both
require the original bytes after the request that produced them has ended.
Re-running a result (`POST /api/reports/rerun`) re-measures and re-prices the
same CAD file, and drawing-table generation (`POST /api/drawings`) sends the CAD
to the Zoo copilot minutes or days after the upload. Asking the user to
re-upload the identical file for each of these was worse for both usability and
consistency — the re-run would no longer be provably the *same* geometry.

**What guards it.**

- The archival of the analysed CAD and drawing remains an explicit opt-in flag,
  so a deployment can turn it off and lose only re-run and drawing generation.
- Keys are built only from server-side identifiers with every segment sanitised:
  `users/{userId}/parts/{partId}/source/{fileName}` and
  `users/{userId}/reports/{reportId}/{fileName}`.
- Bytes are readable only through ownership-checked routes; there is no public
  or guessable blob URL.
- The object store has no route to the internet (`quoteredy_internal` is
  declared `internal: true`) and no published host port.
- Permanent deletion of the owning record is available through the `DELETE`
  routes listed above.

**What is still missing**, and is tracked in Phase 5 and in
[Security review](SECURITY_REVIEW.md) SR-12: blobs have no expiry, no bucket
lifecycle rule, and no per-user byte accounting, and deleting a record does not
yet delete its blobs.

## How to update this roadmap

For each proposed item, record:

1. user problem and evidence;
2. affected trust boundary and retained data;
3. deterministic invariants;
4. Zoo API dependency and fallback;
5. security/access-control impact;
6. test strategy and observable exit criteria;
7. documentation and migration changes.

Mark a capability **Shipped** only after source, tests, user-visible behavior,
operations, limitations, and documentation agree. When only part of an outcome
lands, mark it **Partial** and name the remainder — an item silently left in a
future phase understates the product, and one marked shipped too early
overstates it.
