import { MY_FACTORY_PROCESS } from "./manufacturing";
import { getMaterial } from "./materials";
import type {
  AnalysisMode,
  ApiTrace,
  AuditCheck,
  AuditReport,
  BaseAuditReport,
  ClarificationQuestion,
  GeometryMetrics,
  ReportStatus,
  RfqMetadata,
} from "./types";

interface BuildAuditInput {
  mode: AnalysisMode;
  file: AuditReport["file"];
  metadata: RfqMetadata;
  metrics: GeometryMetrics;
  apiTrace: ApiTrace[];
}

function check(
  id: string,
  label: string,
  status: AuditCheck["status"],
  detail: string,
  evidence: string,
  source: AuditCheck["source"],
  deduction = 0,
): AuditCheck {
  return { id, label, status, detail, evidence, source, deduction };
}

export function buildAuditReport(input: BuildAuditInput): BaseAuditReport {
  const { metadata, metrics } = input;
  const material = getMaterial(metadata.material);
  const checks: AuditCheck[] = [];
  const questions: ClarificationQuestion[] = [];
  const assumptions: string[] = [];

  checks.push(
    check(
      "cad-readable",
      "CAD geometry is readable",
      metrics.volumeMm3 !== null ? "pass" : "fail",
      metrics.volumeMm3 !== null
        ? input.mode === "demo"
          ? "The sample contains representative measurable solid geometry."
          : "Zoo returned measurable solid geometry."
        : "No valid volume was returned for this file.",
      metrics.volumeMm3 !== null
        ? `${metrics.volumeMm3.toLocaleString("en-US", { maximumFractionDigits: 2 })} mm³`
        : "Geometry metric unavailable",
      input.mode === "demo" ? "rule" : "zoo",
      metrics.volumeMm3 !== null ? 0 : 30,
    ),
  );

  if (metadata.units === "unknown") {
    checks.push(
      check(
        "units",
        "Design units are explicit",
        "fail",
        "The quote cannot safely infer whether dimensions are metric or imperial.",
        "No unit supplied",
        "user",
        18,
      ),
    );
    questions.push({
      id: "ask-units",
      priority: "critical",
      question:
        "What are the authoritative design units: millimetres or inches?",
      reason:
        "A wrong unit assumption changes every dimension and invalidates the quote.",
    });
  } else {
    checks.push(
      check(
        "units",
        "Design units are explicit",
        "pass",
        "Units were supplied with the RFQ.",
        metadata.units,
        "user",
      ),
    );
  }

  // A missing target process is a normal, fully supported flow — not an
  // error or alert: every route is compared and the user simply picks one of
  // the proposals before quoting.
  if (metadata.process === "unknown") {
    checks.push(
      check(
        "process",
        "Manufacturing route left open",
        "pass",
        "No target process was selected, so every supported route was compared. Choose one of the proposed routes before quoting.",
        "Route comparison mode",
        "user",
      ),
    );
  } else if (metadata.process === MY_FACTORY_PROCESS.id) {
    // "My Factory" fixes no technology either: it scopes the comparison to
    // the routes the user's own machines can run, and the user still picks
    // one. The manufacturing plan states honestly when no route was coverable
    // and the comparison fell back to every route.
    checks.push(
      check(
        "process",
        "Manufacturing scoped to My Factory",
        "pass",
        "No single target process was fixed: the routes your My Factory machines can run end to end were compared first. Choose one of the proposed routes before quoting.",
        "My Factory route comparison",
        "user",
      ),
    );
  } else {
    checks.push(
      check(
        "process",
        "Manufacturing process is defined",
        "pass",
        "A target process was selected; the estimate focuses on that process.",
        metadata.process,
        "user",
      ),
    );
  }

  if (material.densityKgM3 === null) {
    checks.push(
      check(
        "material",
        "Material is defined",
        "fail",
        "Material affects mass, stock selection, tooling and price.",
        "No material supplied",
        "user",
        16,
      ),
    );
    questions.push({
      id: "ask-material",
      priority: "critical",
      question: "Which material and grade are required?",
      reason:
        "The same geometry can have very different cost and manufacturing constraints by material.",
    });
  } else {
    checks.push(
      check(
        "material",
        "Material is defined",
        "pass",
        "A material grade and density are available.",
        material.label,
        "user",
      ),
    );
  }

  if (!metadata.quantity || metadata.quantity < 1) {
    checks.push(
      check(
        "quantity",
        "Order quantity is known",
        "warning",
        "Setup cost cannot be allocated without a production quantity.",
        "No valid quantity supplied",
        "user",
        10,
      ),
    );
    questions.push({
      id: "ask-quantity",
      priority: "important",
      question: "How many production parts and prototypes are required?",
      reason:
        "Quantity changes setup amortisation and the most economical process.",
    });
  } else {
    checks.push(
      check(
        "quantity",
        "Order quantity is known",
        "pass",
        "Quantity can be used during quoting.",
        `${metadata.quantity} pcs`,
        "user",
      ),
    );
  }

  if (!metadata.tolerance.trim()) {
    checks.push(
      check(
        "tolerance",
        "Tolerance strategy is supplied",
        "warning",
        "The CAD model defines nominal geometry, not acceptable manufacturing variation.",
        "No general or feature tolerance supplied",
        "user",
        12,
      ),
    );
    questions.push({
      id: "ask-tolerance",
      priority: "important",
      question: "What general tolerance or critical feature tolerances apply?",
      reason:
        "Tighter tolerances can change machines, inspection effort and price.",
    });
  } else {
    checks.push(
      check(
        "tolerance",
        "Tolerance strategy is supplied",
        "pass",
        "A tolerance statement was supplied for human review.",
        metadata.tolerance,
        "user",
      ),
    );
  }

  if (!metadata.hasDrawing) {
    checks.push(
      check(
        "drawing",
        "Supporting drawing is attached",
        "warning",
        "Threads, datums, finishes and critical dimensions are often communicated outside nominal CAD geometry.",
        "No PDF drawing attached",
        "rule",
        8,
      ),
    );
    questions.push({
      id: "ask-drawing",
      priority: "important",
      question: "Is there a controlled drawing or specification for this part?",
      reason:
        "The CAD file alone may not contain tolerances, threads, finishes or inspection requirements.",
    });
  } else {
    checks.push(
      check(
        "drawing",
        "Supporting drawing is attached",
        "pass",
        "A drawing is present in the RFQ package.",
        "Document received; semantic comparison is not yet automated",
        "user",
      ),
    );
    assumptions.push(
      "Drawing presence is verified, but its content has not yet been semantically cross-checked against CAD.",
    );
  }

  if (!metadata.finish.trim()) {
    checks.push(
      check(
        "finish",
        "Finish is specified",
        "warning",
        "A finish may affect masking, dimensions, lead time and price.",
        "No finish supplied; do not assume 'as machined'",
        "rule",
        6,
      ),
    );
    questions.push({
      id: "ask-finish",
      priority: "optional",
      question: "Is a coating, treatment or cosmetic finish required?",
      reason:
        "Finishing requirements may add operations or alter dimensional allowances.",
    });
  } else {
    checks.push(
      check(
        "finish",
        "Finish is specified",
        "pass",
        "A finish requirement was supplied.",
        metadata.finish,
        "user",
      ),
    );
  }

  if (metrics.massG === null && material.densityKgM3 !== null) {
    checks.push(
      check(
        "mass",
        "Material mass was calculated",
        "warning",
        "Zoo did not return a mass result for the selected density.",
        `${material.densityKgM3} kg/m³ requested`,
        "zoo",
        5,
      ),
    );
  } else if (metrics.massG !== null) {
    checks.push(
      check(
        "mass",
        "Material mass was calculated",
        "pass",
        input.mode === "demo"
          ? "Sample mass was computed from fixed demo volume and the selected material density."
          : "Mass was computed from CAD geometry and the selected material density.",
        `${metrics.massG.toLocaleString("en-US", { maximumFractionDigits: 2 })} g`,
        input.mode === "demo" ? "rule" : "zoo",
      ),
    );
  }

  const score = Math.max(
    0,
    100 - checks.reduce((total, item) => total + item.deduction, 0),
  );
  const status: ReportStatus = checks.some((item) => item.status === "fail")
    ? "blocked"
    : checks.some((item) => item.status === "warning")
      ? "review"
      : "ready";

  const summary =
    status === "ready"
      ? "The package contains enough information to begin a controlled quotation review."
      : status === "review"
        ? "The geometry is usable, but commercial or manufacturing details still need confirmation."
        : "Critical RFQ information is missing. Resolve the highlighted questions before quoting.";

  if (input.mode === "demo") {
    assumptions.push(
      "Demo geometry metrics are fixed sample values and were not returned by Zoo.",
    );
  }

  return {
    ...input,
    score,
    status,
    summary,
    checks,
    questions: questions.slice(0, 5),
    assumptions,
    generatedAt: new Date().toISOString(),
  };
}
