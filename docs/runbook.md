# Demo runbook

How to bring up every device for a live run or a shoot. Use the demo workspace only: fictional people, a test Google account and a test Slack workspace. Never use real student data.

## Before you start
- [ ] `.env` has `MODEL_API_KEY` and an `AUREN_TOKEN` (any long random string: `openssl rand -hex 24`).
- [ ] The Mac, iPhone and Apple Watch are on the same Wi-Fi. A phone hotspot works when venue Wi-Fi blocks devices from seeing each other.
- [ ] The glasses are paired in the Meta AI app, charged, and the toolkit permission is granted to Auren.
- [ ] Do Not Disturb is on for every device, except Auren's notifications.
- [ ] The demo browser profile is clean, with no saved passwords or cards.

## Bring-up, in order
1. **Core.** Run `make dev`. Note the address it prints, such as `http://192.168.1.20:8787`. Check `/health`: `muse` should be `true`.
2. **Console.** Open `http://<address>/?token=<AUREN_TOKEN>` on the Mac. This is the Mac surface and the debugger.
3. **iPhone.** In Auren's settings, enter the address. On the Mac console choose **Pair a device**, then type the six-digit code under **Pair with your Mac**. The status dot turns green, and the timeline shows the phone paired with its key in the Secure Enclave.
4. **Watch.** Open Auren on the watch and choose **Pair with your Mac** with a fresh code. From Day 4, the phone hands it the address and token. Until then the watch app only reaches Core from the Simulator, at `127.0.0.1`.
5. **Glasses (Day 5).** Open the glasses screen in the iPhone app. A second device appears in the console's device list.
6. **Driver (Day 6).** Run `cd driver && npm start`. The console logs `driver online`.

The console's device chips should now show `web`, `phone`, `watch` and `glasses`.

## Run the Golden Path
Run [the five commands](golden-paths.md) in order, GP1 to GP5. GP5's undo reverts GP1's calendar move, so the run resets itself.

## When something goes wrong
| Symptom | Fix |
|---|---|
| Phone dot stays grey | Wrong address or token. Check that `/health` opens in the phone's browser. |
| "MODEL_API_KEY is not set" in the timeline | Add the key to `.env` and restart Core. |
| Approval never reaches the watch | The watch isn't connected or is asleep. Raise your wrist; the approval moves to the phone if the watch has dropped. |
| Computer use stops at a CAPTCHA | Expected. Finish it by hand, or switch to the backup site on the allowlist. |
| Reset between takes | Stop Core and delete `auren.db`. The demo world reloads on start. |

## The judges' sandbox
A public page where anyone can try the golden paths without a Slack or Gmail account: `/try`, on a fictional demo world, with a simulated iPhone, Apple Watch and glasses. Sends still wait for a tap on the simulated watch.

```bash
make sandbox      # http://127.0.0.1:8787/try
```

- **Engines.** With `MODEL_API_KEY`, Muse Wonder plans each command live until `AUREN_SANDBOX_TOKEN_BUDGET` tokens are spent. Without a key, once the budget is spent, at `AUREN_TOKEN_LIMIT`, or after two live failures in a row (for five minutes), the five golden paths and the planted-email case **replay** from `eval/scripts` through the real loop. The badge on the page says which: "Live · Muse Wonder" or "Replay". Vision and the booking site are always replayed (the eval's synthetic poster and demo booking page).
- **What it never touches.** Sandbox mode returns before Core opens `auren.db`, the master key, connectors, paired devices, the camera or the driver, whatever `.env` says. It serves `/try`, `/try/api/*`, `/health` and the brand assets, and answers 404 to everything else, `/v1/*` included. It prints the settings it's ignoring at start-up.
- **Limits.** Per visitor address: `AUREN_SANDBOX_RPM` commands a minute (6) and `AUREN_SANDBOX_DAILY` a day (60), 600 requests a minute, and 3 sessions (a fourth replaces the oldest). Across everyone: `AUREN_SANDBOX_MAX_VISITORS` (50) and 12 commands running at once. Commands are at most 280 characters, and each visitor runs one at a time. A visitor's world expires after 30 minutes without a command, tap or undo (polling doesn't count), and after 4 hours in any case.
- **Resetting.** Restart the process: every visitor's world, and the live engine's token count, are in memory.

### Hosting it (not deployed yet)
Pick one. In every case the sandbox needs no inbound access to your Mac's real Core: run it as its own process, with its own `.env` holding at most `MODEL_API_KEY`.

**Behind a tunnel from this Mac** (quickest for the judging window):
```bash
AUREN_TRUST_PROXY=true PORT=8790 make sandbox     # a different port from your real Core
cloudflared tunnel --url http://127.0.0.1:8790     # or: ngrok http 8790
```
Give judges `https://<tunnel-host>/try`. **Set `AUREN_TRUST_PROXY`** behind a tunnel: without it, every visitor arrives from 127.0.0.1 and they all share one set of rate limits (Core logs `sandbox.proxy` once when it sees forwarded requests it isn't trusting). Set it to the number of proxies in front if there's more than one; only the last hop is believed, so a visitor can't forge their address by sending their own `X-Forwarded-For`.

**On a small Node host** (Fly.io, Render, a VPS): Node 24, `cd core && npm ci`, then run `npm run sandbox` with `HOST=0.0.0.0`, `PORT` from the platform and `AUREN_TRUST_PROXY=true` (the platform's load balancer is one hop). It needs no volume: nothing is written to disk. Health check: `GET /health`.

Before you share the link, check `/health` says `"sandbox": true`, open `/try`, and play GP1 to its tap.
