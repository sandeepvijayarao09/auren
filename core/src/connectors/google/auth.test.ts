import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadKey, SecretStore } from "../secrets.ts";
import { GOOGLE_SCOPES, GoogleAuth, NotConnectedError } from "./auth.ts";

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(respond: (url: string, init: RequestInit) => Response) {
  let clock = 1_000_000;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as typeof fetch;
  const auth = new GoogleAuth({
    clientId: "cid.apps.googleusercontent.com",
    clientSecret: "csecret",
    redirectUri: "http://127.0.0.1:8787/connect/google/callback",
    connectUrl: "http://127.0.0.1:8787/connect/google",
    store: new SecretStore(":memory:", loadKey({})),
    fetch: fakeFetch,
    now: () => clock,
  });
  return { auth, calls, tick: (ms: number) => (clock += ms) };
}

const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));

test("the consent URL asks for offline access with PKCE and every scope", () => {
  const { auth } = setup(() => json(500, {}));
  const url = new URL(auth.authUrl());
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/connect/google/callback");
  assert.deepEqual(url.searchParams.get("scope")?.split(" "), GOOGLE_SCOPES);
  assert.ok(url.searchParams.get("state"));
});

test("finishing exchanges the code with the matching verifier and stores the tokens", async () => {
  const { auth, calls } = setup(() => json(200, { access_token: "at1", refresh_token: "rt1", expires_in: 3600, scope: "a b", id_token: idToken("demo@example.com") }));
  const url = new URL(auth.authUrl());
  const { email } = await auth.finish("the-code", url.searchParams.get("state")!);
  assert.equal(email, "demo@example.com");
  const sent = form(calls[0].init);
  assert.equal(sent.grant_type, "authorization_code");
  assert.equal(sent.code, "the-code");
  assert.equal(createHash("sha256").update(sent.code_verifier).digest("base64url"), url.searchParams.get("code_challenge"));
  assert.deepEqual(auth.status(), { connected: true, email: "demo@example.com", scopes: ["a", "b"] });
  assert.equal(await auth.accessToken(), "at1");
});

test("an unknown or reused state is refused", async () => {
  const { auth } = setup(() => json(200, { access_token: "at", expires_in: 3600 }));
  await assert.rejects(auth.finish("code", "made-up"), /expired/);
  const state = new URL(auth.authUrl()).searchParams.get("state")!;
  await auth.finish("code", state);
  await assert.rejects(auth.finish("code", state), /expired/);
});

test("refreshes a stale token once, even for parallel calls", async () => {
  let refreshes = 0;
  const { auth, tick } = setup((url, init) => {
    if (url.includes("oauth2.googleapis.com")) {
      if (form(init).grant_type === "refresh_token") refreshes++;
      return json(200, { access_token: refreshes ? `at${refreshes + 1}` : "at1", refresh_token: "rt1", expires_in: 3600 });
    }
    return json(200, { ok: true });
  });
  await auth.finish("code", new URL(auth.authUrl()).searchParams.get("state")!);
  tick(3600_000);
  const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
  assert.equal(refreshes, 1);
  assert.deepEqual(tokens, ["at2", "at2", "at2"]);
});

test("a revoked refresh token disconnects with a clear message", async () => {
  const { auth, tick } = setup((_url, init) =>
    form(init).grant_type === "refresh_token" ? json(400, { error: "invalid_grant" }) : json(200, { access_token: "at1", refresh_token: "rt1", expires_in: 60 }),
  );
  await auth.finish("code", new URL(auth.authUrl()).searchParams.get("state")!);
  tick(120_000);
  await assert.rejects(auth.accessToken(), (e: Error) => e instanceof NotConnectedError && /connect again/.test(e.message));
  assert.equal(auth.status().connected, false);
});

test("API calls send the bearer token and surface Google's error message", async () => {
  const { auth, calls } = setup((url) =>
    url.includes("oauth2") ? json(200, { access_token: "at1", expires_in: 3600 }) : json(403, { error: { message: "Calendar API has not been used in project 123" } }),
  );
  await assert.rejects(auth.json("https://www.googleapis.com/calendar/v3/x"), /isn't connected/);
  await auth.finish("code", new URL(auth.authUrl()).searchParams.get("state")!);
  await assert.rejects(auth.json("https://www.googleapis.com/calendar/v3/x"), /Google 403: Calendar API has not been used/);
  assert.equal((calls.at(-1)!.init.headers as Record<string, string>).authorization, "Bearer at1");
});
