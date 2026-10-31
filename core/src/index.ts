import { serve } from "@hono/node-server";
import OpenAI from "openai";
import { config } from "./config.ts";
import { EventLog } from "./eventlog.ts";
import { createServer, SESSION } from "./server.ts";
import { SurfaceRegistry } from "./surfaces.ts";
import { GoogleAuth } from "./connectors/google/auth.ts";
import { createGoogleCalendar } from "./connectors/google/calendar.ts";
import { loadKey, SecretStore } from "./connectors/secrets.ts";
import { createDemoWorld } from "./tools/demo-world.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { surfacesNamespace } from "./tools/surfaces.ts";

const log = new EventLog(config.dbPath);
const surfaces = new SurfaceRegistry({
  presenceTimeoutMs: config.presenceTimeoutMs,
  onEvent: (kind, data) => log.append(SESSION, kind, data),
});
const store = new SecretStore(
  config.dbPath,
  loadKey({ secret: config.secret || undefined, keyPath: config.dbPath === ":memory:" ? undefined : `${config.dbPath}.key` }),
);
const local = `http://127.0.0.1:${config.port}`;
const google =
  config.googleClientId && config.googleClientSecret
    ? new GoogleAuth({
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        redirectUri: `${local}/connect/google/callback`,
        connectUrl: `${local}/connect/google`,
        store,
      })
    : undefined;
// Live connectors replace demo namespaces one by one; the rest stay in the demo world.
const demo = createDemoWorld().namespaces;
const namespaces = google ? [createGoogleCalendar(google, { timeZone: config.timeZone }), ...demo.filter((ns) => ns.name !== "calendar")] : demo;
const tools = new ToolRegistry().add(...namespaces, surfacesNamespace);
const muse = new OpenAI({ baseURL: config.museBaseUrl, apiKey: config.museApiKey || "missing" });

const core = createServer(
  {
    muse,
    tools,
    surfaces,
    log,
    agentModel: config.agentModel,
    fastModel: config.fastModel,
    timeZone: config.timeZone,
    maxTurns: config.maxTurns,
    approvalTimeoutMs: config.approvalTimeoutMs,
  },
  { token: config.token, museReady: Boolean(config.museApiKey), google },
);

const server = serve({ fetch: core.app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Auren Core on http://${config.host}:${info.port}  (agent ${config.agentModel}, fast ${config.fastModel})`);
  if (!config.museApiKey) console.warn("  ⚠ MODEL_API_KEY not set: surfaces connect, commands return an error.");
  const g = google?.status();
  console.log(
    !google ? "  calendar: demo world (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for the real one)"
      : g?.connected ? `  calendar: Google, connected as ${g.email ?? "your account"}`
      : `  calendar: Google, not connected yet. Open ${local}/connect/google`,
  );
  console.log(`  time zone: ${config.timeZone}`);
  if (!config.token) console.log("  local only. Set AUREN_TOKEN to allow your phone and watch on the network.");
});
server.on("upgrade", core.upgrade);
