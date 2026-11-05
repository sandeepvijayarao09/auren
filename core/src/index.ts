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
import { CaptureBroker } from "./vision/capture.ts";
import { CropStore } from "./vision/crops.ts";
import { createGlasses } from "./vision/look.ts";
import { samSegmenter, sparkReader } from "./vision/models.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { surfacesNamespace } from "./tools/surfaces.ts";
import { createMemory } from "./memory/memory.ts";
import { createReceipts } from "./memory/receipts.ts";
import { sparkOpen } from "./memory/spark.ts";
import { createBrowser } from "./computer/browser.ts";
import { DriverHub } from "./computer/hub.ts";
// R11: MCP bridge
import { loadMcpConfig, McpBridge } from "./connectors/mcp.ts";
import { createRouter } from "./router/router.ts";
import { SpendGuard } from "./obs/spend.ts"; // R13

// R13: AUREN_SANDBOX=true serves only the public sandbox (core/src/sandbox/) until it's stopped, then
// exits. Nothing below runs: no master key, no auren.db, no connectors, devices, camera or driver.
if (config.sandbox) {
  await (await import("./sandbox/main.ts")).runSandbox();
  process.exit(0);
}

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
const demo = createDemoWorld();
// Persona: AUREN_PERSONA=maya loads Maya Okafor's fictional week into the demo world
// and adds her Journal and Tasks MCP servers (src/demo/persona/maya.ts).
const persona = process.env.AUREN_PERSONA === "maya" ? await import("./demo/persona/maya.ts") : undefined;
const personaCounts = persona?.applyMaya(demo.state, demo.namespaces);
const personaServers = persona ? persona.mayaServers().servers : [];
// end persona
const namespaces = demo.namespaces.map((ns) => live.get(ns.name) ?? ns);
const tools = new ToolRegistry().add(...namespaces, surfacesNamespace);

// Auren Memory and voice undo. Muse Spark Open writes the recaps only when BASETEN_API_KEY is set.
const spark = config.basetenApiKey
  ? sparkOpen({ client: new OpenAI({ baseURL: config.basetenBaseUrl, apiKey: config.basetenApiKey, maxRetries: 1 }), model: config.memoryModel, ledger, ops })
  : undefined;
tools.add(createMemory({ log, spark, timeZone: config.timeZone, ops }), createReceipts({ log, tools, timeZone: config.timeZone }));
// R13: ops too, for one `usage` line per model call. The spend guard watches the ledger's token total.
const muse = ledgerMuse(new OpenAI({ baseURL: config.museBaseUrl, apiKey: config.museApiKey || "missing" }), ledger, ops);
const spend = new SpendGuard(ledger, { alarm: config.tokenAlarm, limit: config.tokenLimit, ops, onCross: (e) => log.append(SESSION, "usage", { ...e }) });

// Vision: glasses.look asks a camera surface for one blurred frame; Muse Spark reads it,
// SAM 3.1 outlines what's at the centre, and only that crop is kept (encrypted) for the receipt.
const frames = new CaptureBroker(surfaces);
const crops = new CropStore(config.dbPath, derive(master.key, "crops"));
tools.add(createGlasses({ broker: frames, reader: sparkReader(muse, config.fastModel), segmenter: samSegmenter(muse), crops, ops, timeZone: config.timeZone }));

// R7: computer use. The Playwright driver dials in on /v1/driver; browser.run_task drives it.
const driver = new DriverHub({ ops });
tools.add(createBrowser({ hub: driver, muse, model: config.computerModel, log, ops, ledger, approvalTimeoutMs: config.approvalTimeoutMs }));

// R11: MCP bridge. Each server in mcp.json becomes a namespace while it's connected.
// They connect in the background, so a slow or broken server never holds up Core.
const mcpConfig = loadMcpConfig(config.mcpConfig || undefined);
const mcp = new McpBridge({ servers: [...mcpConfig.servers.filter((s) => !personaServers.some((p) => p.namespace === s.namespace)), ...personaServers], ledger, ops }); // persona servers win
tools.add(...mcp.namespaces);
mcp.start();

// R9: Auren Router. Glimmer on Modal when AUREN_ROUTER_URL is set, else Muse Spark (with a key), else rules.
// Advisory: it preloads namespaces, starts the camera early for "this" and shapes the ack. Tiers stay with the tools.
const router = createRouter({
  url: config.routerUrl || undefined,
  key: config.routerKey || undefined,
  model: config.routerModel,
  budgetMs: config.routerBudgetMs,
  muse: config.museApiKey ? muse : undefined,
  sparkModel: config.fastModel,
  namespaces: () => tools.names(),
  ledger,
  ops,
});
const r9 = { router, prefetchFrame: (purpose: string) => void frames.prefetch(purpose) };

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
    ...r9,
  },
  { token: config.token, museReady: Boolean(config.museApiKey), google,
    ledger,
    devices,
    keys: { source: master.source, note: master.note },
    voice: {
      asr: config.museApiKey ? museAsr({ apiKey: config.museApiKey, metadataOnlyLogging: config.asrMetadataOnly }) : undefined,
      keywords: () => voiceKeywords(config.asrKeywords),
    },
    vision: { frames, crops },
    driver,
    mcp, // R11: MCP bridge
    spend, // R13
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
  if (personaCounts) console.log(`  persona: Maya Okafor (fictional) · ${personaCounts.threads} threads · ${personaCounts.events} events · ${personaCounts.channels} channels · journal + tasks over MCP`); // persona
  console.log("  browser: start the computer-use driver with `cd driver && npm start`");
  // R11: MCP bridge
  const servers = mcpConfig.servers.map((s) => `${s.namespace} (${s.transport}${s.trust ? ", read-only hints trusted" : ", every tool asks"})`);
  console.log(`  mcp: ${servers.length ? `${servers.join(", ")}; connecting in the background, see /v1/connections` : mcpConfig.found ? "no servers in mcp.json" : "no mcp.json (see mcp.example.json)"}`);
  for (const e of mcpConfig.errors) console.warn(`  ⚠ mcp: ${e}`);
  console.log(`  router: ${config.routerUrl ? `Glimmer at ${new URL(config.routerUrl).host}, then Spark, then rules` : config.museApiKey ? "Muse Spark, then rules (set AUREN_ROUTER_URL for Glimmer)" : "rules"}`);
  if (!config.token) console.log("  local only. Set AUREN_TOKEN to allow your phone and watch on the network.");
  // R13
  const used = ledger.totals().total;
  if (config.tokenAlarm || config.tokenLimit || used) console.log(`  tokens: ${used.toLocaleString("en-US")} used${config.tokenAlarm ? ` · alarm ${config.tokenAlarm.toLocaleString("en-US")}` : ""}${config.tokenLimit ? ` · limit ${config.tokenLimit.toLocaleString("en-US")}` : ""}`);
});
server.on("upgrade", core.upgrade);
