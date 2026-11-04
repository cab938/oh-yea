function pointerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function decodeSegment(segment) {
  if (/~(?![01])/u.test(segment)) {
    throw pointerError(
      "INVALID_JSON_POINTER",
      `JSON Pointer segment contains an invalid escape: ${segment}`,
    );
  }
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function resolveJsonPointer(value, pointer) {
  if (pointer === "") return value;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw pointerError(
      "INVALID_JSON_POINTER",
      "JSON Pointer must be empty or start with /",
    );
  }

  let current = value;
  for (const encodedSegment of pointer.slice(1).split("/")) {
    const segment = decodeSegment(encodedSegment);
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, segment)
    ) {
      throw pointerError(
        "EXTRACTION_NOT_FOUND",
        `JSON Pointer did not match the response at segment ${segment}`,
      );
    }
    current = current[segment];
  }
  return current;
}
