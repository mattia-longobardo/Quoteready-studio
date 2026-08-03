/**
 * Part identity rules shared by the UI and the persistence layer.
 *
 * A part name is the handle the user works with (it titles the results, the
 * drawings and the reports derived from it), so two visible parts must never
 * carry the same name. Re-using a name is allowed but only as an explicit
 * overwrite: the previous part is *superseded* — hidden from the workspace yet
 * kept, with its blobs, so everything already generated from it still resolves
 * to the original geometry.
 */

/** Minimal shape needed to decide whether a part is still visible. */
export interface PartVisibility {
  supersededAt?: string | null;
}

/** Minimal shape needed to compare part names. */
export interface PartIdentity extends PartVisibility {
  id: string;
  name: string;
}

/** Whether a newer part has taken over this part's name. */
export function isSupersededPart(part: PartVisibility): boolean {
  return Boolean(part.supersededAt);
}

/**
 * The parts a workspace shows: superseded records stay in storage for old
 * results to resolve, but never appear in lists, pickers or counters.
 */
export function visibleParts<Part extends PartVisibility>(
  parts: readonly Part[],
): Part[] {
  return parts.filter((part) => !isSupersededPart(part));
}

/**
 * Comparison form of a part name: names collide when they differ only in
 * surrounding whitespace or letter case ("Bracket" vs "bracket ").
 */
export function normalizePartName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** Whether two part names are the same name for collision purposes. */
export function samePartName(left: string, right: string): boolean {
  return (
    normalizePartName(left) === normalizePartName(right) &&
    normalizePartName(left) !== ""
  );
}

/**
 * The visible part already carrying `name`, or null when the name is free.
 * `excludeId` skips a part in the comparison — a rename never collides with
 * the record being renamed.
 */
export function findPartByName<Part extends PartIdentity>(
  parts: readonly Part[],
  name: string,
  options: { excludeId?: string } = {},
): Part | null {
  return (
    visibleParts(parts).find(
      (part) => part.id !== options.excludeId && samePartName(part.name, name),
    ) ?? null
  );
}
