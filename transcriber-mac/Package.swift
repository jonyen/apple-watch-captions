// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "caption-transcriber",
    platforms: [.macOS("26.0")],
    dependencies: [
        .package(path: "../TranscriberCore"),
    ],
    targets: [
        .executableTarget(name: "caption-transcriber",
                           dependencies: [.product(name: "TranscriberCore", package: "TranscriberCore")],
                           path: "Sources/caption-transcriber"),
    ],
    swiftLanguageModes: [.v5]
)
