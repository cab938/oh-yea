import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configured, ACTIVE_CAPABILITY } from "../test-support/fixtures.mjs";
import { authorizeRequest, parseCapability, publicConfig } from "../src/lib/config.mjs";
import { publishServices } from "../src/lib/services.mjs";

const sourceDirectory = fileURLToPath(new URL("../services", import.meta.url));

test("service tokens cover new capabilities in that service but never another service or disabled capability", () => {
  const config = configured();
  const first = config.capabilities[0];
  config.capabilities.push({...first,name:"arc.second.read"}, {...first,name:"other.read",service:"umgpt"}, {...first,name:"arc.disabled.read",enabled:false});
  config.serviceTokens.umgpt="distinct-umgpt-token";
  const request={token:config.serviceTokens.arc,input:{}};
  assert.equal(authorizeRequest(config,{...request,capability:"arc.second.read"}).ok,true);
  assert.equal(authorizeRequest(config,{...request,capability:"other.read",service:"arc"}).code,"UNAUTHORIZED");
  assert.equal(authorizeRequest(config,{...request,capability:"arc.disabled.read"}).code,"UNAUTHORIZED");
  assert.equal(authorizeRequest({...config,serviceTokens:{}},{...request,capability:first.name}).code,"UNAUTHORIZED");
  assert.equal(JSON.stringify(publicConfig(config)).includes(request.token),false);
  assert.throws(()=>parseCapability(`${ACTIVE_CAPABILITY}\ntokens: [legacy-token]\n`,config.authentications), error=>error.details.some(detail=>detail.includes(".env")));
});

test("service pointers select maintained workflows and fresh redacted contracts for all four services", async (t) => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"broker-services-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const config=configured();
  const services=await publishServices({sourceDirectory,directory,config});
  assert.deepEqual(services.map(service=>service.id),["arc","expense-reports","mcommunity","umgpt"]);
  for(const service of services) {
    assert.ok(path.isAbsolute(service.workflow_file));
    assert.equal(path.dirname(service.workflow_file),path.dirname(service.capabilities_file));
    assert.match(await fs.readFile(service.workflow_file,"utf8"),new RegExp(`id: ${service.id}`));
    const contracts=JSON.parse(await fs.readFile(service.capabilities_file,"utf8"));
    assert.equal(contracts.length,service.id==="arc"?1:0);
  }
  const arc=services.find(service=>service.id==="arc");
  const text=await fs.readFile(arc.capabilities_file,"utf8");
  for(const secret of [config.serviceTokens.arc,"rmp-backend","requestHeaders","authentication","tokens"])
    assert.equal(text.includes(secret),false);
  config.capabilities[0].contract.inputSchema={type:"object",required:["changed"]};
  await publishServices({sourceDirectory,directory,config});
  assert.deepEqual(JSON.parse(await fs.readFile(arc.capabilities_file,"utf8"))[0].input_schema.required,["changed"]);
  config.capabilities=[];
  await publishServices({sourceDirectory,directory,config});
  assert.deepEqual(JSON.parse(await fs.readFile(arc.capabilities_file,"utf8")),[]);
  config.capabilities=[{...configured().capabilities[0],service:"missing-guide"}];
  await assert.rejects(publishServices({sourceDirectory,directory,config}),{code:"INVALID_SERVICE"});
});
