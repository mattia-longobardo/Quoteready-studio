# Contest demonstration guide

## Demonstration goal

The demo should prove one coherent claim: QuoteReady Studio turns incomplete
manufacturing intent and real Zoo geometry evidence into a constrained,
traceable planning record **and a real technical drawing**, while remaining
useful when the AI layer cannot refine the plan.

The strongest sequence is **one part, planned twice**: an open route comparison
first, then the same RFQ replanned against a factory that now exists. Live
geometry proves the Zoo File API integration, the walk through readiness,
questions, routes and pricing shows the reasoning, and the two artefacts — the
A4 engineering report and the ISO A3 drawing sheet — prove the output leaves the
tool. Adding machines in the middle is what turns a route comparison into a
factory-aware estimate, and the difference lands on the same part, in the same
session.

> The recorded walkthrough is [`contest/demo.mp4`](../contest/demo.mp4), also
> attached inline on the GitHub README. Keep this script and the video in
> agreement; if the product changes, re-record rather than narrating around it.

### Recorded walkthrough chapters

`contest/demo.mp4` — 1 min 15 s, 1920×1080, H.264, ~6 MB, no audio: on-screen
captions carry the narration. The cut is variable-speed — waits (geometry
analysis, report and drawing generation, repetitive machine entry) run up to
10× while every result screen stays at a readable pace.

| Time | Chapter |
|---|---|
| 0:00 | The `/login` gate — every view is behind a Zoo sign-in |
| 0:02 | Overview: the workspace and the part-to-production decision chain |
| 0:04 | Planning: `USB Holder.step` plus the RFQ — material, quantity, units, tolerance, finish, notes. With no machines saved, the target process stays an open comparison |
| 0:11 | Live analysis against the Zoo File API (compressed); the upload appears in **04 Parts** while the run continues |
| 0:16 | The result: readiness score and evidence, questions before quotation, five priced routes, the selected route operation by operation, and the API trace |
| 0:27 | **06 Results**: the saved record, promoted to a detailed AI report |
| 0:30 | **05 Drawings**: the same part handed to the copilot for datums and tolerances |
| 0:32 | **08 My factory**: four machines added on camera — mill, laser, press brake, inspection cell |
| 0:41 | Back to Planning: the target process now offers **My Factory** and defaults to it; the same part is replanned, with the overwrite confirmation |
| 0:49 | While that runs: the finished engineering report opened from **07 Reports** |
| 0:55 | The factory-scoped plan — three routes instead of five, every card `In factory`, factory rates in the estimate, and the readiness check *Manufacturing scoped to My Factory* |
| 1:03 | The A4 report PDF |
| 1:08 | The ISO A3 drawing sheet PDF — first-angle views, section A-A, GD&T frames, ISO 7200 title block |

The recording is a live-geometry run end to end: real Zoo File API metrics, the
real Zoo ML copilot for the drawing table, and both PDFs rendered by the
deployment's own Chromium. No part of it is sample mode.

## What the presenter must not claim

- Zoo project selection does not import geometry; a local CAD upload remains
  necessary.
- Drawing *checks* establish presence and file signature, not semantic agreement
  with CAD or RFQ requirements — that is the uploaded drawing, and it is a
  different thing from the drawing the product generates.
- The *generated* drawing sheet is a reviewable proposal, not a released
  engineering drawing. It is projected from a tessellated mesh, so curved edges
  are polylines, and there is no hole, thread, fillet or diameter recognition.
- Readiness is an evidence gate, not manufacturing approval.
- Price and lead-time ranges are indicative planning estimates, not quotes.
- Factory availability means operation coverage, not real-time scheduling.
- Missing feature-level DFM checks must be presented as risks or future work.
- There is no anonymous mode — do not promise a signed-out walkthrough.

## Pre-demo checklist

Complete this at least 30 minutes before presenting:

- [ ] Public health endpoint returns 200 — and remember it proves only that the
      Node process answers, not that Postgres, MinIO or Zoo are reachable.
- [ ] All long-lived containers are healthy and logs show no repeated failures.
- [ ] Browser can complete Zoo OAuth with `user:read modeling`.
- [ ] A **personal Zoo API token** is saved in Settings for the demo account, or
      the library, uploads and drawing features will refuse.
- [ ] The Zoo credit balance is sufficient — check the top-bar badge.
- [ ] Zoo projects load for the demonstration account.
- [ ] A small non-confidential STEP/STL/OBJ/PLY file is available locally.
- [ ] Optional drawing is a safe PDF/PNG/JPEG fixture.
- [ ] A complete RFQ and an intentionally incomplete RFQ are prepared.
- [ ] **My factory is empty** at the start — the before/after only reads if the
      first plan is genuinely unscoped. Machine profiles are prepared on paper
      (name, process, hourly rate, setup minutes, materials) so they can be
      typed in without hesitating.
- [ ] A part with a **ready drawing table** already exists as a fallback, so the
      copilot's minutes-long generation is not on the critical path.
- [ ] One drawing PDF has been downloaded successfully today, proving Chromium
      works in this deployment.
- [ ] An OpenAI key is configured if the detailed report will be shown.
- [ ] One previously saved result is available as a recovery path.
- [ ] Browser zoom is 100%, viewport is readable, and notifications are hidden.
- [ ] The presenter knows where deterministic and AI provenance are shown.

Do not use a customer design, a real supplier quote, a production credential, or
a secret-bearing browser profile.

## Recommended assets

Use a compact machined bracket or adapter with enough geometric complexity to
make route comparison plausible. Prepare:

| Asset | Purpose |
|---|---|
| `USB Holder.step` (the recorded fixture) | Primary live geometry fixture — slots and pockets, 0.18 MB |
| `bracket-drawing.pdf` | Shows uploaded-drawing presence handling |
| Complete RFQ | Demonstrates a high-readiness package |
| Incomplete RFQ | Demonstrates evidence deductions and questions |
| CNC mill + laser + press brake + inspection cell | The four capabilities that make the hybrid and CNC routes run end to end in-house |
| A machine with no matching capability (e.g. none for turning) | Keeps two routes outside the factory, so the narrowing is visible |
| A part with a ready drawing table | Removes the copilot's generation time from the critical path |

Prefer a part with a few pockets or slots over a plain block: pocket recognition
is what makes the generated drawing look like a drawing rather than an outline.

Keep the CAD below a few MiB so network variation does not dominate the demo.

## Primary script — the recorded order

This is the sequence in `contest/demo.mp4`, expanded with what a presenter says
out loud. The video runs 1:15; presenting it live with commentary, at the unhurried pace
the headings below assume, takes about seven minutes.

### Chapter 1 — The gate and the promise

Say:

> A CAD file alone is not quote-ready. QuoteReady Studio combines measured Zoo
> geometry, declared RFQ requirements, deterministic engineering rules,
> factory capability, and a constrained Zoo Agent review into one traceable
> manufacturing plan.

Start on `/login`: every view is behind a Zoo sign-in, Authorization Code with
S256 PKCE, and the session is a sealed HttpOnly cookie. Sign in, then let the
Overview name the decision chain — source geometry, plan routes, fit factory,
release report — before anything is clicked.

Mention the personal Zoo API token in Settings and why it exists: Zoo's
third-party OAuth scopes do not cover the File, Projects or ML endpoints, so a
personal token is required for the library, uploads and the drawing features.
This is a genuine integration finding, not a workaround to apologise for — see
[Zoo API notes](ZOO_API_NOTES.md#auth-1--third-party-oauth-tokens-are-rejected-by-every-interesting-endpoint).

### Chapter 2 — The RFQ, deliberately unscoped

In **02 Planning**, attach the CAD file and enter:

- part name;
- material;
- quantity;
- units;
- tolerance;
- finish;
- short notes.

Leave the target process on *Let QuoteReady Studio propose* and say why it is
the only option on screen: **this workspace has no machines yet**, so there is
nothing to scope the plan to. That sentence is the setup for the whole demo.

### Chapter 3 — Live geometry

Start the live analysis. While it runs, explain that the server:

1. streams and bounds multipart input;
2. validates supported formats and representative signatures;
3. uploads CAD to Zoo File API;
4. polls volume, surface area, centre of mass, and optional mass in parallel;
5. preserves partial metric outcomes in an operation trace;
6. derives readiness only from measured and declared evidence.

Switch to **04 Parts** mid-run to show the upload tracked as a part while the
analysis continues — the planner state is a module store, so navigating away
does not cancel anything. Then come back.

### Chapter 4 — Readiness, questions, routes, price

When the report appears, walk it in order:

- readiness score, status pill, and the *Live Zoo geometry* provenance badge;
- measured volume, surface area and mass, next to the checks they came from;
- every readiness check with its source and the evidence behind it;
- the questions the RFQ still has to answer before anyone quotes;
- five deterministic candidates — none of them marked `In factory` yet;
- the selected route operation by operation, with setup and cycle minutes,
  reasons and risks;
- the traceability panel: which Zoo endpoints ran, their status and duration,
  and the assumptions the estimate rests on.

Explain the guardrail while the routes are on screen:

- route IDs, operation sequences, suitability, and factory coverage come from
  deterministic planning, computed before any AI call;
- the pricing prompt receives structured context and those candidates — not raw
  CAD or drawing bytes;
- a response may refine only approved narrative and bounded numeric fields;
- unknown routes, malformed output, unsafe prices, or unsafe lead times are
  rejected;
- rejection returns the complete deterministic plan with a visible reason.

### Chapter 5 — The record, the report and the drawing

In **06 Results** the analysis is already a saved record: `{part}_{date}` title,
route, estimate, status and folder/archive/trash lifecycle. Promote it to a
detailed engineering report — the AI writes it server-side and keeps writing
while you navigate away.

In **05 Drawings**, hand the same part to Zoo's copilot for the datum reference
frame and the tolerance table. Say the key sentence explicitly:

> The views are projected from the mesh Zoo's conversion API returned, and the
> tolerances come from Zoo's ML copilot. There is no CAD kernel in this
> application at all.

State the boundary in the same breath: this is a reviewable proposal projected
from a tessellated mesh, so curved edges are polylines and there is no hole or
thread recognition. An engineer must validate it before release.

### Chapter 6 — Teach it the factory

Open **08 My factory** on the empty state and add the machines on camera. Each
one carries a process capability, an hourly rate, a setup time, its material
coverage and its enabled state:

| Machine | Capability | Rate | Setup |
|---|---|---|---|
| Haas VF-2 SS | CNC milling | €82/h | 40 min |
| Trumpf TruLaser 1030 | Laser cutting | €95/h | 20 min |
| Amada HFE 1303 press brake | Sheet metal | €68/h | 25 min |
| Deburr + CMM inspection cell | Finishing and inspection | €46/h | 10 min |

Nothing here covers turning or additive — that is deliberate, and it is what
keeps two of the five routes outside the factory in the next step.

### Chapter 7 — The same part, planned on real machines

Back in **02 Planning**, the target process now offers **My Factory** as the
first option *and defaults to it*, because the workspace owns enabled machines.
Cycle the select once so the audience sees it is a choice, not a lock, then
replan the same part. Confirm the duplicate-name overwrite: the new part takes
the name, and the superseded part is hidden rather than deleted, so the earlier
result, drawing and report keep resolving to the geometry they were built from.

While the analysis runs, open **07 Reports** and show the engineering report the
AI finished in the background: cover, RFQ data, measured geometry, route
comparison with costs, the recommended route breakdown, risks and assumptions.

Then return to the plan and land the point:

- the comparison came back with **three routes instead of five**, and every card
  is marked `In factory`;
- the summary says the estimate is restricted to routes the factory can run end
  to end;
- the rates and setup times in those estimates are the ones just typed in, not
  benchmarks;
- readiness records the decision itself: *Manufacturing scoped to My Factory*.

Clarify that factory availability is an operation-coverage check, not a
production schedule.

### Chapter 8 — The artefacts leave the tool

Download both PDFs and show them full screen:

- the **A4 engineering report**, server-rendered by the deployment's Chromium;
- the **ISO A3 drawing sheet**: first-angle front, left, top and isometric
  views plus section A-A; balloons whose numbers are the dimension-table row
  numbers, so the sheet and the inspection table cannot disagree; ISO 1101
  feature control frames and ISO 5459 datum indicators; the ISO 7200 title
  block with the chosen scale.

Close with:

> The result is not a magic quotation. It is a transparent first engineering
> pass that tells a team what is known, what is missing, which processes are
> plausible, what the indicative range is, and what must be reviewed next.

## Ten-minute extended script

Use the primary flow, then add:

1. an incomplete RFQ that moves the report to `review` or `blocked`;
2. **Run sample** — the deterministic path that sends no geometry at all and
   therefore still answers when the Zoo File API is slow or unavailable;
3. the Zoo library: select a project and show its name/ID carried into the plan
   as traceability context, while stating that geometry still arrives by local
   upload;
4. the 3D preview in **04 Parts** — Zoo's own CAD→glTF conversion, served back
   from the blob store;
5. a drawing-chat request in plain language, and the table updating with the
   agent's one-sentence explanation;
6. attachments and a re-run producing a linked revision;
7. the folder, archive and trash lifecycle;
7. API and security limits from the documentation;
8. the Zoo API findings — AUTH-1 and ML-1 are the two worth naming out loud;
9. a brief roadmap for semantic drawings, deeper DFM, exports and shared
   coordination.

## Deterministic recovery demonstration

Do not manufacture an outage during a live presentation. Use one of these safe
paths:

1. open a previously saved result whose provenance records a real fallback;
2. run sample mode, which sends no geometry and therefore completes even when the
   File API is unavailable;
3. use the automated contract tests to show that unknown routes and out-of-range
   prices are rejected.

The point is not that a provider failed. The point is that unsafe or unavailable
refinement cannot bypass the baseline engineering model.

Note the deliberate asymmetry, and say it if asked: pricing has a deterministic
fallback because a bounded engineering estimate exists, but drawing generation
has none, because there is no honest way to invent a datum scheme. A failed
drawing is shown as failed.

## Expected results by scenario

| Scenario | Expected outcome |
|---|---|
| Any view without a session | Redirect to `/login` |
| Signed-in sample | Report may use the Zoo agent and persists |
| Live without session | 401 before the upload body is read |
| Live with supported CAD | Zoo metrics, audit, routes, saved result, glTF preview |
| Missing solid volume | `blocked` with an explicit evidence failure |
| Missing tolerance/drawing/finish | Score deductions and clarification questions |
| Zoo metric partial failure | Successful metrics retained, failed trace visible |
| Pricing agent unavailable or invalid | Complete deterministic plan with a fallback reason |
| Route lacks machine coverage | `availableInFactory: false` |
| Workspace has no enabled machine | The target process select has no **My Factory** option and the plan compares every route |
| Target process **My Factory** | Only routes whose every operation runs on an enabled machine are compared, the summary says the estimate is restricted to them, and readiness records *Manufacturing scoped to My Factory* |
| **My Factory** with no route runnable end to end | Every route is compared instead, with the reason stated in the plan summary |
| Duplicate part name | 409 with an overwrite confirmation; previous part hidden, not deleted |
| Drawing generated | Datum table, tolerance rows, downloadable A3 sheet |
| Drawing generation fails | Status `failed` with the real error — no invented datums |
| Part without an archived glTF | Sheet still renders, with the reason printed and scale `NTS` |
| Re-run after attaching a note | New linked result, source untouched |
| No personal Zoo API token | Library, upload, drawing generation and chat refuse with guidance |
| No Chromium in the deployment | Both PDF routes return 503; HTML views still work |
| Store or object quota reached | Explicit conflict; no silent data loss |

## Presenter answers to likely questions

### "Why not let the AI invent the process plan?"

The deterministic model owns the candidate set, the operation sequence, the
baseline economics and the safe numeric envelope. The copilot can add useful
manufacturing judgment without creating unknown routes or arbitrary commercial
values. Its output is accepted only inside 0.25×–4× of the deterministic
baseline, with known route IDs and an ordered price range.

### "Is the price accurate?"

It is an indicative range. Accuracy improves when factory rates and setup values,
material, quantity, tolerance, finish and measured mass are known. It still
requires supplier or manufacturing review, and the product never calls it a
quotation.

### "Does the uploaded drawing get checked?"

Its type, signature and presence are checked. Dimensions, GD&T, revisions and
contradictions are not interpreted. That is separate from the drawing the product
*generates*, which is described below.

### "Is the generated drawing real?"

The sheet is a genuine ISO A3 layout — first-angle views, a section, ISO 129
dimensions, ISO 1101 feature control frames, ISO 5459 datum indicators, ISO 6433
balloons tied to the table, an ISO 7200 title block. What it is not is a released
drawing: the views are projected from a tessellated mesh, so curved edges are
polylines, and there is no hole, thread, fillet or diameter recognition. Treat it
as a reviewable first draft that removes an hour of drafting.

### "Where does the drawing geometry come from?"

From Zoo. The CAD file goes through `POST /file/conversion/{src}/gltf`, and the
returned mesh is what every line on the sheet is projected from. There is no CAD
kernel in this application.

### "Can I analyse a Zoo project directly?"

Project selection provides source traceability and planner context. Live metrics
still require a local CAD upload.

### "Why does it ask for a personal Zoo API token?"

Because Zoo's third-party OAuth scopes (`user:read`, `modeling`) do not authorise
`/file/*`, `/user/projects` or the ML copilot socket — those return 403 for an
OAuth token. This is documented as finding AUTH-1 in
[Zoo API notes](ZOO_API_NOTES.md). The token is verified to belong to the
signed-in account and sealed at rest.

### "What happens when Zoo is slow?"

Metric calls share a global 45-second deadline with bounded polling, and partial
outcomes are recorded as traces. The pricing agent falls back deterministically.
The copilot client survives Zoo's mid-turn backend recycling by reconnecting with
replay. Live geometry has no offline replacement, so a missing volume can block
readiness.

### "Can this run multiple replicas?"

Not safely today. The Postgres driver makes the *store* replica-safe, but rate
limits, single-flight locks and background-job de-duplication are still
process-local. The roadmap replaces them with shared services before horizontal
scaling.

## Demo failure matrix

| Failure | In-room response | Recovery path |
|---|---|---|
| Public route unavailable | Show internal health only if appropriate; do not expose host ports | Play `contest/demo.mp4` and walk the documentation |
| OAuth unavailable | Explain the PKCE flow from the diagram | Use an already-signed-in session or the recording |
| Personal Zoo token rejected | State finding AUTH-1 plainly; it is a real integration constraint | Use pre-generated drawings and saved results |
| Zoo credits exhausted | Show the usage badge and explain metering | Use saved results and pre-generated drawings |
| Zoo projects unavailable | Continue with local CAD | State that project listing is independent of upload |
| Live metric timeout | Show the partial trace or a saved live result | Run sample mode and explain deadline behaviour |
| Pricing fallback triggers | Treat it as the guardrail demonstration | Show deterministic candidates and the stored reason |
| Drawing generation slow or failing | Open the pre-generated drawing instead | Explain the 5-minute budget and the zookeeper recycle |
| PDF returns 503 | State that Chromium is missing in that deployment | Show a previously downloaded PDF |
| Browser state issue | Open a clean private window and sign in | Use the prepared saved result |
| Store write conflict | Do not edit the database live | Show the result, diagnose after the demo |

Prepare a short screen recording of the complete successful live path — this is
what `contest/demo.mp4` is for. It is a recovery asset, not a substitute for
disclosing what is live in the room.

## Evidence package for submission

Include:

- the public repository and its licence;
- the [README](../README.md) and the [documentation index](INDEX.md);
- setup, OAuth and personal-token instructions;
- architecture and trust-boundary diagrams;
- reproducible sample and live demo steps;
- [Zoo API notes](ZOO_API_NOTES.md) — the findings, bug reports and
  documentation feedback, which are a scored criterion in their own right;
- `contest/demo.mp4`, linked from the README and attached inline on the GitHub
  README so it plays without a download;
- screenshots of sample mode, live metrics, route comparison, the 3D preview, the
  generated drawing sheet, the factory profile and the result history;
- one exported A3 drawing PDF and one A4 report PDF as artefacts;
- automated check results from the submitted revision (see the release template
  in [Testing](TESTING.md#release-verification-template));
- candid [limitations](LIMITATIONS.md) and the [roadmap](ROADMAP.md);
- the public social or community link required by the contest.
