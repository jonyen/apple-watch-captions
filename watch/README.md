# WatchCaptions — watchOS live-caption app

Standalone watchOS app that streams the Watch mic to the caption relay and shows live captions.
Opening the app picks up where you left off: if the last session ended less than
ten minutes ago it resumes that transcript silently, so glancing away mid-conversation
costs nothing. After a longer gap — or after you tap Stop, which is a decision rather
than a pause — you land on a menu: **New session**, **Continue last**, **Transcripts**.

Transcripts lists past sessions newest first, each row leading with what the recording
was about and the date beneath. Opening one shows its summary and captions, and offers
to continue that conversation.

## Layout
- `CaptionCore/` — Swift package with the pure logic (`ServerMessage`, `CaptionStore`,
  `SessionController`, protocols). Unit-tested with `swift test`.
- `WatchCaptions/` — the watchOS app: `RelayClient` (WebSocket), `AudioCapture` (mic →
  16 kHz mono Int16 PCM), `MicPermission`, SwiftUI views, `@main` app.
- `project.yml` — XcodeGen project definition. The `.xcodeproj` is generated (gitignored).

## Setup
1. `cp WatchCaptions/Secrets.example.swift WatchCaptions/Secrets.swift`
2. Edit `Secrets.swift`: set `relayURL` to `wss://watch-captions-relay.fly.dev/stream` and
   `authToken` to the token from the Fly deploy (`/tmp/auth.token`). This file is gitignored.
3. `cd watch && xcodegen generate && open WatchCaptions.xcodeproj`

## Test (logic)
```bash
cd watch/CaptionCore && swift test
```

## Build (app)
```bash
cd watch && xcodebuild build -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)'
```

## Run on your Watch (manual)
1. Open `WatchCaptions.xcodeproj` in Xcode, select your paired Apple Watch, set your signing team.
2. Run. On first launch, allow the microphone prompt.
3. Speak (or have someone speak) — captions appear live (partial dimmed → final). The green dot
   means it's streaming. Lower your wrist / leave the app to stop.
4. Error check: temporarily set a wrong `authToken` → app shows "Connection lost" / Try Again.

## Verifying in the simulator

The watchOS simulator has no command-line way to drive taps, so debug builds
accept a launch argument that opens a screen directly:

```bash
xcrun simctl launch <sim-id> com.jonyen.watchcaptions.watchkitapp -startScreen history
```

It is compiled out of release builds.
