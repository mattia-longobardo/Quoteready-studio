/**
 * Read a bounded error message from an API response. A 401 means the Zoo
 * session is gone (expired or refresh failed): the only useful action is a
 * fresh sign-in, so the browser is sent straight to /login.
 */
export async function responseMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.replace("/login");
    return "Your Zoo session has expired. Redirecting to sign-in…";
  }
  try {
    const body = (await response.json()) as { error?: string; detail?: string };
    return [body.error, body.detail].filter(Boolean).join(" ") || fallback;
  } catch {
    return fallback;
  }
}
