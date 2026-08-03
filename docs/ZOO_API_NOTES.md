# Zoo API integration notes, findings and bug reports

## What this document is

QuoteReady Studio makes fifteen distinct Zoo calls across five services as load-bearing
infrastructure, not as decoration. Getting there took a fair amount of
trial-and-error against the live service. This page is the field report:

- **[Part 1 — Endpoint reference as exercised](#part-1--endpoint-reference-as-exercised)**
  what we call, with the exact parameters, timeouts and response shapes we
  observed.
- **[Part 2 — Findings and bug reports](#part-2--findings-and-bug-reports)**
  every issue we hit, organised by API area, with reproduction detail, impact,
  and the workaround shipped in the product.
- **[Part 3 — Documentation feedback](#part-3--documentation-feedback)**
  where Zoo's own docs were silent, ambiguous or contradicted the service.
- **[Part 4 — What we would like from the API](#part-4--what-we-would-like-from-the-api)**
- **[Part 5 — Reproducing our observations](#part-5--reproducing-our-observations)**

This is implementation evidence, not a replacement for Zoo's official reference.
Every observation carries the date it was made; endpoints and payloads should be
re-verified against the current service before anyone relies on them.

All requests target `https://api.zoo.dev` (or `wss://api.zoo.dev`). Outbound
hosts are hard-coded in server code; no user input selects a host.

---

## Part 1 — Endpoint reference as exercised

| Service | Endpoint | Our use | Client code |
|---|---|---|---|
| OAuth | `GET /oauth2/authorize` | Authorization Code + S256 PKCE, scope `user:read modeling` | `apps/web/app/api/auth/login/route.ts` |
| OAuth | `POST /oauth2/token` | Code exchange and refresh | `apps/web/lib/zoo-auth.ts` |
| OAuth | `POST /oauth2/token/revoke` | Best-effort sign-out revocation | `apps/web/lib/zoo-auth.ts` |
| Users | `GET /user` | Workspace identity; also verifies that a user-supplied personal API token belongs to the signed-in account | `apps/web/lib/zoo-auth.ts`, `apps/web/lib/zoo-projects.ts` |
| Projects | `GET /user/projects?limit=50` | Library listing and planner context | `apps/web/app/api/zoo/projects/route.ts` |
| Projects | `POST /user/projects` | Create a draft project from an uploaded CAD file | `apps/web/app/api/zoo/upload/route.ts` |
| Billing | `GET /user/payment/balance` | Remaining-usage badge in the top bar | `apps/web/app/api/zoo/usage/route.ts` |
| File | `POST /file/volume` | Solid volume, mm³ | `apps/web/lib/zoo.ts` |
| File | `POST /file/surface-area` | Surface area, mm² | `apps/web/lib/zoo.ts` |
| File | `POST /file/center-of-mass` | Centre of mass, mm | `apps/web/lib/zoo.ts` |
| File | `POST /file/mass` | Mass, g, from the selected material density | `apps/web/lib/zoo.ts` |
| File | `POST /file/conversion/{src}/gltf` | glTF used for the 3D preview **and** as the mesh source for the technical drawing | `apps/web/lib/zoo-model.ts` |
| Async | `GET /async/operations/{id}` | Poll queued/in-progress file operations | `apps/web/lib/zoo.ts`, `apps/web/lib/zoo-model.ts` |
| ML | `wss://api.zoo.dev/ws/ml/copilot` | Pricing agent, drawing-table generation, drawing chat | `packages/core/src/zoo-copilot.ts` |

### File API request pattern

Each metric is a single `application/octet-stream` POST carrying the whole
validated CAD buffer plus a bearer token. The source format comes from our own
extension allowlist and the density from our material catalogue — never from
free-form input:

```text
POST /file/volume?src_format=step&output_unit=mm3
POST /file/surface-area?src_format=step&output_unit=mm2
POST /file/center-of-mass?src_format=step&output_unit=mm
POST /file/mass?src_format=step&material_density=2700&material_density_unit=kg%3Am3&output_unit=g
POST /file/conversion/step/gltf
```

Mass is skipped entirely when the selected material has no known density, rather
than sending a guessed value.

### Timing and deadlines we settled on

The four metric calls start concurrently and share **one 45 s abort deadline**,
which is authoritative — a slow metric cannot extend the analysis by winning a
fresh timeout on every poll.

| Parameter | Metrics (`lib/zoo.ts`) | Conversion (`lib/zoo-model.ts`) |
|---|---|---|
| Shared deadline | 45 s | 45 s |
| Initial POST timeout | 20 s | shared deadline |
| Poll interval | 500 ms | 1 000 ms |
| Maximum polls | 18 | until the deadline |
| Per-poll timeout | 8 s | shared deadline |
| Response ceiling | 128 KiB | 48 MiB |

The 48 MiB conversion ceiling is not paranoia: glTF with embedded buffers is JSON
with base64 payloads, so the response is routinely several times larger than the
source CAD file.

### Operation response model

Accepted status strings: `queued`, `uploaded`, `in_progress`, `completed`,
`failed`. An initial response with no operation id/status, or already
`completed`, is terminal. `failed` produces a bounded per-metric error. Anything
else is polled by encoded operation id.

Metric payload keys we read:

```json
{
  "id": "operation-id",
  "status": "completed",
  "volume": 18420,
  "surface_area": 14862,
  "mass": 49.7,
  "center_of_mass": { "x": 42, "y": 30, "z": 6 }
}
```

We validate before trusting: the response must be a JSON object; volume, surface
area and mass must be finite, non-negative and ≤ `1e15`; each centre-of-mass
coordinate must be finite with `|value| ≤ 1e9`; a non-2xx response becomes a
metric failure. Error bodies carry the human-readable reason in `message` (not
`error`) often enough that we read both.

### Partial-failure behaviour

`runMetric()` converts a failed metric into `{ data: null, trace: failed }`
instead of rejecting the whole `Promise.all`. A report can therefore carry
partial evidence, which is a feature rather than a compromise:

- a volume failure blocks quote readiness;
- surface area and centre of mass render as "unavailable";
- a mass failure raises a warning when the density *was* known;
- every trace retains endpoint, status, duration, optional operation id and a
  bounded detail string.

The point is to expose provider evidence rather than silently substituting an
unlabelled estimate.

### ML copilot wire protocol as observed

Client sends one message per turn:

```json
{
  "type": "user",
  "content": "…prompt…",
  "project_name": "QuoteReady Studio — <part>",
  "forced_tools": [],
  "current_files": { "part.step": [ 73, 84, 69, 80, … ] }
}
```

`current_files` values must be **byte arrays**, not base64 strings.
`forced_tools: []` is how we request a text-only answer with no modelling or
rendering. Server frames are single-key JSON objects; the set we handle:

| Frame | Meaning for us |
|---|---|
| `{"session_data":{"api_call_id":…}}` | In-band auth accepted; the socket is ready. `api_call_id` is what Zoo asks you to quote in a bug report, so we surface it in every error. |
| `{"reasoning":{…}}` | Liveness only. Emitted for minutes before the first delta. |
| `{"conversation_id":{"conversation_id":…}}` | Required to reconnect with replay. |
| `{"delta":{"delta":"…"}}` | Streamed answer text. |
| `{"tool_output":{"result":{type,status_code,error,outputs}}}` | Tool call result; `outputs` maps file name → new contents. |
| `{"project_updated":{"files":{…}}}` | Latest project file contents. |
| `{"backend_shutdown":{…}}` | The backend is being recycled mid-turn. |
| `{"error":{"detail":"…"}}` | Abort — but see [ML-2](#ml-2--long-turns-are-killed-every-56-minutes-by-a-zookeeper-recycle). |
| `{"end_of_stream":{"whole_response":"…"}}` | Turn complete; prefer `whole_response` over the accumulated deltas. |
| `{"pong":{}}` | Answer to our `{"type":"ping"}` keepalive. |
| binary `{"replay":{"messages":[bytes…]}}` | MsgPack-encoded history of the resumed conversation. |

Everything else (`info`, `files`, …) is progress chatter and is ignored.

Our client limits: 16 MiB `maxPayload` per frame (server frames can carry
rendered images as JSON byte arrays), 256 KiB cumulative accepted text, 30 s ping
interval, 5-minute stall watchdog, at most 6 reconnects with exponential backoff
(2 s → 30 s). Per-prompt budgets: 80 s for pricing, 5 min for a drawing table
(2 attempts), 120 s for a drawing chat turn.

### Payment balance

`GET /user/payment/balance` returns `monthly_api_credits_remaining` and
`stable_api_credits_remaining` (plus monetary fields). Zoo meters API usage in
whole minutes, so we present the credit sum as "minutes remaining" and cache the
response for five minutes per user. Failures return `null` fields rather than an
error, so the badge simply disappears.

---

## Part 2 — Findings and bug reports

Severity is from the integrator's point of view: **blocker** = the feature cannot
ship without a workaround; **major** = visible product degradation; **minor** =
friction or wasted development time.

### Authentication and scopes

#### AUTH-1 — Third-party OAuth tokens are rejected by every interesting endpoint

**Severity: blocker.** Verified 2026-07-28.

Zoo's OAuth scope set is `user:read`, `modeling` and `admin:write`. There is no
`projects` scope and no ML scope. An access token obtained through the documented
third-party Authorization Code + PKCE flow — with both `user:read` and
`modeling` granted — is accepted by `GET /user` but answered with **HTTP 403** by:

- `POST /file/volume`, `/file/surface-area`, `/file/center-of-mass`, `/file/mass`
- `POST /file/conversion/{src}/gltf`
- `GET /user/projects` and `POST /user/projects`
- `wss://api.zoo.dev/ws/ml/copilot`

**Repro:** complete the OAuth flow for a third-party app, then
`curl -H "Authorization: Bearer $OAUTH_TOKEN" -X POST --data-binary @cube.step \
"https://api.zoo.dev/file/volume?src_format=step&output_unit=mm3"` → 403.
The same request with a personal API token from the Zoo dashboard → 200.

**Impact.** This is the single largest constraint on the project. An OAuth-only
integration can identify a user and nothing else, which makes the documented
third-party flow unusable for any app that wants to *do* something with the
account. It is also confusing for end users, because the consent screen grants
`modeling` and the modeling endpoints then refuse the token.

**Our workaround.** Every server-side Zoo call goes through
`resolveProjectsToken()` (`apps/web/lib/zoo-projects.ts`), which prefers a
**personal Zoo API token** that the user pastes into the in-app Settings page,
and falls back to the OAuth token. The personal token is only used after a
`GET /user` call confirms it belongs to the signed-in Zoo account (cached
10 minutes), so one user's token can never be used to act as another. It is
sealed with AES-256-GCM before it is stored. Features that provably cannot work
on an OAuth token — library listing, CAD upload, drawing generation, drawing
chat — refuse early with an actionable `409` rather than surfacing a raw 403.

**What we would like.** A `projects` scope and an `ml` scope, or documentation
stating plainly that third-party OAuth is identity-only and that everything else
requires a personal API token.

#### AUTH-2 — A deployment-wide API token is the wrong shape, and we removed ours

**Severity: minor (self-inflicted, but worth recording).** 2026-07-29.

We initially shipped a `ZOO_API_TOKEN` environment fallback so the library
worked before any user configured a token. On 2026-07-29 that token started
returning 401 on all REST calls (expired or revoked), silently breaking the
library for everyone. We removed the fallback the same day: the token now comes
exclusively from per-user settings, and the affected UI is explicitly disabled
until a token is present. A shared token also meant one account's quota funding
every user's calls, which is not a model we want to encourage.

### File API

#### FILE-1 — `/ml/convert/proprietary-to-kcl` stays 403 even with a personal API token

**Severity: major (feature cancelled).** Verified 2026-07-28 and 2026-07-29.

We wanted a "see this part as KCL" feature: convert an uploaded STEP file into
KCL so the user could inspect and edit the parametric source. The endpoint
returned **403** with a valid personal API token from an account in good
standing — unlike `/file/*` and `/user/projects`, which the same token unlocked.
The endpoint appears to be gated behind a beta allowlist that is not visible from
the dashboard, and there is no documented way to request access or to discover
that a token lacks it.

**Impact.** The whole feature was built, then removed. Nothing about the failure
distinguished "you are not in the beta" from "your token is wrong", which cost a
full debugging cycle before we concluded it was gating rather than a client bug.

**Outcome.** The CAD→KCL conversion was **removed from the product**. There is no
`/api/parts/kcl` route; only some deprecated `kcl*` fields remain on the
`StoredPart` type so records written before the removal still type-check. If the
endpoint becomes generally available the feature is straightforward to restore.

**What we would like.** Either a documented "beta features" list on the account
page, or a distinct error code/message for allowlist gating so a client can tell
the user *why* it failed instead of "403".

#### FILE-2 — Conversion output size is undocumented and easy to underestimate

**Severity: minor.** 2026-07-29.

`POST /file/conversion/{src}/gltf` returns the glTF as base64 inside the
operation's `outputs` map. Because buffers are embedded, the response is
routinely several times the size of the input CAD file — a 2 MB STEP part can
produce a double-digit-MB JSON body. Our first response ceiling was far too low
and truncated valid conversions. We now allow 48 MiB. The docs do not state a
maximum output size or offer a URL-based output, which would be much friendlier
for large assemblies.

Also undocumented: the `outputs` map is keyed by output file name, and the key
is not stable enough to hard-code, so we take the first non-empty string value.

#### FILE-3 — The inline/async threshold is invisible to the client

**Severity: minor.** 2026-07-28.

The same request can return either a completed operation inline or a queued
operation that must be polled, depending on file size — but the threshold is not
documented, so a client cannot know in advance whether to expect a fast path.
Both `/file/*` and `/file/conversion/*` behave this way. Every client therefore
has to implement the polling loop regardless. Documenting the threshold (or
always returning an operation) would make the contract predictable.

#### FILE-4 — Format coverage per metric is unstated

**Severity: minor, unresolved.** 2026-07-30.

Our extension allowlist accepts STEP/STP, STL, OBJ, PLY, SLDPRT, IPT, SAT and
Parasolid, but `/file/conversion/*/gltf` documents a different set (we allow
FBX, OBJ, PLY, SLDPRT, STEP, STL for conversion) and we could not find a
statement of which metrics support which source formats. We have verified STEP
end-to-end; the rest we treat optimistically and surface a per-metric failure
trace when Zoo declines. A capability matrix, or a discovery endpoint, would
remove the guesswork.

### ML copilot (websocket)

#### ML-1 — In-band authentication is mandatory and undocumented

**Severity: blocker.** Verified 2026-07-29.

`wss://api.zoo.dev/ws/ml/copilot` requires the **first websocket message** to be

```json
{ "headers": { "Authorization": "Bearer <token>" } }
```

The HTTP `Authorization` header on the upgrade request is **not** sufficient.
Without the in-band frame the server either answers with repeated
`{"error":{"detail":"Please send \`{ headers: … }\` over this websocket."}}`
frames, or closes with code **1006** before emitting any `conversation_id` or
`end_of_stream`.

**Symptom in our app.** "Zoo Copilot closed without a response", which pushed
every pricing call onto the deterministic fallback. The failure mode looks
exactly like an outage, so we spent a long time investigating the wrong thing.

**Fix.** `runCopilotPrompt` now sends the in-band auth frame first on **every**
connection, including replay reconnects, and still sets the HTTP header.
A useful side effect: the `session_data` frame that follows the accepted auth is
a deterministic "the socket is ready for a prompt" signal, which is otherwise
missing from the protocol.

**What we would like.** One sentence in the websocket docs. This cost more
debugging time than any other issue in the project.

#### ML-2 — Long turns are killed every 5–6 minutes by a zookeeper recycle

**Severity: major.** Verified 2026-07-29, still present 2026-07-30.

Any copilot turn lasting more than roughly five or six minutes is interrupted.
Two forms observed, sometimes both in one turn:

1. an error frame whose detail matches
   `zookeeper connection interrupted; please reconnect and retry`;
2. a `backend_shutdown` frame (observed reason `zookeeper_service_refresh`),
   sometimes followed by the socket closing.

Neither is fatal server-side: the prompt keeps running and can be picked back up
with `?replay=true&conversation_id=…`. But it means **no client can hold a
single long copilot turn**, and the "error" framing actively misleads — a naive
client treats it as a failure and discards work the server is still doing.

**Our handling.** `runCopilotPrompt` treats those messages — including recorded
copies found inside replay history — as reconnect signals rather than errors:

- reconnect with `?replay=true&conversation_id=…`, exponential backoff
  2 s → 30 s, up to 6 consecutive failures, budget reset whenever frames flow;
- reset the streamed text on replay (the server replays from the start, so
  keeping it would duplicate the answer) while **harvesting** tool results and
  project files first, so a truncated replay never discards work;
- accept accumulated tool output as a valid outcome when the closing frame never
  arrives;
- a 30 s ping keepalive, because an idle socket is otherwise free to be dropped
  by any intermediary during the minutes-long gaps between frames.

**What we would like.** Either sessions that survive a backend refresh, or a
non-error frame type for "reconnect required" so clients can distinguish
maintenance from failure.

#### ML-3 — A resumed turn frequently goes silent for the rest of the budget

**Severity: major, only partially worked around.** Verified 2026-07-29 to 07-30.

After a replay reconnect the server must be explicitly told to resume:

```json
{ "type": "system", "command": "continue" }
```

Without it the resumed socket stays silent until the client's budget expires.
This is not documented anywhere we could find; we found it by experiment. We now
send `continue` once per replay socket, immediately after the binary replay frame
and, as a fallback, 5 s after the socket opens in case the replay frame never
arrives.

Even with `continue`, resumption is unreliable. In a 30-minute session the
socket stayed connected and authenticated but streamed **zero deltas and zero
tool results**. Because of that we adopted a pragmatic rule: if the copilot has
already produced tool output or project files when an interrupt arrives, we
**take what we have and finish** rather than gambling the remaining budget on a
resume.

Every failure path now reports how far the turn got, which is what makes this
diagnosable at all:

```text
Zoo Copilot timed out (conversation established, 41 reasoning frames,
0 chars streamed, 0 tool results, 3 reconnects, api call 0f9c…).
```

When retries consistently show `0 chars streamed`, the bottleneck is Zoo's agent
service rather than the integration.

#### ML-4 — Minutes of `reasoning` frames before the first `delta`

**Severity: minor (design consequence).** 2026-07-29.

The copilot emits `reasoning` frames — sometimes dozens — long before any answer
text. They are the *only* evidence that a silent turn is alive, so a stall
watchdog must treat them as liveness or it will kill healthy turns. We count
them and report the count in diagnostics, which is how `0 chars streamed` became
an actionable message rather than a mystery.

Related: we deliberately do **not** re-arm the watchdog on our own `pong`
answers. A `pong` proves the socket is up but says nothing about the prompt, and
re-arming on it would make the watchdog unable to ever fire on a wedged turn.

#### ML-5 — Turns end without `end_of_stream` often enough to matter

**Severity: minor.** 2026-07-29.

Some turns simply close after streaming a complete answer. Treating a close as
failure loses good answers, so our client accepts a closed connection as success
whenever text, tool results or project files have arrived. Conversely
`end_of_stream.whole_response` is preferred over the accumulated deltas when
both are present, because the deltas can be missing pieces after a replay.

#### ML-6 — The replay frame is MsgPack, which is not obvious

**Severity: minor.** 2026-07-29.

`?replay=true` history arrives as a **binary** frame containing a MsgPack
document `{replay:{messages:[bytes…]}}`, where each message is the raw bytes of
a JSON frame. Every other frame on the socket is JSON text. We ended up writing
a small MsgPack decoder (maps, arrays, strings, binary, numbers, booleans, nil)
just to read the resume history — see `decodeMsgPack` in
`packages/core/src/zoo-copilot.ts`. A JSON replay envelope, or a documented note
that this frame is MsgPack, would have saved that work.

#### ML-7 — Deprecated text-to-CAD iteration endpoint

**Severity: minor, avoided.** 2026-07-28.

While looking for a supported way to have the agent modify existing geometry, we
found the text-to-CAD iteration endpoint marked deprecated with no clearly
documented successor for the "edit this existing part" use case. We deliberately
did not build on it. The copilot socket with `forced_tools: []` turned out to be
the right primitive for our needs (we want structured JSON answers, not model
mutations), but the deprecation left the "programmatically iterate on a model"
path unclear.

### Projects API

#### PROJ-1 — Project list response shape is not pinned down

**Severity: minor.** 2026-07-28.

We could not determine a guaranteed envelope for `GET /user/projects`, so the
client normalises three shapes: a top-level array, `{ items: [...] }`, and
`{ projects: [...] }`. Per project it reads `id`, `name` falling back to `title`,
`updated_at` falling back to `updatedAt`, and an optional `description`.
Pagination metadata is likewise unclear; we request `limit=50` and treat that as
the whole library. A documented, versioned schema would let us drop the
defensive normalisation.

#### PROJ-2 — Draft project creation requires an undocumented file trio

**Severity: minor.** 2026-07-28.

`POST /user/projects` accepts a multipart body, and a project that imports a
foreign CAD file needs three parts: `project.toml`, a `main.kcl` entrypoint that
imports the file, and the CAD file itself under a name matching the import. We
reverse-engineered this from Zoo's own API clients:

```kcl
// Entrypoint generated by QuoteReady Studio for an imported CAD file.
import "USB_Holder.step" as part

part
```

```toml
name = "USB Holder"
description = "Uploaded from QuoteReady Studio"

[settings.modeling]
base_unit = "mm"
```

Note the consequence: `main.kcl` here is part of the *project format*, not a CAD
translation. We write it once at upload time and never read it back.

Only STEP, STL, OBJ, PLY and SLDPRT could be referenced this way in our testing;
other formats we can analyse cannot be pushed into a project.

---

## Part 3 — Documentation feedback

Ranked by how much time the gap cost us.

| # | Gap | Where it bit us |
|---|---|---|
| 1 | The copilot websocket's in-band auth frame is not documented | [ML-1](#ml-1--in-band-authentication-is-mandatory-and-undocumented) — looked exactly like a service outage |
| 2 | `{"type":"system","command":"continue"}` after a replay reconnect is not documented | [ML-3](#ml-3--a-resumed-turn-frequently-goes-silent-for-the-rest-of-the-budget) — resumed sockets sat silent |
| 3 | No statement that third-party OAuth tokens cannot reach `/file/*`, `/user/projects` or the ML socket | [AUTH-1](#auth-1--third-party-oauth-tokens-are-rejected-by-every-interesting-endpoint) — architecture had to change |
| 4 | The replay frame's MsgPack encoding is not mentioned | [ML-6](#ml-6--the-replay-frame-is-msgpack-which-is-not-obvious) — wrote a decoder |
| 5 | `current_files` must be byte arrays, not base64 | silent no-op until we matched Zoo's own clients |
| 6 | Backend recycling of long turns is not described as expected behaviour | [ML-2](#ml-2--long-turns-are-killed-every-56-minutes-by-a-zookeeper-recycle) — read as a fatal error |
| 7 | Conversion output size and the `outputs` key are unspecified | [FILE-2](#file-2--conversion-output-size-is-undocumented-and-easy-to-underestimate) — truncated valid responses |
| 8 | The inline-vs-async threshold for file operations is unspecified | [FILE-3](#file-3--the-inlineasync-threshold-is-invisible-to-the-client) |
| 9 | No per-metric source-format matrix | [FILE-4](#file-4--format-coverage-per-metric-is-unstated) |
| 10 | Project-creation multipart contract for imported geometry is undocumented | [PROJ-2](#proj-2--draft-project-creation-requires-an-undocumented-file-trio) |
| 11 | Beta gating on `/ml/convert/proprietary-to-kcl` is invisible and indistinguishable from an auth error | [FILE-1](#file-1--mlconvertproprietary-to-kcl-stays-403-even-with-a-personal-api-token) — a feature was built and then deleted |
| 12 | Error bodies sometimes use `message`, sometimes `error` | we read both defensively |
| 13 | No documented rate-limit headers or backoff guidance | we chose our own budgets blind |
| 14 | Credits-to-minutes relationship on `/user/payment/balance` is implied, not stated | our "minutes remaining" badge may drift if accounting changes |

### What Zoo's API does well

Worth saying, because it is why the product exists:

- **The File API removes the need for a local CAD kernel.** Four HTTP calls
  replace an entire geometry stack. That is the whole reason a small web app can
  measure a STEP file at all.
- **Per-operation independence maps beautifully onto an evidence model.** Because
  each metric fails on its own, we can show "volume measured, mass unavailable"
  honestly instead of failing the analysis. Several of our product decisions were
  *enabled* by that shape.
- **Async operations expose stable ids** that we retain in report traces, which
  makes an analysis auditable months later.
- **The conversion endpoint is doubly valuable.** We asked it for a preview and
  got the input to an entire technical-drawing pipeline: the glTF mesh is what
  the ISO A3 sheet is projected from.
- **One identity spans everything** — profile, projects, geometry, ML, billing —
  so a single Zoo account cleanly scopes a whole workspace with no local user
  table.
- **The copilot's structured-answer behaviour is genuinely good.** Asked for
  strict JSON with `forced_tools: []`, it reliably returns parseable JSON, which
  is what makes the datum/tolerance feature and the bounded pricing contract
  possible.

---

## Part 4 — What we would like from the API

In rough order of how much it would improve a third-party integration:

1. **Scopes that match the endpoints** — a `projects` and an `ml` scope, so an
   OAuth app can act on the user's behalf without asking for a pasted API token.
2. **Copilot sessions that survive a backend refresh**, or a first-class
   `reconnect_required` frame plus a documented resume handshake.
3. **A documented websocket handshake**, including the in-band auth frame, the
   `continue` command, and the replay frame's encoding.
4. **Explicit gating errors** — a distinct code for "this endpoint is in beta and
   your account is not enrolled", plus a visible beta list on the account page.
5. **A format capability matrix** per file endpoint, ideally machine-readable.
6. **URL-based outputs for large conversions** instead of base64-in-JSON.
7. **Rate-limit headers** (`X-RateLimit-*` or equivalent) and documented backoff.
8. **A versioned Projects schema** with clear pagination.
9. **Consistent error bodies** — one field name for the human-readable reason.

---

## Part 5 — Reproducing our observations

### Where to look in the code

| Observation | File |
|---|---|
| Metric requests, polling, validation, partial-failure traces | `apps/web/lib/zoo.ts` |
| Conversion request, async polling, response ceiling | `apps/web/lib/zoo-model.ts` |
| OAuth exchange, refresh, revoke, session sealing | `apps/web/lib/zoo-auth.ts` |
| Personal-token resolution and ownership verification | `apps/web/lib/zoo-projects.ts` |
| Copilot protocol, reducer, replay, reconnect, diagnostics | `packages/core/src/zoo-copilot.ts` |
| Pricing prompt and response contract | `packages/core/src/pricing.ts` |
| Drawing-table and drawing-chat prompts | `apps/web/lib/drawing-generation.ts` |
| Frame-reducer and replay unit tests | `packages/core/tests/zoo-copilot.test.ts` |
| Opt-in live copilot contract test | `packages/core/tests/zoo-copilot.live.test.ts` |

`packages/core/tests/zoo-copilot.test.ts` encodes most of the findings above as
assertions: the auth-frame ordering, the reconnect classification of
`connection interrupted`, replay-state reset with harvesting, and the diagnostic
string. If Zoo changes any of that behaviour, those tests are where it will show.

### Reproduction template

Use this when filing a Zoo integration issue. Never include bearer tokens or
customer geometry in a public report; quote `session_data.api_call_id` instead.

```markdown
### Short title

- Date/time and timezone:
- QuoteReady Studio revision:
- Environment: local / container / deployed
- Zoo endpoint (and websocket query string, if any):
- Token type: third-party OAuth / personal API token
- CAD format and synthetic fixture description:
- File size:
- Sanitized query parameters:
- Initial HTTP status (or websocket close code):
- Operation ID / session_data.api_call_id:
- Observed frame or status sequence:
- Duration and reconnect count:
- Expected behavior:
- Actual behavior:
- Sanitized response shape:
- Reproduction count:
- Workaround or fallback observed:
```

### Safe fixture matrix

Keep synthetic, non-confidential fixtures for:

| Fixture | Format | Purpose |
|---|---|---|
| Solid cube | STEP | Baseline volume / surface / centre / mass |
| ASCII and binary solids | STL | Parser behaviour |
| Simple mesh | OBJ / PLY | Mesh metric support |
| Part with a pocket array | STEP | Conversion → drawing pipeline, section A-A |
| Deliberately invalid header | each accepted format | Local signature rejection |
| Valid extension, wrong content | mixed | Mismatch rejection |
| Near-20 MiB synthetic model | any supported | Streaming-limit boundary |
| Long-running operation fixture | any supported | Deadline and polling behaviour |

Do not run volumetric tests against public or production targets without
explicit authorisation. Prefer bounded fixtures, and record exact values and
cleanup.

---

## Related documents

- [Zoo Agent contract](ZOO_AGENT.md) — the pricing prompt, validation rules and
  fallback behaviour in full.
- [Architecture](ARCHITECTURE.md) — where each Zoo call sits in the request flow.
- [Internal HTTP API](API.md) — the routes that wrap these calls.
- [Limitations](LIMITATIONS.md) — product boundaries that follow from the
  findings above.
