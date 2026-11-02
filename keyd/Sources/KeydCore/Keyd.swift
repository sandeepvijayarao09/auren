// Seals a 32-byte master key to a P-256 key that lives in the Secure Enclave.
// The sealed file is useless without this Mac's Secure Enclave: ECDH with a
// one-time key, HKDF-SHA256, then AES-256-GCM (an ECIES construction).
import CryptoKit
import Foundation

/// A P-256 key that can do key agreement: a Secure Enclave key, or a software key in tests.
public protocol AgreementKey {
    var publicKey: P256.KeyAgreement.PublicKey { get }
    func sharedSecretFromKeyAgreement(with publicKeyShare: P256.KeyAgreement.PublicKey) throws -> SharedSecret
}

extension SecureEnclave.P256.KeyAgreement.PrivateKey: AgreementKey {}
extension P256.KeyAgreement.PrivateKey: AgreementKey {}

public enum KeydError: Error, CustomStringConvertible {
    case noSecureEnclave, corrupt, badRecoveryCode

    public var description: String {
        switch self {
        case .noSecureEnclave: "This Mac has no Secure Enclave. Set AUREN_SECRET instead."
        case .corrupt: "The sealed key file is damaged."
        case .badRecoveryCode: "That recovery code isn't valid."
        }
    }
}

public enum Sealer {
    static let info = Data("auren/keyd/master/v1".utf8)
    static let pubLength = 65

    static func wrappingKey(_ shared: SharedSecret, ephemeral: P256.KeyAgreement.PublicKey, recipient: P256.KeyAgreement.PublicKey) -> SymmetricKey {
        shared.hkdfDerivedSymmetricKey(using: SHA256.self,
                                       salt: ephemeral.x963Representation + recipient.x963Representation,
                                       sharedInfo: info,
                                       outputByteCount: 32)
    }

    /// One-time public key (65 bytes) followed by the AES-GCM box (nonce, ciphertext, tag).
    public static func seal(_ secret: Data, to recipient: P256.KeyAgreement.PublicKey) throws -> Data {
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipient)
        let box = try AES.GCM.seal(secret, using: wrappingKey(shared, ephemeral: ephemeral.publicKey, recipient: recipient))
        guard let combined = box.combined else { throw KeydError.corrupt }
        return ephemeral.publicKey.x963Representation + combined
    }

    public static func open(_ sealed: Data, with key: AgreementKey) throws -> Data {
        guard sealed.count > pubLength + 28 else { throw KeydError.corrupt }
        let ephemeral = try P256.KeyAgreement.PublicKey(x963Representation: Data(sealed.prefix(pubLength)))
        let shared = try key.sharedSecretFromKeyAgreement(with: ephemeral)
        let box = try AES.GCM.SealedBox(combined: Data(sealed.dropFirst(pubLength)))
        return try AES.GCM.open(box, using: wrappingKey(shared, ephemeral: ephemeral, recipient: key.publicKey))
    }
}

/// Recovery codes: the master key in Crockford base32, in groups of four, shown once.
public enum Recovery {
    static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    public static func encode(_ key: Data) -> String {
        var bits = 0, value = 0
        var out = ""
        for byte in key {
            value = (value << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                out.append(alphabet[(value >> (bits - 5)) & 31])
                bits -= 5
            }
        }
        if bits > 0 { out.append(alphabet[(value << (5 - bits)) & 31]) }
        return stride(from: 0, to: out.count, by: 4).map { i in
            String(out[out.index(out.startIndex, offsetBy: i)..<out.index(out.startIndex, offsetBy: min(i + 4, out.count))])
        }.joined(separator: "-")
    }

    public static func decode(_ code: String) throws -> Data {
        // Crockford: I and L read as 1, O as 0; dashes and spaces are ignored.
        let cleaned = code.uppercased().compactMap { ch -> Character? in
            switch ch {
            case "-", " ": nil
            case "I", "L": "1"
            case "O": "0"
            default: ch
            }
        }
        var bits = 0, value = 0
        var out = Data()
        for ch in cleaned {
            guard let v = alphabet.firstIndex(of: ch) else { throw KeydError.badRecoveryCode }
            value = (value << 5) | v
            bits += 5
            if bits >= 8 {
                out.append(UInt8((value >> (bits - 8)) & 0xFF))
                bits -= 8
            }
        }
        guard out.count == 32 else { throw KeydError.badRecoveryCode }
        return out
    }
}

/// The two files in the key folder. Both are owner-only; neither is useful off this Mac.
public struct KeyFolder {
    public let url: URL
    public var enclaveKey: URL { url.appending(path: "enclave.key") }
    public var sealedMaster: URL { url.appending(path: "master.sealed") }

    public init(_ path: String) {
        url = URL(fileURLWithPath: path, isDirectory: true)
    }

    public var initialized: Bool {
        FileManager.default.fileExists(atPath: enclaveKey.path) && FileManager.default.fileExists(atPath: sealedMaster.path)
    }

    func write(_ data: Data, to file: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try data.write(to: file, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    /// Seals `master` (or a new random key) to a new Secure Enclave key and saves both files.
    @discardableResult
    public func create(master: Data? = nil) throws -> Data {
        guard SecureEnclave.isAvailable else { throw KeydError.noSecureEnclave }
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey()
        let secret = master ?? SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        try write(key.dataRepresentation, to: enclaveKey)
        try write(try Sealer.seal(secret, to: key.publicKey), to: sealedMaster)
        return secret
    }

    public func open() throws -> Data {
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: try Data(contentsOf: enclaveKey))
        return try Sealer.open(try Data(contentsOf: sealedMaster), with: key)
    }

    /// Crypto-shredding: without these two files, everything encrypted under the master key is unreadable.
    public func forget() throws {
        for file in [enclaveKey, sealedMaster] where FileManager.default.fileExists(atPath: file.path) {
            try FileManager.default.removeItem(at: file)
        }
    }
}
