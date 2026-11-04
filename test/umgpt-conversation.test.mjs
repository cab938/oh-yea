import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { stringify } from "yaml";
import { readTemplates } from "../test-support/templates.mjs";
import { parseCapability, parseConfig, authorizeRequest, validateCapabilityResult } from "../src/lib/config.mjs";
import { readUmGpt, sendUmGpt, runUmGptSocket, setUmGptConnectorActive } from "../src/lib/umgpt-conversation.mjs";

const origin = "https://umgpt.example.test";
const profiles = parseConfig(`version: 1\nauthentications:\n  umgpt_session:\n    url: ${origin}/umgpt/api/me\n    login_url: ${origin}/\n`).authentications;
const examples = (await readTemplates("umgpt")).map(({ definition }) => definition);
const definitions = examples.map((item) => parseCapability(stringify({ ...item, enabled: true }), profiles));
const byOperation = (op) => definitions.find((item) =>
  (item.extraction?.operation ?? (item.action?.type === "umgpt_connector_state" ? "set_active" : "send")) === op);
const rawConversation = { id: 20, title: "Test conversation", created: "2026-10-21T12:00:00Z", extras: {service: 4, is_agentic: true}, meta: {message_count: 2, last_message_created_at: "2026-10-21T12:00:01Z"} };
const rawMessage = { id: 22, conversation_id: 20, message_type: "ai", content: "BROKER_OK", created_at: "2026-10-21T12:00:01Z", attachments: [] };
const rawConnectors = [
  { id: 11, display_name: "Search", description: "Search the web", is_active: true, tool_count: 5, credentials: "must-not-leave-broker", server_url: "https://private.example.test/" },
  { id: 12, display_name: "Documents", is_active: false, tool_count: null },
];
function fixture(connectors = rawConnectors) {
  const requests = [];
  const fetch = async (url, options) => {
    assert.equal(new URL(url).origin, origin);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "include");
    const route = new URL(url).pathname;
    requests.push(route);
    const data = {
      "/umgpt/api/me": { id: 7, private_identity: "must-not-leave-broker" },
      "/umgpt/api/services": [{ id: 4, title: "Text agent", is_agentic: true, backend_type: "text" }],
      "/umgpt/api/users/7/connectors/": connectors,
      "/umgpt/api/users/7/conversations/": [rawConversation],
      "/umgpt/api/users/7/conversations/20/messages/": [rawMessage],
    }[route];
    assert.notEqual(data, undefined, `Unexpected route ${route}`);
    return Response.json(data);
  };
  return { fetch, requests };
}

test("UM GPT examples validate, reject caller routing, and share authorization within the service", () => {
  const config = { capabilities: definitions, serviceTokens: { umgpt: "operator-configured-token" } };
  const input = { request_id: "demo-1", prompt: "Hello", model_id: 4 };
  assert.equal(authorizeRequest(config, {token:"operator-configured-token",capability:byOperation("send").name,input}).ok, true);
  assert.equal(authorizeRequest(config, {token:"operator-configured-token",capability:byOperation("send").name,input:{...input,url:"https://elsewhere.test/"}}).code, "INVALID_INPUT");
  assert.equal(authorizeRequest(config,{token:"another-service-token",capability:byOperation("send").name,input}).code,"UNAUTHORIZED");
  const readExample = examples.find((item) => item.name === byOperation("models").name);
  assert.throws(() => parseCapability(stringify({...readExample,url:"https://other.example.test/"}),profiles), /validation/);
  assert.throws(() => parseCapability(stringify({...readExample,extraction:{type:"umgpt_conversation",operation:"delete"}}),profiles), /validation/);
  const connectorRequest = { token: "operator-configured-token", capability: byOperation("connectors").name, input: {} };
  assert.equal(authorizeRequest(config, connectorRequest).ok, true);
  assert.equal(authorizeRequest(config, { ...connectorRequest, token: "another-service-token" }).code, "UNAUTHORIZED");
  for (const input of [{ user_id: 99 }, { conversation_id: 20 }, { url: "https://elsewhere.test/" }, { is_active: true }]) {
    assert.equal(authorizeRequest(config, { ...connectorRequest, input }).code, "INVALID_INPUT");
  }
  const stateRequest = { ...connectorRequest, capability: byOperation("set_active").name, input: { connector_id: 11, is_active: false } };
  assert.equal(authorizeRequest(config, stateRequest).ok, true);
  assert.equal(authorizeRequest(config, { ...stateRequest, token: "another-service-token" }).code, "UNAUTHORIZED");
  for (const input of [{ connector_id: 11 }, { connector_id: 11, is_active: "false" }, { connector_id: -1, is_active: true },
    { ...stateRequest.input, user_id: 99 }, { ...stateRequest.input, conversation_id: 20 },
    { ...stateRequest.input, url: "https://elsewhere.test/" }, { ...stateRequest.input, token: "caller-csrf" }]) {
    assert.equal(authorizeRequest(config, { ...stateRequest, input }).code, "INVALID_INPUT");
  }
  const stateExample = examples.find((item) => item.name === stateRequest.capability);
  assert.throws(() => parseCapability(stringify({ ...stateExample, action: { ...stateExample.action, page_url: "https://elsewhere.test/" } }), profiles), /validation/);
  assert.throws(() => parseCapability(stringify({ ...stateExample, authentication: undefined }), profiles), /validation/);
});

test("connector discovery reads the signed-in account and preserves active and inactive states without private fields", async () => {
  const f = fixture();
  const definition = byOperation("connectors");
  const result = await readUmGpt({ ...f, definition });
  assert.deepEqual(f.requests, ["/umgpt/api/me", "/umgpt/api/users/7/connectors/"]);
  assert.deepEqual(result, { connectors: [
    { id: 11, display_name: "Search", description: "Search the web", is_active: true, tool_count: 5 },
    { id: 12, display_name: "Documents", description: null, is_active: false, tool_count: null },
  ] });
  assert.equal(validateCapabilityResult(definition, result).ok, true);
  assert.deepEqual(await readUmGpt({ ...fixture([]), definition }), { connectors: [] });
  const zeroTools = await readUmGpt({ ...fixture([{ ...rawConnectors[1], tool_count: 0 }]), definition });
  assert.equal(zeroTools.connectors[0].tool_count, 0);
});

test("connector discovery fails closed when account connector data has drifted", async () => {
  const definition = byOperation("connectors");
  for (const data of [null, { results: rawConnectors }, [null],
    [{ ...rawConnectors[0], id: "11" }],
    [{ ...rawConnectors[0], display_name: null }],
    [{ ...rawConnectors[0], is_active: undefined }],
    [{ ...rawConnectors[0], is_active: "false" }],
    [{ ...rawConnectors[0], description: {} }],
    [{ ...rawConnectors[0], tool_count: -1 }],
    [{ ...rawConnectors[0], tool_count: 1.5 }],
  ]) {
    await assert.rejects(readUmGpt({ ...fixture(data), definition }), { code: "CAPABILITY_BROKEN" });
  }
});

function connectorStateFixture({ status = 200, disconnect = false, confirm = true } = {}) {
  const connectors = structuredClone(rawConnectors);
  const reads = fixture(connectors);
  const patches = [];
  return {
    patches,
    definition: byOperation("set_active"),
    getCsrfToken: async (url) => { assert.equal(url, `${origin}/`); return "BrokerOnlyCsrfValue"; },
    fetch: async (url, options) => {
      if (options.method === "GET") return reads.fetch(url, options);
      assert.equal(url, `${origin}/umgpt/api/users/7/connectors/11/`);
      assert.equal(options.method, "PATCH");
      assert.equal(options.redirect, "manual");
      assert.equal(options.credentials, "include");
      assert.equal(options.headers["X-CSRFToken"], "BrokerOnlyCsrfValue");
      assert.equal(options.headers.Origin, origin);
      assert.equal(options.headers.Referer, `${origin}/`);
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body), ["is_active"]);
      assert.equal(typeof body.is_active, "boolean");
      patches.push(body);
      if (disconnect) throw new Error("private upstream failure");
      if (status === 200 && confirm) connectors[0].is_active = body.is_active;
      return new Response("private write response", { status });
    },
  };
}

test("connector state changes use one fixed PATCH and confirm both off and on; already-set states do not write", async () => {
  const request = connectorStateFixture();
  for (const is_active of [false, true]) {
    const result = await setUmGptConnectorActive({ ...request, input: { connector_id: 11, is_active } });
    assert.equal(result.connector.is_active, is_active);
    assert.equal(result.changed, true);
    assert.equal(validateCapabilityResult(request.definition, result).ok, true);
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.ok(!JSON.stringify(result).includes("must-not-leave-broker"));
  }
  const repeated = await setUmGptConnectorActive({ ...request, input: { connector_id: 11, is_active: true } });
  assert.equal(repeated.changed, false);
  assert.equal(request.patches.length, 2);
});

test("connector state changes require account membership and CSRF before any write", async () => {
  const request = connectorStateFixture();
  await assert.rejects(setUmGptConnectorActive({ ...request, input: { connector_id: 99, is_active: true } }), { code: "RESOURCE_NOT_AVAILABLE" });
  await assert.rejects(setUmGptConnectorActive({ ...request, getCsrfToken: async () => undefined, input: { connector_id: 11, is_active: false } }), { code: "AUTHENTICATION_REQUIRED" });
  await assert.rejects(setUmGptConnectorActive({ ...request, input: { connector_id: 11, is_active: "false" } }), { code: "INVALID_INPUT" });
  assert.equal(request.patches.length, 0);
});

test("connector rejection and uncertain outcomes never retry or report an unverified state", async () => {
  for (const options of [{ status: 403 }, { status: 500 }, { status: 302 }, { status: 408 }, { disconnect: true }, { confirm: false }]) {
    const request = connectorStateFixture(options);
    await assert.rejects(setUmGptConnectorActive({ ...request, input: { connector_id: 11, is_active: false } }), {
      code: options.status === 403 ? "UMGPT_CONNECTOR_REJECTED" : "UMGPT_CONNECTOR_OUTCOME_UNKNOWN",
    });
    assert.equal(request.patches.length, 1);
  }
});

test("reads owned conversations through fixed routes and releases only contracted fields", async () => {
  const f = fixture();
  for (const op of ["models","list","read"]) {
    const definition = byOperation(op);
    const result = await readUmGpt({...f,definition,input:{conversation_id:20}});
    assert.equal(validateCapabilityResult(definition,result).ok,true);
    assert.ok(!JSON.stringify(result).includes("must-not-leave-broker"));
    if(op === "read") assert.equal(result.messages[0].content,"BROKER_OK");
  }
  await assert.rejects(readUmGpt({...f,definition:byOperation("read"),input:{conversation_id:99}}),{code:"RESOURCE_NOT_AVAILABLE"});
  assert.ok(!f.requests.some((route)=>route.includes("/99/")));
});

test("one prompt is sent once; the journal excludes content and refuses repeats and conflicts", async (t) => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"umgpt-test-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let sends=0;
  const f=fixture();
  const input={request_id:"request-1",prompt:"private test prompt",model_id:4,conversation_id:20};
  const request={...f,definition:byOperation("send"),input,journalDirectory:directory,send:async ({message})=>{
    sends++;
    assert.equal(message.question,input.prompt);
    assert.deepEqual(message.attachment_ids,[]);
    assert.equal("decision" in message,false);
    return {status:"complete",conversationId:20,message:rawMessage};
  }};
  const result=await sendUmGpt(request);
  assert.equal(validateCapabilityResult(byOperation("send"),result).ok,true);
  await assert.rejects(sendUmGpt(request),{code:"REQUEST_ALREADY_ATTEMPTED"});
  await assert.rejects(sendUmGpt({...request,input:{...input,prompt:"different"}}),{code:"REQUEST_ID_CONFLICT"});
  assert.equal(sends,1);
  const journal=await fs.readFile(path.join(directory,"request-1.json"),"utf8");
  assert.ok(!journal.includes(input.prompt));
  assert.ok(!journal.includes(rawMessage.content));
  assert.equal((await fs.stat(path.join(directory,"request-1.json"))).mode&0o777,0o600);
});

test("uncertain outcomes and simultaneous duplicate IDs cannot produce a second send",async(t)=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"umgpt-test-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let sends=0;
  const request={...fixture(),definition:byOperation("send"),journalDirectory:directory,input:{request_id:"uncertain",prompt:"hello",model_id:4},send:async()=>{sends++;throw new Error("disconnected");}};
  const results=await Promise.allSettled([sendUmGpt(request),sendUmGpt(request)]);
  assert.equal(results.every(result=>result.status==="rejected"),true);
  await assert.rejects(sendUmGpt(request),{code:"REQUEST_ALREADY_ATTEMPTED"});
  assert.equal(sends,1);
});

async function socketScenario(events) {
  const sent=[];
  class Socket {
    constructor(url) {assert.equal(url, "wss://umgpt.example.test/ws/umgpt/conversations/messages/");queueMicrotask(()=>this.onopen?.());}
    send(text) {sent.push(JSON.parse(text));queueMicrotask(()=>{for(const event of events){if(event==="disconnect") this.onclose?.({});else this.onmessage?.({data:JSON.stringify(event)});}});}
    close() {}
  }
  const result=await vm.runInNewContext(`(${runUmGptSocket.toString()})(input)`,{
    window:{location:{origin}},URL,WebSocket:Socket,setTimeout,clearTimeout,
    input:{origin,message:{question:"hello",service:4,conversation_id:-1,temp_conversation_id:-1},timeoutMs:100},
  });
  return {result,sent};
}

test("WebSocket sends one prompt, waits for the assistant, and leaves connector approval to the human",async()=>{
  const created={type:"conversation.created",conversation_id:20,temp_conversation_id:-1};
  const complete=await socketScenario([created,{type:"conversation.tool_started",message:{conversation_id:20}},{type:"conversation.message",message:rawMessage}]);
  assert.equal(complete.result.status,"complete");
  assert.equal(complete.sent.length,1);
  const interrupt={...rawMessage,message_type:"interrupt",response:null,tool_name:"write_document",action_id:"a-1"};
  const approval=await socketScenario([created,{type:"conversation.tool_interrupt",message:interrupt}]);
  assert.equal(approval.result.status,"approval_required");
  assert.equal(approval.sent.length,1);
  const lost=await socketScenario([created,"disconnect"]);
  assert.equal(lost.result.error,"UMGPT_OUTCOME_UNKNOWN");
  assert.equal(lost.sent.length,1);
});
