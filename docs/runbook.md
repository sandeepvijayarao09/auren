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
3. **iPhone.** In Auren's settings, enter the address and token. The status dot turns green.
4. **Watch.** Open Auren on the watch. From Day 4, the phone hands it the address and token. Until then the watch app only reaches Core from the Simulator, at `127.0.0.1`.
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
