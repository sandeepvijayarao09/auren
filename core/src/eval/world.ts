// The tools the eval plays against: the demo world plus devices, with a case's
// fixtures seeded in. Rounds that add a namespace (glasses in R6, browser in R7,
// memory and receipts in R8) add it to `namespaces` below, and the cases that
// need it stop being skipped on the next run.
import type { EventLog } from "../eventlog.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { surfacesNamespace } from "../tools/surfaces.ts";
import type { Namespace } from "../tools/types.ts";

/** Namespaces the build plan adds later, and the round that adds each one. */
export const PLANNED = new Map([
  ["glasses", "R6"],
  ["browser", "R7"],
  ["memory", "R8"],
  ["receipts", "R8"],
]);

export interface WorldDeps {
  log: EventLog;
  session: string;
}

export function evalWorld(_deps: WorldDeps) {
  const world = createDemoWorld();
  const namespaces: Namespace[] = [...world.namespaces, surfacesNamespace];
  return { state: world.state, namespaces };
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
