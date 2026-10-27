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
    public private(set) var state: State = .idle
    public private(set) var sessionID: String?
    /// Oldest first, in log order.
    public private(set) var events: [AurenEvent] = []
    public private(set) var online: [Presence] = []
    /// Approvals Core routed to this surface. Core moves them away if this surface drops.
    public private(set) var approvals: [ApprovalRequest] = []
    public private(set) var cards: [Card] = []
    /// Called for every `speak` Core routes to this surface.
    public var onSpeak: (@MainActor (String) -> Void)?
    /// Called once when an approval lands here (the watch plays a haptic).
    public var onApproval: (@MainActor (ApprovalRequest) -> Void)?
    /// Sent with each heartbeat. Core prefers active surfaces when it picks a device.
    public var isActive = true

    private var socket: URLSessionWebSocketTask?
    private var run: Task<Void, Never>?

    public init(manifest: Manifest) {
        self.manifest = manifest
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
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        state = .idle
    }

    public func say(_ text: String) async throws {
        try await send(.utterance(text))
    }

    public func answer(_ request: ApprovalRequest, approved: Bool) async throws {
        approvals.removeAll { $0.id == request.id }
        try await send(.approvalResponse(requestID: request.id, approved: approved))
    }

    /// Applies one message from Core. Internal so tests can drive it without a socket.
    func apply(_ message: ServerMessage) {
        switch message {
        case .welcome(let session, let surfaces):
            sessionID = session
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
        case .speak(let text):
            onSpeak?(text)
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

    private func session(_ url: URL) async {
        let socket = URLSession.shared.webSocketTask(with: url)
        self.socket = socket
        state = .connecting
        socket.resume()
        do {
            try await send(.hello(manifest))
            let beat = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(1))
                    guard let self else { return }
                    try? await self.send(.heartbeat(active: self.isActive))
                }
            }
            defer { beat.cancel() }
            while !Task.isCancelled {
                guard case .string(let text) = try await socket.receive() else { continue }
                if let message = try? JSONDecoder().decode(ServerMessage.self, from: Data(text.utf8)) {
                    apply(message)
                }
            }
        } catch {
            if !Task.isCancelled { state = .offline(reason: error.localizedDescription) }
        }
        socket.cancel(with: .goingAway, reason: nil)
    }

    private func send(_ message: ClientMessage) async throws {
        guard let socket else { throw URLError(.notConnectedToInternet) }
        let data = try JSONEncoder().encode(message)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
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
