import AurenKit
import SwiftUI
import WatchKit

@main
struct AurenWatchApp: App {
    @State private var watch = SurfaceClient(manifest: .watch(id: DeviceID.stable(prefix: "watch")))

    var body: some Scene {
        WindowGroup {
            WatchHomeView(client: watch)
        }
    }
}

/// The wrist: black until something needs you, then the approval takes the whole screen.
struct WatchHomeView: View {
    let client: SurfaceClient
    // Day 4: the iPhone app hands these over through WatchConnectivity.
    @AppStorage("coreURL") private var coreURL = "http://127.0.0.1:8787"
    @AppStorage("token") private var token = ""
    @State private var draft = ""
    @State private var speaker = Speaker()
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
            client.onSpeak = { speaker.speak($0) }
            client.onApproval = { _ in WKInterfaceDevice.current().play(.notification) }
            if let url = URL(string: coreURL) { client.connect(to: url, token: token) }
        }
        .onChange(of: scenePhase) { _, phase in client.isActive = phase == .active }
    }

    private var idle: some View {
        ScrollView {
            VStack(spacing: 10) {
                AurenMark(size: 40)
                Text(client.events.last?.line ?? "Say it once.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .lineLimit(4)
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("Your move")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.aurenAurum)
                Text(request.summary).font(.headline)
                Button { answer(true) } label: {
                    Text("Approve").foregroundStyle(Color.aurenOnyx).frame(maxWidth: .infinity)
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
