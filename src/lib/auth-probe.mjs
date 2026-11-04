const MAX_REDIRECTS = 8;

function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The probe deliberately ignores response bodies.
  }
}

export async function probeSessionAuthentication(authSession, targetUrl) {
  const target = new URL(targetUrl);
  let current = new URL(target);
  const hops = [];

  for (let index = 0; index <= MAX_REDIRECTS; index += 1) {
    let response;
    try {
      response = await authSession.fetch(current.href, {
        method: "GET",
        credentials: "include",
        redirect: "manual",
        cache: "no-store",
      });
    } catch (error) {
      return {
        authenticated: null,
        reason: "probe-failed",
        target: safeUrl(target.href),
        error: error.message,
        hops,
      };
    }

    const status = response.status;
    const location = response.headers.get("location");
    const hop = {
      url: safeUrl(current.href),
      status,
    };

    if (status >= 300 && status < 400 && location) {
      const next = new URL(location, current);
      hop.redirectTo = safeUrl(next.href);
      hops.push(hop);
      await discardBody(response);

      if (next.origin !== target.origin) {
        return {
          authenticated: false,
          reason: "external-authentication-redirect",
          target: safeUrl(target.href),
          status,
          redirectTo: safeUrl(next.href),
          hops,
        };
      }
      current = next;
      continue;
    }

    hops.push(hop);
    await discardBody(response);

    if (status === 401 || status === 403) {
      return {
        authenticated: false,
        reason: "protected-response",
        target: safeUrl(target.href),
        status,
        hops,
      };
    }

    return {
      authenticated: true,
      reason: "target-origin-response",
      target: safeUrl(target.href),
      status,
      targetReachable: status >= 200 && status < 300,
      hops,
    };
  }

  return {
    authenticated: null,
    reason: "too-many-same-origin-redirects",
    target: safeUrl(target.href),
    hops,
  };
}
