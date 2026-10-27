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

## Known limit: sockets on a real watch
On a real Apple Watch, watchOS allows `URLSessionWebSocketTask` only in specific cases, such as an active audio session ([TN3135: Low-level networking on watchOS](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos)). The Simulator doesn't enforce this, so the watch app connects directly there. On a device it won't stay connected. The Day 4 plan:
- The iPhone app relays the watch's surface connection over WatchConnectivity, so Core still sees a `watch` surface with haptic output, and approvals reach the wrist.
- The watch opens its own socket only while it's listening (an audio session is active then), and falls back to the HTTPS routes in the spec.

This is the first thing to test when the watch arrives (gate G0).

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
