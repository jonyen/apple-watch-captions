// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CaptionCore",
    platforms: [.watchOS(.v10), .iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "CaptionCore", targets: ["CaptionCore"]),
    ],
    targets: [
        .target(name: "CaptionCore"),
        .testTarget(name: "CaptionCoreTests", dependencies: ["CaptionCore"]),
    ]
)
