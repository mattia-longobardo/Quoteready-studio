import {
  buildDeterministicManufacturingPlan,
  isFactoryScopedPlan,
} from "./manufacturing";
import type {
  BaseAuditReport,
  MachineProfile,
  ManufacturingPlan,
  ManufacturingRoute,
  PricingProvider,
} from "./types";
import {
  renderUserWorkshopMemory,
  type UserWorkshopMemory,
} from "./user-memory";
import { runCopilotPrompt } from "./zoo-copilot";

interface PricingInput {
  report: BaseAuditReport;
  machines: MachineProfile[];
  memory?: UserWorkshopMemory;
  zooAccessToken?: string;
}

interface AgentRouteEstimate {
  id: string;
  minimum: number;
  expected: number;
  maximum: number;
  confidence: number;
  leadTimeHours: number;
  rationale: string;
  reasons: string[];
  risks: string[];
}

interface AgentPricingPayload {
  recommendedRouteId: string;
  summary: string;
  routes: AgentRouteEstimate[];
}

export function agentRequestInstructions(
  report: BaseAuditReport,
  fallback: ManufacturingPlan,
  memory?: UserWorkshopMemory,
): string {
  const memorySection = memory ? renderUserWorkshopMemory(memory) : null;
  // The candidate routes are the deterministic plan's routes, so a "My
  // Factory" target already reaches the agent narrowed. The agent writes the
  // summary, so it must be told why the comparison is short.
  const factoryScoped = isFactoryScopedPlan(
    report.metadata.process,
    fallback.routes,
  );
  return [
    "You are Zoo Agent acting as a manufacturing cost engineer and DFM reviewer for QuoteReady Studio.",
    "Return ONLY one JSON object with recommendedRouteId, summary and routes. Do not use markdown.",
    "Every route must contain exactly: id, minimum, expected, maximum, confidence, leadTimeHours, rationale, reasons (string array), risks (string array).",
    "Estimate preliminary EUR price and elapsed lead time, rank suitability, explain the route and identify geometry or process risks for every provided route.",
    "Do not invent route IDs. Preserve uncertainty: minimum <= expected <= maximum.",
    "Use geometry, material, quantity, tolerance, finish, RFQ readiness and factory availability. These are indicative estimates, not quotations.",
    "The summary is the executive manufacturing recommendation for the final report. Never infer a missing authoritative requirement.",
    ...(factoryScoped
      ? [
          "The customer asked to plan on their own shop floor: the candidate routes are only the ones their My Factory machines can run end to end. Say in the summary that the estimate is restricted to the customer's factory machines, and never suggest a route that is not in the list.",
        ]
      : []),
    ...(memorySection ? [memorySection] : []),
    JSON.stringify({
      part: report.metadata,
      geometry: report.metrics,
      readinessScore: report.score,
      candidateRoutes: fallback.routes.map((route) => ({
        id: route.id,
        name: route.name,
        suitability: route.suitability,
        availableInFactory: route.availableInFactory,
        deterministicEstimate: route.price,
        deterministicLeadTimeHours: route.leadTimeHours,
        operations: route.operations,
      })),
    }),
  ].join("\n\n");
}

function extractJson(value: string): unknown {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  return JSON.parse(fenced || trimmed);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, 6);
  return items.length ? items : fallback;
}

export function validatePricingPayload(
  value: unknown,
  fallback: ManufacturingPlan,
): AgentPricingPayload {
  if (!value || typeof value !== "object")
    throw new Error("Pricing response is not an object.");
  const payload = value as Partial<AgentPricingPayload>;
  const fallbackIds = new Set(fallback.routes.map((route) => route.id));
  if (
    !Array.isArray(payload.routes) ||
    payload.routes.length !== fallback.routes.length
  ) {
    throw new Error("Pricing response does not cover every candidate route.");
  }
  if (
    typeof payload.recommendedRouteId !== "string" ||
    !fallbackIds.has(payload.recommendedRouteId)
  ) {
    throw new Error("Pricing response selected an unknown route.");
  }
  if (
    typeof payload.summary !== "string" ||
    payload.summary.trim().length < 8 ||
    payload.summary.trim().length > 1_200
  ) {
    throw new Error("Pricing response summary is missing.");
  }

  const seen = new Set<string>();
  const routes = payload.routes.map((candidate) => {
    if (!candidate || typeof candidate !== "object")
      throw new Error("Invalid route estimate.");
    const route = candidate as Partial<AgentRouteEstimate>;
    if (
      typeof route.id !== "string" ||
      !fallbackIds.has(route.id) ||
      seen.has(route.id)
    ) {
      throw new Error(
        "Pricing response contains an invalid or duplicate route ID.",
      );
    }
    seen.add(route.id);
    const minimum = finiteNumber(route.minimum);
    const expected = finiteNumber(route.expected);
    const maximum = finiteNumber(route.maximum);
    const confidence = finiteNumber(route.confidence);
    const leadTimeHours = finiteNumber(route.leadTimeHours);
    const baseline =
      fallback.routes.find((item) => item.id === route.id)?.price.expected ?? 1;
    const fallbackRoute = fallback.routes.find((item) => item.id === route.id)!;
    if (
      minimum === null ||
      expected === null ||
      maximum === null ||
      confidence === null ||
      leadTimeHours === null ||
      minimum <= 0 ||
      minimum > expected ||
      expected > maximum ||
      confidence < 0 ||
      confidence > 1 ||
      leadTimeHours <= 0 ||
      minimum < baseline * 0.25 ||
      maximum > baseline * 4 ||
      leadTimeHours < fallbackRoute.leadTimeHours * 0.25 ||
      leadTimeHours > fallbackRoute.leadTimeHours * 4
    ) {
      throw new Error(
        `Pricing response contains unsafe values for ${route.id}.`,
      );
    }
    return {
      id: route.id,
      minimum,
      expected,
      maximum,
      confidence,
      leadTimeHours,
      rationale:
        typeof route.rationale === "string"
          ? route.rationale.trim().slice(0, 800)
          : "",
      reasons: stringArray(route.reasons, fallbackRoute.reasons),
      risks: stringArray(route.risks, fallbackRoute.risks),
    };
  });

  return {
    recommendedRouteId: payload.recommendedRouteId,
    summary: payload.summary.trim(),
    routes,
  };
}

function mergePricing(
  fallback: ManufacturingPlan,
  payload: AgentPricingPayload,
  provider: PricingProvider,
  providerLabel: string,
): ManufacturingPlan {
  const estimates = new Map(payload.routes.map((route) => [route.id, route]));
  const routes: ManufacturingRoute[] = fallback.routes.map((route) => {
    const estimate = estimates.get(route.id)!;
    return {
      ...route,
      description: estimate.rationale || route.description,
      price: {
        currency: "EUR",
        minimum: Math.round(estimate.minimum * 100) / 100,
        expected: Math.round(estimate.expected * 100) / 100,
        maximum: Math.round(estimate.maximum * 100) / 100,
        confidence: estimate.confidence,
      },
      leadTimeHours: Math.round(estimate.leadTimeHours * 10) / 10,
      reasons: estimate.reasons,
      risks: estimate.risks,
    };
  });
  return {
    provider,
    providerLabel,
    recommendedRouteId: payload.recommendedRouteId,
    summary: payload.summary,
    generatedAt: new Date().toISOString(),
    routes,
  };
}

async function priceWithZooAgent(
  report: BaseAuditReport,
  fallback: ManufacturingPlan,
  token: string,
  memory?: UserWorkshopMemory,
): Promise<AgentPricingPayload> {
  const { text } = await runCopilotPrompt({
    token,
    content: agentRequestInstructions(report, fallback, memory),
    projectName: `QuoteReady Studio — ${report.metadata.partName || report.file.name}`,
    // A pricing answer is pure text; forcing no tools keeps the copilot from
    // modelling or rendering anything. The deadline keeps the whole analysis
    // request under upstream proxy limits (~100 s) with metrics included.
    forcedTools: [],
    timeoutMs: 80_000,
  });
  return validatePricingPayload(extractJson(text), fallback);
}

export async function buildManufacturingPlan(
  input: PricingInput,
): Promise<ManufacturingPlan> {
  const fallback = buildDeterministicManufacturingPlan({
    metadata: input.report.metadata,
    metrics: input.report.metrics,
    machines: input.machines,
  });
  if (input.zooAccessToken) {
    try {
      const payload = await priceWithZooAgent(
        input.report,
        fallback,
        input.zooAccessToken,
        input.memory,
      );
      return mergePricing(
        fallback,
        payload,
        "zoo-agent",
        "Zoo Agent · manufacturing intelligence",
      );
    } catch (error) {
      const detail =
        error instanceof Error ? error.message.slice(0, 200) : "Unknown error";
      console.warn("Zoo Agent pricing fell back to deterministic:", detail);
      return {
        ...fallback,
        fallbackReason: `Zoo Agent could not price this analysis (${detail}). The deterministic engineering model was used.`,
      };
    }
  }

  return {
    ...fallback,
    fallbackReason:
      "Zoo authentication is not available for this analysis. The deterministic engineering model was used.",
  };
}
