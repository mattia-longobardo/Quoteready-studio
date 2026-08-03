/**
 * Wire contract for the duplicate-part-name confirmation.
 *
 * The browser checks the workspace before it submits, but the check cannot be
 * trusted (stale list, second tab, direct API call), so the server enforces it
 * too: a name already taken by a visible part is answered with 409 and this
 * code, and the write only proceeds when the request carries an explicit
 * `overwrite` flag — the machine-readable form of the user's confirmation.
 */
const PART_NAME_CONFLICT_CODE = "part_name_conflict";

/** 409 body a route returns for a duplicate part name. */
interface PartNameConflictBody {
  error: string;
  code: typeof PART_NAME_CONFLICT_CODE;
  conflict: { partId: string; partName: string };
}

export function partNameConflictBody(conflict: {
  partId: string;
  partName: string;
  message: string;
}): PartNameConflictBody {
  return {
    error: conflict.message,
    code: PART_NAME_CONFLICT_CODE,
    conflict: { partId: conflict.partId, partName: conflict.partName },
  };
}

/** Whether a request asked for a confirmed overwrite. */
export function isOverwriteConfirmed(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Read the conflicting part name out of a failed response, or null when the
 * failure is not a name collision. The body is read from a clone so the caller
 * can still fall back to `responseMessage`.
 */
export async function readPartNameConflict(
  response: Response,
): Promise<{ partId: string; partName: string } | null> {
  if (response.status !== 409) return null;
  try {
    const body = (await response.clone().json()) as Partial<
      PartNameConflictBody & { conflict?: Record<string, unknown> }
    >;
    if (body.code !== PART_NAME_CONFLICT_CODE) return null;
    const partName = body.conflict?.partName;
    const partId = body.conflict?.partId;
    if (typeof partName !== "string" || typeof partId !== "string") return null;
    return { partId, partName };
  } catch {
    return null;
  }
}
