// Google OAuth for a desktop client: PKCE, a loopback redirect back to Core,
// offline access, and tokens kept in the encrypted SecretStore. One consent
// covers Calendar, Contacts and Gmail, so Day 2 needs no second sign-in.
import { createHash, randomBytes } from "node:crypto";
import type { SecretStore } from "../secrets.ts";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SECRET_NAME = "google";
const PENDING_TTL_MS = 10 * 60_000;

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope: string;
  email?: string;
}

export interface GoogleAuthOptions {
  clientId: string;
  clientSecret: string;
  /** Where Google sends the browser back, e.g. http://127.0.0.1:8787/connect/google/callback */
  redirectUri: string;
  /** Shown in errors so the person knows where to connect. */
  connectUrl: string;
  store: SecretStore;
  fetch?: typeof fetch;
  now?: () => number;
}

export class NotConnectedError extends Error {}

const b64url = (buf: Buffer) => buf.toString("base64url");

export class GoogleAuth {
  #opts: GoogleAuthOptions;
  #fetch: typeof fetch;
  #now: () => number;
  #pending = new Map<string, { verifier: string; at: number }>();
  #refreshing: Promise<StoredTokens> | null = null;

  constructor(opts: GoogleAuthOptions) {
    this.#opts = opts;
    this.#fetch = opts.fetch ?? fetch;
    this.#now = opts.now ?? Date.now;
  }

  /** Starts a sign-in: returns the consent URL and remembers its PKCE verifier. */
  authUrl(): string {
    for (const [state, p] of this.#pending) if (this.#now() - p.at > PENDING_TTL_MS) this.#pending.delete(state);
    const state = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    this.#pending.set(state, { verifier, at: this.#now() });
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.#opts.clientId,
      redirect_uri: this.#opts.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  /** Finishes a sign-in from the callback. */
  async finish(code: string, state: string): Promise<{ email?: string }> {
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (!pending || this.#now() - pending.at > PENDING_TTL_MS) throw new Error("This sign-in link expired. Start again from /connect/google.");
    const t = await this.#token({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.#opts.redirectUri,
      code_verifier: pending.verifier,
    });
    const tokens: StoredTokens = {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: this.#now() + (t.expires_in ?? 3600) * 1000,
      scope: t.scope ?? "",
      email: emailFromIdToken(t.id_token),
    };
    this.#opts.store.set(SECRET_NAME, tokens);
    return { email: tokens.email };
  }

  status(): { connected: boolean; email?: string; scopes?: string[] } {
    const t = this.#opts.store.get<StoredTokens>(SECRET_NAME);
    return t ? { connected: true, email: t.email, scopes: t.scope.split(" ").filter(Boolean) } : { connected: false };
  }

  disconnect(): void {
    this.#opts.store.delete(SECRET_NAME);
  }

  /** A valid access token, refreshed a minute before it expires. */
  async accessToken(): Promise<string> {
    const t = this.#opts.store.get<StoredTokens>(SECRET_NAME);
    if (!t) throw new NotConnectedError(`Google isn't connected. Open ${this.#opts.connectUrl} on this Mac to connect it.`);
    if (t.expires_at - 60_000 > this.#now()) return t.access_token;
    return (await this.#refresh(t)).access_token;
  }

  /** Calls a Google API with the token, retrying once after a refresh if Google says 401. */
  async json<T = any>(url: string, init: RequestInit = {}): Promise<T> {
    const send = async (token: string) =>
      this.#fetch(url, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers, authorization: `Bearer ${token}` } });
    let res = await send(await this.accessToken());
    if (res.status === 401) {
      const t = this.#opts.store.get<StoredTokens>(SECRET_NAME);
      if (t) res = await send((await this.#refresh(t)).access_token);
    }
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const err = new Error(`Google ${res.status}: ${body?.error?.message ?? res.statusText}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return body as T;
  }

  #refresh(t: StoredTokens): Promise<StoredTokens> {
    // One refresh at a time, even when parallel tool calls all find the token stale.
    this.#refreshing ??= (async () => {
      try {
        if (!t.refresh_token) throw new NotConnectedError(`Google needs you to sign in again. Open ${this.#opts.connectUrl}.`);
        const r = await this.#token({ grant_type: "refresh_token", refresh_token: t.refresh_token }).catch((e: Error) => {
          // invalid_grant: revoked, or a Testing-mode token past its 7 days.
          if (/invalid_grant/.test(e.message)) {
            this.disconnect();
            throw new NotConnectedError(`Google signed Auren out. Open ${this.#opts.connectUrl} to connect again.`);
          }
          throw e;
        });
        const next: StoredTokens = { ...t, access_token: r.access_token, expires_at: this.#now() + (r.expires_in ?? 3600) * 1000 };
        if (r.refresh_token) next.refresh_token = r.refresh_token;
        this.#opts.store.set(SECRET_NAME, next);
        return next;
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  async #token(fields: Record<string, string>): Promise<any> {
    const res = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...fields, client_id: this.#opts.clientId, client_secret: this.#opts.clientSecret }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`Google sign-in failed: ${body.error ?? res.status}${body.error_description ? ` (${body.error_description})` : ""}`);
    return body;
  }
}

/** The email claim from an ID token we just received from Google's token endpoint over TLS. */
function emailFromIdToken(idToken?: string): string | undefined {
  try {
    return idToken ? JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")).email : undefined;
  } catch {
    return undefined;
  }
}
