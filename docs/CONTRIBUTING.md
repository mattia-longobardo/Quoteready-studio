# Contributing

## Before changing code

Read the smallest relevant path through:

- [Product](PRODUCT.md) for behavior;
- [Architecture](ARCHITECTURE.md) for ownership;
- [Internal HTTP API](API.md) for route contracts;
- [Data model](DATA_MODEL.md) for persisted shapes;
- [Security](SECURITY.md) for trust boundaries;
- [Security review](SECURITY_REVIEW.md) for the residual risks a change must
  not make worse;
- [Zoo Agent](ZOO_AGENT.md) for the copilot request/validation/merge contract;
- [Code quality](CODE_QUALITY.md) for module ownership and the compiler policy;
- [Design system](DESIGN_SYSTEM.md) for interface patterns;
- [Testing](TESTING.md) for required evidence.

Inspect the current source before following documentation. Source and tests are
authoritative when temporary drift exists, and the documentation must then be
updated in the same contribution.

## Local prerequisites

| Requirement | Needed for | Without it |
|---|---|---|
| Node.js 24+ and npm | everything | — |
| A Zoo OAuth application | signing in at all (every view is gated) | the login button reads "OAuth setup needed" |
| A **personal Zoo API token**, pasted into Settings | Zoo library, CAD upload to Zoo, drawing-table generation, drawing chat | those routes answer `409` asking for the token — an OAuth token gets `403` upstream, see [Zoo API notes](ZOO_API_NOTES.md) |
| An OpenAI API key, pasted into Settings | AI detailed reports | `POST /api/documents` refuses with an actionable message |
| A Chromium or Chrome binary | the two PDF routes | they answer `503`; everything else works |

`apps/web/lib/pdf.ts` probes `PUPPETEER_EXECUTABLE_PATH`, then
`/usr/bin/chromium-browser`, `/usr/bin/chromium`, `/usr/bin/google-chrome`. On
Debian/Ubuntu `apt install chromium` is enough; otherwise set
`PUPPETEER_EXECUTABLE_PATH` to your browser. The container image ships its own
Chromium, so this only affects local development.

## Local setup

```bash
npm ci
cp .env.example .env.local
```

**`.env.example` ships the Compose defaults, which will not start a bare
`npm run dev`.** It sets `QUOTEREADY_STORAGE_DRIVER=postgres` with an empty
password and a commented-out `QUOTEREADY_DATABASE_URL`, so
`packages/storage/src/workspace-store.ts` throws a `StoreConfigurationError` on
the first workspace read; it also sets `QUOTEREADY_BLOB_DRIVER=s3`, which
expects the bundled MinIO. For a zero-dependency local run, edit `.env.local` to
use the code defaults (or delete both lines):

```dotenv
ZOO_OAUTH_CLIENT_ID=your-public-client-id
ZOO_OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/callback
QUOTE_READY_SESSION_SECRET=at-least-32-random-characters
QUOTEREADY_STORAGE_DRIVER=json
QUOTEREADY_BLOB_DRIVER=fs
QUOTEREADY_PERSIST_UPLOADS=true
```

Keep `QUOTEREADY_PERSIST_UPLOADS=true` even locally: re-running an analysis and
generating a drawing table both read the archived CAD file back, and both answer
`409` when it is missing. This mirrors the README's setup section — if the two
ever disagree, the README and `.env.example` are the reference.

```bash
npm run dev          # http://localhost:3000
```

Live integration requires a Zoo OAuth application and the exact local callback
described in [OAuth setup](OAUTH_SETUP.md). Sample mode (**Run sample**) needs
no CAD file, but every view is behind the login gate, so a Zoo session is
still required to reach it.

To develop against Postgres and MinIO instead, bring up the stack described in
[Deployment](DEPLOYMENT.md) and point `QUOTEREADY_DATABASE_URL` and the
`QUOTEREADY_S3_*` variables at it.

## Required checks

Run before requesting review:

```bash
npm run check
npm run build
```

`check` runs typecheck (all three workspaces), ESLint with zero warnings, the
full Vitest suite, and `format:check`, in that order. Do not weaken strict
compiler options or replace a failing test with a looser assertion unless the
product contract intentionally changed and is documented.

`format:check` only covers `apps/web/**/*.{ts,tsx,css}`,
`packages/*/src/**/*.ts`, `packages/*/tests/**/*.ts`, and root-level
`*.{json,mjs}`. **Markdown, everything in `docs/`, `docker-compose.yml`, the
`Dockerfile`, and `.env.example` are not Prettier-checked**, so format
documentation and configuration by hand: ATX headings, tables, fenced code
blocks, prose after every mermaid diagram, and roughly 80-column wrapping.

## Change discipline

- Keep one coherent concern per change.
- Preserve unrelated user or operator configuration.
- Never commit `.env`, `.env.local`, tokens, customer files, `data/` (the JSON
  store, `fs` blobs), or the Compose runtime state in `./postgres/` and
  `./minio/`. All of these are already in `.gitignore`; do not force-add them.
- Keep boundary logic on the server; browser checks are convenience only.
- Prefer pure library functions for manufacturing and audit rules — they belong
  in `packages/core`, which has no web or storage dependency.
- Reuse shared types from `packages/core/src/types.ts`, imported as
  `@quoteredy/core/types`.
- Remove superseded code and styles rather than leaving dormant alternatives.
- Respect the provider split. **Manufacturing recommendations** are owned by the
  Zoo ML copilot plus the deterministic fallback — do not add a second source of
  route or price authority. **Detailed report authoring** is owned by OpenAI,
  gated on a user-supplied key, and never feeds a number back into the plan. A
  change that blurs those two roles needs an explicit product decision.

## Coding conventions

- TypeScript strict mode is mandatory.
- Use the `@/` alias inside `apps/web` only; it resolves to `apps/web`, not to
  the repository root (`@/lib/rfq` → `apps/web/lib/rfq.ts`). Cross-workspace
  imports use `@quoteredy/core` and `@quoteredy/storage`.
- Prefer explicit domain names over abbreviations.
- Validate `unknown` before casting external input.
- Use finite/range checks for numbers.
- Bound strings, arrays, body bytes, response bytes, time, and object counts at
  trust boundaries.
- Keep error messages corrective and free of secrets/internal stack detail.
- Use `async`/`await` for orchestration and explicit fallback branches.
- Preserve immutable deterministic candidates when merging copilot output.
- Read every failed response through `responseMessage()` in
  `apps/web/lib/client-http.ts` rather than parsing the body ad hoc.

## Adding or changing an API route

Answer these questions in code and review:

1. Is the route public, optionally authenticated, or private?
2. Does a state change require same-origin verification?
3. What content types and byte limits apply before parsing?
4. Which fields/IDs are accepted, and what are their bounds?
5. Is tenant identity derived only from the session?
6. What rate/concurrency policy applies?
7. Which upstream requests need host, timeout, response, and schema controls?
8. Which expected failures map to a deliberate status code?
9. Which tests and documentation pages change?

Status codes in use, and what each one means here:

| Code | Meaning |
|---|---|
| `200` | Success |
| `201` | Created — folder, machine, attachment, re-run revision, Zoo draft project |
| `202` | Accepted — a background generation job was started (documents, drawing tables) |
| `400` | Invalid body, field, or query parameter |
| `401` | No valid Zoo session |
| `403` | Origin not accepted |
| `404` | The addressed object does not exist in this workspace |
| `409` | Duplicate part name, single-flight collision, quota reached, wrong item state, or a missing prerequisite (archived CAD, personal Zoo API token) |
| `413` | Body, file, or field size exceeded |
| `415` | Wrong content type, extension, or file signature |
| `429` | Rate limit reached |
| `502` | Bounded upstream provider failure |
| `503` | Dependency unavailable — no Chromium binary, OAuth unconfigured, or rate-identity capacity exhausted |

The complete per-route mapping lives in [API](API.md).

## Changing manufacturing behavior

Deterministic route code is the safety baseline. A new route must define:

- stable route ID and human name;
- ordered operations with process IDs;
- setup and cycle-time assumptions;
- price formula and uncertainty;
- confidence and suitability behavior;
- factory-availability requirements;
- reasons and risks;
- tests for finite ordered ranges and representative inputs;
- copilot contract compatibility.

Do not let the copilot create operations that deterministic code cannot
represent.

## Changing persistence

Any stored-shape change needs:

- a schema-version decision;
- backward-compatible read or explicit migration;
- tenancy and ownership tests;
- quota and serialized-byte analysis;
- atomicity/concurrency analysis;
- verification on **both** drivers — the JSON file and Postgres;
- backup and rollback steps;
- updated [Data model](DATA_MODEL.md) and [Operations](OPERATIONS.md).

Domain rules belong in `WorkspaceStore`
(`packages/storage/src/workspace-store.ts`) so both drivers inherit them; a
driver should only implement `read` and `mutate`.

Never catch a structural parse error and silently replace the store with an
empty workspace.

## Changing stored artifacts

Blob writes go through `apps/web/lib/artifacts.ts` (or
`apps/web/lib/zoo-model.ts` for previews), never through a hand-built key:

- keys are built only from server-side identifiers, each segment sanitised;
- decide explicitly whether the write is unconditional (glTF previews, result
  attachments, CAD attached to an existing part) or gated by
  `QUOTEREADY_PERSIST_UPLOADS` (the analysed CAD and drawing, Zoo-library part
  sources), and say why in the review;
- every read path must verify ownership before returning bytes;
- record the retention consequence in [Security review](SECURITY_REVIEW.md) —
  blobs currently have no expiry or lifecycle rule.

## Interface contributions

- Use existing tokens and component patterns.
- Keep essential prose readable; do not encode critical meaning only in
  compact monospace metadata.
- Use semantic controls and labels.
- Preserve visible `:focus-visible` styling.
- Test keyboard, 200% zoom, mobile drawer, long values, and empty/error states.
- Avoid claims the backend cannot support, especially direct Zoo geometry
  import, drawing interpretation, quote accuracy, or feature recognition beyond
  planar faces, pockets, and pocket arrays.

## Documentation contributions

Update documentation when changing:

- environment variables or callbacks;
- endpoint method, payload, status, limit, rate, or authentication;
- Zoo or OpenAI endpoint or validation behavior;
- domain type or store schema;
- blob key layout or retention behaviour;
- route formula, audit deduction, or material list;
- UI workflow or limitation;
- Compose services, resources, storage, network, hostname, or healthcheck.

Mermaid diagrams require a prose description immediately after the diagram for
readers who cannot render or perceive it.

## Security-sensitive work

- Use synthetic fixtures and local/disposable environments.
- Never test availability against a public service without explicit permission.
- Never print tokens, cookies, complete provider payloads, or customer files.
- Remember that the user's personal Zoo token and OpenAI key are sealed with
  `QUOTE_READY_SESSION_SECRET` and stored in the workspace: rotating that secret
  invalidates them along with every session.
- Keep proof programs bounded and non-destructive.
- Report newly discovered issues privately before documenting exploitation.
