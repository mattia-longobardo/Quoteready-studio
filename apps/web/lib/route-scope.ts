import type { ManufacturingRoute } from "@quoteredy/core/types";

/**
 * Scope of the manufacturing-route comparison: "factory" proposes only the
 * routes every operation of which can run on the user's My Factory machines
 * (ManufacturingRoute.availableInFactory); "all" compares every route.
 */
export type RouteScope = "factory" | "all";

/** Factory-first default: start scoped to the user's machines when possible. */
export function defaultRouteScope(
  routes: readonly ManufacturingRoute[],
): RouteScope {
  return routes.some((item) => item.availableInFactory) ? "factory" : "all";
}

/**
 * Routes shown under a scope. The factory filter never empties the list: with
 * no matching machines every route stays visible so the comparison remains
 * usable.
 */
export function visibleRoutes(
  routes: readonly ManufacturingRoute[],
  scope: RouteScope,
): ManufacturingRoute[] {
  if (scope !== "factory") return [...routes];
  const inFactory = routes.filter((item) => item.availableInFactory);
  return inFactory.length > 0 ? inFactory : [...routes];
}

/**
 * The route whose detail is rendered: the selection when visible, otherwise
 * the first visible route (routes arrive sorted best-fit first).
 */
export function displayedRoute(
  routes: readonly ManufacturingRoute[],
  scope: RouteScope,
  selectedId: string,
): ManufacturingRoute | null {
  const visible = visibleRoutes(routes, scope);
  return visible.find((item) => item.id === selectedId) ?? visible[0] ?? null;
}
