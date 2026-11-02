import CryptoKit
import Foundation
import Testing
@testable import KeydCore

// Software keys stand in for the Secure Enclave, which CI machines and the Simulator don't have.
@Suite struct SealerTests {
    @Test func sealsAndOpensWithTheRightKey() throws {
        let key = P256.KeyAgreement.PrivateKey()
        let secret = Data((0..<32).map { UInt8($0) })
        let sealed = try Sealer.seal(secret, to: key.publicKey)
        #expect(sealed.count == 65 + 12 + 32 + 16)
        #expect(try Sealer.open(sealed, with: key) == secret)
    }

    @Test func refusesAnyOtherKey() throws {
        let sealed = try Sealer.seal(Data(repeating: 7, count: 32), to: P256.KeyAgreement.PrivateKey().publicKey)
        #expect(throws: (any Error).self) { try Sealer.open(sealed, with: P256.KeyAgreement.PrivateKey()) }
    }

    @Test func detectsTampering() throws {
        let key = P256.KeyAgreement.PrivateKey()
        var sealed = try Sealer.seal(Data(repeating: 1, count: 32), to: key.publicKey)
        sealed[sealed.count - 1] ^= 0xFF
        #expect(throws: (any Error).self) { try Sealer.open(sealed, with: key) }
        #expect(throws: KeydError.self) { try Sealer.open(Data(repeating: 0, count: 10), with: key) }
    }
}

@Suite struct RecoveryTests {
    @Test func roundTripsThirtyTwoBytes() throws {
        let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        let code = Recovery.encode(key)
        #expect(code.split(separator: "-").count == 13)
        #expect(try Recovery.decode(code) == key)
    }

    @Test func forgivesLookalikesAndCase() throws {
        let key = Data(repeating: 0, count: 32)
        let code = Recovery.encode(key).lowercased().replacingOccurrences(of: "0", with: "o")
        #expect(try Recovery.decode(code) == key)
    }

    @Test func rejectsBadCodes() {
        #expect(throws: KeydError.self) { try Recovery.decode("UUUU") }
        #expect(throws: KeydError.self) { try Recovery.decode("0000-0000") }
    }
}
