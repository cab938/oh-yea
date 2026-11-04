import test from "node:test";
import assert from "node:assert/strict";
import {
  describeSignInGroup,
  listSignInGroups,
} from "../src/renderer/authentication-status.mjs";

test("groups referenced application profiles under one human sign-in", () => {
  const result = listSignInGroups(
    {
      mcommunity_sso: {
        displayName: "MCommunity",
        signInGroup: "U-M SSO",
      },
      teamdynamix_sso: {
        displayName: "TeamDynamix",
        signInGroup: "U-M SSO",
      },
    },
    [
      {
        name: "mcommunity.groups.list",
        authentication: "mcommunity_sso",
        enabled: true,
        valid: true,
      },
      {
        name: "umich.teamdynamix.expense_report.submit",
        authentication: "teamdynamix_sso",
        enabled: true,
        valid: true,
      },
    ],
    [
      {
        authentication: "mcommunity_sso",
        displayName: "MCommunity",
        state: "authenticated",
      },
      {
        authentication: "teamdynamix_sso",
        displayName: "TeamDynamix",
        state: "unauthenticated",
      },
    ],
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].displayName, "U-M SSO");
  assert.deepEqual(
    result[0].profiles.map(({ name }) => name),
    ["mcommunity_sso", "teamdynamix_sso"],
  );
  assert.deepEqual(describeSignInGroup(result[0]), {
    state: "unauthenticated",
    label: "U-M SSO · Setup needed",
    title: "1 application session using U-M SSO still needs setup",
    signInAuthentication: "teamdynamix_sso",
  });
});

test("shows the earliest approximate revalidation time for a sign-in group", () => {
  const result = describeSignInGroup(
    { displayName: "U-M SSO", profiles: [
      {
        status: {
          authentication: "arc_session",
          state: "authenticated",
          expectedExpiresAt: "2026-07-20T17:48:53.000Z",
        },
      },
      {
        status: {
          authentication: "mcommunity_sso",
          state: "authenticated",
        },
      },
    ] },
    { formatTime: () => "1:48 PM" },
  );

  assert.deepEqual(result, {
    state: "authenticated",
    label: "U-M SSO · Ready",
    title:
      "All application sessions using U-M SSO are ready. Earliest estimated revalidation is around 1:48 PM.",
  });
});
