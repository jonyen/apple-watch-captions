// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CaptionRelay",
    platforms: [.watchOS(.v10), .iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "CaptionRelay", targets: ["CaptionRelay"]),
        // The platform half: Keychain and URLSession adapters for
        // `SecureTokenStore`/`DeviceRegistrar`. Split into its own target so
        // the pure `CaptionRelay` target — and `swift test` — never link
        // Security.framework or make a network call.
        .library(name: "CaptionRelayLive", targets: ["CaptionRelayLive"]),
    ],
    dependencies: [
        .package(url: "https://github.com/jonyen/caption-core", from: "0.1.0"),
    ],
    targets: [
        .target(name: "CaptionRelay",
                dependencies: [.product(name: "CaptionCore", package: "caption-core")]),
        .target(name: "CaptionRelayLive", dependencies: ["CaptionRelay"]),
        .testTarget(name: "CaptionRelayTests", dependencies: ["CaptionRelay"]),
    ]
)
