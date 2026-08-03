"use client";

import { responseMessage } from "@/lib/client-http";
import { readPartNameConflict } from "@/lib/part-names";
import { MY_FACTORY_PROCESS } from "@quoteredy/core/manufacturing";
import type { AuditReport, PlannerSeed } from "@quoteredy/core/types";

export interface PlannerFormState {
  partName: string;
  process: string;
  material: string;
  quantity: string;
  units: string;
  tolerance: string;
  finish: string;
  notes: string;
}

const INITIAL_PLANNER_FORM: PlannerFormState = {
  partName: "",
  process: "unknown",
  material: "unknown",
  quantity: "",
  units: "unknown",
  tolerance: "",
  finish: "",
  notes: "",
};

interface PlannerState {
  form: PlannerFormState;
  cadFile: File | null;
  drawing: File | null;
  activeSeed: PlannerSeed | null;
  report: AuditReport | null;
  loading: boolean;
  error: string | null;
  /** Form fields flagged by the pre-flight validation. */
  missingFields: string[];
  /**
   * Whether the user picked the target process themselves. The factory-first
   * default only applies while this is false, so it never overrides a choice.
   */
  processTouched: boolean;
}

const STORAGE_KEY = "quoteredy-planner-v1";

/** Serializable slice of the planner state (File objects cannot persist). */
type PersistedPlannerState = Pick<
  PlannerState,
  | "form"
  | "activeSeed"
  | "report"
  | "error"
  | "missingFields"
  | "processTouched"
>;

function readPersisted(): Partial<PlannerState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedPlannerState>;
    return {
      form: { ...INITIAL_PLANNER_FORM, ...parsed.form },
      activeSeed: parsed.activeSeed ?? null,
      report: parsed.report ?? null,
      error: typeof parsed.error === "string" ? parsed.error : null,
      missingFields: Array.isArray(parsed.missingFields)
        ? parsed.missingFields.filter((item) => typeof item === "string")
        : [],
      processTouched: parsed.processTouched === true,
    };
  } catch {
    return {};
  }
}

function persist() {
  if (typeof window === "undefined") return;
  try {
    const { form, activeSeed, report, error, missingFields, processTouched } =
      state;
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        form,
        activeSeed,
        report,
        error,
        missingFields,
        processTouched,
      }),
    );
  } catch {
    // Storage may be unavailable; the state still survives in-page navigation.
  }
}

/**
 * Module-level planner state: it outlives the Planner component so an
 * analysis started here keeps running (and its result stays visible) while
 * the user navigates to other pages. The serializable slice is mirrored to
 * sessionStorage so it also survives a full page reload; it clears only when
 * the tab/browser is closed or via the explicit "New plan" button. Attached
 * files cannot be serialized and must be re-attached after a reload.
 */
const PRISTINE_STATE: PlannerState = {
  form: INITIAL_PLANNER_FORM,
  cadFile: null,
  drawing: null,
  activeSeed: null,
  report: null,
  loading: false,
  error: null,
  missingFields: [],
  processTouched: false,
};

let state: PlannerState = { ...PRISTINE_STATE, ...readPersisted() };

/**
 * Whether the workspace currently offers My Factory machines. Fed by the
 * Planner once the workspace has loaded; it is not persisted because the
 * workspace is re-read on every mount.
 */
let factoryAvailable = false;

const listeners = new Set<() => void>();

function emit(partial: Partial<PlannerState>) {
  state = { ...state, ...partial };
  persist();
  for (const listener of listeners) listener();
}

export function subscribePlanner(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPlannerState(): PlannerState {
  return state;
}

/**
 * Snapshot used for server rendering and hydration: always the pristine
 * state, so the HTML matches the server output even when sessionStorage has
 * persisted data — React re-renders with the real snapshot right after
 * hydration.
 */
export function getPlannerServerSnapshot(): PlannerState {
  return PRISTINE_STATE;
}

/**
 * Default target process. A user with machines plans on their own shop floor
 * first ("My Factory"); everyone else keeps the untouched open comparison.
 */
export function defaultTargetProcess(hasMachines: boolean): string {
  return hasMachines ? MY_FACTORY_PROCESS.id : "unknown";
}

/**
 * Aligns the target process with the user's machines once the workspace is
 * known. The factory-first default only applies while the user has not picked
 * a process themselves, and a stale "My Factory" selection degrades back to
 * the open comparison when the last machine disappears — the option is then no
 * longer rendered, so the select must not keep pointing at it.
 */
export function setPlannerFactoryAvailability(hasMachines: boolean): void {
  factoryAvailable = hasMachines;
  if (!hasMachines) {
    if (state.form.process === MY_FACTORY_PROCESS.id) {
      emit({ form: { ...state.form, process: "unknown" } });
    }
    return;
  }
  if (!state.processTouched && state.form.process === "unknown") {
    emit({ form: { ...state.form, process: MY_FACTORY_PROCESS.id } });
  }
}

export function updatePlannerForm(
  name: keyof PlannerFormState,
  value: string,
): void {
  emit({
    form: { ...state.form, [name]: value },
    missingFields: state.missingFields.filter((field) => field !== name),
    // An explicit choice wins over the factory-first default from then on.
    ...(name === "process" ? { processTouched: true } : {}),
  });
}

export function setPlannerFiles(files: {
  cadFile?: File | null;
  drawing?: File | null;
}): void {
  emit(files);
}

// The same seed object is re-seen on every Planner mount; only a genuinely
// new selection from the library (a new object) re-applies the context, so
// a removed context stays removed while the user navigates around.
let lastSeedRef: PlannerSeed | null = null;

export function applyPlannerSeed(seed: PlannerSeed): void {
  if (seed === lastSeedRef) return;
  lastSeedRef = seed;
  emit({
    activeSeed: seed,
    ...(!state.form.partName
      ? { form: { ...state.form, partName: seed.projectName } }
      : {}),
  });
}

export function clearPlannerSeed(): void {
  emit({ activeSeed: null });
}

/**
 * Load a stored analysis result back into the planner so both the filled-in
 * planning form and the full report can be reviewed again.
 */
export function loadPlannerReport(report: AuditReport): void {
  lastSeedRef = null;
  emit({
    form: {
      partName: report.metadata.partName,
      process: report.metadata.process || "unknown",
      material: report.metadata.material || "unknown",
      quantity:
        report.metadata.quantity === null
          ? ""
          : String(report.metadata.quantity),
      units: report.metadata.units || "unknown",
      tolerance: report.metadata.tolerance,
      finish: report.metadata.finish,
      notes: report.metadata.notes,
    },
    cadFile: null,
    drawing: null,
    activeSeed: null,
    report,
    loading: false,
    error: null,
    missingFields: [],
    // The stored report's own target process must survive: the factory-first
    // default must not rewrite what was actually analysed.
    processTouched: true,
  });
}

/** Full reset — bound to the planner's explicit "New plan" button. */
export function resetPlanner(): void {
  lastSeedRef = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // The emit below still resets the in-memory state.
  }
  emit({
    form: {
      ...INITIAL_PLANNER_FORM,
      process: defaultTargetProcess(factoryAvailable),
    },
    cadFile: null,
    drawing: null,
    activeSeed: null,
    report: null,
    loading: false,
    error: null,
    missingFields: [],
    processTouched: false,
  });
}

/**
 * Pre-flight completeness check mirroring the server rule: the plan does not
 * start until the required parameters are filled. Finish is optional (it
 * defaults to "as machined"); the target process may stay on "propose".
 */
export function missingPlannerFields(
  form: PlannerFormState,
  cadFile: File | null,
): Array<{ field: keyof PlannerFormState | "cadFile"; label: string }> {
  const missing: Array<{
    field: keyof PlannerFormState | "cadFile";
    label: string;
  }> = [];
  if (!cadFile) missing.push({ field: "cadFile", label: "CAD file" });
  if (!form.partName.trim())
    missing.push({ field: "partName", label: "part name" });
  if (form.material === "unknown")
    missing.push({ field: "material", label: "material" });
  const quantity = Number(form.quantity);
  if (!form.quantity.trim() || !Number.isInteger(quantity) || quantity < 1) {
    missing.push({ field: "quantity", label: "quantity" });
  }
  if (form.units === "unknown")
    missing.push({ field: "units", label: "design units" });
  return missing;
}

const DEMO_FORM: PlannerFormState = {
  partName: "BR-042 Sensor bracket",
  process: "unknown",
  material: "aluminum_6061",
  quantity: "25",
  units: "mm",
  tolerance: "±0.10 mm",
  finish: "Black anodised",
  notes: "Pilot batch before production release.",
};

/**
 * Outcome of an analysis attempt. `name-conflict` means the part name is
 * already taken: nothing was analysed and the caller must ask the user to
 * confirm the overwrite (then retry with `overwrite: true`).
 */
type PlannerAnalysisOutcome =
  | { status: "ok" }
  | { status: "error" }
  | { status: "name-conflict"; partName: string };

/**
 * Run an analysis against the API, writing progress into the module store so
 * it survives page changes. Returns once the analysis settles either way.
 */
export async function runPlannerAnalysis(
  mode: "zoo" | "demo",
  onReport: () => Promise<void>,
  options: { overwrite?: boolean } = {},
): Promise<PlannerAnalysisOutcome> {
  if (state.loading) return { status: "error" };

  if (mode === "zoo") {
    const missing = missingPlannerFields(state.form, state.cadFile);
    if (missing.length > 0) {
      emit({
        missingFields: missing.map((item) => item.field),
        error: `The manufacturing plan cannot start: complete ${missing
          .map((item) => item.label)
          .join(
            ", ",
          )} first. Target process, tolerance and finish are optional (defaults: route comparison, "ISO 2768-m", "As Machined").`,
      });
      return { status: "error" };
    }
  }

  const values = mode === "demo" ? DEMO_FORM : state.form;
  if (mode === "demo") {
    emit({ form: DEMO_FORM, cadFile: null, drawing: null });
  }
  const metadata = {
    ...values,
    ...(mode === "zoo" && state.activeSeed
      ? {
          sourceProjectId: state.activeSeed.projectId,
          sourceProjectName: state.activeSeed.projectName,
        }
      : {}),
  };
  emit({ loading: true, error: null, report: null, missingFields: [] });
  try {
    let response: Response;
    if (mode === "demo") {
      response = await fetch("/api/analyze?mode=demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
      });
    } else {
      const body = new FormData();
      Object.entries(metadata).forEach(([key, value]) => body.set(key, value));
      body.set("cadFile", state.cadFile!);
      if (state.drawing) body.set("drawing", state.drawing);
      // The user's confirmation that this analysis may take over the name of an
      // existing part; without it the server refuses the collision with a 409.
      if (options.overwrite) body.set("overwrite", "true");
      response = await fetch("/api/analyze?mode=zoo", {
        method: "POST",
        body,
      });
    }
    if (!response.ok) {
      // A duplicate part name is not an error to display: the caller opens the
      // overwrite confirmation and retries with the flag set.
      const conflict = await readPartNameConflict(response);
      if (conflict) {
        emit({ loading: false, error: null });
        return { status: "name-conflict", partName: conflict.partName };
      }
      throw new Error(await responseMessage(response, "Analysis failed."));
    }
    const data = (await response.json()) as AuditReport;
    emit({ report: data, loading: false });
    await onReport();
    return { status: "ok" };
  } catch (cause) {
    emit({
      error: cause instanceof Error ? cause.message : "Analysis failed.",
      loading: false,
    });
    return { status: "error" };
  }
}
