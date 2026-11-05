// Tasks: a fictional to-do MCP server for persona demos, shaped like mcp-journal.ts.
// - list_tasks, marked read-only (readOnlyHint: true);
// - add_task and complete_task, not marked read-only, so Auren asks for a tap.
// Tasks live in memory; the persona world hands in its own list.
//
//   node core/src/connectors/mcp-tasks.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Task { id: string; title: string; due?: string; list: string; done: boolean }

export function createTasks(opts: { tasks?: Task[] } = {}) {
  const tasks = opts.tasks ?? [];
  const server = new McpServer({ name: "tasks", version: "0.1.0" });
  const reply = (data: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data });

  server.registerTool(
    "list_tasks",
    {
      description: "List to-do tasks. Open ones only unless include_done is true.",
      inputSchema: {
        list: z.string().optional().describe("Only this list, e.g. Work or Home."),
        include_done: z.boolean().optional(),
      },
      annotations: { title: "List tasks", readOnlyHint: true, openWorldHint: false },
    },
    async ({ list, include_done }) => reply({ tasks: tasks.filter((t) => (include_done || !t.done) && (!list || t.list.toLowerCase() === list.toLowerCase())) }),
  );

  server.registerTool(
    "add_task",
    {
      description: "Add a task to the to-do list.",
      inputSchema: {
        title: z.string().min(1).max(300),
        due: z.string().regex(DATE).optional().describe("Due date (YYYY-MM-DD)."),
        list: z.string().max(40).optional().describe("Which list (default Inbox)."),
      },
      annotations: { title: "Add a task", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, due, list }) => {
      const task: Task = { id: `task_${tasks.length + 1}`, title, due, list: list ?? "Inbox", done: false };
      tasks.push(task);
      return reply({ task });
    },
  );

  server.registerTool(
    "complete_task",
    {
      description: "Mark a task done.",
      inputSchema: { id: z.string() },
      annotations: { title: "Complete a task", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) return { isError: true, content: [{ type: "text" as const, text: `no task ${id}` }] };
      t.done = true;
      return reply({ task: t });
    },
  );

  return { server, tasks };
}

/** Tasks over an in-memory transport: a fresh server on the same list per connection. */
export function tasksInMemory(opts: { tasks?: Task[] } = {}) {
  const tasks = opts.tasks ?? [];
  return {
    tasks,
    connect(): Transport {
      const [client, server] = InMemoryTransport.createLinkedPair();
      void createTasks({ tasks }).server.connect(server);
      return client;
    },
  };
}

if (import.meta.main) {
  await createTasks().server.connect(new StdioServerTransport());
}
