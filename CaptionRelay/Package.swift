// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CaptionRelay",
    platforms: [.watchOS(.v10), .iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "CaptionRelay", targets: ["CaptionRelay"]),
    ],
    dependencies: [
        .package(url: "https://github.com/jonyen/caption-core", from: "0.1.0"),
    ],
    targets: [
        .target(name: "CaptionRelay",
                dependencies: [.product(name: "CaptionCore", package: "caption-core")]),
        .testTarget(name: "CaptionRelayTests", dependencies: ["CaptionRelay"]),
    ]
)
