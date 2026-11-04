// `make sandbox` (AUREN_SANDBOX=true): the public sandbox and nothing else. It
// never opens auren.db, the master key, a connector, a paired device, the camera
// or the driver, whatever the rest of .env says. The only secret it reads is
// MODEL_API_KEY, for the live engine; without it, every command replays.
import { serve } from "@hono/node-server";
import OpenAI from "openai";
import { config } from "../config.ts";
import { OpsLog } from "../obs/opslog.ts";
import { SpendGuard } from "../obs/spend.ts";
import { Ledger, ledgerMuse } from "../security/ledger.ts";
import { displayModel, Sandbox } from "./sandbox.ts";
import { createSandboxServer } from "./server.ts";

/** Serves the sandbox until SIGINT or SIGTERM, then resolves. */
export async function runSandbox(): Promise<void> {
  const ops = new OpsLog({ file: config.logFile || undefined });
  // In memory: the live engine's tokens, the budget and AUREN_TOKEN_LIMIT count this process only.
  const ledger = new Ledger();
  const spend = new SpendGuard(ledger, { alarm: config.tokenAlarm, limit: config.tokenLimit, ops });
  const live = config.museApiKey
    ? {
        muse: ledgerMuse(new OpenAI({ baseURL: config.museBaseUrl, apiKey: config.museApiKey, timeout: 30_000, maxRetries: 1 }), ledger, ops),
        agentModel: config.agentModel,
        fastModel: config.fastModel,
        ledger,
        spend,
      }
    : undefined;
  const sandbox = new Sandbox({
    live,
    tokenBudget: config.sandboxTokenBudget,
    rpm: config.sandboxRpm,
    daily: config.sandboxDaily,
    maxVisitors: config.sandboxMaxVisitors,
    trustProxy: config.trustProxy,
    approvalTimeoutMs: config.approvalTimeoutMs,
    timeZone: config.timeZone,
    ops,
  });
  const core = createSandboxServer(sandbox, {
    trustProxy: config.trustProxy,
    onUntrustedProxy: () =>
      ops.warn("sandbox.proxy", { message: "Requests carry X-Forwarded-For but AUREN_TRUST_PROXY isn't set, so every visitor shares one set of rate limits." }),
  });

  const server = serve({ fetch: core.app.fetch, port: config.port, hostname: config.sandboxHost }, (info) => {
    const engine = sandbox.engine();
    console.log(`Auren sandbox on http://${config.sandboxHost}:${info.port}/try`);
    console.log(`  engine: ${engine.mode === "live" ? `live (${displayModel(config.agentModel)}), ${config.sandboxTokenBudget.toLocaleString("en-US")} tokens, then replay` : `replay (${engine.reason === "no_key" ? "no MODEL_API_KEY" : engine.reason})`}`);
    console.log(`  limits: ${config.sandboxRpm} commands a minute and ${config.sandboxDaily} a day per address · ${config.sandboxMaxVisitors} visitors · 30 min idle expiry`);
    console.log(`  proxy: ${config.trustProxy ? `X-Forwarded-For trusted through ${config.trustProxy} hop${config.trustProxy === 1 ? "" : "s"}` : "X-Forwarded-For ignored (set AUREN_TRUST_PROXY behind a tunnel)"}`);
    const ignored = [
      config.slackBotToken && "SLACK_BOT_TOKEN",
      (config.googleClientId || config.googleClientSecret) && "GOOGLE_CLIENT_*",
      config.basetenApiKey && "BASETEN_API_KEY",
      config.token && "AUREN_TOKEN",
      config.secret && "AUREN_SECRET",
    ].filter(Boolean);
    console.log(`  never used here: auren.db, the master key, connectors, devices, the camera, the driver${ignored.length ? ` (ignoring ${ignored.join(", ")})` : ""}`);
  });
  server.on("upgrade", core.upgrade);

  await new Promise<void>((resolve) => {
    const stop = () => {
      sandbox.close();
      server.close(() => resolve());
      setTimeout(resolve, 2000).unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
