import { describe, expect, it } from "vitest";

import { roundNumbersDeep } from "@/lib/report-ai";

describe("roundNumbersDeep", () => {
  it("rounds floating-point noise to at most two decimals", () => {
    expect(roundNumbersDeep(128.8607637554295)).toBe(128.86);
    expect(roundNumbersDeep(0.10000000000000009)).toBe(0.1);
  });

  it("keeps integers and short decimals unchanged", () => {
    expect(roundNumbersDeep(100)).toBe(100);
    expect(roundNumbersDeep(6.3)).toBe(6.3);
    expect(roundNumbersDeep(0)).toBe(0);
    expect(roundNumbersDeep(-12.345)).toBe(-12.35);
  });

  it("walks nested objects and arrays without touching other types", () => {
    const rounded = roundNumbersDeep({
      operations: [
        { name: "Additive build", cycleMinutes: 128.8607637554295 },
        { name: "Finish", cycleMinutes: 100, done: true, note: null },
      ],
      confidence: 0.5800000000000001,
      title: "Bracket #000-2",
    });
    expect(rounded).toEqual({
      operations: [
        { name: "Additive build", cycleMinutes: 128.86 },
        { name: "Finish", cycleMinutes: 100, done: true, note: null },
      ],
      confidence: 0.58,
      title: "Bracket #000-2",
    });
  });

  it("leaves non-finite numbers alone", () => {
    expect(roundNumbersDeep(Number.POSITIVE_INFINITY)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(roundNumbersDeep(Number.NaN)).toBeNaN();
  });
});
