# Captions — macOS menu bar caption app

Menu-bar-only (no Dock icon) companion app that streams Mac mic + system audio to the
caption relay and shows live captions in a floating panel.

## Features
- **Menu bar controls** — Start/Stop, and independent Microphone / System Audio toggles
  (`MacCaptionsApp.swift`, `AppModel`). The menu also shows a small status line
  (Connecting… / Listening… / the current error) driven by the caption store's state.
- **Floating caption panel** — translucent, always-on-top, non-activating panel showing
  the last few caption lines with `Me:` / `Them:` labels (channel 0 = mic, channel 1 =
  system audio). If the session hits an error, the panel shows the error message instead
  of/above the caption lines, so failures are always visible rather than silent.
- **Settings** — relay URL and auth token, entered in the app's Settings window. The URL
  is stored in `UserDefaults`; the token is stored in the Keychain (`SettingsStore.swift`).
- **Transcripts window** — browse past sessions and summaries from the relay's transcript
  store (`TranscriptsView`), the same list that syncs across devices.
- **Permissions** — first capture prompts for **Microphone** access, and separately for
  **Screen Recording** access (required for system-audio capture via ScreenCaptureKit).
  Granting Screen Recording access **requires relaunching the app** before capture will
  actually include system audio — macOS doesn't apply a fresh Screen Recording grant to
  an already-running process.

## Layout
- `../watch/CaptionCore/` — shared Swift package with the pure logic (`ServerMessage`,
  `CaptionStore`, `SessionController`, protocols). Already supports macOS 13+.
- `MacCaptions/` — the macOS app: `AppModel` (state, relay/capture wiring), `DualCapture` +
  `SystemAudioSource` + `MicSource` (audio capture), `CaptionPanel.swift` (floating panel),
  `SettingsStore` (relay URL + Keychain token), `TranscriptsView` (transcripts window), `@main`
  app (`MenuBarExtra` scene, `LSUIElement` so it has no Dock icon or main window).
- `MacCaptionsTests/` — unit test target.
- `project.yml` — XcodeGen project definition. The `.xcodeproj` is generated (gitignored).

## Setup
1. `cd mac && xcodegen generate && open Captions.xcodeproj`
2. Select your signing team in Xcode if `DEVELOPMENT_TEAM` in `project.yml` doesn't match.
3. Run. The app lives in the menu bar (look for the captions icon) — no Dock icon, no window.
4. Open Settings from the menu and enter the relay URL and auth token (mirrors
   `watch/WatchCaptions/Secrets.swift`).
5. On first capture, macOS will prompt for **Microphone** access, and separately for
   **Screen Recording** access — grant both in System Settings → Privacy & Security if you
   miss the prompts. If you grant Screen Recording after the app is already running,
   quit and relaunch it before system-audio capture will work.

## Test (logic)
```bash
cd watch/CaptionCore && swift test
```

## Build (app)
```bash
cd mac && xcodebuild build -project Captions.xcodeproj -scheme Captions \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
```
(If you have a Development cert for team 7PZN69YDL4, omit `CODE_SIGNING_ALLOWED=NO`.)

## Test (app target)
```bash
cd mac && xcodebuild test -project Captions.xcodeproj -scheme Captions \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
```
(If you have a Development cert for team 7PZN69YDL4, omit `CODE_SIGNING_ALLOWED=NO`.)
