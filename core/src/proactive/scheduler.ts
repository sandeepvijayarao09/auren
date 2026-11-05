// Auren's proactive day: jobs that fire once a day at a local time (AUREN_TZ).
// The last run of each job is kept in SQLite as plain metadata (job name and
// date, nothing else), so a restart never repeats a job and a Mac that slept
// through the time catches up when it wakes: the next tick sees the time has
// passed today and fires, as long as it's still inside the job's window.
import { DatabaseSync } from "node:sqlite";

export interface DailyJob {
  name: string;
  /** Minutes after local midnight. */
  at: number;
  /** The latest minute it may still fire on a late (catch-up) tick. Defaults to the end of the day. */
  until?: number;
  run: () => Promise<unknown> | unknown;
}

export interface SchedulerOptions {
  /** A database path (auren.db) or an open database. */
  db: string | DatabaseSync;
  timeZone: string;
  jobs: DailyJob[];
  now?: () => Date;
  /** How often to look. A tick after sleep is how a missed time is caught up. */
  tickMs?: number;
  onError?: (job: string, err: unknown) => void;
}

/** "07:30" as minutes after midnight; null for empty (off) or anything unreadable. */
export function parseAt(raw: string | undefined): number | null {
  const m = raw?.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The local date (YYYY-MM-DD) and minute of the day in `timeZone`. */
export function localClock(now: Date, timeZone: string): { day: string; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

export class DailyScheduler {
  #db: DatabaseSync;
  #opts: SchedulerOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = new Set<string>();

  constructor(opts: SchedulerOptions) {
    this.#opts = opts;
    this.#db = typeof opts.db === "string" ? new DatabaseSync(opts.db) : opts.db;
    this.#db.exec("CREATE TABLE IF NOT EXISTS proactive_runs (job TEXT PRIMARY KEY, day TEXT NOT NULL, at INTEGER NOT NULL)");
  }

  get jobs(): string[] {
    return this.#opts.jobs.map((j) => j.name);
  }

  lastRun(job: string): string | undefined {
    return (this.#db.prepare("SELECT day FROM proactive_runs WHERE job = ?").get(job) as { day: string } | undefined)?.day;
  }

  /** Fires every job that's due and hasn't run today. Returns the names it fired. */
  async tick(): Promise<string[]> {
    const now = this.#opts.now?.() ?? new Date();
    const { day, minute } = localClock(now, this.#opts.timeZone);
    const fired: string[] = [];
    for (const job of this.#opts.jobs) {
      if (this.#running.has(job.name) || this.lastRun(job.name) === day) continue;
      if (minute < job.at || minute > (job.until ?? 24 * 60 - 1)) continue;
      // Marked before it runs, so a slow or failing job is still once a day.
      this.#db.prepare("INSERT INTO proactive_runs (job, day, at) VALUES (?, ?, ?) ON CONFLICT(job) DO UPDATE SET day = excluded.day, at = excluded.at").run(job.name, day, now.getTime());
      fired.push(job.name);
      this.#running.add(job.name);
      try {
        await job.run();
      } catch (err) {
        this.#opts.onError?.(job.name, err);
      } finally {
        this.#running.delete(job.name);
      }
    }
    return fired;
  }

  /** Checks now and then every tickMs (30 s by default). Timers pause while the Mac sleeps; the first tick after wake catches up. */
  start(): this {
    if (!this.#opts.jobs.length) return this;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#opts.tickMs ?? 30_000);
    this.#timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
