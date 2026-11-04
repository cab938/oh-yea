import { resolveJsonPointer } from "./json-pointer.mjs";

function extractionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

function groupName(group) {
  return Array.isArray(group?.cn)
    ? group.cn.find((value) => typeof value === "string" && value)
    : null;
}

function entitlements(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    system: nullableString(item?.system),
    foreign_key: nullableString(item?.foreignKey),
    changed_at: nullableString(item?.changeDate),
  }));
}

function principal(value) {
  const directoryId = String(value);
  const person = directoryId.match(/^uid=([^,]+),/iu);
  if (person) {
    return { kind: "person", id: person[1], directory_id: directoryId };
  }
  const group = directoryId.match(/^cn=([^,]+),/iu);
  if (group) {
    return { kind: "group", id: group[1], directory_id: directoryId };
  }
  return { kind: "directory_entry", id: directoryId, directory_id: directoryId };
}

function summary(group, baseUrl, relationships = {}) {
  const name = groupName(group);
  if (!name) return null;
  return {
    key: name,
    name,
    email: nullableString(group.umichGroupEmail),
    description: nullableString(group.umichDescription),
    is_owner: Boolean(relationships.isOwner),
    is_member: Boolean(relationships.isMember),
    expires_at: nullableString(group.umichExpiryTimestamp),
    modified_at: nullableString(group.modifyTimestamp),
    gid_number:
      typeof group.gidNumber === "number" ? group.gidNumber : null,
    service_entitlements: entitlements(group.umichServiceEntitlement),
    group_url: new URL(`/group/${encodeURIComponent(name)}`, baseUrl).href,
  };
}

export function normalizeMCommunityGroups(payload, baseUrl) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw extractionError(
      "INVALID_UPSTREAM_RESPONSE",
      "MCommunity returned an invalid group list",
    );
  }

  const groups = new Map();
  for (const [bucket, flag] of [
    ["owner", "isOwner"],
    ["member", "isMember"],
  ]) {
    for (const raw of Array.isArray(payload[bucket]) ? payload[bucket] : []) {
      const item = summary(raw, baseUrl, { [flag]: true });
      if (!item) continue;
      const existing = groups.get(item.key);
      if (existing) {
        existing.is_owner ||= item.is_owner;
        existing.is_member ||= item.is_member;
      } else {
        groups.set(item.key, item);
      }
    }
  }

  return {
    groups: [...groups.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
}

export function normalizeMCommunityGroup(payload, listItem) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw extractionError(
      "INVALID_UPSTREAM_RESPONSE",
      "MCommunity returned an invalid group record",
    );
  }
  const base = summary(payload, listItem.group_url, {
    isOwner: listItem.is_owner,
    isMember: listItem.is_member,
  });
  if (!base) {
    throw extractionError(
      "INVALID_UPSTREAM_RESPONSE",
      "MCommunity group detail did not include a name",
    );
  }
  return {
    ...base,
    joinable: Boolean(payload.joinable),
    members_only: Boolean(payload.Membersonly),
    private: Boolean(payload.umichPrivate),
    suppress_no_email_error: Boolean(payload.suppressNoEmailError),
    owners: (Array.isArray(payload.owner) ? payload.owner : []).map(principal),
    members: (Array.isArray(payload.member) ? payload.member : []).map(principal),
  };
}

export class BrowserJsonExtractor {
  constructor({ capture } = {}) {
    if (typeof capture !== "function") {
      throw new TypeError("BrowserJsonExtractor requires a capture function");
    }
    this.capture = capture;
  }

  async extract({ definition, input = {} }) {
    const extraction = definition.extraction;
    const raw = await this.capture({
      pageUrl: definition.url,
      responseUrl: extraction.responseUrl,
      method: extraction.responseMethod,
      authenticationExpected: Boolean(definition.authentication),
    });
    const projected = resolveJsonPointer(raw, extraction.pointer);

    if (!extraction.transform) return projected;
    const groups = normalizeMCommunityGroups(projected, definition.url);
    if (extraction.transform === "mcommunity_groups") return groups;

    const requested = input.group;
    const allowed = groups.groups.find((group) => group.key === requested);
    if (!allowed) {
      throw extractionError(
        "RESOURCE_NOT_AVAILABLE",
        "The requested group is not in the authenticated operator's active groups",
      );
    }

    const detailResponseUrl = new URL(
      `/api/groups/${encodeURIComponent(allowed.name)}/`,
      definition.url,
    ).href;
    const detail = await this.capture({
      pageUrl: allowed.group_url,
      responseUrl: detailResponseUrl,
      method: "GET",
      authenticationExpected: true,
    });
    return normalizeMCommunityGroup(detail, allowed);
  }
}
