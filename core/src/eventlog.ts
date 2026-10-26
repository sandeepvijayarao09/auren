import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { EventKind, AurenEvent } from "./protocol.ts";

/** Append-only session timeline. Every surface renders from this. */
export class EventLog {
  #db: DatabaseSync;
  #emitter = new EventEmitter();

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session TEXT NOT NULL,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL
    )`);
  }

  append(session: string, kind: EventKind, data: Record<string, unknown>): AurenEvent {
    const at = Date.now();
    const row = this.#db
      .prepare("INSERT INTO events (session, at, kind, data) VALUES (?, ?, ?, ?)")
      .run(session, at, kind, JSON.stringify(data));
    const event: AurenEvent = { id: Number(row.lastInsertRowid), session, at, kind, data };
    this.#emitter.emit("event", event);
    return event;
  }

  since(session: string, afterId = 0, limit = 500): AurenEvent[] {
    const rows = this.#db
      .prepare("SELECT id, session, at, kind, data FROM events WHERE session = ? AND id > ? ORDER BY id LIMIT ?")
      .all(session, afterId, limit) as Array<{ id: number; session: string; at: number; kind: EventKind; data: string }>;
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  get(id: number): AurenEvent | undefined {
    const r = this.#db.prepare("SELECT id, session, at, kind, data FROM events WHERE id = ?").get(id) as
      | { id: number; session: string; at: number; kind: EventKind; data: string }
      | undefined;
    return r && { ...r, data: JSON.parse(r.data) };
  }

  onEvent(fn: (event: AurenEvent) => void): () => void {
    this.#emitter.on("event", fn);
    return () => this.#emitter.off("event", fn);
  }
}
