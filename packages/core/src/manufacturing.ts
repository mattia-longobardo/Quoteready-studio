import type {
  GeometryMetrics,
  MachineProfile,
  ManufacturingOperation,
  ManufacturingPlan,
  ManufacturingRoute,
  PriceEstimate,
  RfqMetadata,
} from "./types";
import { getMaterial } from "./materials";

interface ManufacturingInput {
  metadata: RfqMetadata;
  metrics: GeometryMetrics;
  machines: MachineProfile[];
}

export const MANUFACTURING_PROCESSES = [
  { id: "unknown", label: "Let QuoteReady Studio propose" },
  { id: "cnc_milling", label: "CNC milling" },
  { id: "cnc_turning", label: "CNC turning" },
  { id: "sheet_metal", label: "Sheet metal" },
  { id: "additive", label: "Additive manufacturing" },
] as const;

/**
 * Target process that scopes the plan to the user's own shop floor instead of
 * a technology: the estimate is narrowed to the routes every operation of
 * which runs on a My Factory machine (ManufacturingRoute.availableInFactory).
 *
 * It is deliberately kept out of MANUFACTURING_PROCESSES: that list also feeds
 * MACHINE_PROCESSES and the machine editor, where "My Factory" is not a
 * process a machine can be assigned to. The option is only offered to users
 * who actually own machines; everyone else keeps the untouched process list.
 */
export const MY_FACTORY_PROCESS = {
  id: "my_factory",
  label: "My Factory",
} as const;

export const MACHINE_PROCESSES = [
  ...MANUFACTURING_PROCESSES.filter((process) => process.id !== "unknown"),
  { id: "laser_cutting", label: "Laser cutting" },
  { id: "finishing", label: "Finishing and inspection" },
] as const;

export function isManufacturingProcess(value: string): boolean {
  return (
    value === MY_FACTORY_PROCESS.id ||
    MANUFACTURING_PROCESSES.some((process) => process.id === value)
  );
}

/**
 * Whether the workspace owns machines usable for planning. Mirrors the rule
 * every estimate already applies: a disabled machine is invisible to
 * machineFor(), so it can never make a route available in the factory.
 */
export function hasFactoryMachines(
  machines: readonly MachineProfile[],
): boolean {
  return machines.some((machine) => machine.enabled);
}

/**
 * Whether a plan's routes were actually narrowed to the user's machines.
 * False when "My Factory" was requested but no route runs end to end in the
 * factory: the comparison then falls back to every route.
 */
export function isFactoryScopedPlan(
  process: string,
  routes: readonly ManufacturingRoute[],
): boolean {
  return (
    process === MY_FACTORY_PROCESS.id &&
    routes.length > 0 &&
    routes.every((route) => route.availableInFactory)
  );
}

/**
 * Primary manufacturing process of each deterministic route. When the RFQ
 * sets a target process the estimate is narrowed to the matching routes;
 * "unknown" compares every route and the user picks one before quoting.
 */
const ROUTE_PRIMARY_PROCESS: Record<string, string> = {
  "cnc-from-billet": "cnc_milling",
  "cnc-turned": "cnc_turning",
  "additive-finish": "additive",
  "sheet-metal": "sheet_metal",
  "laser-bend-cnc": "sheet_metal",
};

function processLabel(id: string): string {
  if (id === MY_FACTORY_PROCESS.id) return MY_FACTORY_PROCESS.label;
  return (
    MANUFACTURING_PROCESSES.find((process) => process.id === id)?.label ?? id
  );
}

export function isMachineProcess(value: string): boolean {
  return MACHINE_PROCESSES.some((process) => process.id === value);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function complexity(metrics: GeometryMetrics): number {
  const volume = Math.max(metrics.volumeMm3 ?? 18_000, 1);
  const surface = Math.max(metrics.surfaceAreaMm2 ?? 12_000, 1);
  return clamp(surface / Math.pow(volume, 2 / 3) / 6, 0.7, 3.2);
}

function materialMassKg(metrics: GeometryMetrics): number {
  return Math.max((metrics.massG ?? 75) / 1000, 0.01);
}

function priceRange(
  expected: number,
  uncertainty: number,
  confidence: number,
): PriceEstimate {
  return {
    currency: "EUR",
    minimum: roundMoney(expected * (1 - uncertainty)),
    expected: roundMoney(expected),
    maximum: roundMoney(expected * (1 + uncertainty)),
    confidence,
  };
}

function machineFor(
  process: string,
  machines: MachineProfile[],
  material: string,
): MachineProfile | undefined {
  return machines.find(
    (machine) =>
      machine.enabled &&
      machine.process === process &&
      (machine.materials.length === 0 || machine.materials.includes(material)),
  );
}

function operation(
  id: string,
  name: string,
  process: string,
  setupMinutes: number,
  cycleMinutes: number,
  detail: string,
): ManufacturingOperation {
  return { id, name, process, setupMinutes, cycleMinutes, detail };
}

function route(input: {
  id: string;
  name: string;
  description: string;
  suitability: number;
  operations: ManufacturingOperation[];
  expectedPrice: number;
  uncertainty: number;
  confidence: number;
  machines: MachineProfile[];
  material: string;
  reasons: string[];
  risks: string[];
}): ManufacturingRoute {
  const processes = new Set(input.operations.map((item) => item.process));
  const availableInFactory =
    input.machines.length > 0 &&
    [...processes].every((process) =>
      Boolean(machineFor(process, input.machines, input.material)),
    );
  const totalMinutes = input.operations.reduce(
    (sum, item) => sum + item.setupMinutes + item.cycleMinutes,
    0,
  );
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    suitability: clamp(
      Math.round(input.suitability + (availableInFactory ? 8 : 0)),
      0,
      100,
    ),
    availableInFactory,
    operations: input.operations,
    price: priceRange(input.expectedPrice, input.uncertainty, input.confidence),
    leadTimeHours: Math.max(1, Math.round((totalMinutes / 60 + 2) * 10) / 10),
    reasons: input.reasons,
    risks: input.risks,
  };
}

export function buildDeterministicManufacturingPlan(
  input: ManufacturingInput,
): ManufacturingPlan {
  const quantity = Math.max(input.metadata.quantity ?? 1, 1);
  const partMassKg = materialMassKg(input.metrics);
  const geometryComplexity = complexity(input.metrics);
  const materialRate = getMaterial(input.metadata.material).eurPerKg ?? 12;
  const rawMaterial = partMassKg * materialRate;
  const cncMachine = machineFor(
    "cnc_milling",
    input.machines,
    input.metadata.material,
  );
  const turningMachine = machineFor(
    "cnc_turning",
    input.machines,
    input.metadata.material,
  );
  const additiveMachine = machineFor(
    "additive",
    input.machines,
    input.metadata.material,
  );
  const sheetMachine = machineFor(
    "sheet_metal",
    input.machines,
    input.metadata.material,
  );
  const laserMachine = machineFor(
    "laser_cutting",
    input.machines,
    input.metadata.material,
  );
  const finishMachine = machineFor(
    "finishing",
    input.machines,
    input.metadata.material,
  );
  const cncRate = cncMachine?.hourlyRate ?? 78;
  const turningRate = turningMachine?.hourlyRate ?? 72;
  const additiveRate = additiveMachine?.hourlyRate ?? 34;
  const sheetRate = sheetMachine?.hourlyRate ?? 62;
  const laserRate = laserMachine?.hourlyRate ?? 70;
  const finishRate = finishMachine?.hourlyRate ?? 55;
  const finishSetup = finishMachine?.setupMinutes ?? 8;
  const toleranceBonus = input.metadata.tolerance ? 8 : 0;
  const finishBonus = input.metadata.finish ? 6 : 0;

  const cncCycle = 12 + geometryComplexity * 16 + partMassKg * 22;
  const cncSetup = cncMachine?.setupMinutes ?? 45;
  const cncExpected =
    rawMaterial * 1.8 * quantity +
    ((cncSetup + cncCycle * quantity) / 60) * cncRate +
    ((finishSetup + 2.5 * quantity) / 60) * finishRate +
    toleranceBonus +
    finishBonus;

  const turningCycle = 8 + geometryComplexity * 11 + partMassKg * 18;
  const turningSetup = turningMachine?.setupMinutes ?? 35;
  const turningExpected =
    rawMaterial * 1.65 * quantity +
    ((turningSetup + turningCycle * quantity) / 60) * turningRate +
    ((finishSetup + 2 * quantity) / 60) * finishRate +
    toleranceBonus +
    finishBonus;

  const additiveCycle = 45 + partMassKg * 260 + geometryComplexity * 25;
  const additiveSetup = additiveMachine?.setupMinutes ?? 20;
  const additiveExpected =
    Math.max(partMassKg * 1000 * 0.14, 8) * quantity +
    ((additiveSetup + additiveCycle * 0.25) / 60) * additiveRate +
    ((finishSetup + 4 * quantity) / 60) * finishRate +
    finishBonus;

  const sheetCycle = 7 + geometryComplexity * 3;
  const sheetSetup = sheetMachine?.setupMinutes ?? 35;
  const sheetExpected =
    rawMaterial * 1.25 * quantity +
    ((sheetSetup + sheetCycle * quantity) / 60) * sheetRate +
    ((finishSetup + 2 * quantity) / 60) * finishRate +
    12 +
    finishBonus;

  const hybridCycle = 5 + geometryComplexity * 3.5;
  const hybridExpected =
    rawMaterial * 1.3 * quantity +
    ((25 + hybridCycle * quantity) / 60) * laserRate +
    ((20 + 3 * quantity) / 60) * sheetRate +
    ((20 + Math.max(3, cncCycle * 0.18) * quantity) / 60) * cncRate +
    ((finishSetup + 2 * quantity) / 60) * finishRate +
    finishBonus;

  const isPolymer = ["abs", "pla"].includes(input.metadata.material);
  const isSheetPreferred = input.metadata.process === "sheet_metal";
  const isCncPreferred = input.metadata.process === "cnc_milling";
  const isTurningPreferred = input.metadata.process === "cnc_turning";
  const isAdditivePreferred = input.metadata.process === "additive";

  const allRoutes: ManufacturingRoute[] = [
    route({
      id: "cnc-from-billet",
      name: "CNC from billet",
      description:
        "Mill the complete part from oversize stock, then deburr and inspect critical features.",
      suitability: 78 + (isCncPreferred ? 16 : 0) - (isPolymer ? 8 : 0),
      operations: [
        operation(
          "cnc-setup",
          "Fixture and datum setup",
          "cnc_milling",
          cncSetup,
          0,
          "Establish stock, datum and tool plan.",
        ),
        operation(
          "cnc-machine",
          "3-axis machining",
          "cnc_milling",
          0,
          cncCycle * quantity,
          "Roughing, finishing and hole operations.",
        ),
        operation(
          "cnc-inspect",
          "Deburr and inspect",
          "finishing",
          finishSetup,
          2.5 * quantity,
          "Edge break and dimensional inspection.",
        ),
      ],
      expectedPrice: cncExpected,
      uncertainty: input.metadata.tolerance ? 0.16 : 0.27,
      confidence: input.metadata.tolerance ? 0.78 : 0.63,
      machines: input.machines,
      material: input.metadata.material,
      reasons: [
        "Strong dimensional control",
        "Works for low and medium quantities",
        "Direct path from solid CAD",
      ],
      risks: input.metadata.tolerance
        ? ["Fixture accessibility requires review"]
        : ["Tolerance strategy is missing", "Stock envelope is estimated"],
    }),
    route({
      id: "cnc-turned",
      name: "CNC turning + finish",
      description:
        "Turn rotational features from bar stock, then finish interfaces and inspect critical dimensions.",
      suitability:
        62 + (isTurningPreferred ? 30 : 0) - (isSheetPreferred ? 18 : 0),
      operations: [
        operation(
          "turn-setup",
          "Chuck and datum setup",
          "cnc_turning",
          turningSetup,
          0,
          "Select bar stock, workholding and datum strategy.",
        ),
        operation(
          "turn-machine",
          "CNC turning",
          "cnc_turning",
          0,
          turningCycle * quantity,
          "Rough and finish rotational geometry, bores and grooves.",
        ),
        operation(
          "turn-inspect",
          "Deburr and inspect",
          "finishing",
          finishSetup,
          2 * quantity,
          "Inspect diameters, runout and surface condition.",
        ),
      ],
      expectedPrice: turningExpected,
      uncertainty: isTurningPreferred ? 0.18 : 0.32,
      confidence: isTurningPreferred ? 0.75 : 0.52,
      machines: input.machines,
      material: input.metadata.material,
      reasons: [
        "Efficient for rotational geometry",
        "Strong diameter control",
        "Scales from prototype to batch",
      ],
      risks: [
        "Rotational symmetry must be confirmed",
        "Secondary milling may be required for prismatic features",
      ],
    }),
    route({
      id: "additive-finish",
      name: "Additive + finish",
      description:
        "Print near-net geometry, remove supports, then finish interfaces and critical holes.",
      suitability:
        69 +
        (isAdditivePreferred ? 18 : 0) +
        (isPolymer ? 12 : 0) -
        (quantity > 100 ? 12 : 0),
      operations: [
        operation(
          "print-setup",
          "Build preparation",
          "additive",
          additiveSetup,
          0,
          "Orient part and generate supports.",
        ),
        operation(
          "print",
          "Additive build",
          "additive",
          0,
          additiveCycle,
          "Near-net build with estimated packing efficiency.",
        ),
        operation(
          "print-finish",
          "Support removal and finish",
          "finishing",
          finishSetup,
          4 * quantity,
          "Remove supports and finish critical interfaces.",
        ),
      ],
      expectedPrice: additiveExpected,
      uncertainty: 0.3,
      confidence: 0.58,
      machines: input.machines,
      material: input.metadata.material,
      reasons: [
        "Low tooling cost",
        "Handles complex geometry",
        "Fast route for prototypes",
      ],
      risks: [
        "Orientation and support volume are estimated",
        "Tolerance may require secondary machining",
      ],
    }),
    route({
      id: "sheet-metal",
      name: "Sheet metal formed",
      description:
        "Cut a flat blank, form bends, then apply the specified finish.",
      suitability: 54 + (isSheetPreferred ? 30 : 0),
      operations: [
        operation(
          "sheet-setup",
          "Blank and tooling setup",
          "sheet_metal",
          sheetSetup,
          0,
          "Select stock gauge and bend tooling.",
        ),
        operation(
          "sheet-form",
          "Cut and form",
          "sheet_metal",
          0,
          sheetCycle * quantity,
          "Cut profile and execute bend sequence.",
        ),
        operation(
          "sheet-finish",
          "Finish and inspect",
          "finishing",
          finishSetup,
          2 * quantity,
          "Deburr, finish and inspect bend geometry.",
        ),
      ],
      expectedPrice: sheetExpected,
      uncertainty: 0.34,
      confidence: 0.49,
      machines: input.machines,
      material: input.metadata.material,
      reasons: [
        "Efficient for thin-wall parts",
        "Scales well with quantity",
        "Low material waste",
      ],
      risks: [
        "Uniform wall thickness is not yet verified",
        "Bend radii and flat pattern require validation",
      ],
    }),
    route({
      id: "laser-bend-cnc",
      name: "Laser + bend + CNC finish",
      description:
        "A hybrid route combining fast blank production with precise secondary machining.",
      suitability: 72 + (isSheetPreferred ? 14 : 0) + (quantity >= 20 ? 6 : 0),
      operations: [
        operation(
          "laser",
          "Laser cut blank",
          "laser_cutting",
          25,
          hybridCycle * quantity,
          "Nest and cut the developed profile.",
        ),
        operation(
          "bend",
          "Form bends",
          "sheet_metal",
          20,
          3 * quantity,
          "Form the part in a controlled sequence.",
        ),
        operation(
          "hybrid-cnc",
          "Finish critical features",
          "cnc_milling",
          20,
          Math.max(3, cncCycle * 0.18) * quantity,
          "Machine datums, holes and precision interfaces.",
        ),
        operation(
          "hybrid-finish",
          "Final inspection",
          "finishing",
          finishSetup,
          2 * quantity,
          "Inspect geometry and finish.",
        ),
      ],
      expectedPrice: hybridExpected,
      uncertainty: 0.25,
      confidence: 0.66,
      machines: input.machines,
      material: input.metadata.material,
      reasons: [
        "Separates fast material removal from precision work",
        "Good batch economics",
        "Reduces CNC cycle time",
      ],
      risks: [
        "Requires a valid flat pattern",
        "Datum transfer between operations must be planned",
      ],
    }),
  ].sort((a, b) => b.suitability - a.suitability);

  // A selected target process narrows the estimate to its matching routes;
  // "My Factory" narrows to the routes the user's own machines can run end to
  // end instead. An unmatched or unknown process keeps the full comparison —
  // the comparison is never allowed to come back empty.
  const factoryTargeted = input.metadata.process === MY_FACTORY_PROCESS.id;
  const targeted = factoryTargeted
    ? allRoutes.filter((item) => item.availableInFactory)
    : allRoutes.filter(
        (item) => ROUTE_PRIMARY_PROCESS[item.id] === input.metadata.process,
      );
  const routes = targeted.length > 0 ? targeted : allRoutes;

  const recommended = routes[0];
  const summary = factoryTargeted
    ? targeted.length > 0
      ? `${recommended.name} is the best fit among the routes your My Factory machines can run end to end; the estimate is restricted to those routes. Prices are preliminary engineering estimates and require supplier or factory validation.`
      : `${recommended.name} is the current best-fit route — no route runs end to end on your My Factory machines, so every route is compared instead. Confirm the route to use before quoting. Prices are preliminary engineering estimates and require supplier or factory validation.`
    : targeted.length > 0
      ? `${recommended.name} estimates the requested ${processLabel(input.metadata.process)} process. Prices are preliminary engineering estimates and require supplier or factory validation.`
      : `${recommended.name} is the current best-fit route — confirm the route to use before quoting. Prices are preliminary engineering estimates and require supplier or factory validation.`;
  return {
    provider: "deterministic",
    providerLabel: "Deterministic fallback",
    recommendedRouteId: recommended.id,
    summary,
    generatedAt: new Date().toISOString(),
    routes,
  };
}
