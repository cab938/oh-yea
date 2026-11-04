import path from "node:path";
import { extractAuthenticatedJson } from "./authenticated-json.mjs";
import { executeTeamDynamixExpenseReport } from "./teamdynamix-expense-action.mjs";
import { readUmGpt, sendUmGpt, setUmGptConnectorActive } from "./umgpt-conversation.mjs";

// The desktop host supplies current configuration and its session-bound surfaces.
export async function executeCapability(job, {
  configuredAuthentication, authenticationManager, authSession,
  browserJsonWorker, rendererExecutor, extractBrowserJson, paths, logs, timeoutMs,
}) {
  const eventContext = { requestId: job.id, capability: job.capability };
  const ensureAuthentication = (requestHeaders) => authenticationManager.ensure(
    configuredAuthentication,
    { ...eventContext, timeoutMs, ...(requestHeaders === undefined ? {} : { requestHeaders }) },
  );
  const requireWorker = () => {
    if (!browserJsonWorker) {
      throw Object.assign(new Error("The hidden browser worker is unavailable"), {
        code: "CONTROL_PLANE_UNAVAILABLE",
      });
    }
  };
  let data;
  if (job.definition.extraction?.type === "umgpt_conversation" ||
      ["umgpt_conversation", "umgpt_connector_state"].includes(job.definition.action?.type)) {
    await ensureAuthentication();
    const request = {
      fetch: (url, options) => authSession.fetch(url, options),
      definition: job.definition, input: job.input,
    };
    if (job.definition.action?.type === "umgpt_connector_state") {
      data = await setUmGptConnectorActive({
        ...request,
        getCsrfToken: async (pageUrl) => {
          const cookies = await authSession.cookies.get({ url: pageUrl, name: "csrftoken" });
          return cookies[0]?.value;
        },
      });
    } else if (job.definition.action) {
      requireWorker();
      data = await sendUmGpt({
        ...request,
        send: (message) => browserJsonWorker.umgptConversation(message),
        journalDirectory: path.join(paths.submissions, "umgpt"),
      });
    } else {
      data = await readUmGpt(request);
    }
  } else if (
    [
      "teamdynamix_expense_report",
      "teamdynamix_expense_report_capture",
    ].includes(job.definition.action?.type)
  ) {
    requireWorker();
    await ensureAuthentication();
    logs.add(
      "info",
      "action.dispatched",
      job.definition.action.type === "teamdynamix_expense_report_capture"
        ? "Preparing configured TeamDynamix expense rehearsal"
        : "Submitting configured TeamDynamix expense report",
      eventContext,
    );
    data = await executeTeamDynamixExpenseReport({
      fetch: (url, options) => authSession.fetch(url, options),
      formSnapshot: (request) => browserJsonWorker.formSnapshot(request),
      definition: job.definition,
      input: job.input,
      journalDirectory: path.join(paths.submissions, "teamdynamix-expense"),
      captureDirectory: path.join(paths.logs, "expense-captures"),
      onEvent: (phase, context) =>
        logs.add(
          "info",
          `expense-report.${phase.replaceAll("_", ".")}`,
          phase === "captured"
            ? "TeamDynamix expense rehearsal captured for inspection"
            : phase === "completed"
              ? "TeamDynamix expense submission recorded"
              : "TeamDynamix expense submission started",
          {
            ...eventContext,
            ...context,
          },
        ),
    });
  } else if (job.definition.extraction.type === "authenticated_json") {
    const authentication = await ensureAuthentication(job.definition.extraction.requestHeaders);
    logs.add(
      "info",
      "extraction.dispatched",
      "Calling authenticated JSON endpoint",
      eventContext,
    );
    data = await extractAuthenticatedJson({
      authSession,
      definition: job.definition,
      requestHeaders: authentication.requestHeaders,
    });
  } else if (job.definition.extraction.type === "browser_json") {
    logs.add(
      "info",
      "extraction.dispatched",
      "Calling structured JSON through the hidden browser worker",
      eventContext,
    );
    data = await extractBrowserJson(job, configuredAuthentication);
  } else {
    if (configuredAuthentication) {
      await authenticationManager.check(configuredAuthentication, {
        reason: "request",
      });
    }
    data = await rendererExecutor.execute(job);
  }

  return data;
}
