import { describe, expect, it } from "vitest";

import {
  findPartByName,
  isSupersededPart,
  normalizePartName,
  samePartName,
  visibleParts,
} from "../src/parts";

function part(
  id: string,
  name: string,
  supersededAt: string | null = null,
): { id: string; name: string; supersededAt?: string | null } {
  return supersededAt === null ? { id, name } : { id, name, supersededAt };
}

describe("part name identity", () => {
  it("compares names ignoring case and surrounding whitespace", () => {
    expect(normalizePartName("  BR-042 Bracket ")).toBe("br-042 bracket");
    expect(samePartName("Bracket", " bracket ")).toBe(true);
    expect(samePartName("Bracket", "Bracket 2")).toBe(false);
    // An empty name is not a collision — the form validation rejects it first.
    expect(samePartName("", "   ")).toBe(false);
  });

  it("hides superseded parts from the workspace", () => {
    const parts = [
      part("new", "Bracket"),
      part("old", "Bracket", "2026-07-30T10:00:00.000Z"),
    ];
    expect(isSupersededPart(parts[0])).toBe(false);
    expect(isSupersededPart(parts[1])).toBe(true);
    expect(visibleParts(parts).map((item) => item.id)).toEqual(["new"]);
  });

  it("finds the visible namesake, never a superseded one nor itself", () => {
    const parts = [
      part("a", "Bracket"),
      part("b", "Housing"),
      part("c", "Cover", "2026-07-30T10:00:00.000Z"),
    ];
    expect(findPartByName(parts, "BRACKET")?.id).toBe("a");
    // A superseded part keeps its record but no longer reserves its name.
    expect(findPartByName(parts, "cover")).toBeNull();
    // A rename never collides with the part being renamed.
    expect(findPartByName(parts, "Bracket", { excludeId: "a" })).toBeNull();
    expect(findPartByName(parts, "Flange")).toBeNull();
  });
});
