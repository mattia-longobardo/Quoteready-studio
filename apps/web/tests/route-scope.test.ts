import { describe, expect, it } from "vitest";

import type { ManufacturingRoute } from "@quoteredy/core/types";
import {
  defaultRouteScope,
  displayedRoute,
  visibleRoutes,
} from "@/lib/route-scope";

function route(
  id: string,
  availableInFactory: boolean,
  suitability = 50,
): ManufacturingRoute {
  return {
    id,
    name: id,
    description: "",
    suitability,
    availableInFactory,
    operations: [],
    price: {
      currency: "EUR",
      expected: 100,
      minimum: 80,
      maximum: 120,
      confidence: 0.5,
    },
    leadTimeHours: 4,
    reasons: [],
    risks: [],
  };
}

const mixed = [route("cnc", true, 90), route("additive", false, 80)];
const noneInFactory = [route("cnc", false), route("additive", false)];
// What a "My Factory" plan produces: the routes are already narrowed to the
// user's machines before the comparison reaches the view.
const allInFactory = [route("cnc", true, 90), route("laser", true, 70)];

describe("defaultRouteScope", () => {
  it("starts on the factory scope when at least one route matches the machines", () => {
    expect(defaultRouteScope(mixed)).toBe("factory");
  });

  it("starts on all routes when no route matches the machines", () => {
    expect(defaultRouteScope(noneInFactory)).toBe("all");
  });
});

describe("visibleRoutes", () => {
  it("keeps only in-factory routes under the factory scope", () => {
    expect(visibleRoutes(mixed, "factory").map((item) => item.id)).toEqual([
      "cnc",
    ]);
  });

  it("keeps every route under the all scope", () => {
    expect(visibleRoutes(mixed, "all")).toEqual(mixed);
  });

  it("falls back to every route when the factory filter would empty the list", () => {
    expect(visibleRoutes(noneInFactory, "factory")).toEqual(noneInFactory);
  });

  // The scope toggle cannot contradict a factory-narrowed plan: both scopes
  // resolve to the same list, which is why the planner hides the toggle.
  it("is inert on a plan already narrowed to the factory", () => {
    expect(defaultRouteScope(allInFactory)).toBe("factory");
    expect(visibleRoutes(allInFactory, "factory")).toEqual(allInFactory);
    expect(visibleRoutes(allInFactory, "all")).toEqual(allInFactory);
  });
});

describe("displayedRoute", () => {
  it("shows the selected route when it is visible", () => {
    expect(displayedRoute(mixed, "all", "additive")?.id).toBe("additive");
  });

  it("falls back to the best visible route when the selection is filtered out", () => {
    expect(displayedRoute(mixed, "factory", "additive")?.id).toBe("cnc");
  });

  it("returns null when there are no routes", () => {
    expect(displayedRoute([], "all", "cnc")).toBeNull();
  });
});
