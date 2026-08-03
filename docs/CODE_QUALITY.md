# Code quality

## Quality objectives

The codebase should remain understandable enough that a reviewer can trace one
analysis from browser input to Zoo calls, deterministic rules, validation,
persistence, and UI output without hidden frameworks or duplicated business
logic.

The practical quality goals are:

- strict types at module boundaries;
- deterministic business logic in testable library functions;
- thin route orchestration;
- bounded and explicit external input handling;
- one canonical data model;
- no unused locals or parameters;
- visible failure and fallback behavior;
- documentation updated with every contract change.

## Compiler and build policy

There is **no root `tsconfig.json`**. Each workspace owns one, and all three
enable the same strict set:

| File | Scope |
|---|---|
| `apps/web/tsconfig.json` | Next.js app router, route handlers, web-layer libraries and tests |
| `packages/core/tsconfig.json` | `@quoteredy/core` sources and tests |
| `packages/storage/tsconfig.json` | `@quoteredy/storage` sources and tests |

Shared options:

- `strict`;
- `noUnusedLocals`;
- `noUnusedParameters`;
- `noFallthroughCasesInSwitch`;
- `isolatedModules`;
- `noEmit`;
- `target: ES2022`, `module: esnext`, `moduleResolution: bundler`.

Only `apps/web/tsconfig.json` declares a path alias, and it is **not** a
repository-root alias: `"@/*": ["./*"]` resolves relative to `apps/web`, so
`@/lib/rfq` is `apps/web/lib/rfq.ts`. Cross-workspace imports use the package
names `@quoteredy/core` and `@quoteredy/storage` (subpath exports such as
`@quoteredy/core/types`), which Next.js compiles from source through
`transpilePackages` in `apps/web/next.config.ts`.

`npm run typecheck` runs `tsc --noEmit` in every workspace that defines the
script, so a stale import in `packages/` fails the gate even when the web app
does not use it.

The required quality gate is:

```bash
npm run check
npm run build
```

`check` runs, in order, typecheck → ESLint with zero warnings → the **118-test**
Vitest suite (13 files, 117 executed and 1 opt-in live test skipped) →
`format:check`. Typecheck catches stale imports and unused code; tests protect
deterministic rules, request boundaries, multipart parsing, OAuth, the drawing
sheet, naming, result context, the copilot protocol, and store invariants; the
production build verifies Next.js server/client boundaries and standalone
output.

`format:check` covers `apps/web/**/*.{ts,tsx,css}`, `packages/*/src/**/*.ts`,
`packages/*/tests/**/*.ts`, and root-level `*.{json,mjs}`. Markdown, `docs/`,
`docker-compose.yml`, the `Dockerfile`, and `.env.example` are deliberately
outside Prettier's reach and are formatted by hand.

## Module ownership

### Web layer (`apps/web`)

| Module | Responsibility | Should not own |
|---|---|---|
| `app/(platform)/layout.tsx` | Mounts the authenticated shell | View-specific state |
| `app/(platform)/{page,planner,library,parts,drawings,results,reports,factory,settings}/page.tsx` | One route per view, thin | Domain rules |
| `app/login/page.tsx` | The unauthenticated gate | Workspace reads |
| `components/platform-shell.tsx` | Navigation, session/workspace state, usage badge, mobile drawer | Manufacturing formulas |
| `components/planner.tsx` | RFQ intake and report presentation | Server trust decisions |
| `components/platform-views.tsx` | Overview, library, results, factory views | Direct Zoo tokens |
| `components/{parts,drawings,documents,settings}-view.tsx` | Per-view presentation and actions | Provider calls |
| `components/{result-context,workspace-controls,overwrite-part-dialog}.tsx` | Attachment panel, shared list controls, overwrite confirmation | Persistence rules |
| `app/api/*` | HTTP contract and orchestration | Duplicated pricing formulas |
| `lib/api-auth.ts` | `requireSession()` — a missing/unrefreshable session becomes a clean `401` | Business logic |
| `lib/request-security.ts` | Generic bounded request/response helpers, rate buckets, single-flight | Product-specific RFQ schema |
| `lib/multipart.ts` | Streaming upload boundary | CAD engineering analysis |
| `lib/rfq.ts` | RFQ allowlist, bounds, CAD format detection, signature checks | Persistence |
| `lib/oauth.ts` | PKCE and AES-256-GCM envelope cryptography | Network token exchange |
| `lib/zoo-auth.ts` | OAuth network/session lifecycle | UI state |
| `lib/zoo.ts` | File API metrics adapter and polling | Readiness score |
| `lib/zoo-model.ts` | CAD→glTF conversion and preview archival | Drawing geometry |
| `lib/zoo-projects.ts` | Personal-token resolution, ownership verification, `403` explanation | Token storage |
| `lib/user-settings.ts` | Settings validation and secret sealing/opening | Route responses |
| `lib/artifacts.ts` | Blob key construction and upload archival | Quota rules |
| `lib/gltf-mesh.ts` | glTF/GLB → millimetre triangle mesh | Projection |
| `lib/drawing-features.ts` | Planar faces, pockets, pocket arrays | View layout |
| `lib/drawing-views.ts` | First-angle projection, section, hidden-line removal, scale | Annotation text |
| `lib/drawing-annotations.ts` | ISO 129/1101/5459/6433 SVG primitives | Sheet layout |
| `lib/drawing-sheet.ts` | ISO 5457 A3 sheet, ISO 7200 title block, tables | Geometry |
| `lib/drawing-generation.ts` | Copilot drawing-table and chat prompts, parsing, bounds | HTTP responses |
| `lib/report-ai.ts` | OpenAI request, HTML extraction and sanitisation | Persistence |
| `lib/report-generation.ts` | Background report job lifecycle | Prompt authoring |
| `lib/pdf.ts` | Chromium discovery, launch hardening, HTML→PDF | Document content |
| `lib/documents.ts` | Document → summary projection | Generation |
| `lib/item-naming.ts` | `{part}_NN` and `{part}_{date}` naming rules | Storage |
| `lib/part-names.ts` | Duplicate-name `409` wire contract | Store mutation |
| `lib/result-context.ts` | Folding attachments and notes into RFQ context | Prompt transport |
| `lib/planner-store.ts` | Planner state that survives route changes | Server trust |
| `lib/client-http.ts` | Bounded error message from a response; `401` → `/login` | Business logic |
| `lib/format.ts`, `lib/use-file-drop.ts` | Date/number formatting, drop-zone props | Validation |
| `lib/platform-store.ts` | Thin re-export facade over `@quoteredy/storage` | Store invariants |

### Domain core (`packages/core/src`)

| Module | Responsibility | Should not own |
|---|---|---|
| `types.ts` | Shared domain contracts and defaults | Runtime side effects |
| `audit.ts` | Evidence, deductions, questions, assumptions | HTTP responses |
| `manufacturing.ts` | Deterministic routes, operations, factory matching, baselines | WebSocket parsing |
| `pricing.ts` | Copilot pricing contract, validation, constrained merge, fallback | Store lifecycle |
| `materials.ts` | Material catalogue and densities | Pricing policy |
| `parts.ts` | Part identity, collision, supersede rules | Persistence |
| `user-memory.ts` | Per-user workshop memory distilled from past results | Authoritative requirements |
| `zoo-copilot.ts` | ML copilot websocket protocol: frame reducer, MsgPack replay, reconnect (the only `ws` dependency) | Domain formulas |

### Persistence (`packages/storage/src`)

| Module | Responsibility | Should not own |
|---|---|---|
| `model.ts` | `STORE_LIMITS`, workspace shape validation, quota assertions, the `WorkspaceStoreDriver` interface | Driver I/O |
| `workspace-store.ts` | Every domain mutation, ownership and quota enforcement, env-driven driver factory | Browser filtering |
| `json-driver.ts` | Single-file store, mutation queue, `0600` temp file + atomic rename | Domain rules |
| `postgres-driver.ts` | One JSONB row per user, `SELECT … FOR UPDATE`, schema bootstrap | Domain rules |
| `blob-store.ts` | Blob interface, key pattern, filename sanitisation | Backend specifics |
| `blob-factory.ts` | Env-driven blob driver selection and caching | Key policy |
| `fs-blob-store.ts` | Atomic filesystem writes with containment checks | Domain rules |
| `s3-blob-store.ts` | S3-compatible client (AWS, MinIO, R2, Garage) | Domain rules |

This separation prevents UI or provider behavior from becoming the only source
of manufacturing truth, and lets the domain and persistence invariants be tested
without an HTTP server: 55 of the 118 tests live in the two packages.

## Data and control-flow quality

### Positive characteristics

- The deterministic plan is a pure function of metadata, metrics, and machines.
- Audit scoring is deterministic and preserves evidence source.
- Copilot output is parsed into a narrow contract before merge.
- Geometry failures are data (`null` plus traces), not hidden exceptions.
- Server-derived user IDs isolate workspace selection.
- Multipart handling streams under limits rather than buffering first.
- Store mutation is centralized in `WorkspaceStore`, ordered, quota-checked, and
  either atomic on disk or transactional in Postgres — both drivers share one
  set of domain rules.
- The drawing pipeline is a one-directional chain of pure transformations, so
  each stage is testable from a fixture mesh.
- Background jobs never throw: a failure is persisted as `failed`, so the UI
  always leaves `generating`.
- Shared domain types prevent route/UI shape drift.

### Important invariants to preserve

1. Build deterministic routes before attempting the Zoo copilot.
2. Authenticate live mode before reading multipart input.
3. Apply byte limits while streaming, not only after parsing.
4. Validate ownership inside store mutations, not in the route.
5. Keep report provider/fallback provenance visible.
6. Keep sample evidence labelled as deterministic rather than Zoo-measured.
7. Never write CAD, drawing, or glTF **buffers into the workspace store** — the
   store holds only blob keys. The bytes themselves *are* written to the blob
   store (always for glTF previews and attachments, and by default for the
   analysed CAD and drawing, because `QUOTEREADY_PERSIST_UPLOADS=true` is the
   Compose default). See `apps/web/lib/artifacts.ts`.
8. Never add a route whose operations are not created by deterministic code.
9. Never return a provider token to the browser; stored user secrets are sealed
   with the session secret and reported only as booleans.
10. Keep every generated HTML document sanitised at generation time, not only at
    render time.

## Current maintainability risks

### Large presentation and geometry modules

Five modules carry most of the density:

| Module | Lines | Why it is large |
|---|---:|---|
| `apps/web/components/platform-views.tsx` | 1 566 | Overview, library, results, and factory views in one file |
| `apps/web/lib/drawing-views.ts` | 1 431 | Projection, hidden-line removal, sectioning, scale selection |
| `apps/web/components/drawings-view.tsx` | 777 | Drawing list, generation state, chat, PDF export |
| `apps/web/lib/drawing-features.ts` | 770 | Mesh adjacency, planar faces, pockets, arrays |
| `apps/web/components/planner.tsx` | 734 | RFQ intake plus the full interactive report |

The geometry modules are cohesive — each is one algorithm — and splitting them
would mostly move private helpers around; they are better served by more fixture
tests than by decomposition. `platform-views.tsx` is the genuine outlier: it
holds four unrelated views and should be split by stable responsibility once
interaction tests exist. Suggested boundaries: overview KPIs; project card/list;
result library and lifecycle actions; factory editor/list.

### Route test coverage

No test imports a handler from `apps/web/app/api/`, so route orchestration is
still verified only through the libraries it calls and through the manual matrix
in [Testing](TESTING.md).

Well covered today:

| Area | Tests |
|---|---:|
| Store quotas, ownership, attachments, revisions, folder modes | 22 |
| Drawing sheet layout, projection, annotation placement | 19 |
| Item naming and timezone-dependent titles | 15 |
| Copilot frame reducer, replay decoding, reconnect | 15 |
| Attachment→RFQ context, re-run chains, part resolution | 13 |
| Origin, bounded readers, rate windows, single-flight, RFQ validation | 7 |
| Deterministic routes, factory matching, agent payload validation | 6 |
| OAuth PKCE, cookie seal/open, tamper rejection | 5 |
| Readiness scoring, workshop memory, multipart, part names | 15 |

The newest untested surfaces, in priority order:

1. Chromium PDF rendering — Chromium-absent `503`, renderer timeout, hostile
   HTML fixture;
2. drawing chat — single-flight, token requirement, table replacement;
3. result attachments — quota, blob write failure, ownership on download;
4. re-run — missing archived CAD `409`, revision lineage, carried attachments;
5. OpenAI document generation — sanitisation, size cap, `failed` persistence;
6. exact stream boundaries, rate-window edges, single-flight release, and status
   mapping at the route level.

These encode security and availability contracts, which is why they outrank
cosmetic refactors.

### Resolved debt (kept here so it is not re-reported)

- **Global stylesheet density.** `apps/web/app/globals.css` is now 4 481 lines,
  Prettier-formatted with one declaration per line, and inside the `format`
  glob. It is reviewable as a diff; no formatting-only pass is pending.
- **Persistence coupling.** The `WorkspaceStoreDriver` interface in
  `packages/storage/src/model.ts` separates domain mutations from the
  implementation, with a JSON and a Postgres driver behind it; Postgres is the
  Compose default.
- **Ad hoc browser error handling.** `apps/web/lib/client-http.ts` centralises
  it: `responseMessage()` reads a bounded `error`/`detail` pair, and a `401`
  redirects to `/login` instead of surfacing a confusing message.

### Known residue from removed features

The CAD→KCL experiment was removed, but two traces were kept deliberately and
should not be "fixed" by accident:

- `StoredPart.kclCode`, `kclStatus`, `kclError`, `kclSource`, and `kclCheckedAt`
  in `packages/core/src/types.ts` are marked `@deprecated` and retained so
  workspaces written by an older revision still validate. Remove them only with
  a store-version migration.
- The `kcl-chip` CSS class in `apps/web/app/globals.css` is still used as a
  generic status chip by `apps/web/components/drawings-view.tsx` and
  `documents-view.tsx`. The styling is live; only the name is stale. Rename the
  class and its five call sites together, or not at all.

## Unused-code policy

- Do not suppress `noUnusedLocals` or `noUnusedParameters` to keep speculative
  code.
- Remove superseded components, aliases, props, styles, and documentation in
  the same change.
- Search for each renamed view/type/route before and after refactoring.
- Keep no **unused** provider configuration or unreachable settings path. Two
  provider integrations are shipped and reachable, and both are configured from
  the Settings view: the OpenAI detailed-report generator (enable flag plus
  model name, default `gpt-4o`, gated on a user-supplied key) and the personal
  Zoo API token used for the Projects, upload, and copilot calls. A third
  provider, or a settings field nothing reads, is what this rule forbids.
- A future feature belongs in [Roadmap](ROADMAP.md), not an unreachable branch.

Useful checks:

```bash
rg -n "OldName|removed-route|unused-class" \
  apps/web/{app,components,lib,tests} packages/*/src packages/*/tests docs
npm run typecheck
npm run build
```

There is no `app/`, `components/`, or `lib/` at the repository root; every
source path is inside `apps/web/` or `packages/*/`.

## Review checklist by change type

### Domain-rule change

- update the canonical library function in `packages/core/src/`;
- add boundary and representative unit tests;
- update report/data documentation;
- verify deterministic ranges remain ordered and finite;
- verify no missing requirement becomes silently authoritative.

### API change

- define authentication and origin behavior;
- bound request and response bytes;
- validate content type and object shape;
- map expected errors to deliberate status codes;
- update [API](API.md), [Security review](SECURITY_REVIEW.md), and tests.

### UI change

- preserve keyboard and focus behavior;
- render loading, empty, success, fallback, and error states;
- route every failed request through `responseMessage()`;
- check both sides of the 1180, 900, 760, and 430 px breakpoints;
- update design-system patterns and manual tests;
- ensure visible claims match implemented behavior.

### Persistence change

- preserve session-derived tenancy;
- check ownership and quota inside the `WorkspaceStore` mutation, so both
  drivers inherit it;
- verify the change on the JSON **and** the Postgres driver;
- test concurrency and failure before commit;
- document migration, backup, rollback, and compatibility;
- never silently discard an unknown schema.

### Blob or artifact change

- derive every key from server-side identifiers through
  `apps/web/lib/artifacts.ts`;
- keep the key pattern and traversal checks in
  `packages/storage/src/blob-store.ts` authoritative;
- decide explicitly whether the write is gated by `QUOTEREADY_PERSIST_UPLOADS`
  or unconditional, and say why;
- verify the read path is ownership-checked;
- state the retention consequence in [Security review](SECURITY_REVIEW.md).

### Zoo integration change

- keep fixed outbound hosts;
- add timeout and byte ceiling;
- validate payload shape and numeric ranges;
- preserve partial failure/fallback provenance;
- state whether the prompt carries CAD bytes or metadata only;
- update [Zoo Agent](ZOO_AGENT.md), [Zoo API notes](ZOO_API_NOTES.md), and
  synthetic fixtures.

### AI-authored content change

- sanitise at generation time, before storage;
- keep the stored size cap;
- keep JavaScript disabled in the renderer and the iframe fully sandboxed;
- confirm the failure path persists `failed` rather than throwing.

## Definition of done

A change is done only when:

- typecheck, tests, and production build pass;
- affected behavior has automated or documented manual coverage;
- no unused code or stale references remain;
- API/data/security limits are synchronized across code and docs;
- the interface accurately names measured, declared, deterministic, and AI data;
- deployment and rollback consequences are documented;
- limitations are updated instead of hidden.
