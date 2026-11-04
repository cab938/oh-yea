export const AUTH_RETRY_LIMIT = 2;
export const AUTH_SETTLE_DELAY_MS = 1_250;

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function matchesConfiguredTarget(currentUrl, targetUrl) {
  const current = parseUrl(currentUrl);
  const target = parseUrl(targetUrl);
  if (!current || !target) return false;
  current.hash = "";
  target.hash = "";
  return current.href === target.href;
}

export function isTargetOrigin(currentUrl, targetUrl) {
  const current = parseUrl(currentUrl);
  const target = parseUrl(targetUrl);
  return Boolean(current && target && current.origin === target.origin);
}

export function canRetrySettledAuthReturn(
  job,
  currentUrl,
  retryLimit = AUTH_RETRY_LIMIT,
) {
  return Boolean(
    job?.phase === "auth-returned" &&
      isTargetOrigin(currentUrl, job.definition?.url) &&
      (job.authRetryCount ?? 0) < retryLimit,
  );
}

export function transitionForNavigation(
  job,
  currentUrl,
  retryLimit = AUTH_RETRY_LIMIT,
) {
  if (!job) return { action: "ignore", patch: {} };

  const current = parseUrl(currentUrl);
  const target = parseUrl(job.definition?.url);
  if (
    !current ||
    !target ||
    !["http:", "https:"].includes(current.protocol)
  ) {
    return { action: "ignore", patch: {} };
  }

  if (matchesConfiguredTarget(current.href, target.href)) {
    const isPostAuthTarget =
      Boolean(job.sawForeignOrigin) ||
      ["auth-returned", "post-auth-retry", "target-after-auth"].includes(
        job.phase,
      );
    return {
      action: "target",
      patch: {
        phase: isPostAuthTarget ? "target-after-auth" : "target",
        sawForeignOrigin: isPostAuthTarget,
        authNotified: false,
      },
    };
  }

  const returnedToTargetOrigin = current.origin === target.origin;
  const retryCount = job.authRetryCount ?? 0;
  const targetBouncedBeforeContent =
    returnedToTargetOrigin &&
    ((["target", "target-after-auth"].includes(job.phase) &&
      job.waitLogged) ||
      (job.phase === "post-auth-retry" &&
        (job.retryStrategy ?? "reload") === "reload"));

  if (targetBouncedBeforeContent) {
    if (retryCount >= retryLimit) {
      return {
        action: "retry-exhausted",
        patch: {
          phase: "awaiting-auth",
        },
      };
    }
    return {
      action: "target-bounced",
      patch: {
        phase: "auth-returned",
        retryStrategy: "in-page",
      },
    };
  }

  if (
    ["awaiting-auth", "post-auth-retry", "target-after-auth"].includes(
      job.phase,
    ) &&
    job.sawForeignOrigin &&
    returnedToTargetOrigin
  ) {
    if (retryCount >= retryLimit) {
      return {
        action: "retry-exhausted",
        patch: {
          phase: "awaiting-auth",
        },
      };
    }
    return {
      action: "auth-returned",
      patch: {
        phase: "auth-returned",
        retryStrategy: job.retryStrategy ?? "reload",
      },
    };
  }

  if (job.phase === "auth-returned" && returnedToTargetOrigin) {
    return {
      action: "auth-returned",
      patch: {},
    };
  }

  return {
    action: "await-auth",
    patch: {
      phase: "awaiting-auth",
      sawForeignOrigin:
        Boolean(job.sawForeignOrigin) || !returnedToTargetOrigin,
    },
  };
}
