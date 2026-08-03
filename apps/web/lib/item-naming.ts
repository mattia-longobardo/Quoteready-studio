/**
 * Human-readable sequential names for the artefacts generated from a part:
 * "USB_Holder_01", "USB_Holder_02", … Drawings and report documents used to be
 * labelled with the part name alone, which made every item of the same part
 * indistinguishable in the lists.
 *
 * Analysis results are named per day instead ("USB_Holder_2026-07-30", then
 * "…_01", "…_02"), see `nextResultTitle`.
 */

import type { DrawingTable, ReportDocument } from "@quoteredy/core/types";

/** Bound of the stem so a generated label always fits the stored fields. */
const MAX_STEM_LENGTH = 80;
/** Guard against absurd suffixes in stored names. */
const SUFFIX_PATTERN = "(\\d{1,6})";

/**
 * Reduce a CAD file name to a safe label stem: the extension is dropped and
 * every character outside [A-Za-z0-9_-] becomes an underscore.
 * "USB Holder.step" → "USB_Holder".
 */
export function partNameStem(fileName: string): string {
  const stem = fileName
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, MAX_STEM_LENGTH);
  return stem || "part";
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * Next free "<stem>_NN" label for a part. The highest suffix already taken
 * wins (+1), so a deleted item never hands its number to a later one; the
 * suffix is zero-padded to two digits and grows naturally past 99.
 */
export function nextSequentialName(
  stem: string,
  existing: readonly (string | undefined | null)[],
): string {
  const pattern = new RegExp(
    `^${escapeForRegExp(stem)}_${SUFFIX_PATTERN}$`,
    "i",
  );
  let highest = 0;
  for (const name of existing) {
    const match = typeof name === "string" ? pattern.exec(name) : null;
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${stem}_${String(highest + 1).padStart(2, "0")}`;
}

/**
 * Calendar day of a result title in the user's timezone, "2026-07-30". An
 * invalid stored timezone (or an unparsable date) must never break naming, so
 * both fall back instead of throwing.
 */
export function resultDateStamp(date: Date, timeZone?: string): string {
  const when = Number.isNaN(date.valueOf()) ? new Date() : date;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(when);
    const value = (type: string) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const [year, month, day] = [value("year"), value("month"), value("day")];
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Unsupported timezone: fall through to UTC.
  }
  return when.toISOString().slice(0, 10);
}

/**
 * Title of a new analysis result: "<part>_<date>", e.g.
 * "USB_Holder_2026-07-30". When that title is already taken in the workspace
 * the LOWEST free numeric suffix is appended ("_01", "_02", …) — unlike
 * `nextSequentialName`, a freed number IS reused, so deleting "_01" hands that
 * slot to the next result of the day. Titles that don't follow this shape
 * (legacy results, renamed ones) simply never collide.
 */
export function nextResultTitle(
  partName: string,
  existingTitles: readonly (string | undefined | null)[],
  options: { date?: Date; timeZone?: string } = {},
): string {
  const base = `${partNameStem(partName)}_${resultDateStamp(
    options.date ?? new Date(),
    options.timeZone,
  )}`;
  const taken = new Set(
    existingTitles
      .filter((title): title is string => typeof title === "string")
      .map((title) => title.trim().toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  // At most `taken.size` names are unavailable and `base` is one of them, so a
  // free suffix always exists in 1…taken.size.
  for (let index = 1; index <= taken.size; index += 1) {
    const candidate = `${base}_${String(index).padStart(2, "0")}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}_${String(taken.size + 1).padStart(2, "0")}`;
}

/** Sequential name of a drawing; older drawings fall back to the part name. */
export function drawingLabel(
  drawing: Pick<DrawingTable, "name" | "partName">,
): string {
  return drawing.name || drawing.partName;
}

/** Sequential name of a report; older reports fall back to their title. */
export function documentLabel(
  document: Pick<ReportDocument, "name" | "title">,
): string {
  return document.name || document.title;
}
