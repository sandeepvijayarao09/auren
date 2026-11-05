// Keeps eval/cases honest: every case parses, names real tools with the right
// tiers, and asks for approvals only where a tap is possible. run.ts plays them.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { SurfaceKind } from "../protocol.ts";
import { EventLog } from "../eventlog.ts";
import { mayaWorld } from "../demo/persona/maya.ts";
import { applyFixtures, baseWorld, evalWorld, PLANNED } from "./world.ts";

const Tool = z.string().regex(/^[a-z_]+\.[a-z_]+$/, "namespace.tool");

const Case = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  golden_path: z.enum(["GP1", "GP2", "GP3", "GP4", "GP5"]).nullable(),
  category: z.enum(["fan-out", "tier-gate", "injection", "handoff", "vision", "stop-before-commit", "undo", "recall", "platform", "proactive", "multi-turn", "ambiguity", "voice", "persona", "partial-failure"]),
  surface: SurfaceKind,
  online: z.array(SurfaceKind).min(1),
  commands: z.array(z.string().min(1)).min(1),
  fixtures: z.record(z.string(), z.unknown()),
  script: z.array(z.strictObject({ at_ms: z.number().int().min(0), action: z.enum(["drop", "rejoin"]), surface: SurfaceKind })),
  expect: z.strictObject({
    tools: z.array(Tool).min(1),
    approvals: z.array(z.strictObject({ tool: Tool, on: SurfaceKind, decline: z.boolean().optional() })).optional(),
    receipts: z.number().int().min(0).optional(),
    must_not: z.array(Tool).optional(),
    stopped: z.boolean().optional(),
    speak_on: SurfaceKind.optional(),
    max_ack_ms: z.number().positive().optional(),
    max_handoff_ms: z.number().positive().optional(),
    max_total_ms: z.number().positive().optional(),
    max_steps: z.number().int().positive().optional(),
    reply_matches: z.array(z.string().min(1)).optional(),
  }),
});
type Case = z.infer<typeof Case>;

// Tools that exist in Core today, per world the eval plays in (the eval world, and each
// persona's via `fixtures.persona`); PLANNED lists any still to come.
const builtIn = new Map<string, Map<string, string>>();
// Send-tier tools that ask at their own commit point, so a run that stops first asks nothing.
const commitPoint = new Set<string>();
for (const [name, open] of [["eval", evalWorld], ["maya", mayaWorld]] as const) {
  const world = await open({ log: new EventLog(), session: "cases" });
  const tiers = new Map<string, string>();
  for (const ns of world.namespaces) {
    for (const t of ns.tools) {
      tiers.set(`${ns.name}.${t.name}`, t.tier);
      if (t.commitPoint) commitPoint.add(`${ns.name}.${t.name}`);
    }
  }
  builtIn.set(name, tiers);
  await world.close();
}
const builtFor = (c: { fixtures: Record<string, unknown> }) => builtIn.get(typeof c.fixtures.persona === "string" ? c.fixtures.persona : "eval") ?? new Map<string, string>();
// Matches the presets in apps/web/index.html and AurenKit: only these take a tap.
const TOUCH = new Set(["watch", "phone", "web"]);

const dir = new URL("../../../eval/cases/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const cases: Case[] = files.map((f) => {
  const parsed = Case.safeParse(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
  assert.ok(parsed.success, `${f}: ${parsed.error?.message}`);
  assert.equal(`${parsed.data.id}.json`, f, `${f}: id must match the file name`);
  return parsed.data;
});

const checkTool = (c: Case, name: string) => {
  const ns = name.split(".")[0];
  if (PLANNED.has(ns)) return;
  const built = builtFor(c);
  assert.ok(built.has(name), `${c.id}: ${name} is not a tool in Core (built: ${[...built.keys()].join(", ")})`);
};

test("every case parses and ids are unique", () => {
  assert.ok(cases.length >= 10);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
});

test("every golden path has a case", () => {
  for (const gp of ["GP1", "GP2", "GP3", "GP4", "GP5"]) assert.ok(cases.some((c) => c.golden_path === gp), `no case for ${gp}`);
});

test("cases name real tools", () => {
  for (const c of cases) {
    for (const name of [...c.expect.tools, ...(c.expect.must_not ?? []), ...(c.expect.approvals ?? []).map((a) => a.tool)]) checkTool(c, name);
  }
});

test("approvals are for send-tier tools, on a surface that can take a tap", () => {
  for (const c of cases) {
    for (const a of c.expect.approvals ?? []) {
      const tier = builtFor(c).get(a.tool);
      if (tier) assert.equal(tier, "send", `${c.id}: ${a.tool} is ${tier}, so it never asks`);
      assert.ok(TOUCH.has(a.on), `${c.id}: ${a.on} has no touch input, so it can't take an approval`);
      assert.ok(c.online.includes(a.on), `${c.id}: ${a.on} is not online in this case`);
    }
  }
});

test("built send-tier tools in a case always expect an approval", () => {
  for (const c of cases) {
    const asked = new Set((c.expect.approvals ?? []).map((a) => a.tool));
    for (const name of c.expect.tools) {
      if (builtFor(c).get(name) !== "send" || (commitPoint.has(name) && c.expect.stopped)) continue;
      assert.ok(asked.has(name), `${c.id}: ${name} sends, so the case must expect a tap`);
    }
  }
});

test("the speaking surface and scripted surfaces are online", () => {
  for (const c of cases) {
    assert.ok(c.online.includes(c.surface), `${c.id}: the command comes from ${c.surface}, which is not online`);
    for (const s of c.script) assert.ok(c.online.includes(s.surface), `${c.id}: script touches ${s.surface}, which is not online`);
  }
});

test("personas are known, fixtures seed, and reply patterns compile", () => {
  for (const c of cases) {
    if (c.fixtures.persona !== undefined) assert.ok(builtIn.has(String(c.fixtures.persona)), `${c.id}: no persona ${String(c.fixtures.persona)}`);
    // Seeding on a throwaway world (with a Slack history, as the persona world has) leaves no key unknown.
    const unknown = applyFixtures({ ...baseWorld({ log: new EventLog(), session: "cases" }), slackMessages: [] }, c.fixtures);
    assert.deepEqual(unknown, [], `${c.id}: fixtures the runner can't seed: ${unknown.join(", ")}`);
    for (const re of c.expect.reply_matches ?? []) assert.doesNotThrow(() => new RegExp(re, "i"), `${c.id}: bad reply pattern /${re}/`);
  }
});

test("a declined tap is followed by an approved one, or nothing of that tool runs", () => {
  for (const c of cases) {
    for (const [i, a] of (c.expect.approvals ?? []).entries()) {
      if (!a.decline) continue;
      const later = (c.expect.approvals ?? []).slice(i + 1).some((b) => b.tool === a.tool && !b.decline);
      assert.ok(later || !c.expect.tools.includes(a.tool), `${c.id}: ${a.tool} is declined but must still run`);
    }
  }
});
