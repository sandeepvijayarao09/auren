import AurenKit
import SwiftUI

/// The phone timeline: approvals waiting for you on top, then everything Muse did, newest first.
struct HomeView: View {
    let client: SurfaceClient
    @AppStorage("coreURL") private var coreURL = "http://127.0.0.1:8787"
    @AppStorage("token") private var token = ""
    @State private var draft = ""
    @State private var showSettings = false
    @State private var speaker = Speaker()
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
            .sheet(isPresented: $showSettings) { SettingsView(coreURL: $coreURL, token: $token) }
        }
        .task {
            client.onSpeak = { speaker.speak($0) }
            connect()
        }
        .onChange(of: coreURL) { connect() }
        .onChange(of: token) { connect() }
        .onChange(of: scenePhase) { _, phase in client.isActive = phase == .active }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Say it once…", text: $draft)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.send)
                .onSubmit(send)
            Button("Say it", action: send)
                .buttonStyle(.bordered)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding()
        .background(.bar)
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
