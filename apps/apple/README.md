# Auren for iPhone and Apple Watch

Two SwiftUI apps and one shared package. Each app is a surface: it says `hello` to Core with its manifest, sends a heartbeat every second, shows the timeline and approvals, and speaks what Core routes to it.

| Path | What it is |
|---|---|
| `project.yml` | XcodeGen spec. The `.xcodeproj` and `Info.plist` files are generated, not committed. |
| `AurenKit/` | Swift package: Surface Protocol models, `SurfaceClient`, event styling, brand colors, `AurenMark`. 10 tests. |
| `iOS/` | The iPhone app: timeline, approvals, a text box, settings for the Core address and token. |
| `Watch/` | The Apple Watch app: black until something needs you, then a full-screen approval with a haptic. |

Requires Xcode 27 and XcodeGen (`brew install xcodegen`). Targets iOS 26 and watchOS 26.

```bash
make apple          # xcodegen generate
open apps/apple/Auren.xcodeproj
make apple-build    # builds both apps for the Simulator, no signing
make test           # includes `swift test` for AurenKit
```

## Running it
1. Start Core: `make dev`.
2. Run the **Auren** scheme on an iPhone Simulator. `http://127.0.0.1:8787` reaches Core on your Mac.
3. The watch app is embedded in the iPhone app. Run the **AurenWatch** scheme on a paired watch Simulator to try approvals on the wrist.
4. On real devices, set `AUREN_TOKEN` in `.env`. Then enter your Mac's network address and the token in the iPhone app's settings, and set your team in `project.yml` (`DEVELOPMENT_TEAM`).

## The watch relays through the iPhone
On a real Apple Watch, watchOS allows `URLSessionWebSocketTask` only in specific cases ([TN3135: Low-level networking on watchOS](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos)).
- **When the iPhone is reachable,** the watch's `SurfaceClient` uses `WatchRelayTransport`, which carries its frames to the iPhone over WatchConnectivity. On the iPhone, `RelayHost` opens Core's socket for it.
- **The watch still signs its own hello and every approval** with its Secure Enclave key; the iPhone only carries bytes.
- **Address and token.** The iPhone pushes the Core address and token to the watch through the application context.
- **Simulator.** The watch connects directly.

The relay is tested end to end in `RelayTests`, with an in-memory link. It still has to be tried on a real watch.

## Pairing and signed approvals
Each app creates a P-256 key in its device's **Secure Enclave** on first launch (a software key in the Simulator) and keeps it in the Keychain, never synced. To pair, choose **Pair a device** in the Mac console and type the code: on iPhone in **Settings → Pair with your Mac**, on the watch with **Pair with your Mac**. After that the app signs Core's challenge on every connection and signs every approval over the decision and the summary it showed. In the Simulator, connections from `127.0.0.1` count as the Mac, so pairing is optional there.

## Design rules in the code
- Gold means you: only the mark and pending approvals use gold (`Color.accentColor` or `Color.aurenAurum`).
- Signals are system colors (`.green`, `.red`, `.blue`), so light, dark and Increase Contrast work for free.
- Every state has a word and an SF Symbol (`AurenEvent.style`), never color alone.
- A spoken yes never sends. Approvals are buttons.

## Coming next
| Day | Work |
|---|---|
| 3 | Push-to-talk on the iPhone: stream PCM16 audio to `/v1/voice`; Muse voice replaces the system voice; bundle Marcellus for the wordmark |
| 4 | Watch voice input; WatchConnectivity hands the Core address and token from the phone to the watch; chunked `speak` |
| 5 | Ray-Ban Meta glasses through the **Meta Wearables Device Access Toolkit** (Swift package added to the iOS target): a second `SurfaceClient` of kind `glasses`, on-device bystander blur with Apple Vision, and frames sent only on Core's `capture_request` |
| 6 | Live `browser_frame` thumbnails in the timeline during computer use |

The approval button says "Approve" until `approval_request` carries the action verb (Surface Protocol v0.1). After that it can say "Post" or "Book", as the brand rules ask.
