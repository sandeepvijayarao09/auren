// This device's identity: a P-256 key in the Secure Enclave (a software key in
// the Simulator, which has no Secure Enclave), kept in the Keychain. It pairs
// once with the code shown on the Mac, then signs the connection challenge and
// every approval. Core checks both against the public key it stored at pairing.
import CryptoKit
import Foundation
import Security

/// Where the key's blob lives. The Keychain in the apps; memory in tests.
public protocol KeyStore: Sendable {
    func read(_ account: String) -> Data?
    func write(_ data: Data, account: String) throws
}

public struct KeychainStore: KeyStore {
    let service = "dev.auren.device-key"

    public init() {}

    public func read(_ account: String) -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: account, kSecReturnData as String: true]
        var out: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    public func write(_ data: Data, account: String) throws {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        // Never synced to iCloud and never restored onto another device.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw PairingError(message: "Couldn't save the device key (Keychain error \(status)).") }
    }
}

public final class MemoryKeyStore: KeyStore, @unchecked Sendable {
    private var items: [String: Data] = [:]
    private let lock = NSLock()

    public init() {}

    public func read(_ account: String) -> Data? { lock.withLock { items[account] } }
    public func write(_ data: Data, account: String) throws { lock.withLock { items[account] = data } }
}

public struct PairingError: Error, LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
}

public struct DeviceIdentity: Sendable {
    enum Key: @unchecked Sendable {
        case enclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)
    }

    public let deviceID: String
    let key: Key

    public var isHardwareBacked: Bool {
        if case .enclave = key { return true }
        return false
    }

    /// SPKI DER, the form Core stores at pairing.
    public var publicKeyDER: Data {
        switch key {
        case .enclave(let k): k.publicKey.derRepresentation
        case .software(let k): k.publicKey.derRepresentation
        }
    }

    /// Loads this device's key, or makes one: in the Secure Enclave when there is one.
    public static func loadOrCreate(deviceID: String, store: KeyStore = KeychainStore(), useEnclave: Bool = SecureEnclave.isAvailable) throws -> DeviceIdentity {
        let account = "auren.\(deviceID)"
        if let blob = store.read(account) {
            if useEnclave, let k = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob) {
                return DeviceIdentity(deviceID: deviceID, key: .enclave(k))
            }
            if !useEnclave, let k = try? P256.Signing.PrivateKey(rawRepresentation: blob) {
                return DeviceIdentity(deviceID: deviceID, key: .software(k))
            }
        }
        if useEnclave {
            let k = try SecureEnclave.P256.Signing.PrivateKey()
            try store.write(k.dataRepresentation, account: account)
            return DeviceIdentity(deviceID: deviceID, key: .enclave(k))
        }
        let k = P256.Signing.PrivateKey()
        try store.write(k.rawRepresentation, account: account)
        return DeviceIdentity(deviceID: deviceID, key: .software(k))
    }

    /// ECDSA P-256 with SHA-256, DER-encoded: what Core's verifier expects.
    public func sign(_ message: Data) throws -> Data {
        switch key {
        case .enclave(let k): try k.signature(for: message).derRepresentation
        case .software(let k): try k.signature(for: message).derRepresentation
        }
    }

    // The exact bytes signed. They must match helloPayload and approvalPayload in core/src/security/devices.ts.
    public static func helloPayload(nonce: String, deviceID: String) -> Data {
        Data("auren-hello\n\(nonce)\n\(deviceID)".utf8)
    }

    public static func approvalPayload(requestID: String, approved: Bool, summary: String) -> Data {
        let hash = SHA256.hash(data: Data(summary.utf8)).map { String(format: "%02x", $0) }.joined()
        return Data("auren-approve\n\(requestID)\n\(approved ? 1 : 0)\n\(hash)".utf8)
    }

    public func helloAuth(nonce: String) throws -> HelloAuth {
        HelloAuth(deviceID: deviceID, signature: try sign(Self.helloPayload(nonce: nonce, deviceID: deviceID)).base64EncodedString())
    }

    /// Signs the decision together with the summary this device showed, so a relay can't swap what you saw.
    public func signApproval(_ request: ApprovalRequest, approved: Bool) throws -> String {
        try sign(Self.approvalPayload(requestID: request.id, approved: approved, summary: request.summary)).base64EncodedString()
    }

    /// Pairs with Core using the six-digit code shown on the Mac.
    public func pair(core: URL, code: String, manifest: Manifest) async throws {
        var request = URLRequest(url: core.appending(path: "pair/finish"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        let body: [String: Any] = [
            "code": code, "device_id": deviceID, "name": manifest.name, "kind": manifest.kind.rawValue,
            "public_key": publicKeyDER.base64EncodedString(), "hardware": isHardwareBacked,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            let reason = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw PairingError(message: reason ?? "Pairing failed. Check the Core address.")
        }
    }
}
