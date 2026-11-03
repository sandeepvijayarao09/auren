// The Auren driver: a headed Chromium on this Mac that Core drives over /v1/driver.
//
//   AUREN_DRIVER_ALLOW=opentable.com npm start
//
// Core can run anywhere: the driver dials out to it, from this Mac or with AUREN_TOKEN.
import { chromium } from "playwright";
import { connectToCore } from "./client.ts";
import { Executor } from "./executor.ts";

const allow = (process.env.AUREN_DRIVER_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const core = process.env.AUREN_CORE_URL || `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const token = process.env.AUREN_TOKEN ?? "";
const headless = process.env.AUREN_DRIVER_HEADLESS === "true";
const viewport = { width: 1280, height: 800 };

if (!allow.length) {
  console.error("Set AUREN_DRIVER_ALLOW in .env to the sites the browser may open, comma-separated (for example opentable.com,resy.com).");
  process.exit(1);
}

// Every launch is a fresh profile and every task a fresh context: no saved passwords, cards or cookies.
const browser = await chromium.launch({ headless, args: ["--use-mock-keychain", "--password-store=basic", "--disable-features=AutofillServerCommunication"] });
const executor = new Executor(browser, { allow, viewport });
const client = connectToCore({
  core,
  token,
  executor,
  hello: { name: process.env.AUREN_DRIVER_NAME || "mac", viewport, allow },
  log: (line) => console.log(`driver: ${line}`),
});
console.log(`Auren driver: ${headless ? "headless" : "headed"} Chromium · allowed sites: ${allow.join(", ")} · dialing ${core}/v1/driver`);

const quit = async () => {
  client.close();
  await browser.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
browser.on("disconnected", () => {
  console.log("driver: the browser closed.");
  client.close();
  process.exit(0);
});
