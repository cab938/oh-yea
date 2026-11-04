function defaultTimeFormatter(value) {
  return value.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function describeSignInGroup(
  group,
  { formatTime = defaultTimeFormatter } = {},
) {
  const statuses = group.profiles.map(({ status }) => status);
  const displayName = group.displayName;

  if (statuses.some((status) => status.state === "checking")) {
    return {
      state: "checking",
      label: `${displayName} · Checking`,
      title: `Checking application sessions that use ${displayName}`,
    };
  }

  const unauthenticated = statuses.filter(
    (status) => status.state === "unauthenticated",
  );
  if (unauthenticated.length > 0) {
    return {
      state: "unauthenticated",
      label: `${displayName} · Setup needed`,
      title: `${unauthenticated.length} application session${unauthenticated.length === 1 ? "" : "s"} using ${displayName} still ${unauthenticated.length === 1 ? "needs" : "need"} setup`,
      signInAuthentication: unauthenticated[0].authentication,
    };
  }

  if (
    statuses.length > 0 &&
    statuses.every((status) => status.state === "authenticated")
  ) {
    const expiryValues = statuses
      .map((status) => Date.parse(status.expectedExpiresAt))
      .filter(Number.isFinite);
    const expiry =
      expiryValues.length > 0 ? new Date(Math.min(...expiryValues)) : null;
    return {
      state: "authenticated",
      label: `${displayName} · Ready`,
      title: expiry
        ? `All application sessions using ${displayName} are ready. Earliest estimated revalidation is around ${formatTime(expiry)}.`
        : `All application sessions using ${displayName} are ready.`,
    };
  }

  return {
    state: "unknown",
    label: `${displayName} · Unknown`,
    title: `At least one application session using ${displayName} could not be determined`,
  };
}

export function listSignInGroups(
  authentications,
  capabilityFiles,
  statuses,
) {
  const statusByName = new Map(
    statuses.map((status) => [status.authentication, status]),
  );
  const referenced = new Set(
    capabilityFiles
      .filter((file) => file.valid && file.enabled && file.authentication)
      .map((file) => file.authentication),
  );
  const groups = new Map();
  for (const [name, profile] of Object.entries(authentications ?? {})) {
    if (!referenced.has(name)) continue;
    const groupName =
      profile.signInGroup ?? profile.sign_in_group ?? profile.displayName ?? name;
    if (!groups.has(groupName)) {
      groups.set(groupName, {
        name: groupName,
        displayName: groupName,
        profiles: [],
      });
    }
    groups.get(groupName).profiles.push({
      name,
      displayName: profile.displayName ?? profile.display_name ?? name,
      status: statusByName.get(name) ?? {
        authentication: name,
        displayName: profile.displayName ?? profile.display_name ?? name,
        state: "unknown",
      },
    });
  }
  return [...groups.values()];
}
