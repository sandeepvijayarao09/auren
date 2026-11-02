// auren-keyd: Core runs `auren-keyd unwrap --dir <folder>` at start-up and reads
// the master key (hex) from stdout. Nothing secret is ever written to disk in the clear.
//
//   auren-keyd status   --dir <folder>          JSON: is there a Secure Enclave, is a key sealed
//   auren-keyd unwrap   --dir <folder>          prints the master key; creates one on first run
//   auren-keyd recovery --dir <folder>          prints the recovery code (show it once, store it offline)
//   auren-keyd restore  --dir <folder> <code>   seals a recovered key to this Mac
//   auren-keyd forget   --dir <folder>          deletes the sealed key: all encrypted data becomes unreadable
import CryptoKit
import Foundation
import KeydCore

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("auren-keyd: \(message)\n".utf8))
    exit(1)
}

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: auren-keyd status|unwrap|recovery|restore|forget --dir <folder>") }
args.removeFirst()
guard let flag = args.firstIndex(of: "--dir"), flag + 1 < args.count else { fail("--dir <folder> is required") }
let folder = KeyFolder(args[flag + 1])
args.removeSubrange(flag...(flag + 1))

do {
    switch command {
    case "status":
        print(#"{"secure_enclave":\#(SecureEnclave.isAvailable),"sealed":\#(folder.initialized)}"#)
    case "unwrap":
        let key = folder.initialized ? try folder.open() : try folder.create()
        print(key.map { String(format: "%02x", $0) }.joined())
    case "recovery":
        guard folder.initialized else { fail("no key yet. Run Core once first.") }
        print(Recovery.encode(try folder.open()))
    case "restore":
        guard let code = args.first else { fail("restore needs the recovery code") }
        guard !folder.initialized else { fail("a key is already sealed here. Run forget first if you mean to replace it.") }
        try folder.create(master: try Recovery.decode(code))
        print("restored")
    case "forget":
        try folder.forget()
        print("forgotten")
    default:
        fail("unknown command \(command)")
    }
} catch {
    fail(String(describing: error))
}
