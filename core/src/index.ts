import { serve } from "@hono/node-server";
import OpenAI from "openai";
import { config } from "./config.ts";
import { EventLog } from "./eventlog.ts";
import { createServer, SESSION } from "./server.ts";
import { SurfaceRegistry } from "./surfaces.ts";
import { createDemoWorld } from "./tools/demo-world.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { surfacesNamespace } from "./tools/surfaces.ts";

const log = new EventLog(config.dbPath);
const surfaces = new SurfaceRegistry({
  presenceTimeoutMs: config.presenceTimeoutMs,
  onEvent: (kind, data) => log.append(SESSION, kind, data),
});
const tools = new ToolRegistry().add(...createDemoWorld().namespaces, surfacesNamespace);
const muse = new OpenAI({ baseURL: config.museBaseUrl, apiKey: config.museApiKey || "missing" });

const core = createServer(
  {
    muse,
    tools,
    surfaces,
    log,
    agentModel: config.agentModel,
    fastModel: config.fastModel,
    maxTurns: config.maxTurns,
    approvalTimeoutMs: config.approvalTimeoutMs,
  },
  { token: config.token, museReady: Boolean(config.museApiKey) },
);

const server = serve({ fetch: core.app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Auren Core on http://${config.host}:${info.port}  (agent ${config.agentModel}, fast ${config.fastModel})`);
  if (!config.museApiKey) console.warn("  ⚠ MODEL_API_KEY not set: surfaces connect, commands return an error.");
  if (!config.token) console.log("  local only. Set AUREN_TOKEN to allow your phone and watch on the network.");
});
server.on("upgrade", core.upgrade);
