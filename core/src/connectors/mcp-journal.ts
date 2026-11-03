// Journal: a fictional MCP server for the demo, the eval and the tests. It stands in
// for "an MCP server you already use". Two tools:
// - list_entries, marked read-only (readOnlyHint: true);
// - add_entry, not marked read-only, so Auren asks for a tap before it runs.
// Entries live in memory, or in a JSON file with --file (the example config uses a
// gitignored journal.json at the repo root).
//
//   node core/src/connectors/mcp-journal.ts [--file journal.json]
import { readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const Entry = z.object({
  id: z.string(),
  date: z.string().regex(DATE),
  text: z.string(),
  tags: z.array(z.string()).default([]),
});
export type JournalEntry = z.infer<typeof Entry>;

export interface JournalOptions {
  /** Shared with the caller, so a test (or a reconnect) sees the same entries. */
  entries?: JournalEntry[];
  /** Keep the entries in this JSON file. */
  file?: string;
  now?: () => Date;
}

function load(file: string): JournalEntry[] {
  try {
    return z.array(Entry).parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`${file} isn't a journal file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createJournal(opts: JournalOptions = {}) {
  const entries = opts.entries ?? (opts.file ? load(opts.file) : []);
  const today = () => new Intl.DateTimeFormat("en-CA").format(opts.now?.() ?? new Date());
  const save = () => {
    if (opts.file) writeFileSync(opts.file, `${JSON.stringify(entries, null, 2)}\n`);
  };
  const server = new McpServer({ name: "journal", version: "0.1.0" });

  server.registerTool(
    "list_entries",
    {
      description: "List journal entries, newest first. Give a date (YYYY-MM-DD) for one day.",
      inputSchema: {
        date: z.string().regex(DATE).optional().describe("Only entries on this day (YYYY-MM-DD)."),
        limit: z.number().int().min(1).max(50).optional().describe("How many (default 10)."),
      },
      annotations: { title: "List journal entries", readOnlyHint: true, openWorldHint: false },
    },
    async ({ date, limit }) => {
      const found = entries.filter((e) => !date || e.date === date).slice(-(limit ?? 10)).reverse();
      return { content: [{ type: "text", text: JSON.stringify({ entries: found }) }], structuredContent: { entries: found } };
    },
  );

  server.registerTool(
    "add_entry",
    {
      description: "Add an entry to the journal. The date defaults to today.",
      inputSchema: {
        text: z.string().min(1).max(4000).describe("The entry, in the user's voice."),
        date: z.string().regex(DATE).optional().describe("The day it's for (YYYY-MM-DD)."),
        tags: z.array(z.string().max(40)).max(10).optional(),
      },
      annotations: { title: "Add a journal entry", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text, date, tags }) => {
      const entry: JournalEntry = { id: `ent_${entries.length + 1}`, date: date ?? today(), text, tags: tags ?? [] };
      entries.push(entry);
      save();
      return { content: [{ type: "text", text: `Added ${entry.id} for ${entry.date}.` }], structuredContent: { entry } };
    },
  );

  return { server, entries };
}

/**
 * The Journal over an in-memory transport, for the eval and the tests. Each
 * connection attempt gets a fresh server on the same entries, the way a stdio
 * server restarts on the same file.
 */
export function journalInMemory(opts: Omit<JournalOptions, "file"> = {}) {
  const entries = opts.entries ?? [];
  let current: McpServer | null = null;
  return {
    entries,
    /** The server behind the latest connection (tests register tools on it, or close it). */
    get server(): McpServer | null {
      return current;
    },
    connect(): Transport {
      const [client, server] = InMemoryTransport.createLinkedPair();
      current = createJournal({ ...opts, entries }).server;
      void current.connect(server);
      return client;
    },
  };
}

if (import.meta.main) {
  const at = process.argv.indexOf("--file");
  const file = at > 0 ? process.argv[at + 1] : undefined;
  const { server } = createJournal({ file });
  await server.connect(new StdioServerTransport());
}
