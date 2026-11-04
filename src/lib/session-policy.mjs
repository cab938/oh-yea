import fs from "node:fs/promises";

export const EPHEMERAL_AUTH_PARTITION = "agent-broker-auth";
export const PERSISTENT_AUTH_PARTITION =
  "persist:agent-broker-auth";

export function authenticationSessionPolicy(env = process.env) {
  const developmentPersistence =
    env.AGENT_BROKER_DEV_PERSIST_AUTH === "1";
  return {
    developmentPersistence,
    partition: developmentPersistence
      ? PERSISTENT_AUTH_PARTITION
      : EPHEMERAL_AUTH_PARTITION,
  };
}

export async function clearLegacyAuthenticationState(
  persistentSession,
  developmentCookiesPath,
) {
  await persistentSession.clearStorageData();
  await persistentSession.clearCache();
  await persistentSession.clearAuthCache?.();
  await fs.rm(developmentCookiesPath, { force: true });
}
