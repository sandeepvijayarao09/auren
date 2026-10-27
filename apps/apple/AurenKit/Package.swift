// swift-tools-version: 6.2
// AurenKit: the Surface Protocol client, models and brand, shared by the iPhone and Apple Watch apps.
import PackageDescription

let package = Package(
    name: "AurenKit",
    platforms: [.iOS(.v26), .watchOS(.v26), .macOS(.v15)],
    products: [.library(name: "AurenKit", targets: ["AurenKit"])],
    targets: [
        .target(name: "AurenKit"),
        .testTarget(name: "AurenKitTests", dependencies: ["AurenKit"]),
    ]
)
