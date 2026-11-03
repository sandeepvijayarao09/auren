import CryptoKit
import Foundation
import Testing
@testable import AurenKit

/// Two ends of an in-memory WatchConnectivity link.
final class MemoryLink: RelayLink, @unchecked Sendable {
    weak var peer: MemoryLink?
    private var handler: (@Sendable ([String: String]) -> Void)?
    private let lock = NSLock()

    static func pair() -> (watch: MemoryLink, phone: MemoryLink) {
        let a = MemoryLink(), b = MemoryLink()
        a.peer = b
        b.peer = a
        return (a, b)
    }

    func send(_ message: [String: String]) { peer?.deliver(message) }
    func setHandler(_ handler: @escaping @Sendable ([String: String]) -> Void) { lock.withLock { self.handler = handler } }
    private func deliver(_ message: [String: String]) { lock.withLock { handler }?(message) }
}

/// A stand-in for Core's socket: records what it's sent and replies from a script.
final class FakeCore: SurfaceTransport, @unchecked Sendable {
    private(set) var opened: URL?
    private(set) var sent: [String] = []
    private let lock = NSLock()
    private let (stream, feed) = AsyncStream.makeStream(of: String.self)
    private lazy var iterator = stream.makeAsyncIterator()
    var onSend: (@Sendable (String) -> Void)?

    func open(_ url: URL) async throws { opened = url }
    func send(_ text: String) async throws {
        lock.withLock { sent.append(text) }
        onSend?(text)
    }
    func receive() async throws -> String {
        guard let next = await iterator.next() else { throw RelayError(message: "closed") }
        return next
    }
    func close() { feed.finish() }
    func push(_ json: String) { feed.yield(json) }
    var sentMessages: [[String: Any]] {
        lock.withLock { sent }.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }
}

@MainActor
private func eventually(_ timeout: Duration = .seconds(2), _ check: @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if check() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return check()
}

@MainActor
@Suite struct RelayTests {
    @Test func framesPassBothWaysInOrder() async throws {
        let (watchEnd, phoneEnd) = MemoryLink.pair()
        let core = FakeCore()
        let host = RelayHost(link: phoneEnd, coreSocketURL: { URL(string: "ws://192.168.1.20:8787/v1/surface") }, makeTransport: { core })
        host.start()
        let relay = WatchRelayTransport(link: watchEnd)
        try await relay.open(URL(string: "ws://ignored")!)
        #expect(core.opened?.absoluteString == "ws://192.168.1.20:8787/v1/surface")

        core.push(#"{"type":"challenge","nonce":"n1"}"#)
        #expect(try await relay.receive() == #"{"type":"challenge","nonce":"n1"}"#)
        for i in 0..<5 { try await relay.send("frame-\(i)") }
        let ok1 = await eventually { core.sent.count == 5 }
        #expect(ok1)
        #expect(core.sent == (0..<5).map { "frame-\($0)" })
    }

    @Test func noCoreAddressMeansAClearFailure() async {
        let (watchEnd, phoneEnd) = MemoryLink.pair()
        RelayHost(link: phoneEnd, coreSocketURL: { nil }).start()
        let relay = WatchRelayTransport(link: watchEnd)
        await #expect(throws: RelayError.self) { try await relay.open(URL(string: "ws://x")!) }
    }

    @Test func coreDroppingReachesTheWatch() async throws {
        let (watchEnd, phoneEnd) = MemoryLink.pair()
        let core = FakeCore()
        RelayHost(link: phoneEnd, coreSocketURL: { URL(string: "ws://core/v1/surface") }, makeTransport: { core }).start()
        let relay = WatchRelayTransport(link: watchEnd)
        try await relay.open(URL(string: "ws://x")!)
        core.close()
        await #expect(throws: RelayError.self) { _ = try await relay.receive() }
    }

    /// The whole path: the watch's client, through the iPhone, to Core. The watch signs; the phone only carries.
    @Test func theWatchSignsThroughTheRelay() async throws {
        let (watchEnd, phoneEnd) = MemoryLink.pair()
        let core = FakeCore()
        RelayHost(link: phoneEnd, coreSocketURL: { URL(string: "ws://core/v1/surface") }, makeTransport: { core }).start()
        let identity = try DeviceIdentity.loadOrCreate(deviceID: "watch-r", store: MemoryKeyStore(), useEnclave: false)
        let client = SurfaceClient(manifest: .watch(id: "watch-r"), identity: identity, transport: { WatchRelayTransport(link: watchEnd) })

        core.push(#"{"type":"challenge","nonce":"relay-nonce"}"#)
        let session = Task { await client.session(URL(string: "ws://ignored")!) }
        let ok2 = await eventually { core.sentMessages.contains { $0["type"] as? String == "hello" } }
        #expect(ok2)
        let hello = try #require(core.sentMessages.first { $0["type"] as? String == "hello" })
        let auth = try #require(hello["auth"] as? [String: String])
        let key = try P256.Signing.PublicKey(derRepresentation: identity.publicKeyDER)
        let signature = try P256.Signing.ECDSASignature(derRepresentation: Data(base64Encoded: auth["signature"]!)!)
        #expect(key.isValidSignature(signature, for: DeviceIdentity.helloPayload(nonce: "relay-nonce", deviceID: "watch-r")))

        core.push(#"{"type":"welcome","session_id":"default","surfaces":[],"heartbeat_ms":500}"#)
        core.push(#"{"type":"approval_request","request_id":"apr_w","summary":"Post in #office-hours","tier":"send"}"#)
        let ok3 = await eventually { client.approvals.count == 1 }
        #expect(ok3)
        try await client.answer(client.approvals[0], approved: true)
        let ok4 = await eventually { core.sentMessages.contains { $0["type"] as? String == "approval_response" } }
        #expect(ok4)
        let answer = try #require(core.sentMessages.first { $0["type"] as? String == "approval_response" })
        let approvalSig = try P256.Signing.ECDSASignature(derRepresentation: Data(base64Encoded: answer["signature"] as! String)!)
        #expect(key.isValidSignature(approvalSig, for: DeviceIdentity.approvalPayload(requestID: "apr_w", approved: true, summary: "Post in #office-hours")))
        session.cancel()
        core.close()
    }
}

@MainActor
@Suite struct SpeechTests {
    @Test func sentencesCarryTheirPlaceAndReportBack() async throws {
        let core = FakeCore()
        let client = SurfaceClient(manifest: .glasses(id: "glasses-1"), transport: { core })
        var heard: [Speech] = []
        client.onSpeak = { heard.append($0) }
        core.push(#"{"type":"challenge","nonce":"n"}"#)
        let session = Task { await client.session(URL(string: "ws://core/v1/surface")!) }
        core.push(#"{"type":"speak","text":"Office hours at 3:15.","reply_id":"r1","seq":1,"final":false}"#)
        let ok5 = await eventually { heard.count == 1 }
        #expect(ok5)
        #expect(heard[0] == Speech(text: "Office hours at 3:15.", replyID: "r1", seq: 1, isFinal: false))
        client.spoke(heard[0])
        let ok6 = await eventually { core.sentMessages.contains { $0["type"] as? String == "speak_progress" } }
        #expect(ok6)
        let progress = try #require(core.sentMessages.first { $0["type"] as? String == "speak_progress" })
        #expect(progress["reply_id"] as? String == "r1")
        #expect(progress["seq"] as? Int == 1)
        session.cancel()
        core.close()
    }

    @Test func olderCoresStillSpeak() throws {
        let m = try JSONDecoder().decode(ServerMessage.self, from: Data(#"{"type":"speak","text":"On it."}"#.utf8))
        #expect(m == .speak(Speech(text: "On it.")))
    }
}
