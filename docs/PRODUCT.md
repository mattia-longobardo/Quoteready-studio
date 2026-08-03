# Product specification

## Product statement

QuoteReady Studio is a manufacturing decision workspace that converts part
geometry and RFQ context into a traceable preliminary production plan. It is
designed for the gap between receiving a model and issuing a controlled quote.

The product does not merely answer “is this package ready?” It also answers:

- Which supported manufacturing routes could make the part?
- Which single- or multi-step route best fits geometry and quantity?
- Can the user's configured factory execute every operation?
- What preliminary price and lead-time range should be validated?
- Which requirements, risks, and assumptions must be resolved before quote?
- What evidence should be retained for later review?

## Target users

### Estimator or quoting engineer

Needs a fast, explainable first pass that highlights missing RFQ information,
compares processes, and produces a defensible range without hiding uncertainty.

### Manufacturing engineer

Needs operation-level routes, geometry evidence, process risks, and a clear
distinction between measured facts and assumptions.

### Small manufacturer or job shop

Needs estimates that reflect available machine capabilities, setup time,
hourly rates, and supported materials instead of generic benchmark costs.

### Contest reviewer

Needs a visible, meaningful use of Zoo OAuth, the Zoo File API (metrics **and**
CAD→glTF conversion), the Zoo Projects and Billing endpoints, and the Zoo ML
copilot, with safe failure behaviour and reproducible documentation. The full
endpoint map is in the [README](../README.md#how-quoteready-studio-uses-zoo-apis)
and the integration findings in [Zoo API notes](ZOO_API_NOTES.md).

## Product principles

1. **Evidence before confidence.** Every readiness result identifies its
   source as user input, Zoo measurement, or deterministic rule.
2. **Missing requirements stay missing.** No recommendation silently invents
   material, units, tolerance, finish, or drawing content.
3. **A recommendation remains bounded.** Zoo Agent may refine deterministic
   candidates but cannot introduce a new route or escape price and time bounds.
4. **Factory context is optional and useful.** An empty factory evaluates all
   routes with benchmark rates; configured capabilities improve make-or-buy fit.
5. **Failure is visible.** The report labels its provider and includes a clear
   deterministic fallback reason when required.
6. **Planning is not quotation.** Every price and time is an indicative range
   that requires supplier or factory validation.

## Main workflows

### Run the sample analysis

1. Sign in with Zoo and open **02 Planning**.
2. Choose **Run sample**.
3. The client sends bounded sample metadata to the demo endpoint.
4. The server applies fixed bracket geometry and deterministic evidence rules.
5. The Zoo agent may refine the plan, and the result is saved to the workspace
   like any other analysis.
6. The interface displays routes, estimates, DFM evidence, questions, and
   assumptions.

Purpose: a reviewer can see the complete output shape without having a CAD file
to hand, and without depending on the Zoo File API being reachable.

Access boundary: every view is behind the `/login` gate, so there is no anonymous
path through the product. The `POST /api/analyze?mode=demo` endpoint itself does
tolerate an anonymous caller — in which case nothing is saved and no private
workspace is read — but no interface route reaches it that way.

### Build a live manufacturing plan

1. Connect a Zoo account.
2. Upload a supported CAD file and optionally a drawing.
3. Complete the required package: part name, material, quantity, and units.
   The target process may stay on "Let QuoteReady Studio propose"; general
   tolerance and finish are optional and default to `ISO 2768-m` and
   `As Machined`. The plan does not start while required fields are missing:
   the planner highlights them client-side and the API re-checks server-side.
4. The server validates origin, authentication, rate, concurrency, body size,
   file count, file signature, extension, and RFQ fields.
5. Zoo File API measures geometry under a shared deadline.
6. The audit engine scores readiness and records evidence.
7. The deterministic model constructs five route candidates.
8. Zoo Agent may refine route ranking, price, lead time, rationale, and risks.
9. The response is validated against candidate IDs and engineering bounds.
10. The final report is saved to the authenticated workspace.

The planner state (form, files, running analysis, result) lives outside the
page component: navigating to other sections while a plan is building does
not lose the run — the result is waiting on the Planning page. Only the
explicit **New plan** button resets the planner. The decision output is
ordered readiness evidence → questions before quotation → manufacturing
routes, so blocking gaps are read before prices.

### Detail a part and export a drawing (05 Drawings)

1. Open **Drawings** and select an uploaded part whose CAD file is archived.
2. The Zoo agent inspects the geometry in the background and chooses the datum
   reference frame plus the dimensional and geometric tolerances on its own.
3. The result is a reviewable datum + tolerance table, with notes and the agent's
   reasoning per datum.
4. Refine it conversationally: the drawing chat applies a natural-language
   request ("tighten the bore to H7", "add flatness on the base") to the table
   and answers with what it changed.
5. Export **Download PDF** to get a real ISO A3 landscape technical sheet:
   first-angle front, left, top and isometric views plus section A-A, ISO 129
   dimensions, ISO 5459 datum indicators, ISO 1101 feature control frames, ISO
   6433 balloons cross-referenced to the dimension table, and an ISO 7200 title
   block. The views are projected from the glTF that Zoo's conversion API
   produced from the CAD file, and rendered server-side with headless Chromium.

Boundary: this is a reviewable proposal, not a released drawing. The views come
from a tessellated mesh, so curved edges are polyline approximations, there is no
hole, thread or diameter recognition, and the agent's tolerances are not verified
against process capability. An engineer must validate the sheet before it reaches
a customer or the shop floor.

### Start from the Zoo library

1. Open **Zoo library** after authentication.
2. The product lists up to 50 projects returned by Zoo Projects API.
3. Search and choose a project.
4. QuoteReady Studio pre-fills planner context such as project identity/name.
5. Attach a local CAD file to perform live geometry analysis.

Current boundary: project selection does not download or analyse Zoo-hosted
geometry directly. The local file remains authoritative for the live run.

### Configure the factory

1. Add an enabled machine capability.
2. Select its process and optional material coverage.
3. Enter hourly rate, setup minutes, and operational notes.
4. The deterministic model uses matching enabled machines before benchmark
   rates.
5. A route is marked available only if every operation has a matching machine.

The machine catalogue supports CNC milling, CNC turning, additive, sheet
metal, laser cutting, and finishing/inspection capabilities.

### Revise a result (06 Results)

An analysis is rarely final on the first pass, so a result is a living record:

1. Attach material to it — a supporting drawing or document (PDF/PNG/JPEG) and
   free-text notes, up to 20 attachments per result.
2. Or replace the 3D part itself with a corrected CAD file; the result is then
   marked stale until it is re-run.
3. Re-run the analysis. The attached material is folded into the RFQ context:
   notes and file captions extend `notes`, and an attached drawing satisfies the
   supporting-drawing readiness check. That context reaches both the Zoo pricing
   agent and the AI report writer.
4. The re-run stores a **new** result linked to its source, so history is never
   overwritten. It keeps the source's folder, tags and attachments, gains a
   1-based revision number, and takes today's date in its title.

### Manage reports

The authenticated report workspace supports:

- active, archived, and trash views, plus explicit permanent deletion (empty the
  trash, or purge a folder's contents);
- title updates and tagging;
- root and nested folders, with report-to-folder assignment;
- reversible archive and trash timestamps;
- persisted route selection from the report interface through the reports API;
- server-rendered PDF export — an A4 document for a detailed report, and an A3
  landscape sheet for a technical drawing;
- dashboard counts for non-trashed reports, quote-ready reports, documents, and
  enabled machines.

Every library table (Results, Reports, Parts, Drawings) shares the same
controls: free-text search, a multi-select **Status** filter, a multi-select
**Tags** filter where the collection is tagged, and sortable name / status /
updated columns whose headers align with the row grid (head and rows use
identical, content-independent column tracks).

All file drop zones (planner CAD and drawing, Zoo library upload) accept
drag & drop in addition to the file picker; required planner fields carry a
red "Required" marker.

Detailed AI reports are generated asynchronously: starting one from Results
creates a `generating` document that keeps running while the user navigates;
the Reports page shows live progress, a visible error with a **Retry** action
when generation fails, and enables View/PDF only once the document is ready.
Drawing tables behave the same way.

Generated artefacts are named so several of them stay distinguishable: drawings
and report documents take a sequential `{part}_NN` label, and analysis results
take `{part}_{YYYY-MM-DD}` in the user's own timezone, with the lowest free `_NN`
suffix when a part is analysed more than once in a day.

Re-using a part name is treated as an overwrite and requires explicit
confirmation. On confirmation the previous part is hidden rather than deleted,
along with all of its files, so results, drawings and reports already generated
from it keep resolving to the original geometry.

Structured spreadsheet export and a branded multi-document package are not
currently exposed.

## Evidence and readiness model

The audit engine evaluates these conditions:

| Check | Outcome when missing | Score deduction |
|---|---|---:|
| Readable volume | Fail | 30 |
| Explicit design units | Fail | 18 |
| Known material | Fail | 16 |
| Tolerance strategy | Warning | 12 |
| Production quantity | Warning | 10 |
| Supporting drawing | Warning | 8 |
| Finish requirement | Warning | 6 |
| Mass for a known-density material | Warning | 5 |
| Target process | Always passes — compare all routes | 0 |

Leaving the target process open is deliberately not penalised: it is a fully
supported flow that switches the estimate into route-comparison mode, and the
user picks a route before quoting. Empty tolerance and finish values are filled
with the industry defaults `ISO 2768-m` and `As Machined` at intake, so in a live
run those two checks pass on the defaults and are recorded as such.

Score is `100 - deductions`, with a floor of zero.

- Any failed check makes the report `blocked`.
- Otherwise, any warning makes it `review`.
- With no failures or warnings the report is `ready`.
- At most five clarification questions are returned, prioritised by the order
  of the audit rules.

The drawing check confirms only that a supported document was attached and
that its leading bytes match PDF, PNG, or JPEG. It does not read dimensions,
datums, notes, revisions, or tolerances from the drawing.

## Manufacturing routes

The deterministic model always creates five comparable candidates:

| Route | Operations | Typical intent |
|---|---|---|
| CNC from billet | Fixture → mill → finish/inspect | Strong dimensional control |
| CNC turning + finish | Chuck/setup → turn → finish/inspect | Rotational geometry |
| Additive + finish | Build preparation → print → remove supports/finish | Prototypes and complex geometry |
| Sheet metal formed | Blank/tooling → cut/form → finish/inspect | Thin-wall formed parts |
| Laser + bend + CNC finish | Laser → bend → CNC → inspection | Hybrid batch route with precision features |

Prices combine material assumptions, measured or fallback mass, quantity,
geometry complexity, setup time, cycle-time formulas, finish work, and either
configured or benchmark hourly rates. The result is a minimum, expected, and
maximum EUR range with confidence—not a quotation.

## Report contents

Every analysis response contains:

- analysis mode and source-file metadata;
- RFQ metadata;
- measured or fixed sample geometry;
- readiness score, status, summary, and evidence checks;
- up to five clarification questions;
- assumptions and per-endpoint trace information;
- manufacturing provider label and fallback reason when applicable;
- all route candidates, operations, suitability, factory availability, price,
  lead time, reasons, and risks;
- selected recommended route.

## Success criteria

The contest build succeeds when a reviewer can:

- understand the value proposition from the README before running anything;
- connect Zoo through a verifiable PKCE flow;
- complete a deterministic sample analysis from a clean browser;
- analyse a supported CAD model and see metric provenance per endpoint;
- compare at least one single-step and one hybrid route;
- see why an estimate is accepted or why the deterministic fallback was used;
- configure a machine and observe factory availability change;
- view the uploaded part in 3D from Zoo's own conversion output;
- generate a datum and tolerance table, refine it by chat, and download the ISO
  A3 drawing sheet;
- attach a note to a result, re-run it, and see a linked new revision rather than
  an overwritten record;
- retrieve every saved artefact after a page refresh;
- understand every material limitation from the interface and documentation.

## Non-goals for the current release

- binding supplier quotations;
- automatic purchase orders or payment;
- production scheduling or machine dispatch;
- semantic drawing-to-CAD comparison;
- feature-level tool access, wall thickness, bend, or tolerance-stack analysis;
- hole, thread, fillet or diameter recognition on the generated drawing;
- a released, revision-controlled engineering drawing;
- direct geometry import from a selected Zoo project;
- multi-replica operation with shared rate limiting and job coordination;
- structured spreadsheet export or a branded multi-document package.

See [Limitations](LIMITATIONS.md) and [Roadmap](ROADMAP.md) for the transition
from contest platform to production service.
