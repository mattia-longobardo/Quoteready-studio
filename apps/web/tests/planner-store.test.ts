import { beforeEach, describe, expect, it } from "vitest";

import {
  defaultTargetProcess,
  getPlannerState,
  resetPlanner,
  setPlannerFactoryAvailability,
  updatePlannerForm,
} from "@/lib/planner-store";
import { MY_FACTORY_PROCESS } from "@quoteredy/core/manufacturing";

function currentProcess(): string {
  return getPlannerState().form.process;
}

describe("planner target process default", () => {
  beforeEach(() => {
    // A machine-less workspace is the baseline the store starts from.
    setPlannerFactoryAvailability(false);
    resetPlanner();
  });

  it("resolves the default from the presence of machines", () => {
    expect(defaultTargetProcess(false)).toBe("unknown");
    expect(defaultTargetProcess(true)).toBe(MY_FACTORY_PROCESS.id);
  });

  it("keeps the open comparison for a workspace without machines", () => {
    expect(currentProcess()).toBe("unknown");
    setPlannerFactoryAvailability(false);
    expect(currentProcess()).toBe("unknown");
  });

  it("selects My Factory once the workspace reports machines", () => {
    setPlannerFactoryAvailability(true);
    expect(currentProcess()).toBe(MY_FACTORY_PROCESS.id);
  });

  it("never overrides a process the user picked", () => {
    updatePlannerForm("process", "cnc_milling");
    setPlannerFactoryAvailability(true);
    expect(currentProcess()).toBe("cnc_milling");
  });

  it("respects an explicit open comparison", () => {
    updatePlannerForm("process", "unknown");
    setPlannerFactoryAvailability(true);
    expect(currentProcess()).toBe("unknown");
  });

  it("degrades a stale My Factory selection when the machines are gone", () => {
    setPlannerFactoryAvailability(true);
    expect(currentProcess()).toBe(MY_FACTORY_PROCESS.id);
    setPlannerFactoryAvailability(false);
    expect(currentProcess()).toBe("unknown");
  });

  it("restores the factory default on a new plan", () => {
    setPlannerFactoryAvailability(true);
    updatePlannerForm("process", "additive");
    resetPlanner();
    expect(currentProcess()).toBe(MY_FACTORY_PROCESS.id);
  });
});
