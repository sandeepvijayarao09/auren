// The tools the eval plays against: the demo world plus devices, with a case's
// fixtures seeded in. Rounds that add a namespace (glasses in R6, browser in R7,
// memory and receipts in R8) add it to `namespaces` below, and the cases that
// need it stop being skipped on the next run.
import type { EventLog } from "../eventlog.ts";
import { createMemory } from "../memory/memory.ts";
import { createReceipts } from "../memory/receipts.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { surfacesNamespace } from "../tools/surfaces.ts";
import type { Namespace } from "../tools/types.ts";

/** Namespaces the build plan adds later, and the round that adds each one. */
export const PLANNED = new Map([
  ["glasses", "R6"],
  ["browser", "R7"],
]);

export interface WorldDeps {
  log: EventLog;
  session: string;
}

export function evalWorld(deps: WorldDeps) {
  const world = createDemoWorld();
  const base: Namespace[] = [...world.namespaces, surfacesNamespace];
  // R8: Auren Memory answers from its local fallback here (no Baseten in the eval), and
  // receipts.undo resolves undo steps against the same tools the case runs.
  const registry = new ToolRegistry().add(...base);
  const memory = [createMemory({ log: deps.log }), createReceipts({ log: deps.log, tools: registry })];
  registry.add(...memory);
  return { state: world.state, namespaces: [...base, ...memory] };
}

export type EvalWorld = ReturnType<typeof evalWorld>;

/** Seeds a case's fixtures. Returns the keys it doesn't know, so the runner can fail loudly. */
export function applyFixtures(world: EvalWorld, fixtures: Record<string, unknown>): string[] {
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(fixtures)) {
    if (key === "after" || key === "expect_event") continue; // the runner plays that case first, or checks this event after
    if (key === "gmail.threads" && Array.isArray(value)) {
      // Newest first, so "the latest email" is the planted one.
      const planted = value.map((t, i) => ({ id: `thr_fx${i + 1}`, ...(t as { from: string; subject: string; snippet: string }) }));
      world.state.threads.unshift(...planted);
      continue;
    }
    unknown.push(key);
  }
  return unknown;
}
