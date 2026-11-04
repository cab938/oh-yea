import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requestOnce } from "../src/lib/broker-client.mjs";
import { stringify } from "yaml";
import { readTemplates } from "../test-support/templates.mjs";

if (process.env.AGENT_BROKER_SMOKE_HEADFUL === "1" &&
    (!/^:(?:9\d|10\d|11\d)$/.test(process.env.DISPLAY ?? "") ||
     !path.basename(path.dirname(process.env.XAUTHORITY ?? "")).startsWith("native-x11-headless-session."))) {
  throw new Error("Visible startup checks require the private Xvfb harness");
}

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshot =
  process.env.AGENT_BROKER_SMOKE_SCREENSHOT ??
  path.join(os.tmpdir(), "agent-broker-smoke.png");

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.stat(file);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await wait(100);
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

let authAddress;
let address;
const browserFixtureRequests = { page: 0, groups: 0 };
const expenseFixtureRequests = { form: 0, submit: 0 };
const authenticationFixtureRequests = [];
let umgptSendCount = 0;
let umgptConnectorActive = true;
let umgptConnectorPatchCount = 0;
const umgptMessage = { id: 22, conversation_id: 20, message_type: "ai", content: "UMGPT_SMOKE_OK", created_at: "2026-10-21T12:00:01Z", attachments: [] };

const fixture = http.createServer(async (request, response) => {
  if (request.url.startsWith("/umgpt/api/")) {
    if (!request.headers.cookie?.includes("auth=1")) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end('{}');
      return;
    }
    if (request.url === "/umgpt/api/users/7/connectors/11/" && request.method === "PATCH") {
      const expectedOrigin = `http://127.0.0.1:${address.port}`;
      if (!request.headers.cookie.includes("csrftoken=SmokeCsrfToken") ||
          request.headers["x-csrftoken"] !== "SmokeCsrfToken" ||
          request.headers.origin !== expectedOrigin || request.headers.referer !== `${expectedOrigin}/`) {
        response.writeHead(403, { "Content-Type": "application/json" });
        response.end('{}');
        return;
      }
      const input = JSON.parse((await requestBody(request)).toString());
      if (Object.keys(input).length !== 1 || typeof input.is_active !== "boolean") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end('{}');
        return;
      }
      umgptConnectorActive = input.is_active;
      umgptConnectorPatchCount++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ is_active: input.is_active, credentials: "umgpt-private-identity" }));
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end();
      return;
    }
    const data = {
      "/umgpt/api/me": { id: 7, private_identity: "umgpt-private-identity" },
      "/umgpt/api/services": [{ id: 4, title: "Fixture agent", is_agentic: true, backend_type: "text" }],
      "/umgpt/api/users/7/connectors/": [
        { id: 11, display_name: "Fixture search", is_active: umgptConnectorActive, tool_count: 5, credentials: "umgpt-private-identity" },
        { id: 12, display_name: "Fixture documents", is_active: false, tool_count: null },
      ],
      "/umgpt/api/users/7/conversations/": [{id:20,title:"Fixture conversation",extras:{service:4,is_agentic:true}}],
      "/umgpt/api/users/7/conversations/20/messages/": [umgptMessage],
    }[request.url];
    response.writeHead(data === undefined ? 404 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(data ?? {}));
    return;
  }
  if (request.url === "/expense" && request.method === "GET") {
    expenseFixtureRequests.form += 1;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(`<!doctype html>
<html>
  <body>
    <form class="js-entry-form" action="/expense-submit" method="post" enctype="multipart/form-data">
      <input name="__RequestVerificationToken" type="hidden" value="private-smoke-token">
      <input name="__RequestVerificationTokenPair" type="hidden" value="private-smoke-token-pair">
      <input name="FormID" type="hidden" value="3196">
      <select name="attribute15885">
        <option value=""></option>
        <option value="59724">An expense for an employee</option>
      </select>
      <input name="files" type="file" multiple>
      <input type="submit" value="Submit">
    </form>
  </body>
</html>`);
    return;
  }

  if (request.url === "/expense-submit" && request.method === "POST") {
    expenseFixtureRequests.submit += 1;
    const body = await requestBody(request);
    if (
      !request.headers["content-type"]?.startsWith("multipart/form-data;") ||
      !body.includes(Buffer.from("private-smoke-token")) ||
      !body.includes(Buffer.from("3196")) ||
      !body.includes(Buffer.from("59724")) ||
      !body.includes(Buffer.from("smoke receipt bytes"))
    ) {
      response.writeHead(400, { "Content-Type": "text/html" });
      response.end("<p>invalid expense form</p>");
      return;
    }
    response.writeHead(302, {
      Location: "/requests/details?TicketID=4242",
    });
    response.end();
    return;
  }

  if (
    request.url === "/requests/details?TicketID=4242" &&
    request.method === "GET"
  ) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end("<p>Request ID 4242 was created.</p>");
    return;
  }

  if (request.url === "/identity") {
    const authenticated = request.headers.cookie?.includes("auth=1") ?? false;
    authenticationFixtureRequests.push({
      authenticated,
      timestamp: Date.now(),
    });
    if (!authenticated) {
      response.writeHead(401, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end('{"message":"Missing identity"}');
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-test-identity": "smoke-identity-value",
    });
    response.end('{"authenticated":true}');
    return;
  }

  if (request.url === "/api/remaining-hours") {
    if (request.headers["x-test-identity"] !== "smoke-identity-value") {
      response.writeHead(401, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end('{"message":"Missing identity"}');
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(
      JSON.stringify({
        accounts: [
          {
            name: "example0",
            remaining: { GPU: 7.5, Standard: 42.5 },
          },
        ],
      }),
    );
    return;
  }

  if (request.url === "/my-groups") {
    browserFixtureRequests.page += 1;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(`<!doctype html>
<html>
  <body>
    <h1>Hidden structured response fixture</h1>
    <script>
      fetch("/api/groups/", { headers: { Accept: "application/json" } })
        .then(response => response.json())
        .then(groups => { window.fixtureGroups = groups; });
    </script>
  </body>
</html>`);
    return;
  }

  if (request.url === "/api/groups/") {
    browserFixtureRequests.groups += 1;
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({
      owner: [{
        cn: ["Smoke Owned Group"],
        umichGroupEmail: "smoke-owned@example.test",
        umichServiceEntitlement: [],
      }],
      member: [{
        cn: ["Smoke Member Group"],
        umichGroupEmail: "smoke-member@example.test",
        umichServiceEntitlement: [],
      }],
    }));
    return;
  }

  if (request.url === "/account" && !request.headers.cookie?.includes("auth=1")) {
    response.writeHead(302, {
      Location: `http://127.0.0.1:${authAddress.port}/login`,
    });
    response.end();
    return;
  }

  if (request.url === "/authenticated") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(`<!doctype html>
<html>
  <body>
    <h1>Finishing authenticated portal initialization</h1>
    <script>
      let navigationStep = 0;
      setInterval(() => {
        navigationStep += 1;
        history.replaceState({}, "", "/authenticated?step=" + navigationStep);
      }, 100);
      setTimeout(() => fetch("/establish-session"), 350);
    </script>
  </body>
</html>`);
    return;
  }

  if (request.url === "/establish-session") {
    response.writeHead(204, {
      "Set-Cookie": ["auth=1; HttpOnly; SameSite=Lax", "csrftoken=SmokeCsrfToken; SameSite=Lax; Path=/"],
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }

  if (request.url === "/account") {
    if (!request.headers.cookie?.includes("portal-ready=1")) {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(`<!doctype html>
<html>
  <body>
    <h1>Target route initializing portal state</h1>
    <script>
      setTimeout(async () => {
        await fetch("/establish-portal");
        window.location.replace("/");
      }, 100);
    </script>
  </body>
</html>`);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(`<!doctype html>
<html>
  <body>
    <h1>ARC fixture</h1>
    <app-remaining-hours data-account="example0">
      <strong>42.5 hours</strong>
    </app-remaining-hours>
  </body>
</html>`);
    return;
  }

  if (request.url === "/establish-portal") {
    response.writeHead(204, {
      "Set-Cookie": "portal-ready=1; HttpOnly; SameSite=Lax",
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html>
  <body>
    <h1>Authenticated portal landing page</h1>
    <script>
      window.addEventListener("popstate", () => {
        if (window.location.pathname !== "/account") return;
        document.body.innerHTML = \`
          <h1>ARC fixture</h1>
          <app-remaining-hours data-account="example0">
            <strong>42.5 hours</strong>
          </app-remaining-hours>
        \`;
      });
    </script>
  </body>
</html>`);
});

fixture.on("upgrade", (request, socket) => {
  if (request.url !== "/ws/umgpt/conversations/messages/" || !request.headers.cookie?.includes("auth=1")) {
    socket.destroy(); return;
  }
  const accept = crypto.createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let pending = Buffer.alloc(0);
  let received = false;
  const frame = (value) => {
    const body = Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(body.length < 126 ? 2 : 4);
    header[0] = 0x81;
    header[1] = body.length < 126 ? body.length : 126;
    if (body.length >= 126) header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  };
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    if (received) { socket.end(); return; }
    pending = Buffer.concat([pending, chunk]);
    if (pending.length < 2) return;
    let length = pending[1] & 127;
    let offset = 2;
    if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
    if (length === 127 || !(pending[1] & 128)) { socket.destroy(); return; }
    if (pending.length < offset + 4 + length) return;
    const mask = pending.subarray(offset, offset + 4);
    const body = pending.subarray(offset + 4, offset + 4 + length);
    const decoded = Buffer.from(body.map((byte, index) => byte ^ mask[index % 4]));
    received = true;
    const message = JSON.parse(decoded.toString("utf8"));
    if (message.question !== "UMGPT_SMOKE_PROMPT" || message.service !== 4 || message.conversation_id !== -1 || "decision" in message) {
      socket.destroy(); return;
    }
    umgptSendCount++;
    socket.write(frame({type:"conversation.created",conversation_id:20,temp_conversation_id:-1}));
    socket.write(frame({type:"conversation.message",message:umgptMessage}));
  });
});

const authFixture = http.createServer((_request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`<!doctype html>
<html>
  <body>
    <h1>Authentication fixture</h1>
    <script>
      window.location.replace("http://127.0.0.1:${address.port}/authenticated");
    </script>
  </body>
</html>`);
});

address = await listen(fixture);
authAddress = await listen(authFixture);
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "agent-broker-electron-"),
);
const socket = path.join(directory, "broker.sock");
const config = `version: 1
authentications:
  test_sso:
    url: http://127.0.0.1:${address.port}/identity
    login_url: http://127.0.0.1:${address.port}/account
  browser_sso:
    url: http://127.0.0.1:${address.port}/my-groups
    login_url: http://127.0.0.1:${address.port}/my-groups
  teamdynamix_sso:
    url: http://127.0.0.1:${address.port}/expense
    login_url: http://127.0.0.1:${address.port}/expense
  umgpt_session:
    url: http://127.0.0.1:${address.port}/umgpt/api/me
    login_url: http://127.0.0.1:${address.port}/
`;
await fs.writeFile(path.join(directory, "config.yaml"), config, {
  mode: 0o600,
});
await fs.writeFile(path.join(directory, ".env"), `AGENT_BROKER_TOKEN_ARC=smoke-test-token-value
AGENT_BROKER_TOKEN_MCOMMUNITY=browser-smoke-test-token
AGENT_BROKER_TOKEN_EXPENSE_REPORTS=expense-smoke-test-token
AGENT_BROKER_TOKEN_UMGPT=umgpt-smoke-test-token
`, {mode: 0o600});
const legacyCookieSnapshot = path.join(
  directory,
  "development-cookies.json",
);
await fs.writeFile(
  legacyCookieSnapshot,
  "legacy authentication state must not be restored",
  { mode: 0o600 },
);
const capabilitiesDirectory = path.join(directory, "capabilities");
await fs.mkdir(capabilitiesDirectory, { mode: 0o700 });
const fixtureOrigin = `http://127.0.0.1:${address.port}`;
const templates = {};
for (const service of ["arc", "mcommunity", "expense-reports", "umgpt"]) {
  for (const { definition } of await readTemplates(service)) templates[definition.name] = definition;
}
async function writeCapability(definition) {
  await fs.writeFile(path.join(capabilitiesDirectory, `${definition.name}.yaml`), stringify(definition), { mode: 0o600 });
}
for (const definition of Object.values(templates).filter(({ service }) => service === "umgpt")) {
  definition.enabled = true;
  if (definition.action) definition.action.page_url = `${fixtureOrigin}/`;
  else definition.url = `${fixtureOrigin}/`;
  await writeCapability(definition);
}
const capabilityPath = path.join(capabilitiesDirectory, "arc.remaining_hours.read.yaml");
const arcCapability = templates["arc.remaining_hours.read"];
Object.assign(arcCapability, {
  enabled: true, url: `${fixtureOrigin}/api/remaining-hours`, authentication: "test_sso",
  extraction: {
    type: "authenticated_json", request_headers: { "x-test-identity": { response_header: "x-test-identity" } },
    pointer: "/accounts/0/remaining",
  },
});
await writeCapability(arcCapability);
const browserCapability = templates["mcommunity.groups.list"];
Object.assign(browserCapability, { enabled: true, url: `${fixtureOrigin}/my-groups`, authentication: "browser_sso" });
browserCapability.extraction.response_url = `${fixtureOrigin}/api/groups/`;
await writeCapability(browserCapability);
const receiptPath = path.join(directory, "smoke-receipt.pdf");
await fs.writeFile(receiptPath, "smoke receipt bytes", { mode: 0o600 });
for (const operation of ["submit", "capture"]) {
  const definition = templates[`umich.teamdynamix.expense_report.${operation}`];
  definition.enabled = true;
  Object.assign(definition.action, {
    form_url: `${fixtureOrigin}/expense`, submit_url: `${fixtureOrigin}/expense-submit`,
    confirmation_url_prefix: `${fixtureOrigin}/requests/`, form_id: 3196,
    field_mappings: { reimbursement_for: { name: "attribute15885", kind: "select", choices: { employee: 59724 } } },
    attachments: { field_name: "files", allowed_extensions: [".pdf"], max_files: 2, max_file_bytes: 1048576, max_total_bytes: 1048576 },
  });
  // The local form has one semantic field. Keep the shipped attachment and result contracts.
  const fields = definition.contract.input_schema.properties.fields;
  fields.required = ["reimbursement_for"];
  fields.properties = { reimbursement_for: fields.properties.reimbursement_for };
  await writeCapability(definition);
}
await fs.rm(screenshot, { force: true });

const binDirectory = path.join(directory, "bin");
await fs.mkdir(binDirectory);
await fs.symlink(path.join(root, "bin/agent-broker.mjs"), path.join(binDirectory, "agent-broker"));
const brokerEnv = {
  ...process.env, PATH: `${binDirectory}:${process.env.PATH}`,
  AGENT_BROKER_HOME: directory, AGENT_BROKER_DEV_PERSIST_AUTH: "0",
  AGENT_BROKER_SMOKE_SCREENSHOT: screenshot,
};
delete brokerEnv.AGENT_BROKER_CONFIG;
delete brokerEnv.AGENT_BROKER_TOKEN;
const launchArgs = [
  ...(process.env.AGENT_BROKER_SMOKE_HEADFUL === "1" ? [] : ["--headless"]),
  "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
];
const pidFile = path.join(directory, "launch.pid");
const stderrFile = path.join(directory, "electron.stderr");
let processGroup;
let smokeStage = "closed discovery";
async function runCli(args) {
  try {
    const result = await execFileAsync("agent-broker", args, { cwd: root, env: brokerEnv, timeout: 30_000 });
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return error;
  }
}
function signalBroker(signal) {
  if (!processGroup) return;
  try { process.kill(-processGroup, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
async function brokerProcessesRemain() {
  const { stdout } = await execFileAsync("ps", ["-eo", "pgid=,stat="]);
  return stdout.trim().split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === processGroup && !state.startsWith("Z");
  });
}
process.once("exit", () => signalBroker("SIGTERM"));

try {
  const closed = await runCli(["services"]);
  if (closed.code !== 1 || JSON.parse(closed.stdout).error?.code !== "BROKER_UNAVAILABLE") {
    throw new Error("Closed discovery did not return JSON BROKER_UNAVAILABLE");
  }
  smokeStage = "detached visual startup";
  // Record the owned process group before exec solely for deterministic test teardown.
  // The command after this bookkeeping is the installed CLI under setsid --fork.
  const output = await fs.open(stderrFile, "w", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const launcher = spawn("setsid", ["--fork", "sh", "-c",
        'echo $$ > "$1"; shift; exec "$@"', "broker-smoke", pidFile,
        "agent-broker", ...launchArgs,
      ], { cwd: root, env: brokerEnv, timeout: 5_000, stdio: ["ignore", output.fd, output.fd] });
      launcher.once("error", reject);
      launcher.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Detached launcher exited ${code}`)));
    });
  } finally { await output.close(); }
  await waitForFile(pidFile);
  processGroup = Number((await fs.readFile(pidFile, "utf8")).trim());
  if (!Number.isSafeInteger(processGroup) || processGroup <= 1) throw new Error("Invalid detached test process group");
  const deadline = Date.now() + 30_000;
  let ready = false;
  do {
    const discovery = await runCli(["services"]);
    const result = JSON.parse(discovery.stdout);
    if (discovery.code === 0 && result.ok) { ready = true; break; }
    if (result.error?.code !== "BROKER_UNAVAILABLE") throw new Error(`Startup discovery failed: ${discovery.stdout}`);
    await wait(200);
  } while (Date.now() < deadline);
  if (!ready) throw new Error("Detached broker was not ready within 30 seconds");
  smokeStage = "waiting for control-plane screenshot";
  await waitForFile(screenshot);
  smokeStage = "requesting capability catalog";
  const catalog = await requestOnce(
    socket,
    { id: "electron-smoke-catalog", operation: "capabilities" },
    20_000,
  );
  if (
    !catalog.ok ||
    catalog.data?.[0]?.name !== "arc.remaining_hours.read" ||
    "url" in catalog.data[0]
  ) {
    throw new Error(`Unexpected capability catalog: ${JSON.stringify(catalog)}`);
  }
  smokeStage = "discovering service workflows and contracts";
  const services = await requestOnce(socket, { operation: "services" }, 20_000);
  if (!services.ok || services.data.length !== 4) throw new Error("Service discovery failed");
  for (const service of services.data) {
    await fs.access(service.workflow_file);
    const text = await fs.readFile(service.capabilities_file, "utf8");
    const contracts = JSON.parse(text);
    if (contracts.some((capability) => capability.service !== service.id) ||
        text.includes("smoke-test-token") || text.includes("requestHeaders") || text.includes("127.0.0.1")) {
      throw new Error("Service discovery exposed private configuration");
    }
  }
  const wrongService = await requestOnce(socket, {
    capability: "arc.remaining_hours.read", token: "umgpt-smoke-test-token", input: {},
  });
  if (wrongService.ok || wrongService.error?.code !== "UNAUTHORIZED") throw new Error("Cross-service token was accepted");
  const expenseTemplate = catalog.data.find(
    ({ name }) =>
      name === "umich.teamdynamix.expense_report.submit",
  );
  const expenseCaptureTemplate = catalog.data.find(
    ({ name }) =>
      name === "umich.teamdynamix.expense_report.capture",
  );
  if (
    expenseTemplate?.input_schema?.properties?.fields?.properties
      ?.reimbursement_for?.enum?.[0] !== "employee" ||
    expenseCaptureTemplate?.input_schema?.properties?.fields?.properties
      ?.reimbursement_for?.enum?.[0] !== "employee" ||
    JSON.stringify(expenseTemplate).includes("15885") ||
    JSON.stringify(expenseTemplate).includes("expense-submit") ||
    JSON.stringify(expenseCaptureTemplate).includes("15885") ||
    JSON.stringify(expenseCaptureTemplate).includes("expense-submit")
  ) {
    throw new Error(
      `Expense templates were not safely discoverable: ${JSON.stringify({
        expenseTemplate,
        expenseCaptureTemplate,
      })}`,
    );
  }
  smokeStage = "requesting authenticated JSON capability";
  const response = await requestOnce(
    socket,
    {
      id: "electron-smoke",
      capability: "arc.remaining_hours.read",
      token: "smoke-test-token-value",
      input: {},
    },
    20_000,
  );
  if (!response.ok) {
    throw new Error(`Broker rejected smoke request: ${JSON.stringify(response)}`);
  }
  if (JSON.stringify(response.data) !== '{"GPU":7.5,"Standard":42.5}') {
    throw new Error(`Unexpected extraction: ${JSON.stringify(response.data)}`);
  }
  const firstAuthenticatedIndex = authenticationFixtureRequests.findIndex(
    ({ authenticated }) => authenticated,
  );
  const lastUnauthenticated =
    authenticationFixtureRequests[firstAuthenticatedIndex - 1];
  const firstAuthenticated =
    authenticationFixtureRequests[firstAuthenticatedIndex];
  if (
    firstAuthenticatedIndex < 1 ||
    authenticationFixtureRequests.length > 3 ||
    firstAuthenticated.timestamp - lastUnauthenticated.timestamp < 1_800
  ) {
    throw new Error(
      `Authentication wait did not use bounded backoff: ${JSON.stringify(authenticationFixtureRequests)}`,
    );
  }
  smokeStage = "reusing and focusing the authenticated instance";
  let windowId;
  if (process.env.AGENT_BROKER_SMOKE_HEADFUL === "1") {
    const { stdout } = await execFileAsync("xdotool", ["search", "--onlyvisible", "--name", "^agent-broker$"], { env: brokerEnv });
    const windows = stdout.trim().split("\n");
    if (windows.length !== 1) throw new Error("Expected one visible control plane");
    [windowId] = windows;
    await execFileAsync("xdotool", ["windowminimize", windowId], { env: brokerEnv });
  }
  const probesBeforeRelaunch = authenticationFixtureRequests.length;
  const second = await runCli(launchArgs);
  if (second.code !== 0 || !(await brokerProcessesRemain())) throw new Error("Second launch did not reuse the original instance");
  if (windowId) {
    const { stdout } = await execFileAsync("xdotool", ["getactivewindow"], { env: brokerEnv });
    if (stdout.trim() !== windowId) throw new Error("Second launch did not restore and focus the original window");
  }
  const reused = await runCli(["connect", "--capability", "arc.remaining_hours.read", "--input", "{}"]);
  if (reused.code !== 0 || JSON.stringify(JSON.parse(reused.stdout).data) !== JSON.stringify(response.data) ||
      authenticationFixtureRequests.slice(probesBeforeRelaunch).some(({ authenticated }) => !authenticated)) {
    throw new Error("Second launch lost the authenticated session");
  }
  const startupLog = await fs.readFile(path.join(directory, "logs", "agent-broker.jsonl"), "utf8");
  if (startupLog.split('"event":"session.ephemeral"').length !== 2) throw new Error("Second launch initialized a new session");
  smokeStage = "requesting hidden browser JSON capability";
  const browserResponse = await requestOnce(
    socket,
    {
      id: "electron-smoke-browser-json",
      capability: "mcommunity.groups.list",
      token: "browser-smoke-test-token",
      input: {},
    },
    20_000,
  );
  if (!browserResponse.ok || browserResponse.data?.groups?.length !== 2) {
    throw new Error(
      `Hidden browser JSON extraction failed: ${JSON.stringify(browserResponse)}`,
    );
  }
  if (
    browserResponse.data.groups[0].group_url !==
    `http://127.0.0.1:${address.port}/group/Smoke%20Member%20Group`
  ) {
    throw new Error(
      `Hidden browser deep link was incorrect: ${JSON.stringify(browserResponse.data)}`,
    );
  }
  smokeStage = "capturing TeamDynamix expense rehearsal";
  const visibleBeforeUmGpt = await requestOnce(socket, {operation:"inspect",command:"summary"});
  for (const [capability, input] of [
    ["umich.umgpt.models.list", {}],
    ["umich.umgpt.connectors.list", {}],
    ["umich.umgpt.conversations.list", {}],
    ["umich.umgpt.conversation.read", {conversation_id:20}],
    ["umich.umgpt.conversation.send", {request_id:"umgpt-smoke-1",prompt:"UMGPT_SMOKE_PROMPT",model_id:4}],
  ]) {
    smokeStage = capability;
    const result = await requestOnce(socket, {capability,token:"umgpt-smoke-test-token",input}, 20_000);
    if (!result.ok || JSON.stringify(result).includes("umgpt-private-identity")) {
      throw new Error(`UM GPT fixture failed: ${JSON.stringify(result)}`);
    }
    if (capability === "umich.umgpt.connectors.list" &&
        (result.data.connectors.length !== 2 || result.data.connectors[0].is_active !== true ||
         result.data.connectors[1].is_active !== false || result.data.connectors[1].tool_count !== null)) {
      throw new Error("UM GPT did not preserve the account connector states and unknown tool count");
    }
    if (capability.endsWith(".send") && (result.data.status !== "complete" || result.data.message.content !== "UMGPT_SMOKE_OK")) {
      throw new Error("UM GPT did not return the completed WebSocket reply");
    }
  }
  smokeStage = "setting UM GPT account connector state";
  for (const [is_active, changed] of [[false, true], [true, true], [true, false]]) {
    const result = await requestOnce(socket, {
      capability: "umich.umgpt.connector.set_active", token: "umgpt-smoke-test-token", input: { connector_id: 11, is_active },
    });
    if (!result.ok || result.data.connector.is_active !== is_active || result.data.changed !== changed ||
        JSON.stringify(result).includes("umgpt-private-identity") || JSON.stringify(result).includes("SmokeCsrfToken")) {
      throw new Error("UM GPT account connector state was not safely confirmed");
    }
  }
  if (umgptConnectorPatchCount !== 2) throw new Error("UM GPT repeated an already-satisfied connector update");
  const repeated = await requestOnce(socket, {capability:"umich.umgpt.conversation.send",token:"umgpt-smoke-test-token",input:{request_id:"umgpt-smoke-1",prompt:"UMGPT_SMOKE_PROMPT",model_id:4}});
  if (repeated.ok || repeated.error?.code !== "REQUEST_ALREADY_ATTEMPTED" || umgptSendCount !== 1) throw new Error("UM GPT repeated a prompt");
  const visibleAfterUmGpt = await requestOnce(socket, {operation:"inspect",command:"summary"});
  if (visibleBeforeUmGpt.data.url !== visibleAfterUmGpt.data.url) throw new Error("UM GPT moved the operator browser");
  smokeStage = "capturing TeamDynamix expense rehearsal";
  const expenseCaptureResponse = await requestOnce(
    socket,
    {
      id: "electron-smoke-expense-capture",
      capability: "umich.teamdynamix.expense_report.capture",
      token: "expense-smoke-test-token",
      input: {
        submission_id: "electron-smoke-expense-1",
        fields: { reimbursement_for: "employee" },
        attachments: [{ path: receiptPath, name: "smoke-receipt.pdf" }],
      },
    },
    20_000,
  );
  if (
    !expenseCaptureResponse.ok ||
    expenseCaptureResponse.data?.status !== "captured" ||
    !expenseCaptureResponse.data?.capture_reference?.startsWith("CAPTURE-") ||
    expenseCaptureResponse.data?.attachments?.captured !== 1 ||
    expenseFixtureRequests.submit !== 0
  ) {
    throw new Error(
      `TeamDynamix expense rehearsal was not safely captured: ${JSON.stringify({
        expenseCaptureResponse,
        expenseFixtureRequests,
      })}`,
    );
  }
  const captureDirectory = path.join(
    directory,
    "logs",
    "expense-captures",
  );
  const captureFiles = await fs.readdir(captureDirectory);
  if (captureFiles.length !== 1) {
    throw new Error(
      `Expected one expense capture artifact, found ${captureFiles.length}`,
    );
  }
  const capturePath = path.join(captureDirectory, captureFiles[0]);
  const captureText = await fs.readFile(capturePath, "utf8");
  if (
    !captureText.includes('"value": "[redacted]"') ||
    captureText.includes("private-smoke-token") ||
    captureText.includes("smoke receipt bytes") ||
    captureText.includes(receiptPath) ||
    ((await fs.stat(capturePath)).mode & 0o077) !== 0
  ) {
    throw new Error("Expense capture artifact exposed private request data");
  }

  smokeStage = "submitting TeamDynamix expense action";
  const expenseResponse = await requestOnce(
    socket,
    {
      id: "electron-smoke-expense",
      capability: "umich.teamdynamix.expense_report.submit",
      token: "expense-smoke-test-token",
      input: {
        submission_id: "electron-smoke-expense-1",
        fields: { reimbursement_for: "employee" },
        attachments: [{ path: receiptPath, name: "smoke-receipt.pdf" }],
      },
    },
    20_000,
  );
  if (
    !expenseResponse.ok ||
    expenseResponse.data?.ticket_reference !== "TDX-4242" ||
    expenseResponse.data?.attachments?.uploaded !== 1 ||
    expenseFixtureRequests.submit !== 1 ||
    expenseFixtureRequests.form < 2
  ) {
    throw new Error(
      `TeamDynamix expense action failed: ${JSON.stringify({
        expenseResponse,
        expenseFixtureRequests,
      })}`,
    );
  }
  const brokerLogPath = path.join(directory, "logs", "agent-broker.jsonl");
  const brokerLogText = await fs.readFile(brokerLogPath, "utf8");
  try {
    await fs.stat(legacyCookieSnapshot);
    throw new Error(
      "Ephemeral startup retained the legacy development cookie snapshot",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    !brokerLogText.includes('"event":"expense-report.captured"') ||
    !brokerLogText.includes('"event":"session.ephemeral"') ||
    brokerLogText.includes('"event":"session.development-persistence"') ||
    brokerLogText.includes("expense-smoke-test-token") ||
    brokerLogText.includes("private-smoke-token") ||
    brokerLogText.includes("smoke receipt bytes") ||
    brokerLogText.includes("UMGPT_SMOKE_PROMPT") ||
    brokerLogText.includes("UMGPT_SMOKE_OK") ||
    brokerLogText.includes("umgpt-private-identity") ||
    brokerLogText.includes(receiptPath) ||
    ((await fs.stat(brokerLogPath)).mode & 0o077) !== 0
  ) {
    throw new Error("Persisted broker log was missing or exposed private data");
  }
  await fs.writeFile(
    capabilityPath,
    stringify({ ...arcCapability, contract: { ...arcCapability.contract, output_schema: { type: "string" } } }),
    { mode: 0o600 },
  );
  await wait(300);
  smokeStage = "requesting broken-contract capability";
  const broken = await requestOnce(
    socket,
    {
      id: "electron-smoke-broken-contract",
      capability: "arc.remaining_hours.read",
      token: "smoke-test-token-value",
      input: {},
    },
    20_000,
  );
  if (broken.ok || broken.error?.code !== "CAPABILITY_BROKEN") {
    throw new Error(`Output contract did not fail closed: ${JSON.stringify(broken)}`);
  }
  const screenshotBytes = (await fs.stat(screenshot)).size;
  if (screenshotBytes < 10_000) {
    throw new Error(`Smoke screenshot is unexpectedly small (${screenshotBytes} bytes)`);
  }
  process.stdout.write(
    `Electron smoke passed; detached startup, single-instance reuse, discovery, output validation, bounded authentication backoff, authenticated JSON, hidden browser JSON, UM GPT reads and one authenticated WebSocket send, duplicate-send protection, TeamDynamix expense capture without POST, persisted logging, and expense submission succeeded; screenshot saved to ${screenshot}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error.message}\nSmoke stage: ${smokeStage}\nAuthentication fixture requests: ${JSON.stringify(authenticationFixtureRequests)}\nBrowser fixture requests: ${JSON.stringify(browserFixtureRequests)}\nExpense fixture requests: ${JSON.stringify(expenseFixtureRequests)}\n${await fs.readFile(stderrFile, "utf8").catch(() => "")}`,
  );
  process.exitCode = 1;
} finally {
  signalBroker("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (processGroup && await brokerProcessesRemain() && Date.now() < deadline) await wait(100);
  if (processGroup && await brokerProcessesRemain()) {
    signalBroker("SIGKILL");
    process.exitCode = 1;
    process.stderr.write("Detached broker required forced teardown\n");
  }
  processGroup = undefined;
  await close(fixture);
  await close(authFixture);
  await fs.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
