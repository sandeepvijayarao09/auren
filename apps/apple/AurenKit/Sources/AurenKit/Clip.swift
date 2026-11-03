// R12: hold-to-talk clips for the watch. A real Apple Watch can't keep the /v1/voice socket
// open, so it records while you hold, converts to PCM16 mono at 24 kHz, signs the clip with
// its Secure Enclave key and posts it to Core's /v1/voice/clip. If Core isn't reachable from
// the watch, the signed clip goes to the iPhone over WatchConnectivity and the iPhone posts it
// unchanged, so the watch's signature still covers every byte.
import CryptoKit
import Foundation

public extension DeviceIdentity {
    /// Must match clipPayload in core/src/security/devices.ts: the device, when it recorded, and a hash of the exact bytes.
    static func clipPayload(deviceID: String, timestamp: Int64, pcm: Data) -> Data {
        let hash = SHA256.hash(data: pcm).map { String(format: "%02x", $0) }.joined()
        return Data("auren-clip\n\(deviceID)\n\(timestamp)\n\(hash)".utf8)
    }

    func signClip(timestamp: Int64, pcm: Data) throws -> String {
        try sign(Self.clipPayload(deviceID: deviceID, timestamp: timestamp, pcm: pcm)).base64EncodedString()
    }
}

/// Why a clip didn't run. `status` is Core's HTTP status when Core answered.
public struct ClipFailure: Error, LocalizedError, Equatable {
    public let message: String
    public let status: Int?
    public init(_ message: String, status: Int? = nil) {
        self.message = message
        self.status = status
    }
    public var errorDescription: String? { message }
}

/// The audio being recorded: converted PCM16 chunks, up to the 30 seconds Core takes.
public final class ClipBuffer: @unchecked Sendable {
    /// 30 s of PCM16 mono at 24 kHz, Core's cap for one turn.
    public static let maxBytes = 24_000 * 2 * 30
    private var data = Data()
    private let lock = NSLock()

    public init() {}

    /// Adds a chunk, cut to fit. False once the clip is full, so the recorder can stop.
    @discardableResult
    public func append(_ chunk: Data) -> Bool {
        lock.withLock {
            let room = Self.maxBytes - data.count
            if room > 0 { data.append(chunk.prefix(room)) }
            return data.count < Self.maxBytes
        }
    }

    public var bytes: Data { lock.withLock { data } }
    public var seconds: Double { Double(lock.withLock { data.count }) / 48_000 }
}

/// One signed clip, ready to post. The same request comes out whether the watch sends it or the iPhone relays it.
public struct VoiceClip: Sendable, Equatable {
    public let pcm: Data
    public let surfaceID: String
    /// Milliseconds since 1970, when it was recorded. Core refuses a clip more than a minute off.
    public let timestamp: Int64
    /// The paired device that signed it. Without one, Core takes the clip only from the Mac itself.
    public let deviceID: String?
    public let signature: String?

    public static func make(pcm: Data, surfaceID: String, identity: DeviceIdentity?, at date: Date = Date()) throws -> VoiceClip {
        guard !pcm.isEmpty, pcm.count % 2 == 0 else { throw ClipFailure("Nothing was recorded.") }
        guard pcm.count <= ClipBuffer.maxBytes else { throw ClipFailure("A clip can be at most 30 seconds.") }
        let timestamp = Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
        return VoiceClip(pcm: pcm, surfaceID: surfaceID, timestamp: timestamp, deviceID: identity?.deviceID,
                         signature: try identity?.signClip(timestamp: timestamp, pcm: pcm))
    }

    /// The POST to /v1/voice/clip.
    public func request(core: URL, token: String?) throws -> URLRequest {
        guard pcm.count <= ClipBuffer.maxBytes else { throw ClipFailure("A clip can be at most 30 seconds.") }
        var request = URLRequest(url: core.appending(path: "v1/voice/clip"))
        request.httpMethod = "POST"
        request.httpBody = pcm
        // Transcription takes a moment after the upload; the command itself runs on after the reply.
        request.timeoutInterval = 12
        request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        for (name, value) in metadata { request.setValue(value, forHTTPHeaderField: name) }
        if let token, !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        return request
    }

    /// Everything but the audio, as the headers Core reads. It travels beside the file over WatchConnectivity.
    public var metadata: [String: String] {
        var m = ["x-auren-surface": surfaceID, "x-auren-timestamp": String(timestamp)]
        if let deviceID, let signature {
            m["x-auren-device"] = deviceID
            m["x-auren-signature"] = signature
        }
        return m
    }

    /// The clip again, on the iPhone, from the file and metadata the watch sent.
    public init(pcm: Data, metadata: [String: String]) throws {
        guard let surfaceID = metadata["x-auren-surface"], let stamp = metadata["x-auren-timestamp"].flatMap(Int64.init) else {
            throw ClipFailure("The watch's clip arrived without its details.")
        }
        self.init(pcm: pcm, surfaceID: surfaceID, timestamp: stamp, deviceID: metadata["x-auren-device"], signature: metadata["x-auren-signature"])
    }

    init(pcm: Data, surfaceID: String, timestamp: Int64, deviceID: String?, signature: String?) {
        self.pcm = pcm
        self.surfaceID = surfaceID
        self.timestamp = timestamp
        self.deviceID = deviceID
        self.signature = signature
    }

    /// Posts a clip and returns the command Core ran ("" when it heard only the wake phrase).
    /// Network trouble throws the URLError; a refusal from Core throws a ClipFailure with its status.
    public static func post(_ request: URLRequest) async throws -> String {
        let (data, response) = try await URLSession.shared.data(for: request)
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw ClipFailure(body?["error"] as? String ?? "Core didn't take the clip.", status: status) }
        return body?["text"] as? String ?? ""
    }
}

/// Where a clip went: straight to Core (with what it heard), or to the iPhone to post.
public enum ClipRoute: Sendable, Equatable {
    case direct(text: String)
    case relayed
}

/// The watch's side: Core directly when it can be reached, the iPhone when it can't.
public struct ClipSender: Sendable {
    private let post: @Sendable (URLRequest) async throws -> String
    private let relay: (@Sendable (VoiceClip) throws -> Void)?

    public init(post: @escaping @Sendable (URLRequest) async throws -> String = { try await VoiceClip.post($0) },
                relay: (@Sendable (VoiceClip) throws -> Void)? = nil) {
        self.post = post
        self.relay = relay
    }

    public func send(_ clip: VoiceClip, core: URL, token: String?) async throws -> ClipRoute {
        let request = try clip.request(core: core, token: token)
        do {
            return .direct(text: try await post(request))
        } catch let error as URLError {
            // Only when Core couldn't be reached. A refusal (bad signature, stale) would be refused again.
            guard let relay else { throw error }
            try relay(clip)
            return .relayed
        }
    }
}

/// The iPhone's side: posts a clip the watch handed over, byte for byte, with the watch's own signature.
public struct ClipRelayHost: Sendable {
    private let core: @Sendable () -> (url: URL, token: String?)?
    private let post: @Sendable (URLRequest) async throws -> String

    public init(core: @escaping @Sendable () -> (url: URL, token: String?)?,
                post: @escaping @Sendable (URLRequest) async throws -> String = { try await VoiceClip.post($0) }) {
        self.core = core
        self.post = post
    }

    @discardableResult
    public func forward(pcm: Data, metadata: [String: String]) async throws -> String {
        let clip = try VoiceClip(pcm: pcm, metadata: metadata)
        guard let core = core() else { throw ClipFailure("Set the Core address in Auren on your iPhone.") }
        return try await post(clip.request(core: core.url, token: core.token))
    }
}
