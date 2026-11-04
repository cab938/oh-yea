import fs from "node:fs/promises";

const SNAPSHOT_VERSION = 1;

function cookieUrl(cookie) {
  const scheme = cookie.secure ? "https" : "http";
  const host = cookie.domain.replace(/^\./u, "");
  return `${scheme}://${host}${cookie.path || "/"}`;
}

function restorableCookie(cookie) {
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.expirationDate
      ? { expirationDate: cookie.expirationDate }
      : {}),
  };
}

export async function restoreDevelopmentCookies(authSession, snapshotPath) {
  let snapshot;
  try {
    snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  if (
    snapshot?.version !== SNAPSHOT_VERSION ||
    !Array.isArray(snapshot.cookies)
  ) {
    throw new Error("Development cookie snapshot has an unsupported format");
  }

  let restored = 0;
  const now = Date.now() / 1_000;
  for (const cookie of snapshot.cookies) {
    if (cookie.expirationDate && cookie.expirationDate <= now) continue;
    try {
      await authSession.cookies.set(cookie);
      restored += 1;
    } catch {
      // Ignore stale or provider-specific cookies that Electron rejects.
    }
  }
  return restored;
}

export async function persistDevelopmentCookies(authSession, snapshotPath) {
  const cookies = await authSession.cookies.get({});
  const snapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    cookies: cookies.map(restorableCookie),
  };
  await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(snapshotPath, 0o600);
  return cookies.length;
}

export function watchDevelopmentCookies(
  authSession,
  snapshotPath,
  { debounceMs = 250, onError } = {},
) {
  let timer = null;
  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return persistDevelopmentCookies(authSession, snapshotPath);
  };
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush().catch(onError);
    }, debounceMs);
  };
  authSession.cookies.on("changed", changed);
  return {
    flush,
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      authSession.cookies.off("changed", changed);
    },
  };
}
