/**
 * Live integration check for the Zoo Copilot pricing path. Skipped unless a
 * Zoo token is provided: ZOO_LIVE_TOKEN=<token> npx vitest run this file.
 */
import { describe, expect, it } from "vitest";

import { buildAuditReport } from "../src/audit";
import { buildManufacturingPlan } from "../src/pricing";

const token = process.env.ZOO_LIVE_TOKEN;

describe.skipIf(!token)("Zoo Copilot pricing (live)", () => {
  it("returns a zoo-agent plan for a realistic report", async () => {
    const base = buildAuditReport({
      mode: "zoo",
      file: { name: "USB Holder.step", format: "step", sizeBytes: 184_215 },
      metadata: {
        partName: "USB Holder",
        process: "",
        material: "aluminum-6061",
        quantity: 25,
        units: "mm",
        tolerance: "ISO 2768-m",
        finish: "",
        notes: "",
        hasDrawing: false,
      },
      metrics: {
        volumeMm3: 51_680.5,
        surfaceAreaMm2: 15_843.9,
        massG: 139.5,
        centerOfMassMm: [46.4, 8.8, -0.7],
      },
      apiTrace: [],
    });
    const plan = await buildManufacturingPlan({
      report: base,
      machines: [],
      zooAccessToken: token,
    });
    console.log(
      "provider:",
      plan.provider,
      "| fallbackReason:",
      plan.fallbackReason ?? "none",
      "| summary:",
      plan.summary.slice(0, 160),
    );
    expect(plan.provider).toBe("zoo-agent");
    expect(plan.fallbackReason).toBeUndefined();
  }, 120_000);
});
