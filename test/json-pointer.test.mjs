import test from "node:test";
import assert from "node:assert/strict";
import { resolveJsonPointer } from "../src/lib/json-pointer.mjs";

test("resolves an RFC 6901 pointer into a JSON response", () => {
  const payload = [
    {
      subaccounts: [
        {
          limits: {
            spending: {
              unitHours: { GPU: 7_180, Standard: 78_525 },
            },
          },
        },
      ],
    },
  ];
  assert.deepEqual(
    resolveJsonPointer(
      payload,
      "/0/subaccounts/0/limits/spending/unitHours",
    ),
    { GPU: 7_180, Standard: 78_525 },
  );
});

test("supports escaped JSON Pointer property names", () => {
  assert.equal(resolveJsonPointer({ "a/b": { "~key": 42 } }, "/a~1b/~0key"), 42);
});

test("fails closed when a pointer does not match", () => {
  assert.throws(
    () => resolveJsonPointer({ present: true }, "/missing"),
    (error) => error.code === "EXTRACTION_NOT_FOUND",
  );
});
