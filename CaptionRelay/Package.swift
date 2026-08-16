// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CaptionRelay",
    platforms: [.watchOS(.v10), .iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "CaptionRelay", targets: ["CaptionRelay"]),
    ],
    dependencies: [
        .package(path: "../watch/CaptionCore"),
    ],
    targets: [
        .target(name: "CaptionRelay", dependencies: ["CaptionCore"]),
        .testTarget(name: "CaptionRelayTests", dependencies: ["CaptionRelay"]),
    ]
)
