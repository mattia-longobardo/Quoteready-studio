export type CheckStatus = "pass" | "warning" | "fail";
export type ReportStatus = "ready" | "review" | "blocked";
export type AnalysisMode = "zoo" | "demo";
export type PricingProvider = "zoo-agent" | "deterministic";

export interface PriceEstimate {
  currency: "EUR";
  minimum: number;
  expected: number;
  maximum: number;
  confidence: number;
}

export interface ManufacturingOperation {
  id: string;
  name: string;
  process: string;
  setupMinutes: number;
  cycleMinutes: number;
  detail: string;
}

export interface ManufacturingRoute {
  id: string;
  name: string;
  description: string;
  suitability: number;
  availableInFactory: boolean;
  operations: ManufacturingOperation[];
  price: PriceEstimate;
  leadTimeHours: number;
  reasons: string[];
  risks: string[];
}

export interface ManufacturingPlan {
  provider: PricingProvider;
  providerLabel: string;
  fallbackReason?: string;
  recommendedRouteId: string;
  /** True when the user manually picked the route, overriding the recommendation. */
  routeSelectedByUser?: boolean;
  summary: string;
  generatedAt: string;
  routes: ManufacturingRoute[];
}

export interface RfqMetadata {
  partName: string;
  process: string;
  material: string;
  quantity: number | null;
  units: string;
  tolerance: string;
  finish: string;
  notes: string;
  hasDrawing: boolean;
  sourceProject?: {
    id: string;
    name: string;
  };
}

export interface GeometryMetrics {
  volumeMm3: number | null;
  surfaceAreaMm2: number | null;
  massG: number | null;
  centerOfMassMm: [number, number, number] | null;
}

export interface AuditCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  evidence: string;
  source: "user" | "zoo" | "rule";
  deduction: number;
}

export interface ClarificationQuestion {
  id: string;
  priority: "critical" | "important" | "optional";
  question: string;
  reason: string;
}

export interface ApiTrace {
  endpoint: string;
  status: "completed" | "failed" | "skipped";
  durationMs: number;
  operationId?: string;
  detail?: string;
}

export interface AuditReport {
  id?: string;
  mode: AnalysisMode;
  score: number;
  status: ReportStatus;
  summary: string;
  file: {
    name: string;
    format: string;
    sizeBytes: number;
  };
  metadata: RfqMetadata;
  metrics: GeometryMetrics;
  checks: AuditCheck[];
  questions: ClarificationQuestion[];
  assumptions: string[];
  apiTrace: ApiTrace[];
  manufacturingPlan: ManufacturingPlan;
  generatedAt: string;
}

export type BaseAuditReport = Omit<AuditReport, "id" | "manufacturingPlan">;

export interface MachineProfile {
  id: string;
  name: string;
  process: string;
  hourlyRate: number;
  setupMinutes: number;
  materials: string[];
  enabled: boolean;
  notes: string;
  createdAt: string;
}

export interface ReportFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

/**
 * Extra material a user attaches to an analysis result to enrich its context:
 * a supporting drawing/document, or a free-text note. Attachments feed the
 * re-run of the analysis and the AI report generation.
 */
export interface ResultAttachment {
  id: string;
  /** "file" for an uploaded drawing or document, "note" for text only. */
  kind: "file" | "note";
  /** The note body, or the caption the user gave the uploaded file. */
  text: string;
  /** Uploaded file name; empty on a pure note. */
  fileName: string;
  /** Uploaded media type; empty on a pure note. */
  mediaType: string;
  /** Uploaded size in bytes; 0 on a pure note. */
  sizeBytes: number;
  /** Blob key of the stored file; null on notes. */
  blobKey: string | null;
  createdAt: string;
}

export interface StoredReport {
  id: string;
  title: string;
  folderId: string | null;
  report: AuditReport;
  tags?: string[];
  /**
   * Additional material attached after the analysis. Absent on results stored
   * before attachments existed, so always read it as `attachments ?? []`.
   */
  attachments?: ResultAttachment[];
  /** Result this one was re-run from; absent on first-run results. */
  sourceResultId?: string | null;
  /** 1-based re-run counter; absent on first-run results. */
  revision?: number;
  archivedAt: string | null;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DocumentStatus = "generating" | "ready" | "failed";

/** AI-generated detailed report document (HTML source of truth). */
export interface ReportDocument {
  id: string;
  /** Analysis result this document was generated from, when still present. */
  resultId: string | null;
  /** Mirrors the folder of the source result; movable independently after. */
  folderId: string | null;
  /**
   * Sequential per-part name shown to the user ("USB_Holder_01"). Absent on
   * documents created before sequential naming, which fall back to the title.
   */
  name?: string;
  title: string;
  html: string;
  model: string;
  /**
   * Generation lifecycle: documents are created as "generating" while the AI
   * writes them in the background, then flip to "ready" or "failed".
   */
  status: DocumentStatus;
  /** Bounded failure detail when status is "failed". */
  error: string | null;
  tags?: string[];
  archivedAt: string | null;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** ReportDocument without its (large) HTML body, for list responses. */
export type ReportDocumentSummary = Omit<ReportDocument, "html"> & {
  sizeBytes: number;
};

export type PartStatus = "uploaded" | "analyzing" | "analyzed" | "failed";

/** An uploaded CAD part tracked across its analysis. */
export interface StoredPart {
  id: string;
  name: string;
  fileName: string;
  format: string;
  sizeBytes: number;
  status: PartStatus;
  source: "analysis" | "zoo-upload";
  /** Analysis result generated from this part, when one exists. */
  reportId: string | null;
  /** Zoo draft project created from this part, when one exists. */
  zooProjectId: string | null;
  /** Blob key of the glTF preview model; absent on parts without one. */
  modelBlobKey?: string | null;
  /** Blob key of the archived source CAD file, when one was stored. */
  cadBlobKey?: string | null;
  /**
   * When a newer part took over this part's name (a confirmed overwrite). The
   * record and its blobs are kept on purpose: results, drawings and reports
   * produced from this part keep resolving to the original geometry. A
   * superseded part is hidden from the parts list, the part pickers and
   * name-collision checks. Absent on every part that was never overwritten.
   */
  supersededAt?: string | null;
  /** Part that took over this part's name. */
  replacedById?: string | null;
  /**
   * @deprecated The CAD→KCL conversion was removed. Parts stored before that
   * still carry these fields in their workspace JSON; nothing reads or writes
   * them any more, they are only declared so old records keep type-checking.
   */
  kclCode?: string;
  /** @deprecated See {@link StoredPart.kclCode}. */
  kclStatus?: string;
  /** @deprecated See {@link StoredPart.kclCode}. */
  kclError?: string | null;
  /** @deprecated See {@link StoredPart.kclCode}. */
  kclSource?: string;
  /** @deprecated See {@link StoredPart.kclCode}. */
  kclCheckedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DrawingStatus = "generating" | "ready" | "failed";

/** A datum feature chosen by the Zoo agent for a drawing table. */
export interface DrawingDatum {
  /** Datum letter (A, B, C, …). */
  label: string;
  /** The part feature the datum is attached to. */
  feature: string;
  /** Why the agent picked this feature as a datum. */
  reason: string;
}

/** One dimension or GD&T row of a generated drawing table. */
export interface DrawingRow {
  id: string;
  feature: string;
  /** Nominal dimension or geometric characteristic (e.g. "Ø6.00", "Flatness"). */
  nominal: string;
  /** Tolerance chosen by the agent (e.g. "±0.05", "0.1 |A|B|"). */
  tolerance: string;
  /** Referenced datums, e.g. "A", "A|B". */
  datums: string;
  /** Whether this row is a plain dimension or a geometric control. */
  kind: "dimension" | "gdt";
  note: string;
}

/**
 * Drawing-table dossier generated by the Zoo agent (Zookeeper) for a stored
 * part: it picks datums and tolerances automatically from the CAD geometry.
 */
export interface DrawingTable {
  id: string;
  partId: string | null;
  /**
   * Sequential per-part name shown to the user ("USB_Holder_01"). Absent on
   * drawings created before sequential naming, which fall back to the part
   * name.
   */
  name?: string;
  partName: string;
  fileName: string;
  status: DrawingStatus;
  error: string | null;
  units: string;
  generalTolerance: string;
  datums: DrawingDatum[];
  rows: DrawingRow[];
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

export type ThemePreference = "system" | "light" | "dark";

export interface UserSettings {
  timezone: string;
  currency: string;
  theme: ThemePreference;
  aiReports: {
    enabled: boolean;
    model: string;
  };
}

/** Server-side persisted settings; API keys/tokens are sealed at rest. */
export interface StoredUserSettings extends UserSettings {
  aiApiKeySealed: string | null;
  zooApiTokenSealed: string | null;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  timezone: "Europe/Rome",
  currency: "EUR",
  theme: "system",
  aiReports: { enabled: true, model: "gpt-4o" },
};

export interface ZooUser {
  id: string;
  name: string;
  email: string;
  image: string;
}

export interface AuthState {
  loading: boolean;
  authenticated: boolean;
  configured: boolean;
  user: ZooUser | null;
}

export interface WorkspaceState {
  folders: ReportFolder[];
  machines: MachineProfile[];
  reports: StoredReport[];
  documents: ReportDocumentSummary[];
  parts: StoredPart[];
  drawings: DrawingTable[];
  settings: UserSettings & { hasAiApiKey: boolean; hasZooApiToken: boolean };
  stats: {
    reports: number;
    ready: number;
    machines: number;
    documents: number;
  };
}

export type PlatformView =
  | "dashboard"
  | "planner"
  | "library"
  | "parts"
  | "drawings"
  | "results"
  | "reports"
  | "factory"
  | "settings";

export interface PlannerSeed {
  projectId: string;
  projectName: string;
}
