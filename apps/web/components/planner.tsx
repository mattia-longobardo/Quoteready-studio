"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useFileDrop } from "@/lib/use-file-drop";

import { ArrowIcon } from "@/components/icons";
import { OverwritePartDialog } from "@/components/overwrite-part-dialog";
import { responseMessage } from "@/lib/client-http";
import {
  applyPlannerSeed,
  clearPlannerSeed,
  getPlannerServerSnapshot,
  getPlannerState,
  missingPlannerFields,
  resetPlanner,
  runPlannerAnalysis,
  setPlannerFactoryAvailability,
  setPlannerFiles,
  subscribePlanner,
  updatePlannerForm,
  type PlannerFormState,
} from "@/lib/planner-store";
import {
  defaultRouteScope,
  displayedRoute,
  visibleRoutes,
} from "@/lib/route-scope";
import {
  hasFactoryMachines,
  MANUFACTURING_PROCESSES,
  MY_FACTORY_PROCESS,
} from "@quoteredy/core/manufacturing";
import { MATERIALS } from "@quoteredy/core/materials";
import { findPartByName } from "@quoteredy/core/parts";
import type {
  AuditReport,
  AuthState,
  CheckStatus,
  MachineProfile,
  ManufacturingRoute,
  PlannerSeed,
  StoredPart,
} from "@quoteredy/core/types";

const MONEY_FORMATTER = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const METRIC_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

function money(value: number) {
  return MONEY_FORMATTER.format(value);
}

function metric(value: number | null, suffix: string) {
  return value === null ? "—" : `${METRIC_FORMATTER.format(value)} ${suffix}`;
}

function CheckIcon({ status }: { status: CheckStatus }) {
  const label =
    status === "pass" ? "Passed" : status === "warning" ? "Review" : "Failed";
  return (
    <span aria-label={label} className={`check-icon ${status}`}>
      {status === "pass" ? "✓" : status === "warning" ? "!" : "×"}
    </span>
  );
}

function RouteCard({
  route,
  selected,
  onSelect,
}: {
  route: ManufacturingRoute;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-pressed={selected}
      className={`route-card ${selected ? "selected" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <div className="route-card-head">
        <span className="suitability">{route.suitability}% fit</span>
        {route.availableInFactory && (
          <span className="factory-match">In factory</span>
        )}
      </div>
      <h4>{route.name}</h4>
      <p>{route.description}</p>
      <div className="route-price">
        <strong>{money(route.price.expected)}</strong>
        <span>{route.leadTimeHours} h lead</span>
      </div>
      <small>
        {money(route.price.minimum)}—{money(route.price.maximum)} ·{" "}
        {Math.round(route.price.confidence * 100)}% confidence
      </small>
    </button>
  );
}

function ReportView({ report }: { report: AuditReport }) {
  const [selectedId, setSelectedId] = useState(
    report.manufacturingPlan.recommendedRouteId,
  );
  const [selectionError, setSelectionError] = useState("");
  const [routeScope, setRouteScope] = useState(() =>
    defaultRouteScope(report.manufacturingPlan.routes),
  );

  const routes = report.manufacturingPlan.routes;
  const hasFactoryRoutes = routes.some((item) => item.availableInFactory);
  const scope = hasFactoryRoutes ? routeScope : "all";
  const shownRoutes = visibleRoutes(routes, scope);
  const route = displayedRoute(routes, scope, selectedId);
  const passed = report.checks.filter((item) => item.status === "pass").length;
  if (!route)
    return (
      <div className="error-message">No manufacturing route was generated.</div>
    );

  async function selectRoute(routeId: string) {
    setSelectedId(routeId);
    setSelectionError("");
    if (!report.id) return;
    try {
      const response = await fetch("/api/reports", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: report.id, recommendedRouteId: routeId }),
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(
            response,
            "Route selection could not be saved.",
          ),
        );
    } catch (error) {
      setSelectionError(
        error instanceof Error
          ? error.message
          : "Route selection could not be saved.",
      );
    }
  }

  return (
    <div className="analysis-result">
      <section className="result-hero">
        <div className={`score-block ${report.status}`}>
          <strong>{report.score}</strong>
          <span>
            /100
            <br />
            readiness
          </span>
        </div>
        <div>
          <div className="result-labels">
            <span className={`status-pill ${report.status}`}>
              {report.status}
            </span>
            <span className="mode-badge">
              {report.mode === "zoo" ? "Live Zoo geometry" : "Demo geometry"}
            </span>
            {report.metadata.sourceProject && (
              <span className="mode-badge">
                Zoo project · {report.metadata.sourceProject.name}
              </span>
            )}
          </div>
          <h2>{report.metadata.partName || report.file.name}</h2>
          <p>{report.summary}</p>
          <button
            className="inline-button print-report"
            onClick={() => window.print()}
            type="button"
          >
            Print or save PDF
          </button>
        </div>
      </section>

      <div className="metric-strip">
        <div>
          <span>Volume</span>
          <strong>{metric(report.metrics.volumeMm3, "mm³")}</strong>
        </div>
        <div>
          <span>Surface</span>
          <strong>{metric(report.metrics.surfaceAreaMm2, "mm²")}</strong>
        </div>
        <div>
          <span>Mass</span>
          <strong>{metric(report.metrics.massG, "g")}</strong>
        </div>
        <div>
          <span>Checks passed</span>
          <strong>
            {passed} / {report.checks.length}
          </strong>
        </div>
      </div>

      <section className="result-section">
        <div className="section-heading">
          <div>
            <span>DFM / 01</span>
            <h3>Readiness evidence</h3>
          </div>
          <span className="count-badge">{report.checks.length}</span>
        </div>
        <div className="checks-list">
          {report.checks.map((item) => (
            <article className="check-row" key={item.id}>
              <CheckIcon status={item.status} />
              <div>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
                <small>
                  {item.source.toUpperCase()} · {item.evidence}
                </small>
              </div>
            </article>
          ))}
        </div>
      </section>

      {report.questions.length > 0 && (
        <section className="result-section">
          <div className="section-heading">
            <div>
              <span>RFQ / 02</span>
              <h3>Questions before quotation</h3>
            </div>
            <span className="count-badge">{report.questions.length}</span>
          </div>
          <div className="question-list">
            {report.questions.map((item, index) => (
              <article key={item.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <small>{item.priority}</small>
                  <strong>{item.question}</strong>
                  <p>{item.reason}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="result-section manufacturing-section">
        <div className="section-heading">
          <div>
            <span>PLAN / 03</span>
            <h3>Manufacturing routes</h3>
          </div>
          <span
            className={`provider-badge ${report.manufacturingPlan.provider}`}
          >
            {report.manufacturingPlan.providerLabel}
          </span>
        </div>
        <p className="section-copy">{report.manufacturingPlan.summary}</p>
        {report.manufacturingPlan.fallbackReason && (
          <div className="fallback-note">
            <strong>Deterministic fallback active.</strong>{" "}
            {report.manufacturingPlan.fallbackReason}
          </div>
        )}
        {selectionError && (
          <div className="error-message" role="alert">
            {selectionError}
          </div>
        )}
        {/* The scope toggle only appears when there is something to switch
            between. A "My Factory" plan already arrives narrowed — every route
            is available in factory — so the toggle hides itself and can never
            contradict the plan. A plan whose factory narrowing found nothing
            arrives with no in-factory route at all and is locked to "all". */}
        {hasFactoryRoutes &&
          routes.some((item) => !item.availableInFactory) && (
            <div aria-label="Route scope" className="route-scope" role="group">
              <button
                className={scope === "factory" ? "active" : ""}
                onClick={() => setRouteScope("factory")}
                type="button"
              >
                My machines
              </button>
              <button
                className={scope === "all" ? "active" : ""}
                onClick={() => setRouteScope("all")}
                type="button"
              >
                All routes
              </button>
              <small>
                {scope === "factory"
                  ? `${shownRoutes.length} of ${routes.length} routes run fully on your factory machines`
                  : "Comparing every proposed route, including ones your factory cannot run in-house"}
              </small>
            </div>
          )}
        <div className="route-grid">
          {shownRoutes.map((item) => (
            <RouteCard
              key={item.id}
              onSelect={() => void selectRoute(item.id)}
              route={item}
              selected={item.id === route.id}
            />
          ))}
        </div>
        <div className="route-detail">
          <div className="route-detail-head">
            <div>
              <span>Selected route</span>
              <h3>{route.name}</h3>
            </div>
            <div>
              <strong>{money(route.price.expected)}</strong>
              <small>preliminary total</small>
            </div>
          </div>
          <div className="operation-flow">
            {route.operations.map((operation, index) => (
              <div className="operation" key={operation.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{operation.name}</strong>
                  <p>{operation.detail}</p>
                  <small>
                    {operation.setupMinutes +
                      Math.round(operation.cycleMinutes)}{" "}
                    min estimated
                  </small>
                </div>
              </div>
            ))}
          </div>
          <div className="route-notes">
            <div>
              <strong>Why it works</strong>
              {route.reasons.map((item) => (
                <p key={item}>+ {item}</p>
              ))}
            </div>
            <div>
              <strong>Validate before quote</strong>
              {route.risks.map((item) => (
                <p key={item}>! {item}</p>
              ))}
            </div>
          </div>
        </div>
      </section>

      <details className="provenance">
        <summary>Traceability, APIs and assumptions</summary>
        {report.metadata.sourceProject && (
          <p>
            Zoo project reference: {report.metadata.sourceProject.name} (
            {report.metadata.sourceProject.id})
          </p>
        )}
        {report.apiTrace.map((trace) => (
          <div
            className="trace-row"
            key={`${trace.endpoint}-${trace.operationId ?? "local"}`}
          >
            <span className={trace.status} />
            <code>{trace.endpoint}</code>
            <small>
              {trace.status} · {trace.durationMs} ms
            </small>
          </div>
        ))}
        {report.assumptions.map((item) => (
          <p key={item}>• {item}</p>
        ))}
      </details>
    </div>
  );
}

export function Planner({
  auth,
  onReport,
  seed,
  parts,
  machines,
}: {
  auth: AuthState;
  onReport: () => Promise<void>;
  seed: PlannerSeed | null;
  /** Parts already in the workspace, used to detect a duplicate part name. */
  parts: StoredPart[];
  /**
   * My Factory machines. Their presence unlocks the "My Factory" target
   * process and makes it the default; without machines the form is untouched.
   */
  machines: MachineProfile[];
}) {
  // Planner state lives in a module store (lib/planner-store) so a running
  // analysis and its result survive page navigation — and, via
  // sessionStorage, a full page reload. It clears only when the tab/browser
  // closes or with the explicit "New plan" button.
  const state = useSyncExternalStore(
    subscribePlanner,
    getPlannerState,
    getPlannerServerSnapshot,
  );
  const { form, cadFile, drawing, activeSeed, report, loading, error } = state;

  useEffect(() => {
    if (seed) applyPlannerSeed(seed);
  }, [seed]);

  // The workspace loads after the first render, so the factory-first default
  // is applied once the machines are actually known.
  const factoryAvailable = hasFactoryMachines(machines);
  useEffect(() => {
    setPlannerFactoryAvailability(factoryAvailable);
  }, [factoryAvailable]);

  const cadDrop = useFileDrop((file) => setPlannerFiles({ cadFile: file }));
  const drawingDrop = useFileDrop((file) => setPlannerFiles({ drawing: file }));

  const missing = useMemo(
    () => missingPlannerFields(form, cadFile),
    [form, cadFile],
  );
  const flagged = new Set(
    state.missingFields.filter((field) =>
      missing.some((item) => item.field === field),
    ),
  );

  // Name of the existing part this analysis would overwrite, while the user
  // decides. Set by the pre-flight check below or by the server's 409 when the
  // parts list was stale.
  const [overwriteName, setOverwriteName] = useState<string | null>(null);

  function update(name: keyof PlannerFormState, value: string) {
    updatePlannerForm(name, value);
  }

  async function analyse(mode: "zoo" | "demo", overwrite = false) {
    if (mode === "zoo" && !auth.authenticated) {
      window.location.assign("/api/auth/login");
      return;
    }
    // A live analysis records the part under the name typed above, so an
    // existing part with that name would be replaced: ask first. Superseded
    // parts are already excluded by findPartByName.
    if (mode === "zoo" && !overwrite) {
      const clash = findPartByName(parts, form.partName);
      if (clash) {
        setOverwriteName(clash.name);
        return;
      }
    }
    const outcome = await runPlannerAnalysis(mode, onReport, { overwrite });
    setOverwriteName(
      outcome.status === "name-conflict" ? outcome.partName : null,
    );
  }

  return (
    <div className="planner-view">
      <div className="view-title">
        <div>
          <span>PLANNING</span>
          <h1>From geometry to a route you can quote.</h1>
          <p>
            Upload a part, describe what is known, then compare viable single
            and multi-step manufacturing paths.
          </p>
        </div>
        <div className="title-side">
          <button
            className="secondary-button"
            disabled={loading}
            onClick={() => resetPlanner()}
            type="button"
          >
            New plan
          </button>
        </div>
      </div>
      {activeSeed && (
        <div className="project-context">
          <div>
            <span>ZOO PROJECT CONTEXT</span>
            <strong>{activeSeed.projectName}</strong>
            <small>{activeSeed.projectId}</small>
          </div>
          <p>
            Project identity will be preserved in the report. Attach a local CAD
            file below because the current Projects API does not transfer
            project geometry into this analysis.
          </p>
          <button onClick={() => clearPlannerSeed()} type="button">
            Remove context
          </button>
        </div>
      )}
      <div className="planner-grid">
        <section className="technical-panel intake-panel">
          <div className="panel-heading">
            <div>
              <span className="step-number">01</span>
              <div>
                <small>INPUT PACKAGE</small>
                <h2>Part + requirements</h2>
              </div>
            </div>
            <span>20 MB CAD</span>
          </div>
          <div className="file-grid">
            <label
              className={`drop-zone ${cadFile ? "has-file" : ""} ${
                flagged.has("cadFile") ? "missing" : ""
              } ${cadDrop.active ? "drag-active" : ""}`}
              {...cadDrop.dropProps}
            >
              <input
                accept=".step,.stp,.stl,.obj,.ply,.sldprt,.ipt,.sat,.x_t,.x_b"
                onChange={(event) =>
                  setPlannerFiles({ cadFile: event.target.files?.[0] ?? null })
                }
                type="file"
              />
              <span className="file-type">
                CAD / PRIMARY <em className="req">· REQUIRED</em>
              </span>
              <strong>
                {cadFile?.name ?? "Choose or drop a manufacturable model"}
              </strong>
              <small>
                {cadFile
                  ? `${(cadFile.size / 1_048_576).toFixed(2)} MB`
                  : "STEP · STL · Parasolid · native CAD · drag & drop"}
              </small>
            </label>
            <label
              className={`drop-zone secondary ${drawing ? "has-file" : ""} ${
                drawingDrop.active ? "drag-active" : ""
              }`}
              {...drawingDrop.dropProps}
            >
              <input
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={(event) =>
                  setPlannerFiles({ drawing: event.target.files?.[0] ?? null })
                }
                type="file"
              />
              <span className="file-type">SPEC / OPTIONAL</span>
              <strong>{drawing?.name ?? "Drawing or specification"}</strong>
              <small>
                {drawing
                  ? `${(drawing.size / 1_048_576).toFixed(2)} MB`
                  : "PDF · PNG · JPEG · drag & drop · presence checked"}
              </small>
            </label>
          </div>
          <div className="form-grid">
            <label
              className={`field wide ${flagged.has("partName") ? "missing" : ""}`}
            >
              <span>
                Part name / number <em className="req">· Required</em>
              </span>
              <input
                maxLength={140}
                onChange={(event) => update("partName", event.target.value)}
                placeholder="BR-042 sensor bracket"
                value={form.partName}
              />
            </label>
            <label className="field">
              <span>Target process</span>
              <select
                onChange={(event) => update("process", event.target.value)}
                value={form.process}
              >
                {/* Plan on the user's own shop floor first: offered — and
                    selected by default — only when they own machines. */}
                {factoryAvailable && (
                  <option value={MY_FACTORY_PROCESS.id}>
                    {MY_FACTORY_PROCESS.label}
                  </option>
                )}
                {MANUFACTURING_PROCESSES.map((process) => (
                  <option key={process.id} value={process.id}>
                    {process.label}
                  </option>
                ))}
              </select>
            </label>
            <label
              className={`field ${flagged.has("material") ? "missing" : ""}`}
            >
              <span>
                Material <em className="req">· Required</em>
              </span>
              <select
                onChange={(event) => update("material", event.target.value)}
                value={form.material}
              >
                {MATERIALS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label
              className={`field compact ${flagged.has("quantity") ? "missing" : ""}`}
            >
              <span>
                Quantity <em className="req">· Required</em>
              </span>
              <input
                max="1000000"
                min="1"
                onChange={(event) => update("quantity", event.target.value)}
                placeholder="25"
                type="number"
                value={form.quantity}
              />
            </label>
            <label
              className={`field compact ${flagged.has("units") ? "missing" : ""}`}
            >
              <span>
                Units <em className="req">· Required</em>
              </span>
              <select
                onChange={(event) => update("units", event.target.value)}
                value={form.units}
              >
                <option value="unknown">Unknown</option>
                <option value="mm">Millimetres</option>
                <option value="in">Inches</option>
              </select>
            </label>
            <label className="field">
              <span>General tolerance</span>
              <input
                maxLength={160}
                onChange={(event) => update("tolerance", event.target.value)}
                placeholder='Defaults to "ISO 2768-m"'
                value={form.tolerance}
              />
            </label>
            <label className="field">
              <span>Finish</span>
              <input
                maxLength={160}
                onChange={(event) => update("finish", event.target.value)}
                placeholder='Defaults to "As Machined"'
                value={form.finish}
              />
            </label>
            <label className="field wide">
              <span>Customer notes</span>
              <textarea
                maxLength={2000}
                onChange={(event) => update("notes", event.target.value)}
                placeholder="Inspection, lead time, packaging…"
                rows={3}
                value={form.notes}
              />
            </label>
          </div>
          {!auth.authenticated && (
            <div className="auth-callout">
              <span />
              <div>
                <strong>Live geometry requires Zoo</strong>
                <p>
                  Connect once to analyse CAD and access your Zoo library. The
                  bounded sample remains available without sign-in.
                </p>
              </div>
            </div>
          )}
          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}
          <div className="panel-actions">
            <button
              className="primary-button"
              disabled={loading || auth.loading}
              onClick={() => void analyse("zoo")}
              type="button"
            >
              {loading
                ? "Building plan…"
                : auth.authenticated
                  ? "Build manufacturing plan"
                  : "Connect Zoo to analyse"}
              <ArrowIcon />
            </button>
            <button
              className="text-button"
              disabled={loading}
              onClick={() => void analyse("demo")}
              type="button"
            >
              Run sample
            </button>
            {missing.length > 0 && auth.authenticated && (
              <small className="panel-hint">
                Still needed: {missing.map((item) => item.label).join(", ")}.
              </small>
            )}
          </div>
        </section>

        <section className="technical-panel output-panel">
          <div className="panel-heading">
            <div>
              <span className="step-number">02</span>
              <div>
                <small>DECISION OUTPUT</small>
                <h2>Readiness + questions + route</h2>
              </div>
            </div>
            {report && <span>{report.manufacturingPlan.providerLabel}</span>}
          </div>
          {!report && !loading && (
            <div className="empty-state">
              <div className="blueprint-part">
                <span>?</span>
                <i />
                <i />
                <i />
                <i />
              </div>
              <h3>Waiting for part geometry</h3>
              <p>
                The result will check quote readiness, list the open questions,
                then compare manufacturing routes with price and time.
              </p>
              <div className="empty-steps">
                <span>01 Geometry</span>
                <span>02 Readiness</span>
                <span>03 Questions</span>
                <span>04 Routes</span>
              </div>
            </div>
          )}
          {loading && (
            <div className="loading-state" aria-live="polite">
              <div className="scan-box">
                <i />
              </div>
              <h3>Engineering the route</h3>
              <p>
                Measuring geometry, comparing processes and validating the Zoo
                Agent estimate. You can switch pages — the analysis keeps
                running and the result will be here when you come back.
              </p>
            </div>
          )}
          {report && !loading && (
            <ReportView key={report.id ?? report.generatedAt} report={report} />
          )}
        </section>
      </div>
      {overwriteName && (
        <OverwritePartDialog
          confirmLabel="Overwrite and analyse"
          onCancel={() => setOverwriteName(null)}
          onConfirm={() => {
            setOverwriteName(null);
            void analyse("zoo", true);
          }}
          partName={overwriteName}
        />
      )}
    </div>
  );
}
