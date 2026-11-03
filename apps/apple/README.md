# Auren for iPhone and Apple Watch

Two SwiftUI apps and one shared package. Each app is a surface: it says `hello` to Core with its manifest, sends a heartbeat every second, shows the timeline and approvals, and speaks what Core routes to it.

| Path | What it is |
|---|---|
| `project.yml` | XcodeGen spec. The `.xcodeproj` and `Info.plist` files are generated, not committed. |
| `AurenKit/` | Swift package: Surface Protocol models, `SurfaceClient`, device identity, voice, camera capture, watch clips, timeline media, event styling, brand colors, `AurenMark`. 54 tests. |
| `iOS/` | The iPhone app: timeline (with the camera's crop on receipts and a live thumbnail of computer use), approvals, hold to talk, a text box, settings for the Core address and token. It also posts the watch's clips when the watch can't reach Core. |
| `Watch/` | The Apple Watch app: hold to talk, then black until something needs you, then a full-screen approval with a haptic. |

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

## Talking on the watch
A real watch can't keep the `/v1/voice` socket open either, so the watch uses hold-to-talk clips ([Surface Protocol: Voice clips](../../spec/surface-protocol.md#voice-clips-v01)).
- **Record.** `ClipRecorder` (watchOS) runs `AVAudioEngine` only while you hold the mic button, converts each 100 ms buffer to PCM16 mono at 24 kHz with `PCMConverter`, and stops by itself at 30 seconds.
- **Sign.** `VoiceClip.make` signs `auren-clip\n<device id>\n<timestamp>\n<sha256 of the bytes>` with the watch's Secure Enclave key. A short haptic plays as it leaves.
- **Send.** `ClipSender` posts it to `/v1/voice/clip` with `URLSession`. If Core can't be reached (a `URLError`), the clip goes to the iPhone with `WatchLink.transferClip` (WatchConnectivity `transferFile`, headers as metadata), and `ClipRelayHost` on the iPhone posts the same bytes and headers with its own token. A refusal from Core (stale, bad signature) is shown, not relayed.
- **Answer.** The watch shows the words Core heard ("“Push my 3 PM to 4.”"), or "Sent through your iPhone". The reply is spoken on the watch when its surface is online, as for any command.

The byte format and the relay are tested in `SurfacesR12Tests`. Recording, `transferFile` and the background post on the iPhone still have to be tried on real devices.

## Pairing and signed approvals
Each app creates a P-256 key in its device's **Secure Enclave** on first launch (a software key in the Simulator) and keeps it in the Keychain, never synced. To pair, choose **Pair a device** in the Mac console and type the code: on iPhone in **Settings → Pair with your Mac**, on the watch with **Pair with your Mac**. After that the app signs Core's challenge on every connection and signs every approval over the decision and the summary it showed. In the Simulator, connections from `127.0.0.1` count as the Mac, so pairing is optional there.

## Design rules in the code
- Gold means you: only the mark and pending approvals use gold (`Color.accentColor` or `Color.aurenAurum`).
- Signals are system colors (`.green`, `.red`, `.blue`), so light, dark and Increase Contrast work for free.
- Every state has a word and an SF Symbol (`AurenEvent.style`), never color alone.
- A spoken yes never sends. Approvals are buttons.

## On the timeline
- **The approval button says what it does:** "Post", "Invite" or "Confirm", from `approval_request.verb` (`ApprovalRequest.actionLabel`), and "Approve" from an older Core. The signature is the same either way: the verb is display only.
- **Computer use:** each `browser_frame` event decodes to a `BrowserFrame` (only `data:image/jpeg;base64`, JPEG bytes, at most 200 KB). The newest one shows as a live thumbnail; older steps are one line each.
- **What the camera saw:** a receipt with `crop_id` shows the crop from `GET /v1/crops/:id`, fetched with the app's token (`CropImage`), JPEG only and under 1 MB. The watch shows neither picture; its screen is for approvals.

## Coming next
| Work |
|---|
| Ray-Ban Meta glasses through the **Meta Wearables Device Access Toolkit** (Swift package added to the iOS target): a second `SurfaceClient` of kind `glasses` once `WearablesToolkitCamera.isAvailable` |
| Muse voice replaces the system voice; bundle Marcellus for the wordmark |
| The watch polls `/v1/events` when neither its own socket nor the relay is up |
