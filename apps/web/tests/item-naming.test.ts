import { describe, expect, it } from "vitest";

import {
  documentLabel,
  drawingLabel,
  nextResultTitle,
  nextSequentialName,
  partNameStem,
  resultDateStamp,
} from "@/lib/item-naming";

describe("partNameStem", () => {
  it("drops the extension and keeps only safe characters", () => {
    expect(partNameStem("USB Holder.step")).toBe("USB_Holder");
    expect(partNameStem("USB_Holder.step")).toBe("USB_Holder");
    expect(partNameStem("bracket-v2.STEP")).toBe("bracket-v2");
    expect(partNameStem("part.v2.stp")).toBe("part_v2");
  });

  it("trims separator noise and falls back for empty stems", () => {
    expect(partNameStem("#000-1.step")).toBe("000-1");
    expect(partNameStem(".step")).toBe("part");
    expect(partNameStem("")).toBe("part");
  });
});

describe("nextSequentialName", () => {
  it("starts at _01 and counts up per part", () => {
    expect(nextSequentialName("USB_Holder", [])).toBe("USB_Holder_01");
    expect(nextSequentialName("USB_Holder", ["USB_Holder_01"])).toBe(
      "USB_Holder_02",
    );
  });

  it("continues past the highest suffix, so deleted numbers are not reused", () => {
    expect(
      nextSequentialName("USB_Holder", ["USB_Holder_01", "USB_Holder_03"]),
    ).toBe("USB_Holder_04");
    expect(nextSequentialName("USB_Holder", ["USB_Holder_99"])).toBe(
      "USB_Holder_100",
    );
  });

  it("ignores other parts, legacy labels and case differences", () => {
    expect(
      nextSequentialName("USB_Holder", [
        "Bracket_07",
        "#000-1",
        undefined,
        null,
        "USB_Holder",
        "usb_holder_02",
      ]),
    ).toBe("USB_Holder_03");
  });

  it("treats the stem literally, not as a pattern", () => {
    expect(nextSequentialName("a-b", ["axb_04"])).toBe("a-b_01");
  });
});

describe("resultDateStamp", () => {
  const midnightUtc = new Date("2026-07-30T23:30:00Z");

  it("uses the calendar day of the given timezone", () => {
    expect(resultDateStamp(midnightUtc, "Europe/Rome")).toBe("2026-07-31");
    expect(resultDateStamp(midnightUtc, "UTC")).toBe("2026-07-30");
    expect(resultDateStamp(midnightUtc, "America/Los_Angeles")).toBe(
      "2026-07-30",
    );
  });

  it("falls back to UTC on an unusable timezone or date", () => {
    expect(resultDateStamp(midnightUtc, "Not/AZone")).toBe("2026-07-30");
    expect(resultDateStamp(new Date("nonsense"), "UTC")).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe("nextResultTitle", () => {
  const options = {
    date: new Date("2026-07-30T09:00:00Z"),
    timeZone: "Europe/Rome",
  };

  it("names the first result of the day without a suffix", () => {
    expect(nextResultTitle("USB Holder.step", [], options)).toBe(
      "USB_Holder_2026-07-30",
    );
  });

  it("appends _01, _02 … for further results of the same part and day", () => {
    expect(
      nextResultTitle("USB_Holder", ["USB_Holder_2026-07-30"], options),
    ).toBe("USB_Holder_2026-07-30_01");
    expect(
      nextResultTitle(
        "USB_Holder",
        ["USB_Holder_2026-07-30", "USB_Holder_2026-07-30_01"],
        options,
      ),
    ).toBe("USB_Holder_2026-07-30_02");
  });

  it("reuses the lowest freed number instead of counting past the highest", () => {
    expect(
      nextResultTitle(
        "USB_Holder",
        [
          "USB_Holder_2026-07-30",
          "USB_Holder_2026-07-30_02",
          "USB_Holder_2026-07-30_03",
        ],
        options,
      ),
    ).toBe("USB_Holder_2026-07-30_01");
    expect(
      nextResultTitle(
        "USB_Holder",
        [
          "USB_Holder_2026-07-30",
          "USB_Holder_2026-07-30_01",
          "USB_Holder_2026-07-30_03",
        ],
        options,
      ),
    ).toBe("USB_Holder_2026-07-30_02");
  });

  it("starts fresh on another day and ignores other parts", () => {
    expect(
      nextResultTitle(
        "USB_Holder",
        [
          "USB_Holder_2026-07-29",
          "USB_Holder_2026-07-29_01",
          "Bracket_2026-07-30",
          "Bracket_2026-07-30_01",
        ],
        options,
      ),
    ).toBe("USB_Holder_2026-07-30");
  });

  it("ignores legacy titles, blanks and case differences", () => {
    expect(
      nextResultTitle(
        "USB_Holder",
        [
          "USB Holder",
          "USB_Holder",
          "USB_Holder_01",
          "demo-bracket.step",
          undefined,
          null,
        ],
        options,
      ),
    ).toBe("USB_Holder_2026-07-30");
    expect(
      nextResultTitle("USB_Holder", ["  usb_holder_2026-07-30  "], options),
    ).toBe("USB_Holder_2026-07-30_01");
  });

  it("sanitizes the part name like every other generated label", () => {
    expect(nextResultTitle("#000 1.step", [], options)).toBe(
      "000_1_2026-07-30",
    );
    expect(nextResultTitle("", [], options)).toBe("part_2026-07-30");
  });
});

describe("labels", () => {
  it("prefers the sequential name and falls back to the legacy label", () => {
    expect(drawingLabel({ name: "USB_Holder_02", partName: "#000-1" })).toBe(
      "USB_Holder_02",
    );
    expect(drawingLabel({ partName: "#000-1" })).toBe("#000-1");
    expect(documentLabel({ name: "USB_Holder_01", title: "#000-1" })).toBe(
      "USB_Holder_01",
    );
    expect(documentLabel({ title: "#000-1" })).toBe("#000-1");
  });
});
