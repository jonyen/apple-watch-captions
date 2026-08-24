// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "caption-transcriber",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(name: "caption-transcriber", path: "Sources/caption-transcriber"),
        .testTarget(name: "CaptionTranscriberTests",
                    dependencies: ["caption-transcriber"],
                    path: "Tests/CaptionTranscriberTests"),
    ],
    swiftLanguageModes: [.v5]
)
