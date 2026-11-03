import AurenKit
import SwiftUI

/// The phone timeline: approvals waiting for you on top, then everything Muse did, newest first.
struct HomeView: View {
    let client: SurfaceClient
    @AppStorage("coreURL") private var coreURL = "http://127.0.0.1:8787"
    @AppStorage("token") private var token = ""
    @AppStorage("paired") private var paired = false
    @State private var draft = ""
    @State private var showSettings = false
    @State private var speaker = Speaker()
    @State private var voice: VoiceSession?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            List {
                if !client.approvals.isEmpty {
                    Section("Your move") {
                        ForEach(client.approvals) { request in
                            ApprovalCard(request: request) { approved in
                                Task { try? await client.answer(request, approved: approved) }
                            }
                        }
                    }
                }
                Section("Timeline") {
                    if client.events.isEmpty {
                        Text("Say it once. Everything Muse does shows up here, with a receipt.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(client.events.reversed()) { EventRow(event: $0) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.black)
            .safeAreaInset(edge: .bottom) { composer }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { StatusDot(state: client.state) }
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 8) {
                        AurenMark(size: 20)
                        Text("AUREN").font(.system(.subheadline, design: .serif)).tracking(4)
                    }
                    .accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Settings", systemImage: "gearshape") { showSettings = true }
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView(coreURL: $coreURL, token: $token, client: client) }
        }
        .task {
            client.onSpeak = { speaker.speak($0) }
            voice = VoiceSession(client: client)
            connect()
        }
        .onChange(of: coreURL) { connect() }
        .onChange(of: token) { connect() }
        .onChange(of: paired) { connect() }
        .onChange(of: scenePhase) { _, phase in client.isActive = phase == .active }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let voice, voice.phase != .idle || !voice.transcript.isEmpty {
                VoiceStatus(voice: voice)
            }
            HStack(spacing: 8) {
                if let voice { TalkButton(voice: voice, coreURL: coreURL, token: token) }
                typing
            }
        }
        .padding()
        .background(.bar)
    }

    private var typing: some View {
        HStack(spacing: 8) {
            TextField("Say it once…", text: $draft)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.send)
                .onSubmit(send)
            Button("Say it", action: send)
                .buttonStyle(.bordered)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        Task { try? await client.say(text) }
    }

    private func connect() {
        guard let url = URL(string: coreURL) else { return }
        client.connect(to: url, token: token)
    }
}

struct EventRow: View {
    let event: AurenEvent

    var body: some View {
        let style = event.style
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Label(style.word, systemImage: style.symbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(style.signal.color)
                .frame(width: 96, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.line)
                Text(event.date, style: .time)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A send-tier action waiting for a tap. Gold fills the button; a spoken yes never sends.
struct ApprovalCard: View {
    let request: ApprovalRequest
    let answer: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Your move", systemImage: "hand.tap.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.accentColor)
            Text(request.summary).font(.headline)
            HStack {
                Button { answer(true) } label: {
                    Text("Approve").foregroundStyle(Color.aurenOnyx).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button("Not now") { answer(false) }
                    .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }
}

struct StatusDot: View {
    let state: SurfaceClient.State

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityLabel(label)
    }

    private var color: Color {
        switch state {
        case .online: .aurenDone
        case .offline: .aurenStopped
        case .idle, .connecting: .secondary
        }
    }

    private var label: String {
        switch state {
        case .online: "Connected to Core"
        case .connecting: "Connecting to Core"
        case .idle: "Not connected"
        case .offline(let reason): "Offline: \(reason)"
        }
    }
}

/// Hold to talk. The microphone is on only while your finger is down.
struct TalkButton: View {
    let voice: VoiceSession
    let coreURL: String
    let token: String

    var body: some View {
        let live = voice.phase == .listening
        Image(systemName: live ? "waveform.circle.fill" : "mic.circle.fill")
            .font(.system(size: 34))
            .foregroundStyle(live ? Color.aurenHalo : Color.secondary)
            .symbolEffect(.pulse, isActive: live)
            .accessibilityLabel(live ? "Listening. Let go to send." : "Hold to talk")
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard let url = URL(string: coreURL) else { return }
                        Task { await voice.start(core: url, token: token) }
                    }
                    .onEnded { _ in Task { await voice.stop() } }
            )
    }
}

/// The words as Muse hears them, or why voice stopped.
struct VoiceStatus: View {
    let voice: VoiceSession

    var body: some View {
        switch voice.phase {
        case .failed(let message):
            Label(message, systemImage: "stop.fill").font(.footnote).foregroundStyle(Color.aurenStopped)
        case .connecting:
            Text("Opening the microphone…").font(.footnote).foregroundStyle(.secondary)
        default:
            Text(voice.transcript.isEmpty ? "Listening…" : "“\(voice.transcript)”")
                .font(.callout)
                .foregroundStyle(voice.phase == .listening ? .primary : .secondary)
                .lineLimit(3)
        }
    }
}
