import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { approvalPayload, DeviceRegistry, helloPayload, PairingError } from "./devices.ts";

/** A stand-in for a device's Secure Enclave key: P-256, DER signatures, like CryptoKit. */
export function fakeDevice() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    sign: (payload: Buffer) => sign("sha256", payload, { key: privateKey, dsaEncoding: "der" }).toString("base64"),
  };
}

const pair = (reg: DeviceRegistry, dev = fakeDevice(), id = "watch-7f3a") => {
  const { code } = reg.startPairing();
  reg.finishPairing({ code, id, name: "Apple Watch", kind: "watch", publicKey: dev.publicKey, hardware: true });
  return dev;
};

test("a paired device proves its key on hello", () => {
  const reg = new DeviceRegistry();
  const dev = pair(reg);
  assert.equal(reg.verify("watch-7f3a", helloPayload("n0nce", "watch-7f3a"), dev.sign(helloPayload("n0nce", "watch-7f3a"))), true);
  assert.equal(reg.verify("watch-7f3a", helloPayload("other", "watch-7f3a"), dev.sign(helloPayload("n0nce", "watch-7f3a"))), false);
  assert.equal(reg.verify("watch-7f3a", helloPayload("n0nce", "watch-7f3a"), fakeDevice().sign(helloPayload("n0nce", "watch-7f3a"))), false);
  assert.ok(reg.get("watch-7f3a")?.lastSeen);
});

test("an approval signature covers the summary the device showed", () => {
  const reg = new DeviceRegistry();
  const dev = pair(reg);
  const sig = dev.sign(approvalPayload("apr_1", true, "Post in #office-hours"));
  assert.equal(reg.verify("watch-7f3a", approvalPayload("apr_1", true, "Post in #office-hours"), sig), true);
  assert.equal(reg.verify("watch-7f3a", approvalPayload("apr_1", true, "Post in #general"), sig), false);
  assert.equal(reg.verify("watch-7f3a", approvalPayload("apr_1", false, "Post in #office-hours"), sig), false);
});

test("codes are single-use, expire, and stop after five wrong tries", () => {
  let now = 0;
  const reg = new DeviceRegistry(":memory:", () => now);
  const dev = fakeDevice();
  const base = { id: "phone-1", kind: "phone", publicKey: dev.publicKey };

  const { code } = reg.startPairing();
  assert.match(code, /^\d{6}$/);
  reg.finishPairing({ ...base, code });
  assert.throws(() => reg.finishPairing({ ...base, code }), PairingError);

  const second = reg.startPairing().code;
  now += 5 * 60_000 + 1;
  assert.throws(() => reg.finishPairing({ ...base, code: second }), /No pairing code is active/);

  const third = reg.startPairing().code;
  const wrong = third === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.throws(() => reg.finishPairing({ ...base, code: wrong }), /doesn't match/);
  assert.throws(() => reg.finishPairing({ ...base, code: third }), /Too many wrong codes/);
});

test("only P-256 keys are accepted", () => {
  const reg = new DeviceRegistry();
  const ed = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  assert.throws(() => reg.finishPairing({ code: reg.startPairing().code, id: "x", kind: "phone", publicKey: ed }), /P-256/);
  assert.throws(() => reg.finishPairing({ code: reg.startPairing().code, id: "x", kind: "phone", publicKey: "not base64 der" }), /P-256/);
});

test("a revoked device can't sign anything, until it pairs again", () => {
  const reg = new DeviceRegistry();
  const dev = pair(reg);
  assert.equal(reg.revoke("watch-7f3a"), true);
  assert.equal(reg.verify("watch-7f3a", helloPayload("n", "watch-7f3a"), dev.sign(helloPayload("n", "watch-7f3a"))), false);
  assert.equal(reg.get("watch-7f3a")?.revoked, true);
  const again = pair(reg, fakeDevice());
  assert.equal(reg.verify("watch-7f3a", helloPayload("n", "watch-7f3a"), again.sign(helloPayload("n", "watch-7f3a"))), true);
  assert.equal(reg.verify("watch-7f3a", helloPayload("n", "watch-7f3a"), dev.sign(helloPayload("n", "watch-7f3a"))), false);
});

// Made once with CryptoKit (P256.Signing, DER), exactly as DeviceIdentity signs on iPhone and Apple Watch.
const CRYPTOKIT = {
  publicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhNMk9OVGgBP7HY9tIzZyZU2Qurwa+cnpdyHsupDum5tmi/U4yUpJdu6D4OO7/uk47/Ym8fi0unKiqvZ9lYVh5Q==",
  approval: "MEUCIDwUZ0BUBrRBiN4uYIDdTQM8L2t+NLfc5417xVYcpBU5AiEAi25kIV8Nvyy06nfleI04dIWX+5aCPpUhE5ezf3a2ikY=",
  hello: "MEUCIHodrjsL/fOHCNbFctl34ouVW84MVL90fCbCDsJuEF2lAiEAptafHDp7N1S1sDl7cr16fxj+xIa9c347Y1zPJFy7uec=",
};

test("signatures made by CryptoKit on Apple devices verify here", () => {
  const reg = new DeviceRegistry();
  reg.finishPairing({ code: reg.startPairing().code, id: "watch-interop", kind: "watch", publicKey: CRYPTOKIT.publicKey, hardware: true });
  assert.equal(reg.verify("watch-interop", approvalPayload("apr_interop", true, "Post in #office-hours"), CRYPTOKIT.approval), true);
  assert.equal(reg.verify("watch-interop", helloPayload("n0nce", "watch-interop"), CRYPTOKIT.hello), true);
  assert.equal(reg.verify("watch-interop", approvalPayload("apr_interop", true, "Post in #general"), CRYPTOKIT.approval), false);
});
