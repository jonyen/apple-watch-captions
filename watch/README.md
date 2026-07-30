# WatchCaptions — watchOS live-caption app

Standalone watchOS app that streams the Watch mic to the caption relay and shows live captions.
Lowering your wrist does not stop a session. The app declares the `audio`
background mode, so the mic stays live and captions keep accumulating with the
screen off — only **Stop** ends a session.

Opening the app picks up where you left off: if the last session ended less than
ten minutes ago it resumes that transcript silently, so glancing away mid-conversation
costs nothing. After a longer gap — or after you tap Stop, which is a decision rather
than a pause — you land on a menu: **New session**, **Live caption**, **Continue last**,
**Transcripts**.

Transcripts lists past sessions newest first, each row leading with what the recording
was about and the date beneath. Opening one shows its summary and captions, and offers
to continue that conversation.

### Live caption

**Live caption** — the narrow waveform button beside **New session** — captions
without keeping anything. The relay streams the text to your wrist and writes no
transcript, so there is no summary, no Notion page, and nothing in
**Transcripts** afterwards. The indicator on the captions screen is a hollow ring
rather than a filled dot to say so.

Because nothing is stored, a live session cannot be resumed: Stop or a back-swipe
out of the captions screen ends it for good. Lowering your wrist does not — the
mic stays live and captions keep arriving, the same as a recorded session. Your
last *saved* session is left alone and still waiting under **Continue last**,
though a launch after a live session lands on the menu rather than resuming
anything on its own.

## Layout
- `CaptionCore/` — Swift package with the pure logic (`ServerMessage`, `CaptionStore`,
  `SessionController`, protocols). Unit-tested with `swift test`.
- `WatchCaptions/` — the watchOS app: `RelayClient` (WebSocket), `AudioCapture` (mic →
  16 kHz mono Int16 PCM), `MicPermission`, SwiftUI views, `@main` app.
- `Scripts/stamp-git-commit.sh` — build phase that writes the checkout's commit into
  the built `Info.plist`.
- `project.yml` — XcodeGen project definition. The `.xcodeproj` is generated (gitignored).

## Which build is this
The home screen ends with a line like `1.0 (7664d60)` — the marketing version and the
commit the build came from, so a report from your wrist can name one. A trailing `*`
(`1.0 (7664d60*)`) means the build was made with uncommitted changes, so the commit
alone does not describe it. Builds made outside a git checkout fall back to the build
number.

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
3. Speak (or have someone speak) — captions appear live, flowing as a paragraph with the
   dimmed in-progress text at the end. A pause of a few seconds starts a new paragraph.
   A filled green dot means it's streaming to a saved session; a hollow ring means
   it's streaming live-only and nothing is being kept.
4. Lowering your wrist keeps recording, so the session continues and there is nothing to
   restore. To see a restore, swipe back to the menu (which does end capture) and tap
   **Continue** — the transcript so far reappears above the live captions, and you can
   scroll up to read it. Browse → a transcript → "Continue this session" does the same.
   (Tapping **Stop** ends the session for good — it is never resumed.)
5. Error check: temporarily set a wrong `authToken` → app shows "Connection lost" / Try Again.
6. Live caption check: from the menu, tap the waveform button (**Live caption**), speak,
   then tap **Stop**. Open **Transcripts** and confirm it's unchanged — no new row, no
   summary, nothing exported to Notion. This is hand-only: there's no test target for
   the app, and it also depends on the relay's `ephemeral=1` support being deployed —
   against a relay that doesn't yet honour it, the session saves normally and the app
   now fails loudly ("This relay can't do live captions") instead of silently showing
   the live indicator over a session the relay is quietly keeping.

## Verifying in the simulator

The watchOS simulator has no command-line way to drive taps, so debug builds
accept a launch argument that opens a screen directly:

```bash
xcrun simctl launch <sim-id> com.jonyen.watchcaptions.watchkitapp -startScreen history
```

`captions` and `detail` work the same way.

It is compiled out of release builds.
