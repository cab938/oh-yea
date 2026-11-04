import test from "node:test";
import assert from "node:assert/strict";
import { extractAuthenticatedJson } from "../src/lib/authenticated-json.mjs";

test("fetches authenticated JSON and returns only the configured projection", async () => {
  const calls = [];
  const authSession = {
    async fetch(url, options) {
      calls.push({ url, options });
      return Response.json({
        accounts: [{ remaining: { GPU: 10, Standard: 100 } }],
      });
    },
  };
  const data = await extractAuthenticatedJson({
    authSession,
    definition: {
      url: "https://api.example.test/account",
      extraction: {
        type: "authenticated_json",
        pointer: "/accounts/0/remaining",
      },
    },
    requestHeaders: { "x-identity": "private-value" },
  });

  assert.deepEqual(data, { GPU: 10, Standard: 100 });
  assert.equal(calls[0].url, "https://api.example.test/account");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.headers["x-identity"], "private-value");
});

test("reports an authentication rejection without reading its body", async () => {
  const authSession = {
    async fetch() {
      return new Response("private response", { status: 401 });
    },
  };
  await assert.rejects(
    extractAuthenticatedJson({
      authSession,
      definition: {
        url: "https://api.example.test/account",
        extraction: { type: "authenticated_json", pointer: "" },
      },
    }),
    (error) => error.code === "AUTHENTICATION_REQUIRED",
  );
});
