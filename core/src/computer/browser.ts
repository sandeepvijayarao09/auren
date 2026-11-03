// The `browser` namespace: one tool, run_task, for websites with no API. It exists
// only while the driver on the Mac is connected, like a device.
//
// run_task is send tier, but its tap comes at the commit point: it browses on its
// own, and when the driver's commit guard pauses before a confirm-like click, it
// asks through ctx.approveCommit. Core writes a receipt only if that tap approved.
import { z } from "zod";
import type { MuseLike } from "../agent/loop.ts";
import type { EventLog } from "../eventlog.ts";
import type { OpsLog } from "../obs/opslog.ts";
import type { Ledger } from "../security/ledger.ts";
import { params, type Namespace } from "../tools/types.ts";
import type { DriverHub } from "./hub.ts";
import { runTask, type TaskResult } from "./runner.ts";

export interface BrowserDeps {
  /** Core's DriverHub; the eval's demo site stands in with the same three calls. */
  hub: Pick<DriverHub, "connected" | "info" | "claim">;
  muse: MuseLike;
  /** The computer-use model (Muse Wonder). */
  model: string;
  log: EventLog;
  ops?: OpsLog;
  ledger?: Ledger;
  approvalTimeoutMs?: number;
  maxSteps?: number;
  maxMs?: number;
}

const RunTaskArgs = z.object({
  task: z.string().trim().min(1).max(2000),
  url: z.url({ protocol: /^https?$/ }).max(2048),
  summary: z.string().trim().min(1).max(120),
});
type RunTaskArgs = z.infer<typeof RunTaskArgs>;

export function createBrowser(deps: BrowserDeps): Namespace {
  return {
    name: "browser",
    app: "Browser",
    description: () => {
      const allow = deps.hub.info()?.allow ?? [];
      return `A real browser on the user's Mac, for websites with no API. Sites it may open: ${allow.join(", ") || "none"}.`;
    },
    available: () => deps.hub.connected(),
    tools: [
      {
        name: "run_task",
        description:
          "Do a task on a website in the browser on the user's Mac, such as finding and holding a table. It browses on its own; when the next click would commit (book, reserve, pay, confirm), Auren asks the user to tap Approve first. Returns what happened.",
        parameters: params({
          task: { type: "string", description: "The whole goal with every detail: party size, date, time, place, and whether to hold or book." },
          url: { type: "string", description: "The page to start on, on an allowed site." },
          summary: { type: "string", description: 'What committing does, under 10 words, shown on the approval. Example: "Hold a table for 2 at 8:00 PM".' },
        }),
        tier: "send",
        verb: "Confirm",
        commitPoint: true,
        external: true,
        async run(raw: RunTaskArgs, ctx): Promise<TaskResult> {
          const args = RunTaskArgs.parse(raw);
          const result = await runTask(
            {
              muse: deps.muse,
              model: deps.model,
              driver: deps.hub.claim(),
              log: deps.log,
              session: ctx.session,
              trace: ctx.trace,
              ops: deps.ops,
              ledger: deps.ledger,
              approveCommit: ctx.approveCommit,
              approveCheck: (summary) => ctx.surfaces.requestApproval(summary, "send", deps.approvalTimeoutMs),
              maxSteps: deps.maxSteps,
              maxMs: deps.maxMs,
            },
            { goal: args.task, url: args.url, summary: args.summary },
          );
          // A failed commit click must not leave a receipt, so a broken run is an error, not a result.
          if (result.status === "error") throw new Error(result.reason ?? "The browser task failed.");
          return result;
        },
        summarize: (args: RunTaskArgs, result?: TaskResult) => (result?.committed ? `Confirmed on the web: ${args.summary}` : `Browser: ${args.summary}`),
        proof: (_args: RunTaskArgs, result: TaskResult) => (/^https:\/\//.test(result?.url ?? "") ? result.url : undefined),
      },
    ],
  };
}
