// One live connection to Auren Core over /v1/surface. A device can run several:
// the iPhone app runs one for the phone and, from Day 5, one for the glasses.
import Foundation
import Observation

/// A surface Core reports as online.
public struct Presence: Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: SurfaceKind
}

@MainActor
@Observable
public final class SurfaceClient {
    public enum State: Equatable, Sendable {
        case idle, connecting, online
        case offline(reason: String)
    }

    public let manifest: Manifest
    /// This device's key. Without one, only a connection from the Mac itself is accepted.
    public let identity: DeviceIdentity?
    public private(set) var state: State = .idle
    public private(set) var sessionID: String?
    /// Oldest first, in log order.
    public private(set) var events: [AurenEvent] = []
    public private(set) var online: [Presence] = []
    /// Approvals Core routed to this surface. Core moves them away if this surface drops.
    public private(set) var approvals: [ApprovalRequest] = []
    public private(set) var cards: [Card] = []
    /// Called for every sentence Core routes to this surface. Call `spoke(_:)` when it finishes playing.
    public var onSpeak: (@MainActor (Speech) -> Void)?
    /// Called once when an approval lands here (the watch plays a haptic).
    public var onApproval: (@MainActor (ApprovalRequest) -> Void)?
    /// Sent with each heartbeat. Core prefers active surfaces when it picks a device.
    public var isActive = true

    private let makeTransport: @MainActor () -> SurfaceTransport
    private var transport: SurfaceTransport?
    private var run: Task<Void, Never>?
    /// Core sets this in welcome: 500 ms for glasses, 1 s for others.
    private var heartbeat: Duration = .seconds(1)

    /// `transport` is asked for a fresh connection each time: a WebSocket, or the watch's relay through the iPhone.
    public init(manifest: Manifest, identity: DeviceIdentity? = nil, transport: @escaping @MainActor () -> SurfaceTransport = { WebSocketTransport() }) {
        self.manifest = manifest
        self.identity = identity
        self.makeTransport = transport
    }

    /// `core` is the address Core prints at start-up, such as http://192.168.1.20:8787.
    public nonisolated static func socketURL(core: URL, token: String?) -> URL? {
        guard var parts = URLComponents(url: core, resolvingAgainstBaseURL: false) else { return nil }
        switch parts.scheme {
        case "https", "wss": parts.scheme = "wss"
        case "http", "ws": parts.scheme = "ws"
        default: return nil
        }
        parts.path = "/v1/surface"
        parts.queryItems = (token?.isEmpty ?? true) ? nil : [URLQueryItem(name: "token", value: token)]
        return parts.url
    }

    /// Connects, loads the log so far, and reconnects every second if the link drops.
    public func connect(to core: URL, token: String? = nil) {
        disconnect()
        guard let url = Self.socketURL(core: core, token: token) else {
            state = .offline(reason: "The Core address must start with http:// or https://")
            return
        }
        run = Task { [weak self] in
            await self?.loadHistory(core: core, token: token)
            while !Task.isCancelled {
                await self?.session(url)
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    public func disconnect() {
        run?.cancel()
        run = nil
        transport?.close()
        transport = nil
        state = .idle
    }

    public func say(_ text: String) async throws {
        try await send(.utterance(text))
    }

    /// Signed with this device's key when it has one, over the decision and the summary it showed.
    public func answer(_ request: ApprovalRequest, approved: Bool) async throws {
        let signature = try identity?.signApproval(request, approved: approved)
        approvals.removeAll { $0.id == request.id }
        try await send(.approvalResponse(requestID: request.id, approved: approved, signature: signature))
    }

    /// Tells Core a sentence finished playing here.
    public func spoke(_ speech: Speech) {
        guard let replyID = speech.replyID, let seq = speech.seq else { return }
        Task { try? await send(.speakProgress(replyID: replyID, seq: seq)) }
    }

    /// Applies one message from Core. Internal so tests can drive it without a socket.
    func apply(_ message: ServerMessage) {
        switch message {
        case .challenge:
            break
        case .welcome(let session, let surfaces, let heartbeatMs):
            sessionID = session
            if let heartbeatMs, heartbeatMs >= 100 { heartbeat = .milliseconds(heartbeatMs) }
            online = surfaces.map { Presence(id: $0.id, kind: $0.kind) }
            state = .online
        case .event(let event):
            append(event)
            if event.kind == .surface, let id = event.string("surface_id") {
                online.removeAll { $0.id == id }
                if event.string("status") == "online", let kind = event.string("kind").flatMap(SurfaceKind.init(rawValue:)) {
                    online.append(Presence(id: id, kind: kind))
                }
            }
        case .speak(let speech):
            onSpeak?(speech)
        case .showCard(let card):
            cards.insert(card, at: 0)
        case .approvalRequest(let request):
            guard !approvals.contains(request) else { return }
            approvals.append(request)
            onApproval?(request)
        case .approvalCancel(let id, _):
            approvals.removeAll { $0.id == id }
        case .unknown:
            break
        }
    }

    private func append(_ event: AurenEvent) {
        // id 0 marks a message Core sends without logging it (a protocol error).
        guard event.id == 0 || !events.contains(where: { $0.id == event.id }) else { return }
        events.append(event)
    }

    func session(_ url: URL) async {
        let transport = makeTransport()
        self.transport = transport
        state = .connecting
        do {
            try await transport.open(url)
            // Core opens with a challenge; a paired device signs it. An older Core sends nothing first.
            var early: ServerMessage?
            if let first = try? JSONDecoder().decode(ServerMessage.self, from: Data(try await transport.receive().utf8)) {
                if case .challenge(let nonce) = first {
                    try await send(.hello(manifest, auth: try identity?.helloAuth(nonce: nonce)))
                } else {
                    try await send(.hello(manifest))
                    early = first
                }
            } else {
                try await send(.hello(manifest))
            }
            if let early { apply(early) }
            let beat = Task { [weak self] in
                while !Task.isCancelled {
                    guard let self else { return }
                    try? await Task.sleep(for: self.heartbeat)
                    try? await self.send(.heartbeat(active: self.isActive))
                }
            }
            defer { beat.cancel() }
            while !Task.isCancelled {
                let text = try await transport.receive()
                if let message = try? JSONDecoder().decode(ServerMessage.self, from: Data(text.utf8)) {
                    apply(message)
                }
            }
        } catch {
            if !Task.isCancelled { state = .offline(reason: error.localizedDescription) }
        }
        transport.close()
    }

    private func send(_ message: ClientMessage) async throws {
        guard let transport else { throw URLError(.notConnectedToInternet) }
        let data = try JSONEncoder().encode(message)
        try await transport.send(String(decoding: data, as: UTF8.self))
    }

    private struct EventPage: Decodable { let events: [AurenEvent] }

    private func loadHistory(core: URL, token: String?) async {
        var request = URLRequest(url: core.appending(path: "v1/events"))
        if let token, !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let page = try? JSONDecoder().decode(EventPage.self, from: data) else { return }
        page.events.forEach(append)
        events.sort { $0.id < $1.id }
    }
}
