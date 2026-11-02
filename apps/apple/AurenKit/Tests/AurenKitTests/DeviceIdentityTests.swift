import CryptoKit
import Foundation
import Testing
@testable import AurenKit

private func verifies(_ identity: DeviceIdentity, _ signature: Data, _ payload: Data) throws -> Bool {
    let key = try P256.Signing.PublicKey(derRepresentation: identity.publicKeyDER)
    return key.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: signature), for: payload)
}

@Suite struct DeviceIdentityTests {
    @Test func payloadsMatchCoreByteForByte() {
        // The same strings core/src/security/devices.ts signs and verifies.
        #expect(String(decoding: DeviceIdentity.helloPayload(nonce: "n0nce", deviceID: "watch-7f3a"), as: UTF8.self) == "auren-hello\nn0nce\nwatch-7f3a")
        #expect(String(decoding: DeviceIdentity.approvalPayload(requestID: "apr_1", approved: true, summary: "Post in #office-hours"), as: UTF8.self)
            == "auren-approve\napr_1\n1\n58524066d1245a66040b003dd1df2752588e544afb1bf7a5206ddcec0dd7c6c5")
    }

    @Test func softwareKeyIsKeptAndReused() throws {
        let store = MemoryKeyStore()
        let a = try DeviceIdentity.loadOrCreate(deviceID: "phone-1", store: store, useEnclave: false)
        let b = try DeviceIdentity.loadOrCreate(deviceID: "phone-1", store: store, useEnclave: false)
        #expect(a.publicKeyDER == b.publicKeyDER)
        #expect(!a.isHardwareBacked)
        let other = try DeviceIdentity.loadOrCreate(deviceID: "phone-2", store: store, useEnclave: false)
        #expect(other.publicKeyDER != a.publicKeyDER)
    }

    @Test func signsTheChallengeAndApprovals() throws {
        let id = try DeviceIdentity.loadOrCreate(deviceID: "watch-1", store: MemoryKeyStore(), useEnclave: false)
        let auth = try id.helloAuth(nonce: "abc")
        #expect(auth.deviceID == "watch-1")
        #expect(try verifies(id, Data(base64Encoded: auth.signature)!, DeviceIdentity.helloPayload(nonce: "abc", deviceID: "watch-1")))

        let request = ApprovalRequest(id: "apr_9", summary: "Post in #office-hours", tier: .send)
        let sig = Data(base64Encoded: try id.signApproval(request, approved: true))!
        #expect(try verifies(id, sig, DeviceIdentity.approvalPayload(requestID: "apr_9", approved: true, summary: "Post in #office-hours")))
        #expect(try !verifies(id, sig, DeviceIdentity.approvalPayload(requestID: "apr_9", approved: true, summary: "Post in #general")))
    }

    @Test(.enabled(if: SecureEnclave.isAvailable)) func enclaveKeySignsTooAndNeverLeaves() throws {
        let store = MemoryKeyStore()
        let id = try DeviceIdentity.loadOrCreate(deviceID: "mac-test", store: store, useEnclave: true)
        #expect(id.isHardwareBacked)
        let payload = DeviceIdentity.helloPayload(nonce: "n", deviceID: "mac-test")
        #expect(try verifies(id, try id.sign(payload), payload))
        // What's stored is the Secure Enclave's wrapped blob, not a raw 32-byte private key.
        #expect(store.read("auren.mac-test")?.count != 32)
        let again = try DeviceIdentity.loadOrCreate(deviceID: "mac-test", store: store, useEnclave: true)
        #expect(again.publicKeyDER == id.publicKeyDER)
    }

    @Test func messagesCarryTheProof() throws {
        let hello = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ClientMessage.hello(.watch(id: "w"), auth: HelloAuth(deviceID: "w", signature: "c2ln")))) as! [String: Any]
        #expect((hello["auth"] as? [String: String]) == ["device_id": "w", "signature": "c2ln"])
        let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ClientMessage.hello(.watch(id: "w")))) as! [String: Any]
        #expect(plain["auth"] == nil)
        let answer = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ClientMessage.approvalResponse(requestID: "a", approved: false, signature: "c2ln"))) as! [String: Any]
        #expect(answer["signature"] as? String == "c2ln")
        let challenge = try JSONDecoder().decode(ServerMessage.self, from: Data(#"{"type":"challenge","nonce":"xyz"}"#.utf8))
        #expect(challenge == .challenge(nonce: "xyz"))
    }
}
