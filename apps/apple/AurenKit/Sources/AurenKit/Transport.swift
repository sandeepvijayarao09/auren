// How a surface's text frames reach Core. Usually a WebSocket; on a real Apple
// Watch, which may not hold one open (TN3135), the frames go through the iPhone
// over WatchConnectivity instead. The watch still signs with its own key, so
// Core sees a verified watch, not the phone.
import Foundation

public protocol SurfaceTransport: AnyObject, Sendable {
    func open(_ url: URL) async throws
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close()
}

public final class WebSocketTransport: SurfaceTransport, @unchecked Sendable {
    private var task: URLSessionWebSocketTask?

    public init() {}

    public func open(_ url: URL) async throws {
        let task = URLSession.shared.webSocketTask(with: url)
        self.task = task
        task.resume()
    }

    public func send(_ text: String) async throws {
        guard let task else { throw URLError(.notConnectedToInternet) }
        try await task.send(.string(text))
    }

    public func receive() async throws -> String {
        guard let task else { throw URLError(.notConnectedToInternet) }
        while true {
            if case .string(let text) = try await task.receive() { return text }
        }
    }

    public func close() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }
}

// MARK: - Watch relay

/// The message link between the watch and its iPhone: WatchConnectivity in the apps, in memory in tests.
public protocol RelayLink: AnyObject, Sendable {
    func send(_ message: [String: String])
    func setHandler(_ handler: @escaping @Sendable ([String: String]) -> Void)
}

public struct RelayError: Error, LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
}

/// The watch's side: a transport whose frames travel through the iPhone.
public final class WatchRelayTransport: SurfaceTransport, @unchecked Sendable {
    private let link: RelayLink
    private let inbox: AsyncStream<[String: String]>
    private let feed: AsyncStream<[String: String]>.Continuation
    private var iterator: AsyncStream<[String: String]>.Iterator

    public init(link: RelayLink) {
        self.link = link
        (inbox, feed) = AsyncStream.makeStream(of: [String: String].self)
        iterator = inbox.makeAsyncIterator()
        let feed = feed
        link.setHandler { message in feed.yield(message) }
    }

    /// Asks the iPhone to open Core's surface socket with its own address and token.
    public func open(_ url: URL) async throws {
        link.send(["op": "open"])
        let reply = try await next()
        guard reply["op"] == "opened" else { throw RelayError(message: reply["reason"] ?? "The iPhone couldn't reach Core.") }
    }

    public func send(_ text: String) async throws {
        link.send(["op": "frame", "text": text])
    }

    public func receive() async throws -> String {
        let message = try await next()
        if message["op"] == "frame", let text = message["text"] { return text }
        throw RelayError(message: message["reason"] ?? "The relay closed.")
    }

    public func close() {
        link.send(["op": "close"])
        feed.finish()
    }

    private func next() async throws -> [String: String] {
        guard let message = await iterator.next() else { throw RelayError(message: "The relay closed.") }
        return message
    }
}

/// The iPhone's side: opens Core's socket for the watch and passes frames both ways, in order.
public actor RelayHost {
    private let link: RelayLink
    private let coreSocketURL: @Sendable () -> URL?
    private let makeTransport: @Sendable () -> SurfaceTransport
    private var upstream: SurfaceTransport?
    private var pump: Task<Void, Never>?

    public init(link: RelayLink, coreSocketURL: @escaping @Sendable () -> URL?, makeTransport: @escaping @Sendable () -> SurfaceTransport = { WebSocketTransport() }) {
        self.link = link
        self.coreSocketURL = coreSocketURL
        self.makeTransport = makeTransport
    }

    /// Starts handling the watch's messages one at a time, so frames keep their order.
    public nonisolated func start() {
        let (stream, feed) = AsyncStream.makeStream(of: [String: String].self)
        link.setHandler { message in feed.yield(message) }
        Task { for await message in stream { await self.handle(message) } }
    }

    func handle(_ message: [String: String]) async {
        switch message["op"] {
        case "open":
            stop()
            guard let url = coreSocketURL() else {
                link.send(["op": "closed", "reason": "Set the Core address in Auren on your iPhone."])
                return
            }
            let transport = makeTransport()
            do {
                try await transport.open(url)
            } catch {
                link.send(["op": "closed", "reason": error.localizedDescription])
                return
            }
            upstream = transport
            link.send(["op": "opened"])
            let link = link
            pump = Task {
                do {
                    while !Task.isCancelled { link.send(["op": "frame", "text": try await transport.receive()]) }
                } catch {
                    link.send(["op": "closed", "reason": error.localizedDescription])
                }
            }
        case "frame":
            if let text = message["text"] { try? await upstream?.send(text) }
        case "close":
            stop()
        default:
            break
        }
    }

    private func stop() {
        pump?.cancel()
        pump = nil
        upstream?.close()
        upstream = nil
    }
}
