// swift-tools-version: 6.2
// auren-keyd: keeps Auren Core's master key sealed to this Mac's Secure Enclave.
import PackageDescription

let package = Package(
    name: "auren-keyd",
    platforms: [.macOS(.v15)],
    targets: [
        .target(name: "KeydCore"),
        .executableTarget(name: "auren-keyd", dependencies: ["KeydCore"]),
        .testTarget(name: "KeydCoreTests", dependencies: ["KeydCore"]),
    ]
)
