import { serve } from "@hono/node-server";
import OpenAI from "openai";
import { config } from "./config.ts";
import { EventLog } from "./eventlog.ts";
import { createServer, SESSION } from "./server.ts";
import { SurfaceRegistry } from "./surfaces.ts";
import { GoogleAuth } from "./connectors/google/auth.ts";
import { createGoogleCalendar } from "./connectors/google/calendar.ts";
import { SecretStore } from "./connectors/secrets.ts";
import { OpsLog } from "./obs/opslog.ts";
import { derive, masterKey } from "./security/keys.ts";
import { Ledger, ledgerMuse, pathTemplate } from "./security/ledger.ts";
import { createDemoWorld } from "./tools/demo-world.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { surfacesNamespace } from "./tools/surfaces.ts";

// One master key (sealed to the Secure Enclave on a Mac), one derived key per job.
const master = masterKey({ secret: config.secret || undefined, dbPath: config.dbPath });
const log = new EventLog(config.dbPath, derive(master.key, "events"));
const store = new SecretStore(config.dbPath, derive(master.key, "tokens"));
const ledger = new Ledger(config.dbPath);
const ops = new OpsLog({ file: config.logFile || undefined });

const surfaces = new SurfaceRegistry({
  presenceTimeoutMs: config.presenceTimeoutMs,
  onEvent: (kind, data) => log.append(SESSION, kind, data),
});
const local = `http://127.0.0.1:${config.port}`;
const google =
  config.googleClientId && config.googleClientSecret
    ? new GoogleAuth({
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        redirectUri: `${local}/connect/google/callback`,
        connectUrl: `${local}/connect/google`,
        store,
        onCall: (c) => ledger.record({ service: "Google", operation: `${c.operation} ${new URL(c.url).host}${pathTemplate(c.url)}`, status: c.status, ms: c.ms, bytesOut: c.bytesOut }),
      })
    : undefined;
// Live connectors replace demo namespaces one by one; the rest stay in the demo world.
const demo = createDemoWorld().namespaces;
const namespaces = google ? [createGoogleCalendar(google, { timeZone: config.timeZone }), ...demo.filter((ns) => ns.name !== "calendar")] : demo;
const tools = new ToolRegistry().add(...namespaces, surfacesNamespace);
const muse = ledgerMuse(new OpenAI({ baseURL: config.museBaseUrl, apiKey: config.museApiKey || "missing" }), ledger);

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
    ops,
  },
  { token: config.token, museReady: Boolean(config.museApiKey), google, ledger, keys: { source: master.source, note: master.note } },
);

const server = serve({ fetch: core.app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Auren Core on http://${config.host}:${info.port}  (agent ${config.agentModel}, fast ${config.fastModel})`);
  if (!config.museApiKey) console.warn("  ⚠ MODEL_API_KEY not set: surfaces connect, commands return an error.");
  const keyLine = {
    "secure-enclave": "keys: sealed to this Mac's Secure Enclave (auren-keyd)",
    env: "keys: from AUREN_SECRET",
    file: `keys: ⚠ file next to the database (${master.note ?? "no Secure Enclave"})`,
    memory: "keys: in memory only",
  }[master.source];
  console.log(`  ${keyLine}`);
  const v = log.verify();
  console.log(v.ok ? `  log: ${v.count} events, chain intact (head ${v.head})` : `  ⚠ log: ${v.reason}. Check /v1/audit/verify.`);
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
