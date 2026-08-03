import { describe, expect, it } from "vitest";

import {
  buildDeterministicManufacturingPlan,
  hasFactoryMachines,
  isFactoryScopedPlan,
  isMachineProcess,
  isManufacturingProcess,
  MANUFACTURING_PROCESSES,
  MY_FACTORY_PROCESS,
} from "@quoteredy/core/manufacturing";
import {
  agentRequestInstructions,
  validatePricingPayload,
} from "@quoteredy/core/pricing";
import type {
  BaseAuditReport,
  MachineProfile,
  RfqMetadata,
} from "@quoteredy/core/types";

const metadata: RfqMetadata = {
  partName: "Test bracket",
  process: "unknown",
  material: "aluminum_6061",
  quantity: 25,
  units: "mm",
  tolerance: "±0.1 mm",
  finish: "Anodised",
  notes: "",
  hasDrawing: true,
};

const metrics = {
  volumeMm3: 18_420,
  surfaceAreaMm2: 14_862,
  massG: 49.734,
  centerOfMassMm: [42, 30, 6] as [number, number, number],
};

function machine(id: string, process: string, enabled = true): MachineProfile {
  return {
    id,
    name: id,
    process,
    hourlyRate: 60,
    setupMinutes: 20,
    materials: [],
    enabled,
    notes: "",
    createdAt: new Date(0).toISOString(),
  };
}

describe("deterministic manufacturing plan", () => {
  it("always produces bounded estimates and multi-step routes", () => {
    const plan = buildDeterministicManufacturingPlan({
      metadata,
      metrics,
      machines: [],
    });
    expect(plan.provider).toBe("deterministic");
    expect(plan.routes.length).toBeGreaterThanOrEqual(5);
    expect(plan.routes.some((route) => route.id === "cnc-turned")).toBe(true);
    expect(plan.routes.some((route) => route.operations.length >= 3)).toBe(
      true,
    );
    for (const route of plan.routes) {
      expect(route.price.minimum).toBeGreaterThan(0);
      expect(route.price.minimum).toBeLessThanOrEqual(route.price.expected);
      expect(route.price.maximum).toBeGreaterThanOrEqual(route.price.expected);
    }
  });

  it("narrows the estimate to the selected target process", () => {
    const plan = buildDeterministicManufacturingPlan({
      metadata: { ...metadata, process: "cnc_milling" },
      metrics,
      machines: [],
    });
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0].id).toBe("cnc-from-billet");
    expect(plan.recommendedRouteId).toBe("cnc-from-billet");
  });

  it("keeps every sheet metal route for a sheet metal target", () => {
    const plan = buildDeterministicManufacturingPlan({
      metadata: { ...metadata, process: "sheet_metal" },
      metrics,
      machines: [],
    });
    expect(plan.routes.map((route) => route.id).sort()).toEqual([
      "laser-bend-cnc",
      "sheet-metal",
    ]);
  });

  it("marks a route as factory-capable only when all operations are covered", () => {
    const plan = buildDeterministicManufacturingPlan({
      metadata,
      metrics,
      machines: [
        machine("mill", "cnc_milling"),
        machine("finish", "finishing"),
      ],
    });
    expect(
      plan.routes.find((route) => route.id === "cnc-from-billet")
        ?.availableInFactory,
    ).toBe(true);
    expect(
      plan.routes.find((route) => route.id === "additive-finish")
        ?.availableInFactory,
    ).toBe(false);
  });
});

describe("My Factory target process", () => {
  const factoryMetadata: RfqMetadata = {
    ...metadata,
    process: MY_FACTORY_PROCESS.id,
  };

  it("narrows the comparison to the routes the machines cover end to end", () => {
    const plan = buildDeterministicManufacturingPlan({
      metadata: factoryMetadata,
      metrics,
      machines: [
        machine("mill", "cnc_milling"),
        machine("finish", "finishing"),
      ],
    });
    expect(plan.routes.map((route) => route.id)).toEqual(["cnc-from-billet"]);
    expect(plan.recommendedRouteId).toBe("cnc-from-billet");
    expect(plan.routes.every((route) => route.availableInFactory)).toBe(true);
    expect(plan.summary).toContain("My Factory machines");
    expect(plan.summary).toContain("restricted");
    expect(isFactoryScopedPlan(factoryMetadata.process, plan.routes)).toBe(
      true,
    );
  });

  it("falls back to the full comparison when no route runs in the factory", () => {
    const full = buildDeterministicManufacturingPlan({
      metadata,
      metrics,
      machines: [],
    });
    // A turning machine alone covers no route: every route needs finishing.
    const plan = buildDeterministicManufacturingPlan({
      metadata: factoryMetadata,
      metrics,
      machines: [machine("lathe", "cnc_turning")],
    });
    expect(plan.routes.map((route) => route.id)).toEqual(
      full.routes.map((route) => route.id),
    );
    expect(plan.routes.some((route) => route.availableInFactory)).toBe(false);
    expect(plan.summary).toContain("no route runs end to end");
    expect(isFactoryScopedPlan(factoryMetadata.process, plan.routes)).toBe(
      false,
    );
  });

  it("degrades to the open comparison for a workspace without machines", () => {
    const baseline = buildDeterministicManufacturingPlan({
      metadata,
      metrics,
      machines: [],
    });
    const plan = buildDeterministicManufacturingPlan({
      metadata: factoryMetadata,
      metrics,
      machines: [],
    });
    expect(plan.routes.map((route) => route.id)).toEqual(
      baseline.routes.map((route) => route.id),
    );
    expect(plan.recommendedRouteId).toBe(baseline.recommendedRouteId);
    // Disabled machines are invisible to planning, so they cannot narrow it.
    const disabled = buildDeterministicManufacturingPlan({
      metadata: factoryMetadata,
      metrics,
      machines: [
        machine("mill", "cnc_milling", false),
        machine("finish", "finishing", false),
      ],
    });
    expect(disabled.routes.map((route) => route.id)).toEqual(
      baseline.routes.map((route) => route.id),
    );
  });

  it("leaves every other target process untouched", () => {
    const plan = buildDeterministicManufacturingPlan({
      metadata: { ...metadata, process: "cnc_milling" },
      metrics,
      machines: [],
    });
    expect(plan.routes).toHaveLength(1);
    expect(plan.summary).toContain("CNC milling");
    expect(isFactoryScopedPlan("cnc_milling", plan.routes)).toBe(false);
  });

  it("keeps the new id out of the machine process list but valid as a target", () => {
    expect(isManufacturingProcess(MY_FACTORY_PROCESS.id)).toBe(true);
    expect(isMachineProcess(MY_FACTORY_PROCESS.id)).toBe(false);
    // Adding it to MANUFACTURING_PROCESSES would leak it into
    // MACHINE_PROCESSES and the machine editor, so it stays out.
    expect(
      MANUFACTURING_PROCESSES.map((process) => process.id as string),
    ).not.toContain(MY_FACTORY_PROCESS.id);
  });

  it("reports machine availability from enabled machines only", () => {
    expect(hasFactoryMachines([])).toBe(false);
    expect(hasFactoryMachines([machine("mill", "cnc_milling", false)])).toBe(
      false,
    );
    expect(hasFactoryMachines([machine("mill", "cnc_milling")])).toBe(true);
  });
});

describe("Zoo Agent factory scoping", () => {
  it("tells the agent the candidate routes are the factory ones", () => {
    const machines = [
      machine("mill", "cnc_milling"),
      machine("finish", "finishing"),
    ];
    const report = {
      metadata: { ...metadata, process: MY_FACTORY_PROCESS.id },
      metrics,
      score: 80,
      file: { name: "part.step", format: "step", sizeBytes: 1_024 },
    } as unknown as BaseAuditReport;
    const scoped = buildDeterministicManufacturingPlan({
      metadata: report.metadata,
      metrics,
      machines,
    });
    expect(agentRequestInstructions(report, scoped)).toContain(
      "restricted to the customer's factory machines",
    );

    const open = buildDeterministicManufacturingPlan({
      metadata,
      metrics,
      machines,
    });
    expect(
      agentRequestInstructions(
        { ...report, metadata } as BaseAuditReport,
        open,
      ),
    ).not.toContain("restricted to the customer's factory machines");
  });
});

describe("Zoo Agent pricing guardrails", () => {
  it("accepts complete estimates inside deterministic bounds", () => {
    const fallback = buildDeterministicManufacturingPlan({
      metadata,
      metrics,
      machines: [],
    });
    const payload = {
      recommendedRouteId: fallback.routes[0].id,
      summary: "A conservative estimate based on the supplied routes.",
      routes: fallback.routes.map((route) => ({
        id: route.id,
        minimum: route.price.minimum,
        expected: route.price.expected,
        maximum: route.price.maximum,
        confidence: 0.7,
        leadTimeHours: route.leadTimeHours,
        rationale: "Geometry and quantity support this route.",
      })),
    };
    expect(validatePricingPayload(payload, fallback).routes).toHaveLength(
      fallback.routes.length,
    );
  });

  it("rejects hallucinated routes and unsafe prices", () => {
    const fallback = buildDeterministicManufacturingPlan({
      metadata,
      metrics,
      machines: [],
    });
    const routes = fallback.routes.map((route) => ({
      id: route.id,
      minimum: 1,
      expected: route.price.expected,
      maximum: route.price.maximum,
      confidence: 0.7,
      leadTimeHours: 2,
      rationale: "Bounded.",
    }));
    routes[0] = { ...routes[0], id: "invented-process", expected: 999999 };
    expect(() =>
      validatePricingPayload(
        {
          recommendedRouteId: fallback.routes[0].id,
          summary: "Unsafe fabricated estimate.",
          routes,
        },
        fallback,
      ),
    ).toThrow();
  });
});
