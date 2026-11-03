# Connect an MCP server

Auren with MCP: connect an MCP server you already use, and its tools become one namespace in Muse's tools, as long as it's connected. Say *"Add today's receipts to my journal"* and Auren reads your receipts, then asks for a tap before the journal write.

Setup takes about 2 minutes. The demo **Journal** server (fictional, in this repo) is the quickest way to see it work.

## 1. Try the demo Journal
```bash
cp mcp.example.json mcp.json     # at the repo root; mcp.json is gitignored
make dev
```
Core prints `mcp: journal (stdio, read-only hints trusted); connecting in the background`, then an `mcp.connect` line in the ops log with `tools: 2, read: 1, send: 1`. Check it with `curl http://127.0.0.1:8787/v1/connections`.

Open the console with a watch tab (`/?kind=watch`) and say *"Add today's receipts to my journal."* The watch asks:

> Run add_entry in Journal (MCP) · text "Moved office hours to 3:15, told #office-hours I was runnin…" · date "2026-11-03"

Tap Approve. The receipt reads `Ran add_entry in Journal (MCP) · …`, and the entry is in `journal.json` at the repo root (also gitignored).

You can also run the Journal on its own: `node core/src/connectors/mcp-journal.ts [--file journal.json]`. It speaks MCP over stdio and has two tools:

| Tool | Annotations | In Auren |
|---|---|---|
| `list_entries(date?, limit?)` | `readOnlyHint: true` | read (runs on its own), because the example trusts this server |
| `add_entry(text, date?, tags?)` | `readOnlyHint: false` | send (asks for a tap) |

## 2. Add your own server
`mcp.json` uses the same shape as other MCP clients, plus one Auren flag:
```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "some-notes-mcp-server"],
      "env": { "NOTES_TOKEN": "…" }
    },
    "tracker": {
      "url": "https://tracker.example.com/mcp",
      "headers": { "Authorization": "Bearer …" },
      "trust_annotations": true
    }
  }
}
```

| Field | Meaning |
|---|---|
| name (the key) | Becomes the namespace: lowercase letters, digits and `_` (`"My Notes"` → `my_notes`). Auren's own app names (`slack`, `calendar`, `gmail`, `browser`, `memory`, `receipts`, `surfaces`, `glasses`) are refused. |
| `command`, `args`, `env`, `cwd` | A **stdio** server. It runs in the folder that holds `mcp.json` unless you set `cwd` (relative to that folder). It gets PATH, HOME, USER, SHELL, TERM and LOGNAME plus its own `env`, never Core's keys. |
| `url`, `headers` | A **Streamable HTTP** server. Use `https://`; plain `http://` only works for a server on this Mac. Redirects are refused, so your headers never follow one to another host. SSE-only servers aren't supported. |
| `trust_annotations` | Off by default. **Off:** every tool asks for a tap. **On:** tools the server marks `readOnlyHint: true` run on their own; the rest still ask. No MCP tool is ever "write", because Auren can't undo a call on someone else's server. |
| `disabled` | `true` skips the server. |

Put secrets in `env` or `headers`, not in `args`: Auren scrubs env and header values from everything it logs, but it doesn't know which arguments are secret.

`AUREN_MCP_CONFIG` points Core at another file. A relative path is resolved from where Core runs (`core/` with `make dev`).

## How it behaves
- **Startup never waits.** Each server connects in the background with a 10 s timeout, then retries with backoff (1 s, 2 s, 4 s … up to 1 minute). A server that drops is retried the same way.
- **Its namespace is there only while it's connected.** A server that drops is gone from Muse's tools on the next turn, and its tools refuse to run until it's back.
- **Tools can change.** When a server sends `notifications/tools/list_changed`, Auren lists its tools again. A change that arrives during a call is in place before the result goes back, so the very next turn sees it.
- **Calls time out after 30 s.** A timed-out call is reported as failed and never retried; on the server it may still have run.
- **Results** keep text and structured content, describe images and files instead of passing them on, and are capped at 16,000 characters. A result the server marks `isError` comes back to Muse as an error, with no receipt.
- More than 8 tools on a server load through `tool_search` instead of all at once. At most 64 tools per server are kept.

## Check it
- `GET /v1/connections` → `mcp`: each server's name, namespace, transport, state, tool counts by tier, and trust mode, plus the last error while it's disconnected. Never commands, URLs, env or headers.
- `GET /v1/outbound`: one row per MCP request, such as `Journal (MCP) · tools/call add_entry · stdio`, with bytes sent and time. Never arguments or results.
- The ops log: `mcp.connect`, `mcp.retry` (with the last line of a failed server's stderr, scrubbed), `mcp.disconnect` and `mcp.tools_changed`.

Why the defaults are what they are: [SECURITY.md](../SECURITY.md#mcp-servers).
