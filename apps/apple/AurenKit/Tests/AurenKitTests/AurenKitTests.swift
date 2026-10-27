import Foundation
import Testing
@testable import AurenKit

private func decode(_ json: String) throws -> ServerMessage {
    try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
}

private func object(_ message: ClientMessage) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any])
}

@Suite struct ProtocolTests {
    @Test func helloMatchesCoreSchema() throws {
        let json = try object(.hello(.watch(id: "watch-1")))
        #expect(json["type"] as? String == "hello")
        let surface = try #require(json["surface"] as? [String: Any])
        #expect(surface["id"] as? String == "watch-1")
        #expect(surface["kind"] as? String == "watch")
        #expect(surface["inputs"] as? [String] == ["voice", "text", "touch"])
        #expect(surface["outputs"] as? [String] == ["voice", "haptic", "screen"])
    }

    @Test func approvalResponseUsesCoreFieldNames() throws {
        let json = try object(.approvalResponse(requestID: "apr_1", approved: true))
        #expect(json["type"] as? String == "approval_response")
        #expect(json["request_id"] as? String == "apr_1")
        #expect(json["approved"] as? Bool == true)
    }

    @Test func decodesApprovalRequest() throws {
        let message = try decode(#"{"type":"approval_request","request_id":"apr_1","summary":"Post in #office-hours","tier":"send"}"#)
        #expect(message == .approvalRequest(ApprovalRequest(id: "apr_1", summary: "Post in #office-hours", tier: .send)))
    }

    @Test func decodesReceiptEvent() throws {
        let message = try decode(#"{"type":"event","event":{"id":7,"session":"default","at":1793000000000,"kind":"receipt","data":{"summary":"Moved Office hours to 3:15 PM","undo":true}}}"#)
        guard case .event(let event) = message else { Issue.record("expected an event"); return }
        #expect(event.kind == .receipt)
        #expect(event.line == "Moved Office hours to 3:15 PM")
        #expect(event.style.signal == .done)
        #expect(event.data["undo"] == .bool(true))
    }

    @Test func toleratesWhatItDoesNotKnow() throws {
        #expect(try decode(#"{"type":"browser_frame","jpeg":"…","step":3}"#) == .unknown(type: "browser_frame"))
        let message = try decode(#"{"type":"event","event":{"id":8,"session":"default","at":1,"kind":"usage","data":{}}}"#)
        guard case .event(let event) = message else { Issue.record("expected an event"); return }
        #expect(event.kind == .unknown)
    }

    @Test func socketURL() {
        let local = SurfaceClient.socketURL(core: URL(string: "http://127.0.0.1:8787")!, token: nil)
        #expect(local?.absoluteString == "ws://127.0.0.1:8787/v1/surface")
        let lan = SurfaceClient.socketURL(core: URL(string: "https://core.local:8443/")!, token: "t0k")
        #expect(lan?.absoluteString == "wss://core.local:8443/v1/surface?token=t0k")
        #expect(SurfaceClient.socketURL(core: URL(string: "ftp://x")!, token: nil) == nil)
    }
}

@MainActor
@Suite struct ClientStateTests {
    private func event(_ id: Int, _ kind: String, _ data: String) throws -> ServerMessage {
        try decode(#"{"type":"event","event":{"id":\#(id),"session":"default","at":1,"kind":"\#(kind)","data":\#(data)}}"#)
    }

    @Test func approvalsArriveOnceAndLeaveWhenMoved() {
        let client = SurfaceClient(manifest: .watch(id: "watch-1"))
        var buzzes = 0
        client.onApproval = { _ in buzzes += 1 }
        let request = ApprovalRequest(id: "apr_1", summary: "Post in #office-hours", tier: .send)
        client.apply(.approvalRequest(request))
        client.apply(.approvalRequest(request))
        #expect(client.approvals == [request])
        #expect(buzzes == 1)
        client.apply(.approvalCancel(requestID: "apr_1", reason: "moved"))
        #expect(client.approvals.isEmpty)
    }

    @Test func presenceFollowsSurfaceEvents() throws {
        let client = SurfaceClient(manifest: .phone(id: "phone-1"))
        client.apply(.welcome(sessionID: "default", surfaces: [.phone(id: "phone-1")]))
        #expect(client.state == .online)
        client.apply(try event(1, "surface", #"{"surface_id":"glasses-1","kind":"glasses","status":"online"}"#))
        #expect(client.online.map(\.id) == ["phone-1", "glasses-1"])
        client.apply(try event(2, "surface", #"{"surface_id":"glasses-1","kind":"glasses","status":"offline"}"#))
        #expect(client.online.map(\.id) == ["phone-1"])
    }

    @Test func eventsAreNotDuplicated() throws {
        let client = SurfaceClient(manifest: .phone(id: "phone-1"))
        let receipt = try event(3, "receipt", #"{"summary":"Drafted a reply to Prof. Lee"}"#)
        client.apply(receipt)
        client.apply(receipt)
        #expect(client.events.count == 1)
    }

    @Test func onlyARequestedApprovalIsGold() throws {
        let client = SurfaceClient(manifest: .phone(id: "phone-1"))
        client.apply(try event(4, "approval", #"{"status":"requested","summary":"Post in #office-hours"}"#))
        client.apply(try event(5, "approval", #"{"status":"approved","summary":"Post in #office-hours"}"#))
        #expect(client.events.map(\.style.signal) == [.you, .neutral])
    }
}
