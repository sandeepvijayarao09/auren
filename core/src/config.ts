const token = process.env.AUREN_TOKEN ?? "";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  // Without a token, Core only listens on this machine. Set AUREN_TOKEN to let
  // your phone and watch reach it over the network.
  host: process.env.HOST ?? (token ? "0.0.0.0" : "127.0.0.1"),
  token,
  // PEM paths. With both set, Core serves HTTPS and WSS on the same port (`make cert` makes a local CA and cert).
  tlsCert: process.env.AUREN_TLS_CERT ?? "",
  tlsKey: process.env.AUREN_TLS_KEY ?? "",
  museBaseUrl: process.env.MUSE_BASE_URL ?? "https://api.meta.ai/v1",
  museApiKey: process.env.MODEL_API_KEY ?? "",
  agentModel: process.env.AUREN_AGENT_MODEL ?? "muse-wonder-1.0",
  fastModel: process.env.AUREN_FAST_MODEL ?? "muse-spark-1.3",
  // Live check (CU-live): Muse Wonder 1.0 answers 400 "Unsupported tool type: 'computer'"; Spark 1.3 takes it.
  computerModel: process.env.AUREN_COMPUTER_MODEL ?? "muse-spark-1.3",
  dbPath: process.env.AUREN_DB ?? "auren.db",
  // Encrypts connector tokens. Without it, Core generates a key next to the database.
  secret: process.env.AUREN_SECRET ?? "",
  // Also append the operational log (JSON lines) to this file. stdout always gets it.
  logFile: process.env.AUREN_LOG_FILE ?? "",
  // The user's time zone, for dates in the prompt and on the calendar.
  timeZone: process.env.AUREN_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  // A Google "Desktop app" OAuth client. Setting both swaps the demo calendar for the real one.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  // The Slack bot token (xoxb-…) for the demo workspace. Setting it swaps the demo Slack for the real one.
  slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",
  // Extra words for speech recognition to favour (names, channels), comma-separated.
  asrKeywords: (process.env.AUREN_ASR_KEYWORDS ?? "").split(",").map((w) => w.trim()).filter(Boolean),
  // Set to "false" if your Meta account doesn't allow metadata-only logging for voice.
  asrMetadataOnly: process.env.AUREN_ASR_METADATA_ONLY !== "false",
  // Auren Memory on Muse Spark Open, hosted on Baseten. Without the key, recaps are built locally from the receipts.
  basetenApiKey: process.env.BASETEN_API_KEY ?? "",
  basetenBaseUrl: process.env.BASETEN_BASE_URL ?? "https://inference.baseten.co/v1",
  memoryModel: process.env.AUREN_MEMORY_MODEL ?? "meta-models/muse-spark-open-1026",
  // R11: MCP bridge. The MCP servers to connect. Empty means mcp.json at the repo root (gitignored; see mcp.example.json).
  mcpConfig: process.env.AUREN_MCP_CONFIG ?? "",
  // R9: Auren Router. The Glimmer LoRA on Modal (OpenAI-compatible, …/v1). Without it, Muse Spark
  // routes when a key is set, else the rules. Advisory only; tiers stay with the tools.
  routerUrl: process.env.AUREN_ROUTER_URL ?? "",
  routerKey: process.env.AUREN_ROUTER_KEY ?? "",
  routerModel: process.env.AUREN_ROUTER_MODEL || "auren-router",
  routerBudgetMs: Number(process.env.AUREN_ROUTER_BUDGET_MS) || 300,
  presenceTimeoutMs: 3000,
  approvalTimeoutMs: 60_000,
  maxTurns: 8,
  // R13: spend limits in model tokens (Muse prices aren't published). 0 turns either off.
  tokenAlarm: count(process.env.AUREN_TOKEN_ALARM, 0),
  tokenLimit: count(process.env.AUREN_TOKEN_LIMIT, 0),
  // R13: the public sandbox. Serves only /try on a fictional demo world, never live connectors or devices.
  sandbox: process.env.AUREN_SANDBOX === "true",
  // AUREN_TOKEN means nothing to the sandbox, so it binds to 127.0.0.1 unless HOST says otherwise (a tunnel or a Node host).
  sandboxHost: process.env.HOST ?? "127.0.0.1",
  sandboxTokenBudget: count(process.env.AUREN_SANDBOX_TOKEN_BUDGET, 200_000),
  sandboxRpm: count(process.env.AUREN_SANDBOX_RPM, 6),
  sandboxDaily: count(process.env.AUREN_SANDBOX_DAILY, 60),
  sandboxMaxVisitors: count(process.env.AUREN_SANDBOX_MAX_VISITORS, 50),
  // Trust X-Forwarded-For only when set: "true" (one proxy in front) or the number of proxies.
  trustProxy: proxyHops(process.env.AUREN_TRUST_PROXY),
};

// R13: whole numbers from the environment, with a default for anything unset or unreadable.
function count(raw: string | undefined, fallback: number): number {
  const v = Number(raw);
  return raw?.trim() && Number.isInteger(v) && v >= 0 ? v : fallback;
}

function proxyHops(raw: string | undefined): number {
  if (raw === "true") return 1;
  return count(raw, 0);
}

export type Config = typeof config;
