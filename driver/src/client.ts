// Dials Core's /v1/driver, says hello, and runs each command Core sends, one at a
// time, answering with a result that carries the same seq. Reconnects if Core
// restarts. See core/src/computer/hub.ts for Core's side.
import { WebSocket } from "ws";
import type { Executor } from "./executor.ts";
import { Command, type StepResult } from "./protocol.ts";

export interface ClientOptions {
  /** Core's address, such as http://127.0.0.1:8787. */
  core: string;
  /** AUREN_TOKEN, when Core is on another machine. */
  token?: string;
  executor: Pick<Executor, "start" | "run" | "commit" | "end">;
  hello: { name: string; viewport: { width: number; height: number }; allow: string[] };
  log?: (line: string) => void;
  reconnectMs?: number;
}

export function connectToCore(opts: ClientOptions): { close(): void } {
  const log = opts.log ?? (() => {});
  const base = opts.reconnectMs ?? 2000;
  let delay = base;
  let ws: WebSocket | null = null;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  const run = (cmd: Exclude<Command, { type: "welcome" }>): Promise<StepResult> => {
    switch (cmd.type) {
      case "start":
        return opts.executor.start(cmd.url);
      case "actions":
        return opts.executor.run(cmd.actions);
      case "commit":
        return opts.executor.commit();
      case "end":
        return opts.executor.end();
    }
  };

  const dial = () => {
    const url = new URL("/v1/driver", opts.core);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {} });
    ws = socket;
    const reply = (seq: number, result: StepResult) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "result", seq, ...result }));

    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", driver: opts.hello })));
    socket.on("message", (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      const parsed = Command.safeParse(data);
      if (!parsed.success) {
        const seq = (data as { seq?: unknown })?.seq;
        if (typeof seq === "number") queue = queue.then(() => void reply(seq, { status: "error", url: "", title: "", error: "The driver couldn't read that command." }));
        return;
      }
      const cmd = parsed.data;
      if (cmd.type === "welcome") {
        delay = base;
        return log(`connected to Core at ${opts.core}`);
      }
      queue = queue.then(async () => {
        const result = await run(cmd).catch((err): StepResult => ({ status: "error", url: "", title: "", error: err instanceof Error ? err.message.split("\n")[0] : String(err) }));
        reply(cmd.seq, result);
      });
    });
    socket.on("error", (err) => log(`connection: ${err.message}`));
    socket.on("close", (code, reason) => {
      if (closed) return;
      if (code === 4000) {
        closed = true;
        return log(`Core took a newer driver instead (${String(reason)}). Stopping.`);
      }
      log(`not connected to Core; retrying in ${Math.round(delay / 1000)} s`);
      setTimeout(() => !closed && dial(), delay);
      delay = Math.min(delay * 2, 30_000);
    });
  };

  dial();
  return {
    close() {
      closed = true;
      ws?.close(1000);
    },
  };
}
