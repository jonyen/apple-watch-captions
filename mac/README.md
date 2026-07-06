# MacCaptions — macOS menu bar caption app

Menu-bar-only (no Dock icon) companion app that will stream Mac mic / system audio to the
caption relay and show live captions. Currently a scaffold: Start/Stop toggles local state only.

## Layout
- `../watch/CaptionCore/` — shared Swift package with the pure logic (`ServerMessage`,
  `CaptionStore`, `SessionController`, protocols). Already supports macOS 13+.
- `MacCaptions/` — the macOS app: `AppModel` (state, later relay/capture), `@main` app
  (`MenuBarExtra` scene, `LSUIElement` so it has no Dock icon or main window).
- `MacCaptionsTests/` — unit test target.
- `project.yml` — XcodeGen project definition. The `.xcodeproj` is generated (gitignored).

## Setup
1. `cd mac && xcodegen generate && open MacCaptions.xcodeproj`
2. Select your signing team in Xcode if `DEVELOPMENT_TEAM` in `project.yml` doesn't match.
3. Run. The app lives in the menu bar (look for the captions icon) — no Dock icon, no window.
4. On first capture, macOS will prompt for **Microphone** access, and separately for
   **Screen Recording** access (required for system-audio capture) — grant both in
   System Settings → Privacy & Security if you miss the prompts.
5. Relay URL / auth token will be configurable from the app's Settings once wired up in a
   later task (mirrors `watch/WatchCaptions/Secrets.swift`).

## Test (logic)
```bash
cd watch/CaptionCore && swift test
```

## Build (app)
```bash
cd mac && xcodebuild build -project MacCaptions.xcodeproj -scheme MacCaptions \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
```
(If you have a Development cert for team 7PZN69YDL4, omit `CODE_SIGNING_ALLOWED=NO`.)

## Test (app target)
```bash
cd mac && xcodebuild test -project MacCaptions.xcodeproj -scheme MacCaptions \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
```
(If you have a Development cert for team 7PZN69YDL4, omit `CODE_SIGNING_ALLOWED=NO`.)
