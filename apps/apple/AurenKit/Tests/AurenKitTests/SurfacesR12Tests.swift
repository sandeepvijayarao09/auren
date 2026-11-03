// R12: watch voice clips, timeline media, and approval verbs.
import CryptoKit
import Foundation
import Testing
@testable import AurenKit

private let core = URL(string: "http://192.168.1.20:8787")!
/// 1762200000000 ms: the timestamp Core's test vector uses.
private let recordedAt = Date(timeIntervalSince1970: 1_762_200_000)

private func identity(_ id: String = "watch-7f3a") throws -> DeviceIdentity {
    try DeviceIdentity.loadOrCreate(deviceID: id, store: MemoryKeyStore(), useEnclave: false)
}

private func verifies(_ identity: DeviceIdentity, _ signatureB64: String?, _ payload: Data) throws -> Bool {
    let key = try P256.Signing.PublicKey(derRepresentation: identity.publicKeyDER)
    let der = try #require(Data(base64Encoded: signatureB64 ?? ""))
    return key.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: der), for: payload)
}

private func event(_ json: String) throws -> AurenEvent {
    try JSONDecoder().decode(AurenEvent.self, from: Data(json.utf8))
}

/// A little PCM16: 0.5 s of a rising ramp, so a changed byte is a different clip.
private let pcm = Data((0..<24_000).flatMap { i -> [UInt8] in let s = Int16(truncatingIfNeeded: i * 3); return [UInt8(s & 0xFF), UInt8((s >> 8) & 0xFF)] })

@Suite struct ClipTests {
    @Test func clipPayloadMatchesCoreByteForByte() {
        // The same string core/src/voice/clip.test.ts pins: sha256("abc").
        #expect(String(decoding: DeviceIdentity.clipPayload(deviceID: "watch-7f3a", timestamp: 1_762_200_000_000, pcm: Data("abc".utf8)), as: UTF8.self)
            == "auren-clip\nwatch-7f3a\n1762200000000\nba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @Test func theRequestCarriesTheClipItsTimeAndItsSignature() throws {
        let watch = try identity()
        let clip = try VoiceClip.make(pcm: pcm, surfaceID: "watch-7f3a", identity: watch, at: recordedAt)
        let request = try clip.request(core: core, token: "t0k")
        #expect(request.url?.absoluteString == "http://192.168.1.20:8787/v1/voice/clip")
        #expect(request.httpMethod == "POST")
        #expect(request.httpBody == pcm)
        #expect(request.value(forHTTPHeaderField: "content-type") == "application/octet-stream")
        #expect(request.value(forHTTPHeaderField: "authorization") == "Bearer t0k")
        #expect(request.value(forHTTPHeaderField: "x-auren-device") == "watch-7f3a")
        #expect(request.value(forHTTPHeaderField: "x-auren-surface") == "watch-7f3a")
        #expect(request.value(forHTTPHeaderField: "x-auren-timestamp") == "1762200000000")
        let signature = request.value(forHTTPHeaderField: "x-auren-signature")
        #expect(try verifies(watch, signature, DeviceIdentity.clipPayload(deviceID: "watch-7f3a", timestamp: 1_762_200_000_000, pcm: pcm)))
        #expect(try !verifies(watch, signature, DeviceIdentity.clipPayload(deviceID: "watch-7f3a", timestamp: 1_762_200_000_001, pcm: pcm)))
        #expect(try !verifies(watch, signature, DeviceIdentity.clipPayload(deviceID: "watch-7f3a", timestamp: 1_762_200_000_000, pcm: pcm + Data([0, 0]))))
    }

    @Test func withoutAKeyOnlyTheSurfaceIsNamed() throws {
        let request = try VoiceClip.make(pcm: pcm, surfaceID: "watch-sim", identity: nil).request(core: core, token: nil)
        #expect(request.value(forHTTPHeaderField: "x-auren-surface") == "watch-sim")
        #expect(request.value(forHTTPHeaderField: "x-auren-signature") == nil)
        #expect(request.value(forHTTPHeaderField: "authorization") == nil)
    }

    @Test func refusesWhatCoreWould() throws {
        #expect(throws: ClipFailure.self) { try VoiceClip.make(pcm: Data(), surfaceID: "w", identity: nil) }
        #expect(throws: ClipFailure.self) { try VoiceClip.make(pcm: Data([1, 2, 3]), surfaceID: "w", identity: nil) }
        #expect(throws: ClipFailure.self) { try VoiceClip.make(pcm: Data(count: ClipBuffer.maxBytes + 2), surfaceID: "w", identity: nil) }
    }

    @Test func theBufferStopsAtThirtySeconds() {
        let buffer = ClipBuffer()
        let second = Data(count: 48_000)
        for _ in 0..<29 { #expect(buffer.append(second)) }
        #expect(!buffer.append(second + second), "full: the recorder stops")
        #expect(buffer.bytes.count == ClipBuffer.maxBytes)
        #expect(buffer.seconds == 30)
    }

    @Test func theRelayHandsTheExactBytesThrough() async throws {
        let watch = try identity()
        let clip = try VoiceClip.make(pcm: pcm, surfaceID: "watch-7f3a", identity: watch, at: recordedAt)
        let direct = try clip.request(core: core, token: "t0k")

        // The watch can't reach Core, so the clip goes over the (in-memory) WatchConnectivity file link.
        let carried = Box<(Data, [String: String])>()
        let sender = ClipSender(post: { _ in throw URLError(.cannotConnectToHost) },
                                relay: { carried.value = ($0.pcm, $0.metadata) })
        #expect(try await sender.send(clip, core: core, token: "t0k") == .relayed)
        let (file, metadata) = try #require(carried.value)

        // The iPhone posts it with its own address and token, and changes nothing else.
        let posted = Box<URLRequest>()
        let host = ClipRelayHost(core: { (core, "t0k") }, post: { request in
            posted.value = request
            return "I'm running 15 late."
        })
        #expect(try await host.forward(pcm: file, metadata: metadata) == "I'm running 15 late.")
        let request = try #require(posted.value)
        #expect(request.httpBody == pcm)
        for header in ["x-auren-device", "x-auren-surface", "x-auren-timestamp", "x-auren-signature", "authorization", "content-type"] {
            #expect(request.value(forHTTPHeaderField: header) == direct.value(forHTTPHeaderField: header), "\(header)")
        }
        #expect(try verifies(watch, request.value(forHTTPHeaderField: "x-auren-signature"),
                             DeviceIdentity.clipPayload(deviceID: "watch-7f3a", timestamp: clip.timestamp, pcm: request.httpBody ?? Data())))
    }

    @Test func aRefusalFromCoreIsShownNotRelayed() async throws {
        let relayed = Box<Bool>()
        let sender = ClipSender(post: { _ in throw ClipFailure("That clip is too old, or this device's clock is off.", status: 403) },
                                relay: { _ in relayed.value = true })
        let clip = try VoiceClip.make(pcm: pcm, surfaceID: "watch-7f3a", identity: try identity())
        await #expect(throws: ClipFailure("That clip is too old, or this device's clock is off.", status: 403)) {
            try await sender.send(clip, core: core, token: nil)
        }
        #expect(relayed.value == nil)
    }

    @Test func aClipWithoutItsDetailsIsNotPosted() async {
        let host = ClipRelayHost(core: { (core, nil) }, post: { _ in Issue.record("posted"); return "" })
        await #expect(throws: ClipFailure.self) { try await host.forward(pcm: pcm, metadata: ["x-auren-device": "watch-7f3a"]) }
    }
}

@Suite struct TimelineMediaTests {
    static let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0xFF, 0xD9])

    private func frameEvent(_ frame: String, status: String = "paused", id: Int = 41) throws -> AurenEvent {
        try event(#"{"id":\#(id),"session":"default","at":1793000000000,"kind":"browser_frame","data":{"step":3,"status":"\#(status)","host":"www.opentable.com","title":"Lumen · Reserve","frame":"\#(frame)"}}"#)
    }

    @Test func decodesABrowserFrame() throws {
        let e = try frameEvent("data:image/jpeg;base64,\(Self.jpeg.base64EncodedString())")
        #expect(e.kind == .browserFrame)
        let frame = try #require(e.browserFrame)
        #expect(frame == BrowserFrame(event: e))
        #expect(frame.step == 3)
        #expect(frame.jpeg == Self.jpeg)
        #expect(frame.status == "paused")
        #expect(frame.host == "www.opentable.com")
        #expect(e.line == "www.opentable.com · step 3 · waiting for your tap")
        #expect(e.style.word == "Browser")
        #expect(try frameEvent("data:image/jpeg;base64,\(Self.jpeg.base64EncodedString())", status: "stopped").style.signal == .stopped)
    }

    @Test func onlyJPEGDataURLsUnderTheCapAreShown() throws {
        #expect(try frameEvent("data:image/png;base64,\(Self.jpeg.base64EncodedString())").browserFrame == nil)
        #expect(try frameEvent("https://example.com/frame.jpg").browserFrame == nil)
        #expect(try frameEvent("data:image/jpeg;base64,\(Data("not a jpeg".utf8).base64EncodedString())").browserFrame == nil)
        #expect(try frameEvent("data:image/jpeg;base64,%%%").browserFrame == nil)
        let big = Self.jpeg + Data(count: BrowserFrame.maxBytes)
        #expect(BrowserFrame.decode(dataURL: "data:image/jpeg;base64,\(big.base64EncodedString())") == nil)
        let justUnder = Self.jpeg + Data(count: BrowserFrame.maxBytes - Self.jpeg.count)
        #expect(BrowserFrame.decode(dataURL: "data:image/jpeg;base64,\(justUnder.base64EncodedString())")?.count == BrowserFrame.maxBytes)
    }

    @Test func theTimelineShowsOnlyTheNewestFrame() throws {
        let url = "data:image/jpeg;base64,\(Self.jpeg.base64EncodedString())"
        let events = [try frameEvent(url, status: "ok", id: 40), try event(#"{"id":41,"session":"default","at":1,"kind":"tool_call","data":{}}"#),
                      try frameEvent(url, status: "paused", id: 42), try frameEvent("data:image/png;base64,AAAA", id: 43)]
        #expect(events.liveBrowserFrameID == 42)
        #expect([AurenEvent]().liveBrowserFrameID == nil)
    }

    @Test func aReceiptsCropIsFetchedWithTheToken() throws {
        let receipt = try event(#"{"id":9,"session":"default","at":1,"kind":"receipt","data":{"summary":"Added \"Design Systems Night\"","crop_id":"crop_0123456789abcdef"}}"#)
        let id = try #require(receipt.cropID)
        let request = try #require(CropImage.request(core: core, token: "t0k", cropID: id))
        #expect(request.url?.absoluteString == "http://192.168.1.20:8787/v1/crops/crop_0123456789abcdef")
        #expect(request.value(forHTTPHeaderField: "authorization") == "Bearer t0k")
        #expect(CropImage.request(core: core, token: nil, cropID: id)?.value(forHTTPHeaderField: "authorization") == nil)
    }

    @Test func aCropIdIsNeverAnythingElse() throws {
        for bad in ["../trust", "crop_0123456789ABCDEF", "crop_0123456789abcde", "crop_0123456789abcdef0", "crop_0123456789abcdeg", "crop_01234567/9abcdef"] {
            #expect(CropImage.request(core: core, token: nil, cropID: bad) == nil, "\(bad)")
        }
        let receipt = try event(#"{"id":9,"session":"default","at":1,"kind":"receipt","data":{"summary":"x","crop_id":"../../v1/trust"}}"#)
        #expect(receipt.cropID == nil)
    }

    @Test func aCropMustBeAJPEGFromCore() async throws {
        let request = try #require(CropImage.request(core: core, token: nil, cropID: "crop_0123456789abcdef"))
        let answer = { (status: Int, body: Data) in
            { @Sendable (r: URLRequest) async throws -> (Data, URLResponse) in (body, HTTPURLResponse(url: r.url!, statusCode: status, httpVersion: nil, headerFields: nil)!) }
        }
        #expect(try await CropImage.fetch(request, using: answer(200, Self.jpeg)) == Self.jpeg)
        await #expect(throws: CaptureFailure.self) { try await CropImage.fetch(request, using: answer(404, Data())) }
        await #expect(throws: CaptureFailure.self) { try await CropImage.fetch(request, using: answer(200, Data("<html>".utf8))) }
        await #expect(throws: CaptureFailure.self) { try await CropImage.fetch(request, using: answer(200, Self.jpeg + Data(count: CropImage.maxBytes))) }
    }
}

@Suite struct ApprovalVerbTests {
    @Test func theButtonSaysWhatItDoes() throws {
        let message = try JSONDecoder().decode(ServerMessage.self, from: Data(#"{"type":"approval_request","request_id":"apr_2","summary":"Post to #office-hours: \"Running 15 late\"","tier":"send","verb":"Post"}"#.utf8))
        guard case .approvalRequest(let request) = message else { Issue.record("expected an approval request"); return }
        #expect(request.verb == "Post")
        #expect(request.actionLabel == "Post")
        #expect(ApprovalRequest(id: "a", summary: "s", tier: .send).actionLabel == "Approve", "an older Core sends no verb")
        #expect(ApprovalRequest(id: "a", summary: "s", tier: .send, verb: "  ").actionLabel == "Approve")
    }

    @Test func theVerbIsNotSigned() throws {
        let watch = try identity()
        let withVerb = ApprovalRequest(id: "apr_3", summary: "Send an invite to priya@example.com?", tier: .send, verb: "Invite")
        let signature = try watch.signApproval(withVerb, approved: true)
        // Exactly the payload Core checks, which has no verb in it.
        #expect(try verifies(watch, signature, DeviceIdentity.approvalPayload(requestID: "apr_3", approved: true, summary: "Send an invite to priya@example.com?")))
    }
}

/// A value a @Sendable closure can set, for tests.
final class Box<T>: @unchecked Sendable {
    private var stored: T?
    private let lock = NSLock()
    var value: T? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}
