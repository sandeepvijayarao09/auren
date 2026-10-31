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
  // The user's time zone, for dates in the prompt and on the calendar.
  timeZone: process.env.AUREN_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  // A Google "Desktop app" OAuth client. Setting both swaps the demo calendar for the real one.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  presenceTimeoutMs: 3000,
  approvalTimeoutMs: 60_000,
  maxTurns: 8,
};

export type Config = typeof config;
