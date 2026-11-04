import { resolveJsonPointer } from "./json-pointer.mjs";

function extractionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function extractAuthenticatedJson({
  authSession,
  definition,
  requestHeaders = {},
}) {
  let response;
  try {
    response = await authSession.fetch(definition.url, {
      method: "GET",
      credentials: "include",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: "application/json",
        ...requestHeaders,
      },
    });
  } catch (error) {
    throw extractionError(
      "UPSTREAM_UNREACHABLE",
      `Authenticated JSON request failed: ${error.message}`,
    );
  }

  if ([401, 403].includes(response.status)) {
    throw extractionError(
      "AUTHENTICATION_REQUIRED",
      "The authenticated JSON endpoint rejected the current session",
    );
  }
  if (!response.ok) {
    throw extractionError(
      "UPSTREAM_RESPONSE_ERROR",
      `Authenticated JSON endpoint returned HTTP ${response.status}`,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw extractionError(
      "INVALID_UPSTREAM_RESPONSE",
      "Authenticated JSON endpoint did not return valid JSON",
    );
  }

  return resolveJsonPointer(payload, definition.extraction.pointer);
}
