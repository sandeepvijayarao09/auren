// R13: the spend alarm and the spend limit, in tokens (Muse prices aren't
// published, so Auren never guesses at money). The outbound ledger counts every
// model token; this watches its running total.
//   AUREN_TOKEN_ALARM  a warning event, once, that the console shows as a banner
//   AUREN_TOKEN_LIMIT  new commands are refused; approvals already waiting still resolve
import type { Ledger, Usage } from "../security/ledger.ts";
import { silentOps, type OpsLog } from "./opslog.ts";

export interface SpendEvent {
  level: "alarm" | "limit";
  tokens: number;
  alarm: number | null;
  limit: number | null;
  message: string;
}

export interface SpendOptions {
  /** Tokens. 0 or unset turns it off. */
  alarm?: number;
  limit?: number;
  ops?: OpsLog;
  /** Called once when the total first crosses the alarm, and once when it first reaches the limit. */
  onCross?: (e: SpendEvent) => void;
}

export interface SpendStatus extends Usage {
  alarm: number | null;
  limit: number | null;
  alarmed: boolean;
  limited: boolean;
}

const n = (x: number) => x.toLocaleString("en-US");

export class SpendGuard {
  #ledger: Ledger;
  #alarm: number | null;
  #limit: number | null;
  #alarmed: boolean;
  #limited: boolean;

  constructor(ledger: Ledger, opts: SpendOptions = {}) {
    this.#ledger = ledger;
    this.#alarm = opts.alarm && opts.alarm > 0 ? opts.alarm : null;
    this.#limit = opts.limit && opts.limit > 0 ? opts.limit : null;
    const ops = opts.ops ?? silentOps;
    // A total already past a line at start-up was announced when it crossed; it isn't announced again.
    const start = ledger.totals().total;
    this.#alarmed = this.#alarm !== null && start >= this.#alarm;
    this.#limited = this.#limit !== null && start >= this.#limit;
    ledger.onUsage(({ total }) => {
      if (this.#alarm !== null && !this.#alarmed && total >= this.#alarm) {
        this.#alarmed = true;
        const e = this.#event("alarm", total);
        ops.warn("usage.alarm", { total_tokens: total, alarm: this.#alarm, limit: this.#limit });
        opts.onCross?.(e);
      }
      if (this.#limit !== null && !this.#limited && total >= this.#limit) {
        this.#limited = true;
        const e = this.#event("limit", total);
        ops.error("usage.limit", { total_tokens: total, limit: this.#limit });
        opts.onCross?.(e);
      }
    });
  }

  /** Why a new command is refused, or null when it may run. */
  refusal(): string | null {
    return this.#limited ? this.#event("limit", this.#ledger.totals().total).message : null;
  }

  status(): SpendStatus {
    return { ...this.#ledger.usage(), alarm: this.#alarm, limit: this.#limit, alarmed: this.#alarmed, limited: this.#limited };
  }

  #event(level: SpendEvent["level"], tokens: number): SpendEvent {
    const message =
      level === "alarm"
        ? `Token alarm: Auren has used ${n(tokens)} model tokens, past AUREN_TOKEN_ALARM (${n(this.#alarm ?? 0)}). It keeps working${this.#limit ? ` until AUREN_TOKEN_LIMIT (${n(this.#limit)})` : ""}.`
        : `Token limit reached: Auren has used ${n(tokens)} of AUREN_TOKEN_LIMIT (${n(this.#limit ?? 0)}) model tokens, so it won't start new commands. Raise the limit in .env and restart Core. Approvals already waiting still go through.`;
    return { level, tokens, alarm: this.#alarm, limit: this.#limit, message };
  }
}
