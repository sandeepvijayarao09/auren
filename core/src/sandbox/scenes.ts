// The worlds a sandbox visitor can play in. Each is a scene: its own demo world,
// its own session in the visitor's in-memory log (so receipts, recaps and Undo
// stay inside it), and its own Auren Preferences, learned in memory from that
// session alone.
//   demo  the eval world: a TA's calendar, Slack and Gmail (the golden paths)
//   maya  Maya Okafor's week (demo/persona/maya.ts): her morning briefing,
//         "Plan tomorrow" and her usual status channel
// No MCP here either: Maya's task list is a plain read-only namespace over the
// same fictional tasks her MCP server serves elsewhere, so the planner can read it.
import type { EventLog } from "../eventlog.ts";
import { applyMaya, taskList } from "../demo/persona/maya.ts";
import { baseWorld, type BaseWorld } from "../eval/world.ts";
import { Preferences } from "../memory/preferences.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { params, type Namespace } from "../tools/types.ts";

export type SceneId = "demo" | "maya";

export const SCENES: Record<SceneId, { session: string; who: string }> = {
  demo: { session: "sandbox", who: "A TA's day: office hours, Prof. Lee, a demo night" },
  maya: { session: "sandbox-maya", who: "Maya Okafor's day: a product designer flying to New York tonight" },
};

export interface Scene {
  id: SceneId;
  session: string;
  world: BaseWorld;
  tools: ToolRegistry;
  /** What Auren has learned from this scene's own receipts. In memory, under a random key, gone with the visitor. */
  prefs: Preferences;
}

/** Maya's open tasks, read-only: what planner.plan_tomorrow reads. Adding a task isn't possible here. */
function mayaTasks(): Namespace {
  const tasks = taskList();
  return {
    name: "tasks",
    app: "Tasks",
    description: "Maya's to-do list (read-only in the sandbox).",
    tools: [
      {
        name: "list_tasks",
        description: "List open to-do tasks, with their list and due date.",
        parameters: params({ list: { type: "string", description: "Only this list, e.g. Work or Home." } }, ["list"]),
        tier: "read",
        external: true,
        async run(a: { list?: string }) {
          return { tasks: tasks.filter((t) => !t.done && (!a?.list || t.list.toLowerCase() === a.list.toLowerCase())).map((t) => ({ ...t })) };
        },
      },
    ],
  };
}

/**
 * Maya's yesterday, as a few events at the start of her session: one approved post to #design-team.
 * Every one is marked `history`, and the page shows them as seeded history, not as something the
 * visitor did. They're what her preferences learn "status posts go to #design-team" from, the way
 * the live run in docs/personalization.md learned it from her day. The receipt has no Undo: it was a send.
 */
export function seedMayaHistory(log: EventLog, session: string): void {
  const history = "Seeded: Maya's yesterday, so Auren has a receipt to learn from";
  const text = "Leaving the office at 3, back online at 4.";
  const summary = `Post to #design-team: "${text}"`;
  log.append(session, "utterance", { text: "Tell design-team I'm leaving the office at 3.", surface_id: "watch", history });
  log.append(session, "tool_call", { app: "Slack", namespace: "slack", tool: "post_message", tier: "send", args: { channel_id: "CM1", text }, history });
  log.append(session, "approval", { request_id: "history-1", status: "requested", summary, surface_id: "watch", history });
  log.append(session, "approval", { request_id: "history-1", status: "approved", surface_id: "watch", history });
  log.append(session, "receipt", { app: "Slack", namespace: "slack", tool: "post_message", tier: "send", summary, undo: null, link: null, history });
  log.append(session, "reply", { text: "Posted to design-team.", spoken_on: "watch", history });
}

export function buildScene(id: SceneId, log: EventLog): Scene {
  const session = SCENES[id].session;
  const base = baseWorld({ log, session });
  let world: BaseWorld = base;
  if (id === "maya") {
    applyMaya(base.state, base.namespaces);
    const tasks = mayaTasks();
    base.registry.add(tasks);
    world = { ...base, namespaces: [...base.namespaces, tasks] };
    seedMayaHistory(log, session);
  }
  // No MCP: the scene's tools are its world's and nothing else (R11's bridge stays out).
  const tools = new ToolRegistry().add(...world.namespaces);
  return { id, session, world, tools, prefs: new Preferences({ path: ":memory:", log, session }) };
}
