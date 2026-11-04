import test from "node:test";
import assert from "node:assert/strict";
import { BrowserJsonExtractor } from "../src/lib/browser-json-extractor.mjs";

const list = {
  owner: [
    {
      entry_dn: "cn=Owned Group,ou=Groups,dc=example,dc=test",
      cn: ["Owned Group"],
      umichGroupEmail: "owned@example.test",
      modifyTimestamp: "20260722120000Z",
      umichExpiryTimestamp: "20270722120000Z",
      umichServiceEntitlement: [],
    },
  ],
  member: [
    {
      entry_dn: "cn=Member Group,ou=Groups,dc=example,dc=test",
      cn: ["Member Group"],
      umichDescription: "A member group",
      umichGroupEmail: "member@example.test",
      umichServiceEntitlement: [],
    },
  ],
};

function definition(transform) {
  return {
    name: `test.${transform}`,
    url: "https://mcommunity.example.test/my-groups",
    authentication: "test_sso",
    extraction: {
      type: "browser_json",
      responseUrl: "https://mcommunity.example.test/api/groups/",
      responseMethod: "GET",
      pointer: "",
      transform,
    },
  };
}

test("normalizes owned and member groups with inert deep links", async () => {
  const extractor = new BrowserJsonExtractor({ capture: async () => list });
  const result = await extractor.extract({
    definition: definition("mcommunity_groups"),
  });

  assert.equal(result.groups.length, 2);
  assert.deepEqual(
    result.groups.map(({ name, is_owner, is_member }) => ({
      name,
      is_owner,
      is_member,
    })),
    [
      { name: "Member Group", is_owner: false, is_member: true },
      { name: "Owned Group", is_owner: true, is_member: false },
    ],
  );
  assert.equal(
    result.groups[1].group_url,
    "https://mcommunity.example.test/group/Owned%20Group",
  );
});

test("reads detail only after the group appears in the active group list", async () => {
  const calls = [];
  const detail = {
    cn: ["Owned Group"],
    umichGroupEmail: "owned@example.test",
    owner: ["uid=owner,ou=People,dc=example,dc=test"],
    member: ["uid=member,ou=People,dc=example,dc=test"],
    joinable: false,
    Membersonly: true,
    umichPrivate: true,
  };
  const extractor = new BrowserJsonExtractor({
    capture: async (request) => {
      calls.push(request);
      return calls.length === 1 ? list : detail;
    },
  });

  const result = await extractor.extract({
    definition: definition("mcommunity_group"),
    input: { group: "Owned Group" },
  });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].responseUrl,
    "https://mcommunity.example.test/api/groups/Owned%20Group/",
  );
  assert.deepEqual(result.owners[0], {
    kind: "person",
    id: "owner",
    directory_id: "uid=owner,ou=People,dc=example,dc=test",
  });
  assert.equal(result.private, true);
});

test("refuses detail for a group outside the authenticated list", async () => {
  let calls = 0;
  const extractor = new BrowserJsonExtractor({
    capture: async () => {
      calls += 1;
      return list;
    },
  });

  await assert.rejects(
    extractor.extract({
      definition: definition("mcommunity_group"),
      input: { group: "Unlisted Group" },
    }),
    (error) => error.code === "RESOURCE_NOT_AVAILABLE",
  );
  assert.equal(calls, 1);
});
