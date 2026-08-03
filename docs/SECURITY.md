# Security and privacy

## Security posture

QuoteReady Studio is a contest-scale, single-container application with real
OAuth tokens, customer metadata, CAD uploads, factory costs, and report history.
The implementation applies defense in depth at browser, request, provider,
persistence, and container boundaries. It should still be treated as a
pre-production system until the residual risks in
[Security review](SECURITY_REVIEW.md) are addressed.

## Protected assets

- Zoo access and refresh tokens;
- OAuth state and PKCE verifier;
- Zoo user identity;
- **each user's personal Zoo API token and OpenAI API key**, which are stored at
  rest rather than only held in a cookie;
- customer CAD and optional drawing bytes, both in transit and — by default in
  the deployed stack — archived in the blob store;
- generated glTF preview models and result attachments;
- RFQ requirements and notes;
- factory capabilities, rates, and setup time;
- report history, route selections, estimates, and trace data;
- the session-encryption secret, which is also the key material for the two
  stored user secrets above;
- the Postgres and MinIO credentials in the deployment `.env`;
- availability of the service and its data layer.

## Threat actors and assumptions

The model considers:

- an anonymous internet user;
- a malicious site targeting a signed-in browser;
- a normal authenticated user abusing inputs, request volume, or quotas;
- malformed, slow, oversized, or compromised upstream responses;
- accidental operator errors and corrupted local persistence;
- theft of host files or runtime secrets.

The Docker host, Traefik configuration, environment-secret delivery, and Zoo
service are trusted but defended as separate boundaries. A fully compromised
host or leaked session secret is outside what application validation can
contain.

## Authentication and session controls

- Authorization Code with S256 PKCE;
- random state and verifier/challenge values;
- state equality and 10-minute transaction expiry;
- exact configured redirect URI;
- least required `user:read modeling` scopes;
- 15-second token/profile request timeouts;
- bounded token and profile responses;
- AES-256-GCM encrypted and authenticated cookies;
- `HttpOnly`, `SameSite=Lax`, root path, and production `Secure` flag;
- maximum 30-day absolute session lifetime;
- refresh near token expiry without extending absolute lifetime;
- local invalidation on malformed/expired session or failed refresh;
- access and refresh token revocation on logout when available.

The session endpoint returns only authentication state and bounded profile
fields. Token values never appear in its response.

### Secrets at rest

Two user-supplied secrets are persisted rather than kept in a cookie: the
personal Zoo API token and the OpenAI API key. Both are sealed with the same
AES-256-GCM envelope used for cookies — key derived by SHA-256 from
`QUOTE_READY_SESSION_SECRET`, `v1` version prefix, random 12-byte IV,
authentication tag — *before* they reach the workspace store, and are unsealed
only server-side at the moment of use. The settings API returns
`hasZooApiToken` and `hasAiApiKey` booleans and never the values.

A personal Zoo API token is additionally verified against `GET /user` before it
is used, and accepted only when it belongs to the signed-in Zoo account
(10-minute ownership cache). One user's token can therefore never be used to act
as another.

Two operational consequences follow, and both are easy to get wrong:

- **Rotating `QUOTE_READY_SESSION_SECRET` destroys every stored user secret**,
  not just active sessions. Users must re-enter their tokens, and the
  `has…` flags will still read `true` until they do.
- **Backups of the workspace store are secret-bearing.** They decrypt only with
  the matching session secret, which should be backed up separately and with at
  least the same protection.

## Cross-site request protection

State-changing endpoints compare the request `Origin` against:

- the origin of `ZOO_OAUTH_REDIRECT_URI`;
- the forwarded host/protocol origin;
- the request URL origin.

Missing or unknown origins return `403`. This applies to analysis, logout,
factory mutations, and report mutations. Cookies also use `SameSite=Lax`.

Traefik must overwrite or sanitize forwarded headers; the application assumes
its trusted proxy supplies the externally visible host and protocol.

## Browser security policy

`next.config.ts` applies the following repository-defined headers to every
application path:

- Content Security Policy with `default-src 'self'`, `base-uri 'self'`,
  `object-src 'none'`, `frame-ancestors 'none'`, and `form-action 'self'`;
- scripts restricted to self, inline framework code, and the Cloudflare
  Insights script origin;
- styles restricted to self and inline styles;
- images/fonts restricted to self and `data:`;
- connections restricted to self and Cloudflare Insights;
- `Cross-Origin-Opener-Policy: same-origin`;
- `Cross-Origin-Resource-Policy: same-origin`;
- `Permissions-Policy` denying camera, microphone, geolocation, payment, and
  USB;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- one-year `Strict-Transport-Security`;
- `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`;
- removal of the framework-powered response header.

Zoo HTTP/WebSocket calls are server-side and therefore do not require browser
CSP connection allowances. The 3D part preview does: `<model-viewer>` needs
`connect-src data:` (THREE.GLTFLoader fetches the glTF's embedded
`data:` buffer), `script-src 'wasm-unsafe-eval'` for its WebAssembly helpers,
and the existing `img-src`/`worker-src blob:` allowances. The inline
script/style allowances remain a hardening opportunity; future work should
adopt nonces/hashes when compatible with the framework and edge analytics.

## Request and resource controls

### JSON

- strict `application/json` content type;
- `Content-Length` sanity check;
- streaming byte count for chunked bodies;
- 32 KiB default and 16 KiB demo ceilings;
- object-only JSON;
- unknown RFQ fields rejected.

### Multipart

- live authentication before body consumption;
- 32 MiB complete request ceiling, even without `Content-Length`;
- 20 MiB CAD and 10 MiB drawing ceilings;
- maximum 2 files, 12 fields, and 14 parts;
- bounded field names and values;
- duplicate field/file rejection;
- unexpected file rejection;
- extension allowlist and format-specific leading-content checks;
- PDF/PNG/JPEG drawing signature checks.

### Rate and concurrency

All windows are 60 seconds and keyed per Zoo user.

| Limit | Routes |
|---:|---|
| 10 | sample analyses (per session, or per normalised proxy client key when anonymous) |
| 6 | live analyses |
| 6 | 3D-part replacements |
| 6 | drawing-chat turns |
| 6 | PDF renders (report documents and drawing sheets share the key) |
| 5 | Zoo project uploads |
| 4 | analysis re-runs |
| 4 | drawing-table generations |
| 3 | detailed-report generations |
| 30 | factory mutations |
| 30 | result-attachment writes |
| 40 | result mutations |
| 40 | part mutations |

Single-flight keys admit one in-process execution each and answer `409`
otherwise: `analysis:{user}` (shared by a live analysis and a re-run, so the two
can never run concurrently for one account), `report-doc:{user}`,
`drawings:{user}` and `drawing-chat:{user}:{drawing}`.

Expired buckets are swept periodically. The rate map is capped at 10,000
identities and rejects new identities with `503` when a full map has no expired
entry to reclaim. These maps live in process memory, do not coordinate across
replicas, and reset on restart. Anonymous sample identity prefers the trusted
`CF-Connecting-IP`, falls back to the first `X-Forwarded-For` value, and strips
non-address characters before keying.

## Provider boundary controls

### Zoo

- fixed outbound hosts (`api.zoo.dev` over HTTPS and WSS);
- bearer tokens only in authorization headers, and — on the copilot socket — in
  the in-band authentication frame Zoo requires;
- no-store request caching;
- request timeouts and one 45-second shared deadline across all metric calls;
- 18 polls per metric at 500 ms intervals;
- bounded responses: 128 KiB per file operation, 48 MiB per glTF conversion,
  512 KiB per project list, 256 KiB for profile, project creation and balance,
  64 KiB for OAuth token responses;
- copilot socket: 16 MiB per frame, 256 KiB cumulative text, 30 s ping keepalive,
  5-minute stall watchdog, at most 6 reconnects;
- JSON object and finite/range validation for geometry metrics;
- per-metric failure traces rather than fabricated values;
- a strict route, numeric, text, price and lead-time contract on agent output;
- deterministic fallback on any pricing-agent failure.

Raw CAD bytes are sent to the Zoo File API for measurement and conversion. The
**pricing** prompt receives only structured RFQ, geometry and route context — but
the **drawing-table** prompt uploads the part's raw CAD file to the ML copilot,
because the agent cannot pick datums without geometry. Neither prompt ever
receives the uploaded PDF/PNG/JPEG drawing or machine names and notes.

### OpenAI

Detailed reports are the one non-Zoo egress, and only when the user has stored
their own key and left AI reports enabled:

- fixed host `https://api.openai.com/v1/chat/completions`;
- the user's own key, sealed at rest and used server-side only;
- 180-second timeout and a 2 MiB response ceiling;
- the prompt carries the analysis JSON — RFQ fields, geometry, checks, questions,
  assumptions, plan and traces — plus attachment captions and file names, but no
  file bytes;
- the returned HTML is stripped of `<script>` elements, inline event handlers and
  `javascript:` URLs, capped at 500 KiB, and rendered in a sandboxed iframe.

### Headless Chromium

PDF rendering is a local subprocess boundary, not a network one:

- page JavaScript is disabled and content loading is capped at 30 seconds;
- each browser gets a private temporary profile with its user-data, crash-dump
  and cache directories redirected into it;
- the Chromium sandbox is disabled, because the container drops all capabilities
  and runs unprivileged — the sanitisation above and the disabled JavaScript are
  the compensating controls;
- a missing binary degrades to `503` instead of failing open.

## Persistence controls

- the workspace key is the server-validated Zoo user ID;
- one versioned store schema with structural validation on load;
- per-workspace object quotas: 250 results, 250 documents, 250 parts,
  100 drawings, 200 folders, 100 machines, 20 attachments per result;
- 64 MiB serialised-workspace ceiling — per user row on Postgres, for the whole
  file on the JSON driver;
- mutation isolation: a `SELECT … FOR UPDATE` row lock on Postgres, or one
  process-wide promise queue plus a mode-`0600` temp file and atomic rename on
  the JSON driver;
- folder membership and selected-route membership are validated against the same
  workspace;
- IDs and timestamps have route-level format and length bounds;
- blob keys are pattern-checked, traversal-checked and filename-sanitised before
  reaching any backend, and the filesystem driver additionally verifies path
  containment.

CAD and drawing bytes are never written into the *workspace* store — it holds
only blob keys. The bytes are written to the *blob* store: always for part-source
CAD needed by re-runs and drawing tables, for glTF previews and for result
attachments, and additionally for the analysed CAD and drawing when
`QUOTEREADY_PERSIST_UPLOADS=true`, which is the deployed default. Blob storage
has no expiry, lifecycle rule or per-user byte quota.

## Container and network controls

- unprivileged `1000:1000` runtime user;
- `no-new-privileges` and all Linux capabilities dropped;
- `init: true` for correct signal handling and reaping;
- no published host port on any service;
- only the application joins the external Traefik `proxy_public` network; the
  database and object store sit on `quoteredy_internal`, declared
  `internal: true`, so they have no route to or from the internet;
- 2 GiB memory and 2 CPUs for the application (Chromium is a large part of that
  allowance); 1 GiB/1 CPU for Postgres, 512 MiB/0.5 CPU for MinIO;
- healthcheck plus `unless-stopped` restart policy on every long-lived service;
- Docker log rotation: 10 MiB × 3 files;
- persistent data through bind mounts (`./data`, `./postgres`, `./minio`), not
  anonymous or named volumes.

The container is not read-only because it must write `/app/data` and Chromium's
temporary profiles. No Docker socket or host device is mounted.

## Data-flow and retention summary

| Data | Sent out | Stored server-side | Browser-readable |
|---|---|---|---|
| CAD bytes | Zoo File API (metrics + conversion); the ML copilot for drawing-table generation | Blob store — always as part source, plus next to the result when upload persistence is on | Owner only, via the part and attachment routes |
| Drawing bytes | No | Blob store when upload persistence is on, and always when attached to a result | Owner only, via the attachment route |
| glTF preview | Produced by Zoo's conversion API | Blob store | Owner only, via `/api/parts/model` |
| RFQ metadata | Zoo pricing agent; OpenAI when a detailed report is generated | In saved results | Yes |
| Geometry metrics | Produced by the File API; sent to the pricing agent and to OpenAI | In saved results | Yes |
| Factory machine list | Not directly — only route-level availability enters agent context | Yes | Owner only |
| OAuth tokens | Zoo endpoints | Encrypted session cookie only | No JavaScript access (`HttpOnly`) |
| Personal Zoo API token, OpenAI key | The provider they authenticate to | Sealed in the workspace store | No — only `has…` booleans |
| Project list | Produced by the Projects API | No | Owner session only |
| Results and report documents | No complete export to any provider | Yes | Owner only |

Archive and trash are retention states, not deletion. They continue to occupy
the store and report quota. Permanent deletion is not currently exposed.

## Logging guidance

The application should log operational status without recording:

- authorization headers;
- cookies;
- token or profile responses;
- personal Zoo API tokens or OpenAI keys, sealed or plain;
- raw CAD, drawing or glTF buffers;
- complete RFQ notes;
- complete agent or OpenAI prompts and outputs;
- workspace or blob contents;
- database or object-store credentials.

Current container log rotation limits disk growth. Production logging should use
request IDs, normalised event types, status codes, durations, and redacted user
identifiers. Note that the application already logs bounded provider failure
detail (for example a Zoo HTTP status or a copilot diagnostic string); that is
intentional and contains no credential material.

## Secret management

Deployment secrets live in `.env` or the runtime environment, never as Compose
literals. `.env` and `.env.local` are excluded from source control and from the
container build context, as are the `./postgres` and `./minio` runtime
directories.

The deployment secrets are `QUOTE_READY_SESSION_SECRET`,
`DB_QUOTEREADY_PASSWORD` and `QUOTEREADY_MINIO_ROOT_PASSWORD` (the last also
serving as the S3 secret key). Each should be randomly generated and unique per
deployment. There is deliberately **no** deployment-wide Zoo API token: that
credential is per user and lives in the workspace store.

`QUOTE_READY_SESSION_SECRET` must be at least 32 characters. Rotating it signs
out every user **and permanently destroys every stored personal Zoo API token and
OpenAI key** — plan it as a user-visible event, not a routine hygiene task, and
back the secret up with the same care as the data it protects. A production
secret store and a planned rotation procedure are recommended; see
[Operations](OPERATIONS.md).

## User responsibilities

- Upload only data the user is authorised to send to Zoo, and remember that
  generating a drawing table uploads the CAD file itself to Zoo's ML service.
- Enable detailed reports only if sending analysis content to OpenAI is
  acceptable for that data.
- Avoid unrelated confidential information in free-text notes and attachments.
- Treat estimates as preliminary and verify manufacturing assumptions.
- Treat a generated drawing sheet as a proposal requiring engineering review.
- Use a personal Zoo API token scoped to an account the user controls, and revoke
  it at Zoo if it is ever exposed.
- Remove or rotate access after a shared-browser session.
- Report unexpected cross-workspace data, token exposure, or upload behaviour
  privately.

## Security reporting

Report a suspected issue privately to the repository maintainer. Include:

- affected route or workflow;
- environment and revision;
- exact preconditions;
- minimal non-destructive reproduction;
- observed versus expected behavior;
- impact and any evidence of cross-user access;
- suggested mitigation if known.

Do not include real tokens, customer CAD, or private report data. Do not test
availability against a public deployment without explicit authorization.

## Residual risk

The open risks worth naming here:

- rate limiting, single-flight and background-job de-duplication are all
  process-local, so they do not survive a restart or coordinate across replicas;
- headless Chromium renders LLM-authored HTML without its sandbox;
- detailed reports send analysis content to a third-party LLM, and drawing-table
  generation uploads raw CAD to Zoo's ML service;
- blob storage has no expiry, lifecycle rule or per-user byte quota;
- the content security policy still permits inline script and style, one
  analytics origin, and the `wasm-unsafe-eval` / `blob:` / `data:` allowances the
  3D preview needs — there is no nonce or hash policy yet;
- native CAD signature validation is shallow for several binary formats;
- with the JSON driver, one workspace can exhaust the shared 64 MiB ceiling for
  every user.

See [Security review](SECURITY_REVIEW.md) for the evidence, severity and
priorities behind each of these.
