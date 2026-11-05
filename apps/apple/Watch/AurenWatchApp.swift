import AurenKit
import SwiftUI
import WatchKit

@main
struct AurenWatchApp: App {
    @State private var watch: SurfaceClient

    init() {
        let id = DeviceID.stable(prefix: "watch")
        // The approval you tap is signed by this key, held in the watch's Secure Enclave.
        let identity = try? DeviceIdentity.loadOrCreate(deviceID: id)
        // The iPhone hands over the Core address and token, so nothing is typed on the wrist.
        WatchLink.shared.onConfig = { coreURL, token in
            UserDefaults.standard.set(coreURL, forKey: "coreURL")
            UserDefaults.standard.set(token, forKey: "token")
        }
        WatchLink.shared.activate()
        // Through the iPhone when it's reachable (a real watch can't keep its own socket open); direct otherwise.
        _watch = State(initialValue: SurfaceClient(manifest: .watch(id: id), identity: identity, transport: {
            WatchLink.shared.isReachable ? WatchRelayTransport(link: WatchLink.shared) as SurfaceTransport : WebSocketTransport()
        }))
    }

    var body: some Scene {
        WindowGroup {
            WatchHomeView(client: watch)
        }
    }
}

/// The wrist: black until something needs you, then the approval takes the whole screen.
struct WatchHomeView: View {
    let client: SurfaceClient
    // Set by the iPhone app over WatchConnectivity.
    @AppStorage("coreURL") private var coreURL = "http://127.0.0.1:8787"
    @AppStorage("token") private var token = ""
    @AppStorage("paired") private var paired = false
    @State private var showPairing = false
    @State private var draft = ""
    @State private var speaker = Speaker()
    // R12: hold to talk. The clip goes straight to Core, or through the iPhone when Core can't be reached.
    @State private var recorder: ClipRecorder?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if let request = client.approvals.first {
                ApprovalView(request: request) { approved in
                    Task { try? await client.answer(request, approved: approved) }
                }
            } else {
                idle
            }
        }
        .task {
            client.onSpeak = { speech in speaker.speak(speech) { client.spoke($0) } }
            client.onApproval = { _ in WKInterfaceDevice.current().play(.notification) }
            if recorder == nil {
                let recorder = ClipRecorder(client: client, sender: ClipSender(relay: { clip in
                    try WatchLink.shared.transferClip(clip.pcm, metadata: clip.metadata)
                }))
                recorder.onSend = { WKInterfaceDevice.current().play(.click) }
                self.recorder = recorder
            }
            if let url = URL(string: coreURL) { client.connect(to: url, token: token) }
        }
        .onChange(of: scenePhase) { _, phase in client.isActive = phase == .active }
        .onChange(of: paired) { if let url = URL(string: coreURL) { client.connect(to: url, token: token) } }
        .onChange(of: coreURL) { if let url = URL(string: coreURL) { client.connect(to: url, token: token) } }
        .sheet(isPresented: $showPairing) { WatchPairView(client: client, paired: $paired) }
    }

    private var idle: some View {
        ScrollView {
            VStack(spacing: 10) {
                AurenMark(size: 40)
                if let recorder {
                    WatchTalkButton(recorder: recorder, coreURL: coreURL, token: token)
                    ClipStatus(recorder: recorder)
                }
                Text(client.events.last?.line ?? "Say it once.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(4)
                if client.identity != nil && !paired {
                    Button("Pair with your Mac") { showPairing = true }
                }
                TextField("Say it…", text: $draft)
                    .onSubmit {
                        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        draft = ""
                        if !text.isEmpty { Task { try? await client.say(text) } }
                    }
            }
        }
    }
}

/// Color only when it says something: the gold wash means "your move".
struct ApprovalView: View {
    let request: ApprovalRequest
    let answer: (Bool) -> Void
    /// The short line leads; tap it to read the full summary, which is what the watch signs.
    @State private var expanded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("Your move")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.aurenAurum)
                Text(expanded ? request.summary : request.headline).font(.headline)
                if request.hasMore {
                    Button(expanded ? "Less" : "Details") { expanded.toggle() }
                        .font(.caption2)
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.aurenAurum)
                }
                Button { answer(true) } label: {
                    // R12: the verb Core sent ("Post", "Invite"), or "Approve".
                    Text(request.actionLabel).foregroundStyle(Color.aurenOnyx).frame(maxWidth: .infinity)
                }
                .tint(.aurenAurum)
                .buttonStyle(.borderedProminent)
                Button("Not now") { answer(false) }
            }
        }
        .background(
            LinearGradient(colors: [Color.aurenAurum.opacity(0.32), Color.aurenAurum.opacity(0.06)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
        )
    }
}

/// R12: hold to talk. The microphone is on only while your finger is down, and at most 30 seconds.
struct WatchTalkButton: View {
    let recorder: ClipRecorder
    let coreURL: String
    let token: String
    // One clip per press, so a press held past 30 seconds doesn't start a second one.
    @State private var holding = false

    var body: some View {
        let live = recorder.phase == .recording
        Image(systemName: live ? "waveform.circle.fill" : "mic.circle.fill")
            .font(.system(size: 44))
            .foregroundStyle(live ? Color.aurenHalo : Color.secondary)
            .symbolEffect(.pulse, isActive: live)
            .accessibilityLabel(live ? "Listening. Let go to send." : "Hold to talk")
            .accessibilityAddTraits(.isButton)
            .highPriorityGesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !holding, let url = URL(string: coreURL) else { return }
                        holding = true
                        Task { await recorder.start(core: url, token: token) }
                    }
                    .onEnded { _ in
                        holding = false
                        Task { await recorder.stop() }
                    }
            )
    }
}

/// What happened to the last clip, in a few words.
struct ClipStatus: View {
    let recorder: ClipRecorder

    var body: some View {
        switch recorder.phase {
        case .idle:
            Text("Hold to talk").font(.caption2).foregroundStyle(.secondary)
        case .recording:
            Text("Listening…").font(.caption2)
        case .sending:
            Text("Sending…").font(.caption2).foregroundStyle(.secondary)
        case .sent(let text):
            Text(text.isEmpty ? "Only heard “Hey Muse”." : "“\(text)”").font(.caption2).multilineTextAlignment(.center).lineLimit(3)
        case .relayed:
            Label("Sent through your iPhone", systemImage: "iphone").font(.caption2).foregroundStyle(.secondary)
        case .failed(let message):
            Label(message, systemImage: "stop.fill").font(.caption2).foregroundStyle(Color.aurenStopped)
        }
    }
}

/// Pairing on the wrist: type the six digits the Mac shows.
struct WatchPairView: View {
    let client: SurfaceClient
    @Binding var paired: Bool
    @AppStorage("coreURL") private var coreURL = "http://127.0.0.1:8787"
    @State private var code = ""
    @State private var message: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                Text("Enter the code on your Mac").font(.footnote).multilineTextAlignment(.center)
                TextField("Code", text: $code)
                Button("Pair") {
                    Task {
                        guard let identity = client.identity, let url = URL(string: coreURL) else { return }
                        do {
                            try await identity.pair(core: url, code: code.filter(\.isNumber), manifest: client.manifest)
                            paired = true
                            dismiss()
                        } catch {
                            message = error.localizedDescription
                        }
                    }
                }
                .disabled(code.filter(\.isNumber).count != 6)
                if let message {
                    Text(message).font(.caption2).foregroundStyle(Color.aurenStopped)
                }
            }
        }
    }
}
