import test from "node:test";
import assert from "node:assert/strict";
import { shouldSyncAddress } from "../src/renderer/address-sync.mjs";

test("browser URL synchronization pauses while the address field is focused", () => {
  const address = {};
  assert.equal(shouldSyncAddress(address, address), false);
});

test("browser URL synchronization resumes when focus leaves the address field", () => {
  const address = {};
  const otherElement = {};
  assert.equal(shouldSyncAddress(otherElement, address), true);
  assert.equal(shouldSyncAddress(null, address), true);
});
