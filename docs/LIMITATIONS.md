# Current limitations

## Why this page exists

QuoteReady Studio is a contest-ready manufacturing decision platform, not a
production quoting, CAD-authoring, or shop-control system. This page separates
implemented capability from planned work so demonstrations and evaluations do
not overstate the evidence.

## Geometry and Zoo library

### Zoo project selection is contextual

The project library lists authenticated Zoo projects and can pre-fill planner
context. It does not download project geometry into the analysis pipeline. A
local CAD file is still required for live volume, surface, centre-of-mass, and
mass measurements.

### Supported formats are not equally inspected locally

The server recognizes STEP/STP, STL, OBJ, PLY, SLDPRT, IPT, SAT, and Parasolid
extensions. STEP, OBJ, PLY, and STL have simple leading-content checks; some
native/binary formats rely more heavily on extension and exclusion checks
before Zoo processing. This is not full format validation.

### Geometry metrics are scalar

The File API workflow measures volume, surface area, centre of mass and material
mass. Those four scalars — plus quantity and a surface-to-volume complexity
proxy derived from them — are the entire geometric input to the readiness audit
and the cost model. They do not establish:

- wall thickness;
- undercuts or tool reach;
- hole, thread or fillet recognition;
- bend lines or flat pattern;
- surface classification;
- topology repair;
- tolerance feasibility.

Route risks call these gaps out as assumptions rather than claiming
feature-level DFM proof.

Separately, the drawing pipeline derives a bounding box and some coarse features
locally from the tessellated glTF mesh, but that analysis feeds only the drawing
sheet — it is not used for pricing or readiness, and it is limited to planar
faces, pockets and pocket arrays. See
[Generated drawing tables and drawing sheets](#generated-drawing-tables-and-drawing-sheets).

## Drawing handling

An optional drawing is limited to PDF, PNG, or JPEG and checked by leading-byte
signature. The application records that a document is present. It does not:

- extract text or dimensions;
- compare drawing revision to CAD;
- reconcile tolerances, datums, threads, finishes, or notes;
- detect contradictory requirements.

A "drawing present" readiness pass means presence and file signature only.

The drawing bytes are not written into the workspace store, but they are not
discarded either: with `QUOTEREADY_PERSIST_UPLOADS=true` — the deployed default —
the analysed drawing is archived in the blob store next to its result, and any
drawing attached to a result afterwards is always stored. Only the blob key is
recorded in the workspace record.

## Generated drawing tables and drawing sheets

The 05 Drawings section asks the Zoo agent to choose datums and tolerances from
the CAD geometry, then projects an ISO A3 sheet from the glTF that Zoo's
conversion API produced. Both halves have real boundaries.

**The table** is a bounded, parsed suggestion — not a controlled engineering
drawing. The agent's choices are not verified against process capability or
inspection equipment, and datums, rows and notes are capped and truncated for
safety (6 / 40 / 10, 200 characters per field). Row IDs are regenerated on every
parse, including each drawing-chat turn, so they are stable only within one
version of the table.

**The sheet** is projected from a *tessellated* mesh, not from B-rep geometry,
which sets hard limits:

- curved edges are polyline approximations, so a "circular" edge is a polygon;
- feature recognition finds planar faces, recessed pockets and linear pocket
  arrays — there is no cylinder fitting, and therefore no hole, bore, thread,
  fillet or diameter recognition, and no diameter or radius dimensions;
- there are no per-feature centre lines or axis marks;
- exactly one section is produced and it is always lettered A;
- the title-block revision field is fixed at `00`; there is no revision history,
  approval signature or drawing-number scheme;
- models above 250 000 triangles are refused rather than simplified;
- a part with no usable archived glTF still produces a sheet, but with the
  reason printed in the drawing area and scale `NTS` in the title block.

An engineer must review the sheet before it reaches a customer or the shop floor.
It is a starting point that removes an hour of drafting, not a released drawing.

When the RFQ supplies no general tolerance or surface finish at intake, the plan
proceeds with the industry defaults `ISO 2768-m` and `As Machined` and records
them as such.

## PDF rendering

Both PDF exports — the A4 detailed report and the A3 drawing sheet — are rendered
server-side by headless Chromium through `puppeteer-core`. Consequences:

- a deployment without a Chromium binary returns `503` from those two routes;
  everything else continues to work, and the HTML view remains available;
- Chromium runs `--no-sandbox`, because the container drops all capabilities and
  runs as an unprivileged user. The compensating controls are that page
  JavaScript is disabled, the input HTML is sanitised upstream, and each browser
  gets a private temporary profile;
- Chromium is a significant part of the container's 2 GiB memory allowance;
- rendering is synchronous and rate-limited to 6 PDFs per minute per user.

## Zoo usage badge

The top-bar "minutes left" figure sums `monthly_api_credits_remaining` and
`stable_api_credits_remaining` from `GET /user/payment/balance`. Zoo bills
API usage in whole minutes, so credits are presented 1:1 as minutes; if Zoo
changes its credit accounting the label may drift from wall-clock minutes.
The value is cached for five minutes and hidden when the balance cannot be
read.

## Manufacturing estimates

All prices and times are indicative planning ranges. They are not supplier
quotes, contractual lead times, schedules, or production commitments.

The deterministic model uses simplified formulas based on:

- selected material benchmark EUR/kg;
- measured or fallback part mass;
- quantity;
- a surface-to-volume complexity proxy;
- fixed setup/cycle assumptions;
- configured or benchmark hourly rates;
- tolerance and finish adjustments.

It does not include every commercial input, including stock availability,
minimum order quantities, tooling purchases, scrap, inspection plans, shift
calendar, queue, supplier margin, freight, tax, currency movement, or regional
pricing.

Zoo Agent is constrained by deterministic route and numeric envelopes, but its
rationale remains a recommendation requiring engineering review.

## Factory model

Machine profiles currently compute with process, material coverage, enabled
state, hourly rate, and setup minutes. Notes are human-readable only. The model
does not calculate from:

- work envelope;
- axis count;
- spindle power/speed;
- tolerance capability;
- tooling inventory;
- operator skills;
- measured historical cycle time;
- maintenance state;
- capacity or schedule.

“Available in factory” means each route operation has a matching enabled
capability. It does not mean the route is scheduled, qualified, or approved.

The interface exposes material coverage when creating a machine, but editing an
existing machine and enable/disable management still need dedicated controls.

## Reports and library

- Server-rendered PDF export exists for detailed reports (A4) and drawing sheets
  (A3), but there is no structured spreadsheet export, signed export, batch
  export, or branded multi-document package.
- Archive and trash are reversible timestamps, not deletion; permanent deletion
  is a separate explicit action (empty the trash, or purge a folder's contents).
- Archived and trashed reports continue to count toward the 250-result quota
  until the trash is emptied.
- Folder hierarchy and report-to-folder assignment exist at the data and API
  layer, but the interface does not expose every filesystem-style operation.
- Selecting a route on a saved result persists it immediately, but there is no
  approval state or selection revision history.
- Re-runs create linked revisions with a `sourceResultId` and a revision number,
  but there is no side-by-side revision comparison view and no immutable release
  or signature.
- Detailed reports depend on an OpenAI key the user supplies. Without one the
  feature is disabled; the model choice is unvalidated beyond a name pattern, so
  an unavailable model surfaces as a generation failure with the provider's
  message.

## Persistence and scaling

The deployed stack stores one row-locked JSONB document per user in Postgres and
its binaries in an S3-compatible bucket. A single-file JSON driver and a
filesystem blob driver remain available and are the code defaults.

What is genuinely solved:

- concurrent writers serialise correctly on the Postgres row lock;
- the 64 MiB ceiling applies per user row on Postgres, so it acts as a per-user
  byte quota there;
- blobs no longer inflate the structured store.

What is not:

- **rate buckets, single-flight keys and background-job in-flight sets are still
  process-local**, so multiple replicas would not share admission control even
  though the database would stay consistent;
- there is no migration framework — the schema is one auto-created table and the
  document shape is normalised defensively on read;
- there is no per-user byte quota on blob storage, and no expiry or lifecycle
  rule, so uploads accumulate until an operator removes them;
- there is no built-in encryption at rest beyond the sealed per-user secrets, and
  no point-in-time restore;
- with the JSON driver, every read parses and every mutation rewrites the whole
  multi-user file, and one large workspace can exhaust the shared 64 MiB ceiling
  for everyone.

The architecture should remain a single replica until the process-local
coordination is replaced.

## Rate limiting and abuse controls

Rate buckets are memory-only fixed-window counters. Expired entries are swept,
the map is capped at 10,000 identities, and capacity exhaustion fails closed;
however, buckets reset on restart, are not shared, and have no durable audit
trail. Anonymous sample identity relies on trusted forwarded-address handling.
Production use needs shared limiting, trusted-proxy configuration, monitoring,
and adaptive abuse controls.

## Authentication and tenancy

Zoo identity scopes the local workspace. There are no organisations, teams,
shared folders, role-based permissions, delegated administrators, or workspace
transfer. A user has one workspace keyed by Zoo user ID.

The 30-day encrypted cookie contains the tokens needed for server-side Zoo
calls. There is no separate server-side session database, device list, or
remote session revocation UI beyond token revocation on logout.

## Provider availability

Zoo geometry metrics may fail independently. Missing volume blocks readiness;
other values remain null with a failure trace. A Zoo agent failure produces a
complete deterministic fallback, but recommendation quality and provider
provenance change. The project list may be unavailable while local upload remains
usable.

There is no offline replacement for live Zoo geometry. Sample mode uses fixed
metrics and is clearly labelled.

Degradation is not uniform, because only some features have a fallback:

| Zoo dependency unavailable | Effect |
|---|---|
| One `/file/*` metric | That value is `null` with a failed trace; the analysis completes |
| All `/file/*` metrics | Readiness is blocked, but the report still renders with its traces |
| `/file/conversion/*/gltf` | No 3D preview and no drawing sheet for that part; the analysis is unaffected |
| ML copilot (pricing) | Deterministic plan with a visible `fallbackReason` |
| ML copilot (drawing table or chat) | **No fallback** — the drawing is recorded as `failed` with its error |
| `/user/projects` | The library is unavailable; local upload still works |
| `/user/payment/balance` | The usage badge disappears silently |

### Personal token dependency

Zoo's third-party OAuth scopes do not cover the File, Projects or ML endpoints,
so several features require the user to paste a **personal Zoo API token** into
Settings. Without one, the library, CAD upload to Zoo, drawing generation and
drawing chat refuse with an actionable message. This is an upstream constraint,
not a design choice; it is documented in
[Zoo API notes](ZOO_API_NOTES.md#auth-1--third-party-oauth-tokens-are-rejected-by-every-interesting-endpoint).

Zoo credits are also finite. When an account exhausts them, geometry and agent
calls begin failing and the product degrades along the table above.

## Interface and accessibility

The UI includes keyboard/focus foundations, responsive breakpoints, a complete
mobile menu, Escape handling, a 12 px visible-text floor, and reduced-motion
rules, but the project does not claim formal accessibility conformance.
Remaining work includes screen-reader interaction testing, automated contrast
checks, robust 200%/400% zoom verification, and broader browser/device coverage.

The interface is English-only. Dates and currency use fixed presentation
choices; there is no locale, currency, or unit-conversion preference system.

## Observability and operations

The health endpoint returns a static literal. It proves the Node process answers
HTTP and nothing else — it does not verify Postgres, the blob store or Zoo
connectivity, so a container can report `healthy` while the database is down.
Logs rotate, but there are no built-in metrics, traces, dashboards, alerts, audit
log, job console, quota dashboard or backup scheduler.

Backup and restore are operator-run procedures across two data stores, and a
corrupt or oversized store fails loudly rather than self-healing or silently
discarding data. Note that backups are secret-bearing: the workspace store
contains each user's sealed Zoo API token and OpenAI key, and rotating
`QUOTE_READY_SESSION_SECRET` permanently destroys them. See
[Operations](OPERATIONS.md).

## Testing boundaries

The automated suite is 118 tests across 13 files (117 run, 1 opt-in live test
skipped). It is strongest where the domain rules live: store invariants,
readiness scoring, deterministic routes, the copilot protocol, drawing-sheet
layout, item naming and result-revision logic.

It does **not** cover:

- any `app/api` route handler end to end — no test imports one, so
  auth-before-body ordering and status mapping are verified manually;
- Chromium PDF rendering, drawing chat, attachments, re-run or OpenAI document
  generation;
- browser end-to-end flows, accessibility or visual regression;
- store recovery from a corrupt or oversized file, and concurrent mutation;
- live Zoo contract behaviour, except through one opt-in test that requires a
  dedicated account and is skipped by default.

Until those are automated, the corresponding manual checks in
[Testing](TESTING.md) are release gates rather than optional work.

## Security boundaries

The browser header set is restrictive, but the content security policy still
permits inline script and style for framework compatibility, one Cloudflare
analytics origin, and the `wasm-unsafe-eval`, `blob:` and `data:` allowances the
3D preview requires. Native CAD signature checks are shallow. Headless Chromium
renders LLM-authored HTML without its sandbox, because the container drops all
capabilities. Detailed reports send analysis content to OpenAI, and drawing-table
generation uploads the raw CAD file to Zoo's ML service. See
[Security](SECURITY.md) and [Security review](SECURITY_REVIEW.md) for the
prioritised residual-risk register.

## What judges should rely on

Judges can rely on:

- repeatable sample output that never claims to be measured;
- real Zoo OAuth, project listing and CAD upload to Zoo;
- real Zoo geometry calls, with per-endpoint provenance visible in the report;
- a real Zoo CAD→glTF conversion behind both the 3D preview and the drawing;
- deterministic five-route comparison with factory-aware rates;
- a constrained Zoo agent recommendation with a visible fallback path;
- agent-chosen datums and tolerances, refinable by chat, exported as a genuine
  ISO A3 sheet;
- linked re-run revisions that never overwrite history;
- traceable report evidence and assumptions;
- containerised deployment and documented controls.

They should not interpret the output as a production quote, a semantic drawing
review, a released engineering drawing, direct Zoo-project geometry import, or
automated manufacturing approval.
