# Internal HTTP API

## Scope and conventions

These 23 route handlers are the server-side contract consumed by the QuoteReady
Studio browser interface. They are not a separately versioned public developer
API. All examples assume the application origin is in `BASE_URL`.

- Success and error payloads are JSON, except OAuth redirects and binary
  responses (PDF, glTF, attachment downloads).
- Every state-changing route verifies the `Origin` header
  (`assertSameOrigin`, `403` on mismatch).
- Private routes derive the user ID from the encrypted Zoo session cookie. The
  server never accepts a user or workspace ID from a request body.
- JSON request bodies must be objects and must declare
  `Content-Type: application/json` (`415` otherwise).
- Timestamps are ISO 8601 strings. Money is numeric EUR, never a formatted
  string.
- Unknown RFQ metadata fields are rejected rather than ignored.
- Rate limits are keyed per Zoo user (per route family) and are process-local.

Typical error body:

```json
{ "error": "The request body exceeds the permitted size." }
```

Provider failures may add a bounded `detail` field. The duplicate-part-name
response adds `code` and `conflict` — see
[Part-name conflicts](#part-name-conflicts). Credentials and tokens are never
included in any response.

## Limits at a glance

### Request bodies

| Boundary | Limit |
|---|---:|
| JSON body, default | 32 KiB |
| JSON body — `POST /api/analyze?mode=demo`, `POST /api/documents`, `POST /api/drawings`, `POST /api/drawings/chat`, `PATCH /api/parts`, `POST /api/reports/rerun` | 16 KiB |
| Complete multipart request | 32 MiB |
| `cadFile` part | 20 MiB |
| `drawing` part | 10 MiB |
| Multipart files / fields / total parts | 2 / 12 / 14 |
| Multipart field name / field value | 64 bytes / 4 KiB |

### Rate limits (per Zoo user, 60-second fixed window)

| Key | Limit | Routes |
|---|---:|---|
| `demo` | 10 | `POST /api/analyze?mode=demo` (falls back to a normalised client address when anonymous) |
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

Single-flight (one in-process execution per key, `409` otherwise):
`analysis:{userId}` — shared by `POST /api/analyze` and
`POST /api/reports/rerun`; `report-doc:{userId}`; `drawings:{userId}`;
`drawing-chat:{userId}:{drawingId}`.

Plain read routes (`/api/platform`, the `GET` list routes, `/api/settings`,
`/api/zoo/projects`, `/api/zoo/usage`, `/api/parts/model`) are not rate-limited.

### Upstream response ceilings

| Upstream | Ceiling |
|---|---:|
| Zoo file operation (`/file/*`, `/async/operations/*`) | 128 KiB |
| Zoo CAD→glTF conversion | 48 MiB |
| Zoo project list | 512 KiB |
| Zoo project creation | 256 KiB |
| Zoo `/user` profile, `/user/payment/balance` | 256 KiB |
| Zoo OAuth token response | 64 KiB |
| Zoo copilot websocket — per frame / cumulative text | 16 MiB / 256 KiB |
| OpenAI chat completion (detailed reports) | 2 MiB |

### Storage quotas (per workspace)

| Object | Limit |
|---|---:|
| Analysis results | 250 |
| Report documents | 250 |
| Parts | 250 (rolling — the oldest non-analysing part is evicted) |
| Drawing tables | 100 |
| Folders | 200 |
| Machines | 100 |
| Attachments per result | 20 |
| Attachment note text | 4 000 characters |
| Report-document HTML | 500 KiB |
| Complete workspace store | 64 MiB |

Rate and concurrency controls are in-memory and process-local. Expired buckets
are swept periodically, the process keeps at most 10 000 rate identities, and a
new identity receives `503` when a full map has nothing to reclaim. These
controls suit the single-container deployment, not a multi-replica service.

## Route summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | — | Liveness response |
| `GET` | `/api/auth/login` | — | Start Zoo OAuth with PKCE |
| `GET` | `/api/auth/callback` | OAuth transaction | Validate the callback and establish a session |
| `GET` | `/api/auth/session` | optional | Public session summary |
| `POST` | `/api/auth/logout` | optional, same origin | Revoke tokens and clear the cookie |
| `POST` | `/api/analyze?mode=demo` | optional, same origin | Fixed-geometry sample analysis |
| `POST` | `/api/analyze` | session, same origin | Live CAD analysis |
| `GET` | `/api/platform` | session | Complete workspace + stats |
| `GET` | `/api/settings` | session | Read user settings |
| `PUT` | `/api/settings` | session, same origin | Update user settings and secrets |
| `GET` | `/api/factory` | session | List machine profiles |
| `POST` | `/api/factory` | session, same origin | Create or update a machine (`201`) |
| `DELETE` | `/api/factory?id=…` | session, same origin | Remove a machine |
| `GET` | `/api/reports` | session | List folders and results |
| `POST` | `/api/reports` | session, same origin | Create a folder (`201`) |
| `PATCH` | `/api/reports` | session, same origin | Update result lifecycle/title/folder/tags, **or** select a route |
| `DELETE` | `/api/reports?folderId=…&mode=purge\|release` | session, same origin | Delete a folder, purging or releasing its contents |
| `DELETE` | `/api/reports?scope=trash` | session, same origin | Empty the results trash |
| `GET` | `/api/reports/attachments?resultId=…&attachmentId=…` | session | Download one attachment |
| `POST` | `/api/reports/attachments` | session, same origin | Attach a drawing/document and/or a note (`201`) |
| `DELETE` | `/api/reports/attachments?resultId=…&attachmentId=…` | session, same origin | Detach material |
| `POST` | `/api/reports/part` | session, same origin | Replace the 3D part attached to a result |
| `POST` | `/api/reports/rerun` | session, same origin | Re-run a result as a new linked revision (`201`) |
| `GET` | `/api/documents` | session | List report documents (summaries) |
| `POST` | `/api/documents` | session, same origin | Start background AI report generation (`202`) |
| `PATCH` | `/api/documents` | session, same origin | Update document lifecycle/title/folder/tags |
| `DELETE` | `/api/documents?scope=trash` | session, same origin | Empty the documents trash |
| `GET` | `/api/documents/{id}` | session | Read a finished document (JSON, or `?format=pdf`) |
| `GET` | `/api/parts` | session | List stored parts |
| `PATCH` | `/api/parts` | session, same origin | Rename a part |
| `DELETE` | `/api/parts?id=…` | session, same origin | Remove a part and its part-scoped blobs |
| `GET` | `/api/parts/model?id=…` | session | Stream a part's glTF preview |
| `GET` | `/api/drawings` | session | List drawing tables |
| `POST` | `/api/drawings` | session, same origin | Start background drawing-table generation (`202`) |
| `DELETE` | `/api/drawings?id=…` | session, same origin | Delete a drawing table |
| `POST` | `/api/drawings/chat` | session, same origin | One drawing-chat turn with the Zoo agent |
| `GET` | `/api/drawings/pdf?id=…` | session | Render the ISO A3 drawing sheet as PDF |
| `GET` | `/api/zoo/projects` | session | Proxy a bounded Zoo project list |
| `POST` | `/api/zoo/upload` | session, same origin | Create a Zoo draft project from local CAD (`201`) |
| `GET` | `/api/zoo/usage` | session | Remaining Zoo usage (cached 5 min) |

Every handler runs on the Node.js runtime (`export const runtime = "nodejs"`).

---

## Health

### `GET /api/health`

Response `200`:

```json
{ "status": "ok", "service": "quoteredy-studio" }
```

Proves the Next.js process answers HTTP. It does not read the store or call Zoo,
so it is a liveness probe, not a dependency-readiness probe. Declared
`dynamic = "force-dynamic"` so it is never statically cached.

---

## Authentication

### `GET /api/auth/login`

Creates random OAuth state and an S256 PKCE verifier/challenge, seals the
transaction in an encrypted 10-minute cookie, and redirects to
`https://api.zoo.dev/oauth2/authorize` with `response_type=code`, `client_id`,
`redirect_uri`, `scope`, `state`, `code_challenge` and
`code_challenge_method=S256`.

Requested scope: `user:read modeling`.

`?format=json` turns a configuration failure into a JSON body (`503` when OAuth
is unconfigured) instead of a redirect; normal browser navigation redirects to
`/login?auth_error=…`.

### `GET /api/auth/callback`

Query parameters: `code` and `state` on success; `error` and optional
`error_description` on denial.

The handler verifies that the transaction cookie exists, that `state` matches,
and that the transaction is at most 10 minutes old. It then exchanges the code
with the PKCE verifier, reads the Zoo profile from `GET /user`, seals a session
cookie, clears the transaction, and redirects to `/?auth=success`.

Failures redirect to `/login?auth_error=…`. The redirect origin is built from
`ZOO_OAUTH_REDIRECT_URI`, which prevents an internal container origin such as
`0.0.0.0:3000` from leaking into the browser.

### `GET /api/auth/session`

Response `200`:

```json
{
  "authenticated": true,
  "configured": true,
  "user": {
    "id": "zoo-user-id",
    "name": "Example User",
    "email": "user@example.com",
    "image": "https://..."
  }
}
```

`authenticated` is false and `user` is null when there is no valid session;
`configured` reports whether `ZOO_OAUTH_CLIENT_ID`, `ZOO_OAUTH_REDIRECT_URI` and
a 32+ character `QUOTE_READY_SESSION_SECRET` are all present. Token values are
never returned. The route attempts a refresh when the access token is within
60 seconds of expiry, and answers with the unauthenticated shape (not an error)
if that refresh fails.

### `POST /api/auth/logout`

Requires a verifiable same-origin request. Attempts to revoke each unique access
and refresh token, then clears the local cookie regardless:

```json
{ "loggedOut": true, "revoked": true }
```

`revoked: false` means at least one remote revocation failed; the local session
is removed either way.

---

## Analysis

### RFQ metadata contract

Both analysis modes normalise their input into this object:

| Field | Type | Accepted values / limit |
|---|---|---|
| `partName` | string | Optional, ≤ 140 characters |
| `process` | string | `unknown`, `cnc_milling`, `cnc_turning`, `sheet_metal`, `additive` (≤ 40 before the allowlist check) |
| `material` | string | `unknown`, `aluminum_6061`, `mild_steel`, `stainless_304`, `abs`, `pla` (≤ 40 before the allowlist check) |
| `quantity` | number/string | Empty, or a safe integer 1–1 000 000 |
| `units` | string | `unknown`, `mm`, `in` (≤ 16 before the allowlist check) |
| `tolerance` | string | Optional, ≤ 160 characters; empty becomes `ISO 2768-m` |
| `finish` | string | Optional, ≤ 160 characters; empty becomes `As Machined` |
| `notes` | string | Optional, ≤ 2 000 characters |
| `sourceProjectId` | string | Optional, ≤ 200 characters; must be supplied together with the name |
| `sourceProjectName` | string | Optional, ≤ 160 characters; must be supplied together with the ID |
| `hasDrawing` | boolean | Derived by the server; never accepted as input |

Whitespace is trimmed. Any other key produces `400` (`Unsupported RFQ field: …`).
The two project fields are traceability context only; they do not replace the
local CAD file. The live route additionally accepts a non-metadata `overwrite`
field — see [Part-name conflicts](#part-name-conflicts).

### `POST /api/analyze?mode=demo`

`application/json`, ≤ 16 KiB. Verifies origin, then allows 10 requests per minute
keyed on the Zoo user or, when anonymous, a normalised client address
(`CF-Connecting-IP` preferred, first `X-Forwarded-For` value as fallback,
non-address characters stripped, key capped at 64 characters).

```bash
curl --fail-with-body \
  -X POST "$BASE_URL/api/analyze?mode=demo" \
  -H "Origin: $BASE_URL" \
  -H "Content-Type: application/json" \
  --data '{
    "partName":"BR-042 Sensor bracket",
    "process":"unknown",
    "material":"aluminum_6061",
    "quantity":25,
    "units":"mm",
    "tolerance":"±0.10 mm",
    "finish":"Black anodised",
    "notes":"Pilot batch"
  }'
```

The server uses fixed sample geometry (volume 18 420 mm³, surface 14 862 mm²,
centre of mass `[42, 30, 6]`, mass derived from the selected density) and records
a `skipped` Zoo File API trace. Incomplete metadata is accepted here so the
readiness engine can be demonstrated. Without a session the response uses the
deterministic plan and is **not** saved; with a session the Zoo agent may refine
the plan and the result is stored in the workspace.

> Note: this endpoint tolerates anonymous callers, but every UI view is gated
> behind `/login`, so in practice sample runs happen inside an authenticated
> session.

### `POST /api/analyze`

Live mode is selected whenever `mode=demo` is absent. **Authentication is checked
before the upload body is read.** `Content-Type` must be `multipart/form-data`
with a valid boundary.

| Part | Required | Limit | Content validation |
|---|---|---:|---|
| `cadFile` | yes | 20 MiB | Extension allowlist plus format-specific leading-content checks |
| `drawing` | no | 10 MiB | PDF, PNG or JPEG leading-byte signature |

Accepted CAD extensions and the `src_format` they map to:

| Extension | `src_format` |
|---|---|
| `.step`, `.stp` | `step` |
| `.stl` | `stl` |
| `.obj` | `obj` |
| `.ply` | `ply` |
| `.sldprt` | `sldprt` |
| `.ipt` | `inventor` |
| `.sat` | `acis` |
| `.x_t`, `.x_b` | `parasolid` |

Content checks: STEP must contain `ISO-10303-21`, PLY must start with `ply`, OBJ
must match a vertex/face pattern, STL must be ≥ 84 bytes or start with `solid`;
a file whose leading bytes are PDF/PNG/JPEG, or a ZIP container for a non-ZIP
format, is rejected.

A live analysis requires a **complete package** before any Zoo request is made:
part name, material, design units and quantity. Otherwise the request fails with
`400` naming the missing fields. Target process may stay on "let the app
propose"; tolerance and finish are optional and default as described above.

```bash
curl --fail-with-body \
  -X POST "$BASE_URL/api/analyze" \
  -H "Origin: $BASE_URL" \
  -b cookies.txt \
  -F "cadFile=@part.step;type=application/octet-stream" \
  -F "drawing=@drawing.pdf;type=application/pdf" \
  -F "partName=BR-042" \
  -F "process=cnc_milling" \
  -F "material=aluminum_6061" \
  -F "quantity=25" \
  -F "units=mm" \
  -F "tolerance=±0.10 mm" \
  -F "finish=Black anodised" \
  -F "notes=Pilot batch"
```

What the handler does, in order: origin check → session → rate limit →
single-flight → parse multipart → validate metadata and file content → create a
`StoredPart` with `status: "analyzing"` → resolve the Zoo token → in parallel,
measure geometry (`analyzeWithZoo`) and build the glTF preview (`storePartModel`,
best effort) → build the readiness audit → build the deterministic plan and
attempt the Zoo pricing agent → save the result with the title
`{part}_{YYYY-MM-DD}` → archive the CAD and drawing when
`QUOTEREADY_PERSIST_UPLOADS=true` → flip the part to `analyzed`. A failure at any
point after the part record exists sets the part to `failed`.

The response body is an `AuditReport` — see [Data model](DATA_MODEL.md).

| Status | Meaning |
|---:|---|
| `400` | Invalid body, field, quantity, multipart structure, or missing CAD file |
| `401` | No valid Zoo session |
| `403` | Origin not accepted |
| `409` | Duplicate part name (see below), another analysis active, or a storage quota reached |
| `413` | JSON, multipart, CAD, drawing or field size exceeded |
| `415` | Wrong content type, extension or file signature |
| `429` | Rate limit reached |
| `503` | Rate-identity capacity exhausted, or OAuth unconfigured |
| `500` | Unexpected failure, returned without raw detail |

### Part-name conflicts

A part name is the handle everything downstream is named after, so two *visible*
parts may not share one. `POST /api/analyze` and `PATCH /api/parts` therefore
refuse a duplicate name with `409` and a machine-readable body:

```json
{
  "error": "A part named \"USB Holder\" already exists in this workspace. Confirm the overwrite to replace it, or choose another part name.",
  "code": "part_name_conflict",
  "conflict": { "partId": "…", "partName": "USB Holder" }
}
```

The client turns this into a confirmation dialog and, if the user agrees,
resubmits the identical request with `overwrite=true` (multipart field on
`/api/analyze`, JSON field on `/api/parts`; both `true` and `"true"` are
accepted).

On a confirmed overwrite the previous part is **superseded, not deleted**: it
gets `supersededAt` and `replacedById`, disappears from the parts list, pickers
and future collision checks, and keeps every blob — so results, drawings and
reports already generated from it still resolve to the original geometry. For
`/api/analyze` the supersede happens only *after* the new analysis succeeds, so a
failed run never hides the part the user still depends on.

---

## Workspace

### `GET /api/platform`

The single call the browser shell makes to hydrate itself:

```json
{
  "folders": [],
  "machines": [],
  "reports": [],
  "documents": [],
  "parts": [],
  "drawings": [],
  "settings": {
    "timezone": "Europe/Rome",
    "currency": "EUR",
    "theme": "system",
    "aiReports": { "enabled": true, "model": "gpt-4o" },
    "hasAiApiKey": false,
    "hasZooApiToken": false
  },
  "stats": { "reports": 0, "ready": 0, "machines": 0, "documents": 0 }
}
```

`documents` are summaries (no `html`, plus `sizeBytes`). `stats.reports` and
`stats.documents` exclude trashed items, `stats.ready` counts non-trashed results
whose readiness status is `ready`, and `stats.machines` counts enabled machines.
Settings never include the sealed secrets — only the two `has…` booleans.

### `GET /api/settings` · `PUT /api/settings`

`GET` returns the same `settings` object as above.

`PUT` accepts `application/json` ≤ 32 KiB with any subset of:

| Field | Validation |
|---|---|
| `timezone` | ≤ 80 characters and accepted by `Intl.DateTimeFormat` |
| `currency` | An ISO 4217 code known to `Intl.supportedValuesOf("currency")` |
| `theme` | `system`, `light` or `dark` |
| `aiReportsEnabled` | boolean |
| `aiModel` | `^[a-zA-Z0-9._:-]{1,80}$` |
| `openaiApiKey` | string ≤ 400 characters — see below |
| `zooApiToken` | string ≤ 400 characters — see below |

Secret semantics: omit the field to keep the current value, send an empty string
to remove it, send a value to replace it. Both secrets are sealed with AES-256-GCM
(key derived from `QUOTE_READY_SESSION_SECRET`) before they reach the store and
are never returned. The response is the public settings object.

---

## Factory

### `GET /api/factory`

Returns the machine array (not wrapped in an object).

### `POST /api/factory`

Creates a machine when `id` is absent or unknown, updates it when `id` matches an
existing machine in this workspace. Returns `201` in both cases.

```json
{
  "name": "Haas VF-2",
  "process": "cnc_milling",
  "hourlyRate": 75,
  "setupMinutes": 30,
  "materials": ["aluminum_6061", "mild_steel"],
  "enabled": true,
  "notes": "3-axis work; inspect critical bores"
}
```

Validation: `name` required, ≤ 100 characters; `process` one of `cnc_milling`,
`cnc_turning`, `sheet_metal`, `additive`, `laser_cutting`, `finishing`;
`hourlyRate` finite 0–10 000; `setupMinutes` finite 0–10 080; `materials` at most
20 supported non-`unknown` IDs (duplicates removed); `notes` ≤ 500 characters;
`id` ≤ 64 characters; `enabled` defaults to `true` unless explicitly `false`; at
most 100 machines per workspace.

### `DELETE /api/factory?id={machineId}`

ID must be 1–64 characters. Returns `{ "deleted": true }`, or `deleted: false`
for a valid but unknown ID.

---

## Results and folders

### `GET /api/reports`

```json
{ "folders": [], "reports": [] }
```

### `POST /api/reports` — create a folder

```json
{ "name": "Customer A", "parentId": null }
```

`name` required, ≤ 100 characters; `parentId` null or a ≤ 64-character ID that
must exist in this workspace; at most 200 folders. Returns `201`.

### `PATCH /api/reports` — lifecycle, title, folder, tags

```json
{
  "id": "result-id",
  "title": "BR-042 revision B",
  "folderId": "folder-id",
  "archivedAt": "2026-07-28T10:00:00.000Z",
  "trashedAt": null,
  "tags": ["customer-a", "urgent"]
}
```

- `id` required, ≤ 64 characters;
- `title` 1–140 trimmed characters;
- `folderId` null or a ≤ 64-character ID that exists in this workspace;
- `archivedAt` / `trashedAt` null, or a parseable date string ≤ 40 characters
  (normalised with `toISOString()`);
- `tags` at most 10 entries, each ≤ 30 characters, stripped to letters, numbers,
  spaces and `_.-`, de-duplicated;
- at least one supported change is required.

Moving a result to another folder also moves the report documents generated from
it. Returns `404` when the result does not exist.

### `PATCH /api/reports` — select a manufacturing route

```json
{ "id": "result-id", "recommendedRouteId": "cnc-from-billet" }
```

The route ID must be 1–80 characters and must exist in that result's route array.
When `recommendedRouteId` is present the handler performs **only** route
selection and ignores lifecycle fields in the same request. Selection sets
`manufacturingPlan.routeSelectedByUser = true`, which later feeds the per-user
workshop memory sent to the Zoo pricing agent.

### `DELETE /api/reports?folderId={id}&mode=purge|release`

`mode` is mandatory. `purge` permanently removes the results and report documents
filed in the folder; `release` moves them back to "all folders". Child folders are
re-parented to the root either way. Returns
`{ "removedReports": n, "removedDocuments": n }`, or `404` when the folder does
not exist.

### `DELETE /api/reports?scope=trash`

Permanently deletes every trashed result. Returns `{ "removed": n }`. Any other
`scope` value is a `400`.

---

## Result attachments and re-runs

### `POST /api/reports/attachments`

`multipart/form-data` with a `resultId` field, an optional `note` field and an
optional `drawing` file (PDF, PNG or JPEG, magic-byte checked, ≤ 10 MiB). At
least one of note or file is required; a `cadFile` part is rejected with a
pointer to `/api/reports/part`.

File bytes go to the blob store under
`users/{userId}/reports/{resultId}/attachments/{uuid}/{fileName}` and only the
reference is recorded on the result, so results stored before attachments existed
keep loading unchanged. At most 20 attachments per result; note text ≤ 4 000
characters (the 4 KiB multipart field cap bounds a single submission). Returns
the created `ResultAttachment` with `201`.

### `GET /api/reports/attachments?resultId=…&attachmentId=…`

Streams the stored bytes to their owner with the recorded `Content-Type`,
`Content-Disposition: inline` and `Cache-Control: private, max-age=3600`.
`404` when the result, the attachment or the blob is missing.

### `DELETE /api/reports/attachments?resultId=…&attachmentId=…`

Detaches the entry and deletes the bytes **only** when no other result still
references the same blob — a re-run copies attachment references forward, so the
blob is shared. Returns `{ "removed": true }`.

### `POST /api/reports/part`

`multipart/form-data` with `resultId` and `cadFile`; a `drawing` part is rejected.
Replaces the 3D part attached to a result: the file goes through the same
extension and content validation as the original upload, is archived under
`users/{userId}/parts/{partId}/source/{fileName}`, and its glTF preview is
re-converted (best effort). The previous part-scoped CAD blob is deleted; report
artefacts are never touched.

The part is left in `status: "uploaded"`, which the UI reads as "this result is
stale until the analysis is re-run". Returns the updated `StoredPart`.

`409` when the result has no part record any more, or while the part is being
analysed.

### `POST /api/reports/rerun`

```json
{ "id": "result-id" }
```

Re-measures the CAD file currently attached to the result and re-prices it,
folding every attachment into the RFQ context: notes and file captions are
appended to `metadata.notes` under a stable heading (so repeated re-runs never
stack duplicates), and an attached PDF/PNG/JPEG satisfies the "supporting
drawing" readiness check. That context then reaches the Zoo pricing agent and the
AI report generator, because both serialise `report.metadata` (the report prompt
also receives a separate `attachedMaterial` digest).

A re-run **never overwrites history**. It stores a *new* result that:

- carries the source's `folderId`, `tags` and attachment references;
- links back through `sourceResultId` and a 1-based `revision`;
- gets a fresh `{part}_{today}` title, so re-running an old analysis reads as
  today's work while the source keeps its own title;
- becomes the part's `reportId`, so `part.reportId` always names the newest
  analysis of that CAD file.

Requires the part's CAD file to be archived (`409` with guidance otherwise —
replace the 3D part to archive one). Shares the `analysis:{userId}` single-flight
key with `POST /api/analyze`. Returns the new `StoredReport` with `201`.

---

## Report documents (AI detailed reports)

### `GET /api/documents`

```json
{ "documents": [] }
```

Summaries only: every field except `html`, plus `sizeBytes`.

### `POST /api/documents`

```json
{ "resultId": "result-id" }
```

Requires AI reports to be enabled and an OpenAI key present in Settings
(`409` with an actionable message otherwise). Creates the document with
`status: "generating"` and a sequential `{part}_NN` name, returns it immediately
with `202`, and writes the HTML in the background; the record then flips to
`ready`, or to `failed` with a bounded `error`. The Reports page polls the
workspace while a document is generating, so the state survives navigation.

A second generation for the same result is rejected with `409` while a fresh one
is still running (a document stuck in `generating` is considered stale after
10 minutes).

The generated HTML is a standalone A4-print-friendly document with inline SVG
illustrations. It is stripped of `<script>` elements, inline event handlers and
`javascript:` URLs before storage, capped at 500 KiB, and rendered in a sandboxed
iframe in the browser.

### `PATCH /api/documents`

`application/json` ≤ 32 KiB. Accepts `id` (required) plus `title` (1–140
characters), `folderId` (null or an existing folder), `archivedAt`, `trashedAt`
(any non-null value is normalised to *now*), and `tags`. Returns the updated
summary, or `404`.

### `DELETE /api/documents?scope=trash`

Permanently deletes every trashed document. Returns `{ "removed": n }`.

### `GET /api/documents/{id}`

Default response:

```json
{ "document": { "id": "…", "html": "<!doctype html>…", "…": "…" } }
```

`?format=pdf` renders the stored HTML with headless Chromium and returns
`application/pdf` as an attachment named after the document's sequential label
(A4, `printBackground`, margins 12/14/11/11 mm, JavaScript disabled during
rendering). Counts against the `pdf` rate limit.

| Status | Meaning |
|---:|---|
| `404` | Document not found |
| `409` | Document is still `generating`, or `failed` |
| `503` | No Chromium binary is available in this deployment |

---

## Parts

### `GET /api/parts`

```json
{ "parts": [] }
```

Superseded parts are stored but hidden from this list.

### `PATCH /api/parts`

```json
{ "id": "part-id", "name": "USB Holder", "overwrite": false }
```

`name` is the only supported change: 1–140 trimmed characters. A rename onto a
name already held by another visible part returns the
[part-name conflict](#part-name-conflicts) `409`; with `overwrite: true` the
renamed part takes the name over and the previous holder is superseded. Re-casing
a part's own name is never a conflict. Returns the updated part, or `404`.

### `DELETE /api/parts?id={partId}`

Removes the part record and best-effort deletes its part-scoped blobs (the glTF
preview and the archived CAD under `…/parts/…`). Report artefacts stay with their
report. Returns `{ "removed": true }`, or `404`.

### `GET /api/parts/model?id={partId}`

Streams the part's stored glTF preview to its owner as `model/gltf+json`, with
`Content-Disposition: inline; filename="model.gltf"` and
`Cache-Control: private, max-age=3600`. `404` when the part has no stored model or
the blob is gone. This is what `<model-viewer>` loads in the Parts view.

---

## Drawing tables and drawing sheets

### `GET /api/drawings`

```json
{ "drawings": [] }
```

### `POST /api/drawings`

```json
{ "partId": "part-id" }
```

Hands the part's archived CAD file to the Zoo copilot, which chooses the datum
reference frame and the dimensional and geometric tolerance rows itself. The
drawing is created with `status: "generating"` and a sequential `{part}_NN` name
and returned with `202`; the agent's JSON answer is parsed, bounded (≤ 6 datums,
≤ 40 rows, ≤ 10 notes, 200 characters per field) and stored in the background,
flipping the record to `ready` or `failed`.

To spare the agent a slow tool loop, the prompt already carries what has been
measured: volume, surface area, mass, material and design units from the part's
analysis result, plus the RFQ general tolerance.

| Status | Meaning |
|---:|---|
| `400` | Missing or over-long `partId` |
| `404` | Part not found |
| `409` | CAD file not archived for this part; a generation is already running (stale after 15 minutes); or only an OAuth token is available |
| `429` | Rate limit reached |

The last case matters: Zoo's ML endpoints reject third-party OAuth tokens, so a
verified personal Zoo API token in Settings is a hard requirement. The `409`
message says exactly that.

### `POST /api/drawings/chat`

```json
{ "id": "drawing-id", "message": "Tighten the bore to H7 and add flatness on the base" }
```

One synchronous turn (120 s budget, text-only — no CAD attached — so it stays
interactive). The agent receives the current table as JSON, applies the request,
and answers with the same JSON contract. The parsed table **replaces** `units`,
`generalTolerance`, `datums`, `rows` and `notes` wholesale; row IDs are
regenerated each turn.

```json
{
  "drawing": { "…": "the updated DrawingTable" },
  "reply": "Bore tolerance changed to H7 and a flatness control was added on datum A."
}
```

`message` is required and ≤ 600 characters. The drawing must exist (`404`) and be
`ready` (`409`). A personal Zoo API token is required (`409`). Single-flight per
drawing.

### `GET /api/drawings/pdf?id={drawingId}`

Renders the drawing as a real ISO A3 landscape technical sheet and returns
`application/pdf` as an attachment. The pipeline: read the part's archived glTF
→ parse it into a millimetre triangle mesh → recognise planar faces, pockets and
pocket arrays → project first-angle front / left / top / isometric views plus
section A-A with hidden-line removal → choose an ISO 5455 scale that fits the
239 × 276 mm drawing area → place ISO 129 dimensions, ISO 5459 datum indicators,
ISO 1101 feature control frames and ISO 6433 balloons without collisions →
compose the sheet with zone markers, an ISO 7200 title block and the datum and
dimension tables → print it with Chromium at `preferCSSPageSize` so the
420 × 297 mm sheet comes out 1:1.

Balloon numbers are the dimension-table row numbers, so the views and the table
cannot disagree. Rows the annotator could not anchor to a feature are left
un-ballooned. If the table overflows the first sheet's column, continuation
sheets repeat the frame and title block.

A part without a usable archived glTF still gets its sheet: the drawing area then
prints the reason ("No 3D model is archived for this part, …") and the title
block shows scale `NTS`. The part-data box (envelope, volume, surface, mass) is
only printed when the view layout leaves at least 30 mm free below the views.

| Status | Meaning |
|---:|---|
| `400` | Missing or over-long `id` |
| `404` | Drawing not found |
| `409` | Drawing is still `generating`, or `failed` |
| `429` | `pdf` rate limit reached |
| `503` | No Chromium binary is available in this deployment |

### `DELETE /api/drawings?id={drawingId}`

Permanently deletes one drawing table. Returns `{ "removed": true }`, or `404`.

---

## Zoo proxies

### `GET /api/zoo/projects`

Calls `GET https://api.zoo.dev/user/projects?limit=50` with the resolved token, a
15-second timeout, no cache and a 512 KiB response ceiling, and passes a
successful JSON body through unchanged. The browser normalises a top-level array,
`{ items: [...] }` or `{ projects: [...] }`, and reads `id`, `name` (falling back
to `title`), an optional `description` and `updated_at`/`updatedAt`.

A non-2xx upstream response becomes `502` with a bounded `detail`. For upstream
`403` the detail explains the token situation:

```json
{
  "error": "Zoo Projects API request failed.",
  "detail": "Zoo's Projects API does not accept third-party OAuth tokens. Add your personal Zoo API token in Settings to enable the library."
}
```

The list supplies planner context only. A live analysis still requires a local
CAD upload.

### `POST /api/zoo/upload`

`multipart/form-data` with `cadFile` and an optional `projectName` field; a
`drawing` part is rejected. Accepted formats are the subset a Zoo project can
import as foreign geometry: STEP, STL, OBJ, PLY, SLDPRT (`415` otherwise).

The handler POSTs a three-part multipart body to
`https://api.zoo.dev/user/projects` (45-second timeout): a `project.toml`
descriptor with `base_unit = "mm"`, a `main.kcl` entrypoint that imports the
uploaded file, and the CAD file itself. `main.kcl` is part of Zoo's project
format, not a CAD translation — it is written once at upload time and never read
back.

On success the upload is also recorded as a local part (best effort — a store
failure never undoes the Zoo upload), the CAD is archived and the glTF preview is
built. Response `201`:

```json
{ "id": "zoo-project-id", "name": "USB Holder", "entrypoint": "main.kcl" }
```

Upstream failures return `502` with a bounded `detail` (the same token
explanation for `403`).

### `GET /api/zoo/usage`

Reads `GET https://api.zoo.dev/user/payment/balance` with the resolved token
(15-second timeout, 256 KiB ceiling) and returns:

```json
{
  "minutesRemaining": 412,
  "monthlyCreditsRemaining": 400,
  "stableCreditsRemaining": 12
}
```

Zoo meters API usage in whole minutes, so the credit sum is surfaced as minutes
in the top bar. Responses are cached in-process for five minutes per user
(cache cleared wholesale past 500 entries). A failure returns `null` fields with
HTTP `200` rather than an error, so the badge simply disappears.

---

## Error-handling expectations

- Display `error`, and `detail` when present.
- A `401` should offer Zoo reconnection rather than silently retrying.
- A `409` carrying `code: "part_name_conflict"` should become a confirmation
  prompt and, on confirmation, a resubmission with `overwrite=true`. A
  single-flight `409` should wait for the current run; a quota `409` needs user
  action; a `409` asking for a personal Zoo API token should link to Settings.
- A `413` must not be retried unchanged.
- A `429` should back off until the minute window resets.
- A `502` from a Zoo proxy may be retried later.
- A `503` from a PDF route means the deployment has no Chromium; the HTML view
  is still available.
- Browser callers must not suppress fallback provenance
  (`manufacturingPlan.provider`, `providerLabel`, `fallbackReason`) in successful
  reports.

## Related documents

- [Data model](DATA_MODEL.md) — the objects these routes return.
- [Architecture](ARCHITECTURE.md) — how a request flows through the layers.
- [Zoo Agent contract](ZOO_AGENT.md) — the pricing validation rules.
- [Zoo API notes](ZOO_API_NOTES.md) — the upstream Zoo endpoints behind these
  routes.
- [Security](SECURITY.md) — the full control set behind these limits.
