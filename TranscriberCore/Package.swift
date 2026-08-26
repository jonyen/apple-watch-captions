// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TranscriberCore",
    platforms: [.iOS("26.0"), .macOS("26.0")],
    products: [.library(name: "TranscriberCore", targets: ["TranscriberCore"])],
    targets: [
        .target(name: "TranscriberCore"),
        .testTarget(name: "TranscriberCoreTests", dependencies: ["TranscriberCore"]),
    ],
    swiftLanguageModes: [.v5]
)
