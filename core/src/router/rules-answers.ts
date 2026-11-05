// Core's rules router over a JSONL of router examples, for the Python evaluator's
// `--answers` baseline: node src/router/rules-answers.ts < ../router/data/test.jsonl > rules.jsonl
// Each output line is {"prompt": <the rendered user turn>, "answer": <the rules route as JSON>}.
import { createInterface } from "node:readline";
import { renderUser, RouteContext } from "./prompt.ts";
import { APPS, rulesRoute } from "./router.ts";

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const ex = JSON.parse(line) as { text: string; context: unknown };
  const ctx = RouteContext.parse(ex.context);
  const route = rulesRoute(ex.text, ctx, [...APPS]);
  process.stdout.write(JSON.stringify({ prompt: renderUser(ex.text, ctx), answer: JSON.stringify(route) }) + "\n");
}
