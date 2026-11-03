import { serve } from "@hono/node-server";
import OpenAI from "openai";
import { config } from "./config.ts";
import { EventLog } from "./eventlog.ts";
import { createServer, SESSION } from "./server.ts";
import { SurfaceRegistry } from "./surfaces.ts";
import { GoogleAuth } from "./connectors/google/auth.ts";
import { createGoogleCalendar } from "./connectors/google/calendar.ts";
import { createGmail } from "./connectors/google/gmail.ts";
import { createSlack } from "./connectors/slack.ts";
import { SecretStore } from "./connectors/secrets.ts";
import { OpsLog } from "./obs/opslog.ts";
import { DeviceRegistry } from "./security/devices.ts";
import { derive, masterKey } from "./security/keys.ts";
import { Ledger, ledgerMuse, pathTemplate } from "./security/ledger.ts";
import { createDemoWorld } from "./tools/demo-world.ts";
import { museAsr } from "./voice/asr.ts";
import { voiceKeywords } from "./voice/wake.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { surfacesNamespace } from "./tools/surfaces.ts";
import { createBrowser } from "./computer/browser.ts";
import { DriverHub } from "./computer/hub.ts";

// One master key (sealed to the Secure Enclave on a Mac), one derived key per job.
const master = masterKey({ secret: config.secret || undefined, dbPath: config.dbPath });
const log = new EventLog(config.dbPath, derive(master.key, "events"));
const store = new SecretStore(config.dbPath, derive(master.key, "tokens"));
const ledger = new Ledger(config.dbPath);
const devices = new DeviceRegistry(config.dbPath);
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
const live = new Map<string, ReturnType<typeof createSlack>>();
if (google) {
  live.set("calendar", createGoogleCalendar(google, { timeZone: config.timeZone }));
  live.set("gmail", createGmail(google));
}
if (config.slackBotToken) {
  live.set("slack", createSlack({ token: config.slackBotToken, onCall: (c) => ledger.record({ service: "Slack", ...c }) }));
}
const namespaces = createDemoWorld().namespaces.map((ns) => live.get(ns.name) ?? ns);
const tools = new ToolRegistry().add(...namespaces, surfacesNamespace);
const muse = ledgerMuse(new OpenAI({ baseURL: config.museBaseUrl, apiKey: config.museApiKey || "missing" }), ledger);

// R7: computer use. The Playwright driver dials in on /v1/driver; browser.run_task drives it.
const driver = new DriverHub({ ops });
tools.add(createBrowser({ hub: driver, muse, model: config.agentModel, log, ops, ledger, approvalTimeoutMs: config.approvalTimeoutMs }));

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
  { token: config.token, museReady: Boolean(config.museApiKey), google,
    ledger,
    devices,
    keys: { source: master.source, note: master.note },
    voice: {
      asr: config.museApiKey ? museAsr({ apiKey: config.museApiKey, metadataOnlyLogging: config.asrMetadataOnly }) : undefined,
      keywords: () => voiceKeywords(config.asrKeywords),
    },
    driver,
  },
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
  const paired = devices.list().filter((d) => !d.revoked);
  console.log(`  devices: ${paired.length ? paired.map((d) => `${d.name} (${d.hardware ? "Secure Enclave" : "software key"})`).join(", ") : "none paired yet. Pair one from the console."}`);
  const g = google?.status();
  const googleState = !google ? "demo" : g?.connected ? `Google (${g.email ?? "connected"})` : `Google, not connected: open ${local}/connect/google`;
  console.log(`  apps: calendar and gmail ${googleState} · slack ${config.slackBotToken ? "live" : "demo"}`);
  console.log(`  time zone: ${config.timeZone}`);
  console.log("  browser: start the computer-use driver with `cd driver && npm start`");
  if (!config.token) console.log("  local only. Set AUREN_TOKEN to allow your phone and watch on the network.");
});
server.on("upgrade", core.upgrade);
