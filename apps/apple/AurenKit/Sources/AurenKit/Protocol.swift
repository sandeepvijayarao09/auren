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

/// Surface → Core.
public enum ClientMessage: Encodable, Sendable, Equatable {
    case hello(Manifest)
    case heartbeat(active: Bool)
    case utterance(String)
    case approvalResponse(requestID: String, approved: Bool)

    private enum Keys: String, CodingKey { case type, surface, active, text, request_id, approved }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .hello(let manifest):
            try c.encode("hello", forKey: .type)
            try c.encode(manifest, forKey: .surface)
        case .heartbeat(let active):
            try c.encode("heartbeat", forKey: .type)
            try c.encode(active, forKey: .active)
        case .utterance(let text):
            try c.encode("utterance", forKey: .type)
            try c.encode(text, forKey: .text)
        case .approvalResponse(let requestID, let approved):
            try c.encode("approval_response", forKey: .type)
            try c.encode(requestID, forKey: .request_id)
            try c.encode(approved, forKey: .approved)
        }
    }
}

public enum EventKind: String, Decodable, Sendable {
    case utterance, ack, toolCall = "tool_call", receipt, approval, handoff, reply, error, surface, unknown

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
}

public struct Card: Sendable, Equatable {
    public let title: String
    public let body: String
}

/// Core → surface.
public enum ServerMessage: Decodable, Sendable, Equatable {
    case welcome(sessionID: String, surfaces: [Manifest])
    case event(AurenEvent)
    case speak(text: String)
    case showCard(Card)
    case approvalRequest(ApprovalRequest)
    case approvalCancel(requestID: String, reason: String)
    /// A message this build doesn't know yet. Newer Cores add messages; old surfaces ignore them.
    case unknown(type: String)

    private enum Keys: String, CodingKey { case type, session_id, surfaces, event, text, title, body, request_id, summary, tier, reason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "welcome":
            self = .welcome(sessionID: try c.decode(String.self, forKey: .session_id), surfaces: try c.decode([Manifest].self, forKey: .surfaces))
        case "event":
            self = .event(try c.decode(AurenEvent.self, forKey: .event))
        case "speak":
            self = .speak(text: try c.decode(String.self, forKey: .text))
        case "show_card":
            self = .showCard(Card(title: try c.decode(String.self, forKey: .title), body: try c.decode(String.self, forKey: .body)))
        case "approval_request":
            self = .approvalRequest(ApprovalRequest(id: try c.decode(String.self, forKey: .request_id),
                                                    summary: try c.decode(String.self, forKey: .summary),
                                                    tier: try c.decode(Tier.self, forKey: .tier)))
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
