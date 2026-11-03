const token = process.env.AUREN_TOKEN ?? "";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  // Without a token, Core only listens on this machine. Set AUREN_TOKEN to let
  // your phone and watch reach it over the network.
  host: process.env.HOST ?? (token ? "0.0.0.0" : "127.0.0.1"),
  token,
  museBaseUrl: process.env.MUSE_BASE_URL ?? "https://api.meta.ai/v1",
  museApiKey: process.env.MODEL_API_KEY ?? "",
  agentModel: process.env.AUREN_AGENT_MODEL ?? "muse-wonder-1.0",
  fastModel: process.env.AUREN_FAST_MODEL ?? "muse-spark-1.3",
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
  // R9: Auren Router. The Glimmer LoRA on Modal (OpenAI-compatible, …/v1). Without it, Muse Spark
  // routes when a key is set, else the rules. Advisory only; tiers stay with the tools.
  routerUrl: process.env.AUREN_ROUTER_URL ?? "",
  routerKey: process.env.AUREN_ROUTER_KEY ?? "",
  routerModel: process.env.AUREN_ROUTER_MODEL || "auren-router",
  routerBudgetMs: Number(process.env.AUREN_ROUTER_BUDGET_MS) || 300,
  presenceTimeoutMs: 3000,
  approvalTimeoutMs: 60_000,
  maxTurns: 8,
};

export type Config = typeof config;
