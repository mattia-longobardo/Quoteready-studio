import type { StoredReport } from "./types";

/**
 * Per-user workshop memory distilled from the user's saved reports. It is a
 * soft preference signal injected into the Zoo Agent prompt — never an
 * authoritative requirement, and never a substitute for measured geometry.
 */
export interface UserWorkshopMemory {
  /** Non-trashed reports considered (most recent first, capped). */
  reportCount: number;
  /** Distribution of the routes that ended up selected in past reports. */
  routePreferences: Array<{
    routeId: string;
    routeName: string;
    count: number;
    share: number;
  }>;
  /** Routes the user picked by hand, overriding the recommendation. */
  manualRouteOverrides: Array<{
    routeId: string;
    routeName: string;
    count: number;
  }>;
  /** Most frequently declared RFQ materials. */
  frequentMaterials: Array<{ material: string; count: number }>;
  /** Median declared quantity across past reports, when known. */
  typicalQuantity: number | null;
  /** Share of selected routes that were available in the user's factory. */
  inFactoryShare: number | null;
}

const MAX_REPORTS_CONSIDERED = 50;
const TOP_ENTRIES = 3;

function sortedCounts<T extends { count: number }>(
  entries: Map<string, T>,
): T[] {
  return [...entries.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([, value]) => value);
}

export function buildUserWorkshopMemory(
  reports: StoredReport[],
): UserWorkshopMemory {
  const considered = reports
    .filter((item) => !item.trashedAt)
    .slice(0, MAX_REPORTS_CONSIDERED);

  const routes = new Map<
    string,
    { routeId: string; routeName: string; count: number; share: number }
  >();
  const overrides = new Map<
    string,
    { routeId: string; routeName: string; count: number }
  >();
  const materials = new Map<string, { material: string; count: number }>();
  const quantities: number[] = [];
  let selectedTotal = 0;
  let inFactoryCount = 0;

  for (const item of considered) {
    const plan = item.report.manufacturingPlan;
    const selected = plan.routes.find(
      (route) => route.id === plan.recommendedRouteId,
    );
    if (selected) {
      selectedTotal += 1;
      if (selected.availableInFactory) inFactoryCount += 1;
      const routeEntry = routes.get(selected.id) ?? {
        routeId: selected.id,
        routeName: selected.name,
        count: 0,
        share: 0,
      };
      routeEntry.count += 1;
      routes.set(selected.id, routeEntry);
      if (plan.routeSelectedByUser) {
        const overrideEntry = overrides.get(selected.id) ?? {
          routeId: selected.id,
          routeName: selected.name,
          count: 0,
        };
        overrideEntry.count += 1;
        overrides.set(selected.id, overrideEntry);
      }
    }
    const material = item.report.metadata.material;
    if (material && material !== "unknown") {
      const materialEntry = materials.get(material) ?? { material, count: 0 };
      materialEntry.count += 1;
      materials.set(material, materialEntry);
    }
    const quantity = item.report.metadata.quantity;
    if (typeof quantity === "number" && Number.isFinite(quantity)) {
      quantities.push(quantity);
    }
  }

  const routePreferences = sortedCounts(routes)
    .slice(0, TOP_ENTRIES)
    .map((entry) => ({
      ...entry,
      share: selectedTotal
        ? Math.round((entry.count / selectedTotal) * 100)
        : 0,
    }));

  quantities.sort((a, b) => a - b);
  const typicalQuantity = quantities.length
    ? quantities[Math.floor((quantities.length - 1) / 2)]
    : null;

  return {
    reportCount: considered.length,
    routePreferences,
    manualRouteOverrides: sortedCounts(overrides).slice(0, TOP_ENTRIES),
    frequentMaterials: sortedCounts(materials).slice(0, TOP_ENTRIES),
    typicalQuantity,
    inFactoryShare: selectedTotal
      ? Math.round((inFactoryCount / selectedTotal) * 100)
      : null,
  };
}

/**
 * Render the memory as a bounded prompt section, or null when there is no
 * history worth mentioning. Output stays deterministic for identical input.
 */
export function renderUserWorkshopMemory(
  memory: UserWorkshopMemory,
): string | null {
  if (memory.reportCount === 0) return null;
  const lines: string[] = [
    "User workshop history (soft preference signal from this user's previous saved reports; it must never override geometry, RFQ data or the engineering bounds):",
    `- Previous analyses considered: ${memory.reportCount}.`,
  ];
  if (memory.routePreferences.length) {
    lines.push(
      `- Routes this user ended up selecting: ${memory.routePreferences
        .map((entry) => `${entry.routeName} ${entry.share}% (${entry.count}x)`)
        .join(", ")}.`,
    );
  }
  if (memory.manualRouteOverrides.length) {
    lines.push(
      `- Routes the user manually chose over the recommendation: ${memory.manualRouteOverrides
        .map((entry) => `${entry.routeName} (${entry.count}x)`)
        .join(", ")}.`,
    );
  }
  if (memory.frequentMaterials.length) {
    lines.push(
      `- Frequent declared materials: ${memory.frequentMaterials
        .map((entry) => `${entry.material} (${entry.count}x)`)
        .join(", ")}.`,
    );
  }
  if (memory.typicalQuantity !== null) {
    lines.push(`- Typical declared quantity: ${memory.typicalQuantity} parts.`);
  }
  if (memory.inFactoryShare !== null) {
    lines.push(
      `- Share of selected routes available in the user's own factory: ${memory.inFactoryShare}%.`,
    );
  }
  lines.push(
    "Use this history only to break ties between comparably suitable routes and to tailor the summary; when it conflicts with the current part's evidence, ignore it.",
  );
  return lines.join("\n").slice(0, 1_500);
}
