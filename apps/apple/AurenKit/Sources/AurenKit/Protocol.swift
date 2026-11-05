// Surface Protocol v0, mirrored from core/src/protocol.ts. See spec/surface-protocol.md.
import Foundation

public enum SurfaceKind: String, Codable, Sendable { case watch, glasses, phone, web, desktop, other }
public enum Input: String, Codable, Sendable { case voice, text, camera, touch }
public enum Output: String, Codable, Sendable { case voice, screen, haptic }
public enum Tier: String, Codable, Sendable { case read, write, send }

/// What a surface tells Core about itself in `hello`.
public struct Manifest: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var kind: SurfaceKind
    public var name: String
    public var inputs: [Input]
    public var outputs: [Output]

    public init(id: String, kind: SurfaceKind, name: String, inputs: [Input], outputs: [Output]) {
        self.id = id
        self.kind = kind
        self.name = name
        self.inputs = inputs
        self.outputs = outputs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(SurfaceKind.self, forKey: .kind)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        inputs = try c.decode([Input].self, forKey: .inputs)
        outputs = try c.decode([Output].self, forKey: .outputs)
    }

    // Same capabilities as the console presets in apps/web/index.html.
    public static func phone(id: String, name: String = "iPhone") -> Manifest {
        Manifest(id: id, kind: .phone, name: name, inputs: [.voice, .text, .touch, .camera], outputs: [.voice, .screen])
    }
    public static func watch(id: String, name: String = "Apple Watch") -> Manifest {
        Manifest(id: id, kind: .watch, name: name, inputs: [.voice, .text, .touch], outputs: [.voice, .haptic, .screen])
    }
    public static func glasses(id: String, name: String = "Ray-Ban Meta") -> Manifest {
        Manifest(id: id, kind: .glasses, name: name, inputs: [.voice, .camera], outputs: [.voice])
    }
}

/// A paired device's answer to Core's challenge: the nonce, signed by its Secure Enclave key.
public struct HelloAuth: Codable, Sendable, Equatable {
    public let deviceID: String
    public let signature: String

    public init(deviceID: String, signature: String) {
        self.deviceID = deviceID
        self.signature = signature
    }

    private enum CodingKeys: String, CodingKey { case deviceID = "device_id", signature }
}

/// Surface → Core.
public enum ClientMessage: Encodable, Sendable, Equatable {
    case hello(Manifest, auth: HelloAuth? = nil)
    case heartbeat(active: Bool)
    case utterance(String)
    case approvalResponse(requestID: String, approved: Bool, signature: String? = nil)
    /// A sentence of a reply finished playing here, so Core can resume elsewhere if this surface drops.
    case speakProgress(replyID: String, seq: Int)

    private enum Keys: String, CodingKey { case type, surface, auth, active, text, request_id, approved, signature, reply_id, seq }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .hello(let manifest, let auth):
            try c.encode("hello", forKey: .type)
            try c.encode(manifest, forKey: .surface)
            try c.encodeIfPresent(auth, forKey: .auth)
        case .heartbeat(let active):
            try c.encode("heartbeat", forKey: .type)
            try c.encode(active, forKey: .active)
        case .utterance(let text):
            try c.encode("utterance", forKey: .type)
            try c.encode(text, forKey: .text)
        case .approvalResponse(let requestID, let approved, let signature):
            try c.encode("approval_response", forKey: .type)
            try c.encode(requestID, forKey: .request_id)
            try c.encode(approved, forKey: .approved)
            try c.encodeIfPresent(signature, forKey: .signature)
        case .speakProgress(let replyID, let seq):
            try c.encode("speak_progress", forKey: .type)
            try c.encode(replyID, forKey: .reply_id)
            try c.encode(seq, forKey: .seq)
        }
    }
}

public enum EventKind: String, Decodable, Sendable {
    case utterance, ack, toolCall = "tool_call", receipt, approval, handoff, reply, error, surface, device
    /// A small JPEG of the browser on the Mac after each computer-use step. Decode it with `browserFrame`.
    case browserFrame = "browser_frame"
    case unknown

    public init(from decoder: Decoder) throws {
        self = EventKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// One entry in Core's append-only event log.
public struct AurenEvent: Decodable, Sendable, Identifiable, Equatable {
    public let id: Int
    public let session: String
    /// Milliseconds since 1970, as Core writes it.
    public let at: Double
    public let kind: EventKind
    public let data: [String: JSONValue]

    public var date: Date { Date(timeIntervalSince1970: at / 1000) }
    public func string(_ key: String) -> String? { data[key]?.stringValue }
}

public struct ApprovalRequest: Sendable, Equatable, Identifiable {
    public let id: String
    public let summary: String
    public let tier: Tier
    /// What the approve button does, such as "Post" or "Invite" (Surface Protocol v0.1). Display only:
    /// the signature covers the request, the decision and the summary, never the verb.
    public let verb: String?
    /// A glanceable line of about 60 characters for small screens, such as "Post to #office-hours".
    /// Display only: the signature always covers the full `summary`, which surfaces show when expanded.
    public let short: String?

    public init(id: String, summary: String, tier: Tier, verb: String? = nil, short: String? = nil) {
        self.id = id
        self.summary = summary
        self.tier = tier
        self.verb = verb
        self.short = short
    }

    /// The line to lead with on a small screen: the short summary Core sent, or the full one from an older Core.
    public var headline: String {
        let line = short?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return line.isEmpty ? summary : String(line.prefix(80))
    }

    /// True when the headline leaves something out, so the full summary is worth expanding.
    public var hasMore: Bool { headline != summary }

    /// The approve button's word: the verb Core sent, or "Approve" from an older Core.
    public var actionLabel: String {
        let word = verb?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return word.isEmpty ? "Approve" : String(word.prefix(24))
    }
}

/// One sentence of a reply. `replyID` and `seq` let Core move the rest if this surface drops mid-reply.
public struct Speech: Sendable, Equatable {
    public let text: String
    public let replyID: String?
    public let seq: Int?
    public let isFinal: Bool

    public init(text: String, replyID: String? = nil, seq: Int? = nil, isFinal: Bool = true) {
        self.text = text
        self.replyID = replyID
        self.seq = seq
        self.isFinal = isFinal
    }
}

public struct Card: Sendable, Equatable {
    public let title: String
    public let body: String
}

/// Core asks this surface for one camera frame, for a "this" command. Answer with `FrameUpload` to POST /v1/frames/:request_id.
public struct CaptureRequest: Sendable, Equatable, Identifiable {
    public let id: String
    /// Why Auren is looking, to show while the camera is on.
    public let purpose: String

    public init(id: String, purpose: String) {
        self.id = id
        self.purpose = purpose
    }
}

/// Core → surface.
public enum ServerMessage: Decodable, Sendable, Equatable {
    /// Sent first on every connection; a paired device signs it in its hello.
    case challenge(nonce: String)
    case welcome(sessionID: String, surfaces: [Manifest], heartbeatMs: Int? = nil)
    case event(AurenEvent)
    case speak(Speech)
    case showCard(Card)
    /// v0.1 camera: one frame, only for a "this" command.
    case captureRequest(CaptureRequest)
    case approvalRequest(ApprovalRequest)
    case approvalCancel(requestID: String, reason: String)
    /// A message this build doesn't know yet. Newer Cores add messages; old surfaces ignore them.
    case unknown(type: String)

    private enum Keys: String, CodingKey { case type, nonce, session_id, surfaces, heartbeat_ms, event, text, reply_id, seq, final, title, body, request_id, summary, tier, reason, verb, short }
    private enum CaptureKeys: String, CodingKey { case request_id, purpose }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "challenge":
            self = .challenge(nonce: try c.decode(String.self, forKey: .nonce))
        case "welcome":
            self = .welcome(sessionID: try c.decode(String.self, forKey: .session_id), surfaces: try c.decode([Manifest].self, forKey: .surfaces),
                            heartbeatMs: try c.decodeIfPresent(Int.self, forKey: .heartbeat_ms))
        case "event":
            self = .event(try c.decode(AurenEvent.self, forKey: .event))
        case "speak":
            self = .speak(Speech(text: try c.decode(String.self, forKey: .text),
                                 replyID: try c.decodeIfPresent(String.self, forKey: .reply_id),
                                 seq: try c.decodeIfPresent(Int.self, forKey: .seq),
                                 isFinal: try c.decodeIfPresent(Bool.self, forKey: .final) ?? true))
        case "show_card":
            self = .showCard(Card(title: try c.decode(String.self, forKey: .title), body: try c.decode(String.self, forKey: .body)))
        case "capture_request":
            let k = try decoder.container(keyedBy: CaptureKeys.self)
            self = .captureRequest(CaptureRequest(id: try k.decode(String.self, forKey: .request_id),
                                                  purpose: try k.decodeIfPresent(String.self, forKey: .purpose) ?? ""))
        case "approval_request":
            self = .approvalRequest(ApprovalRequest(id: try c.decode(String.self, forKey: .request_id),
                                                    summary: try c.decode(String.self, forKey: .summary),
                                                    tier: try c.decode(Tier.self, forKey: .tier),
                                                    verb: try c.decodeIfPresent(String.self, forKey: .verb),
                                                    short: try c.decodeIfPresent(String.self, forKey: .short)))
        case "approval_cancel":
            self = .approvalCancel(requestID: try c.decode(String.self, forKey: .request_id), reason: try c.decode(String.self, forKey: .reason))
        default:
            self = .unknown(type: type)
        }
    }
}

/// Any JSON value, for event payloads whose shape depends on the event kind.
public enum JSONValue: Decodable, Sendable, Equatable {
    case string(String), number(Double), bool(Bool), null
    case array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public var stringValue: String? {
        switch self {
        case .string(let s): s
        case .number(let n): n.rounded() == n ? String(Int(n)) : String(n)
        case .bool(let b): String(b)
        default: nil
        }
    }
}
