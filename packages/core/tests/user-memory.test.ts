import { describe, expect, it } from "vitest";

import { agentRequestInstructions } from "@quoteredy/core/pricing";
import type {
  BaseAuditReport,
  ManufacturingPlan,
  ManufacturingRoute,
  StoredReport,
} from "@quoteredy/core/types";
import {
  buildUserWorkshopMemory,
  renderUserWorkshopMemory,
} from "@quoteredy/core/user-memory";

function route(
  id: string,
  name: string,
  availableInFactory = false,
): ManufacturingRoute {
  return {
    id,
    name,
    description: name,
    suitability: 80,
    availableInFactory,
    operations: [],
    price: {
      currency: "EUR",
      minimum: 100,
      expected: 200,
      maximum: 300,
      confidence: 0.6,
    },
    leadTimeHours: 24,
    reasons: [],
    risks: [],
  };
}

function storedReport(input: {
  selectedRouteId: string;
  routes: ManufacturingRoute[];
  material?: string;
  quantity?: number | null;
  manual?: boolean;
  trashed?: boolean;
}): StoredReport {
  const plan: ManufacturingPlan = {
    provider: "deterministic",
    providerLabel: "Deterministic",
    recommendedRouteId: input.selectedRouteId,
    ...(input.manual ? { routeSelectedByUser: true } : {}),
    summary: "Plan",
    generatedAt: new Date(0).toISOString(),
    routes: input.routes,
  };
  return {
    id: `report-${Math.random().toString(36).slice(2)}`,
    title: "Part",
    folderId: null,
    report: {
      mode: "zoo",
      score: 90,
      status: "ready",
      summary: "Ready.",
      file: { name: "part.step", format: "step", sizeBytes: 1 },
      metadata: {
        partName: "Part",
        process: "unknown",
        material: input.material ?? "unknown",
        quantity: input.quantity ?? null,
        units: "mm",
        tolerance: "",
        finish: "",
        notes: "",
        hasDrawing: false,
      },
      metrics: {
        volumeMm3: 1,
        surfaceAreaMm2: 1,
        massG: 1,
        centerOfMassMm: [0, 0, 0],
      },
      checks: [],
      questions: [],
      assumptions: [],
      apiTrace: [],
      manufacturingPlan: plan,
      generatedAt: new Date(0).toISOString(),
    },
    archivedAt: null,
    trashedAt: input.trashed ? new Date(0).toISOString() : null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

const CNC = route("cnc-from-billet", "CNC from billet", true);
const SHEET = route("sheet-metal", "Sheet metal formed");

describe("user workshop memory", () => {
  it("aggregates route preferences, materials, and quantities", () => {
    const memory = buildUserWorkshopMemory([
      storedReport({
        selectedRouteId: "cnc-from-billet",
        routes: [CNC, SHEET],
        material: "aluminum_6061",
        quantity: 10,
      }),
      storedReport({
        selectedRouteId: "cnc-from-billet",
        routes: [CNC, SHEET],
        material: "aluminum_6061",
        quantity: 25,
        manual: true,
      }),
      storedReport({
        selectedRouteId: "sheet-metal",
        routes: [CNC, SHEET],
        material: "steel_mild",
        quantity: 100,
      }),
    ]);

    expect(memory.reportCount).toBe(3);
    expect(memory.routePreferences[0]).toMatchObject({
      routeId: "cnc-from-billet",
      count: 2,
      share: 67,
    });
    expect(memory.manualRouteOverrides).toEqual([
      { routeId: "cnc-from-billet", routeName: "CNC from billet", count: 1 },
    ]);
    expect(memory.frequentMaterials[0]).toMatchObject({
      material: "aluminum_6061",
      count: 2,
    });
    expect(memory.typicalQuantity).toBe(25);
    expect(memory.inFactoryShare).toBe(67);
  });

  it("ignores trashed reports and unknown materials", () => {
    const memory = buildUserWorkshopMemory([
      storedReport({
        selectedRouteId: "cnc-from-billet",
        routes: [CNC],
        trashed: true,
      }),
      storedReport({ selectedRouteId: "cnc-from-billet", routes: [CNC] }),
    ]);
    expect(memory.reportCount).toBe(1);
    expect(memory.frequentMaterials).toEqual([]);
  });

  it("renders nothing for an empty history and stays bounded otherwise", () => {
    expect(renderUserWorkshopMemory(buildUserWorkshopMemory([]))).toBeNull();

    const reports = Array.from({ length: 40 }, (_, index) =>
      storedReport({
        selectedRouteId: index % 2 ? "cnc-from-billet" : "sheet-metal",
        routes: [CNC, SHEET],
        material: `material_${index % 7}`,
        quantity: index + 1,
        manual: index % 3 === 0,
      }),
    );
    const rendered = renderUserWorkshopMemory(buildUserWorkshopMemory(reports));
    expect(rendered).toContain("User workshop history");
    expect(rendered).toContain("soft preference signal");
    expect(rendered!.length).toBeLessThanOrEqual(1_500);
  });

  it("injects the memory section into the Zoo Agent instructions", () => {
    const stored = storedReport({
      selectedRouteId: "cnc-from-billet",
      routes: [CNC, SHEET],
      material: "aluminum_6061",
      quantity: 25,
    });
    const base: BaseAuditReport = { ...stored.report };
    const fallback = stored.report.manufacturingPlan;

    const withMemory = agentRequestInstructions(
      base,
      fallback,
      buildUserWorkshopMemory([stored]),
    );
    expect(withMemory).toContain("User workshop history");
    expect(withMemory).toContain("CNC from billet 100% (1x)");

    const withoutMemory = agentRequestInstructions(base, fallback);
    expect(withoutMemory).not.toContain("User workshop history");

    const emptyMemory = agentRequestInstructions(
      base,
      fallback,
      buildUserWorkshopMemory([]),
    );
    expect(emptyMemory).not.toContain("User workshop history");
  });
});
