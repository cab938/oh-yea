import test from "node:test";
import assert from "node:assert/strict";
import {
  redactDiagnosticText,
  safeBrowserUrl,
} from "../src/lib/browser-inspector.mjs";

test("browser diagnostics remove URL queries and fragments", () => {
  assert.equal(
    safeBrowserUrl(
      "https://weblogin.umich.edu/callback?code=sensitive#fragment",
    ),
    "https://weblogin.umich.edu/callback",
  );
});

test("browser diagnostics redact common credential-shaped text", () => {
  const redacted = redactDiagnosticText(
    "Bearer secret-value SAMLResponse=very-secret https://example.test/path?code=secret",
  );
  assert.equal(
    redacted,
    "Bearer [redacted] SAMLResponse=[redacted] https://example.test/path",
  );
});
