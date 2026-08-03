export function formatDate(
  value: string,
  timeZone?: string,
  withTime = false,
): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "Unknown";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
      timeZone,
    }).format(parsed);
  } catch {
    // An invalid stored timezone must never break rendering.
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(parsed);
  }
}
