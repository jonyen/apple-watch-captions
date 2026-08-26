# WatchCaptions — watchOS live-caption app

Standalone watchOS app (`WKWatchOnly`, no iPhone companion in the App Store
sense) that captions nearby speech on the wrist. Captions always start
instantly on-watch (Moonshine, on-device); the home screen's capture-mode
button then decides who — if anyone — refines them.
Lowering your wrist does not stop a session. The app declares the `audio`
background mode, so the mic stays live and captions keep accumulating with the
screen off — only **Stop** ends a session.

## Modes

The home screen's mode button (`AppModel.CaptureMode`) cycles between two:

- **Auto** (default, wand icon) — instant local partials refined by the best
  remote transcriber reachable when the session starts: the iPhone over
  `WatchConnectivity` if the "Captions" iPhone app is nearby and its
  transcriber service picks up, else the iMac relay over the network, else
  local-only. A remote failure mid-session degrades to local-only rather than
  dropping captions. This replaces the old separate Cloud/Hybrid modes — Auto
  picks the best available transport itself.
- **Watch only** (applewatch icon) — captions computed entirely on the watch
  (Moonshine); nothing is sent anywhere except the kept-session
  caption/audio uploads described below.

**Keep transcripts** (on by default) is orthogonal to the mode: it decides
whether a session leaves a transcript at all, not where captions are
computed. With Keep on and Auto routing through the phone, the phone is the
one holding the transcript mid-session — it store-and-forwards each kept
session's lines to the iMac relay in the background (`ForwardingStore`,
batched, retried on a 60 s backoff), so the transcript, summary, and history
land on the relay even if the phone only reconnects to the network minutes
after the watch finished talking to it. With Keep on and Auto falling back to
the iMac relay directly (no phone nearby), the relay keeps the transcript the
way it always has. With Keep on in **Watch only**, the watch uploads
captions/audio to the relay itself, same as before.

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

### On device

**On device** — captions computed on the watch with Moonshine Base (watchOS 11+,
best on S9 and later); nothing leaves the watch and nothing is saved.

## Layout
- `CaptionCore` — the pure-logic Swift package (`CaptionStore`, `SessionController`,
  protocols), pulled in remotely from [`jonyen/caption-core`](https://github.com/jonyen/caption-core) (see `project.yml`).
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
2. Edit `Secrets.swift`: set `relayURL` to `wss://watch-captions-relay.fly.dev/stream`. This
   file is gitignored. No auth token to fill in — the app registers itself with the relay
   on first launch and keeps the token it's issued in the Keychain (`DeviceIdentity`).
3. `Scripts/fetch-moonshine.sh` — downloads the on-device Moonshine Base models (~110 MB)
   into `Models/Moonshine/`; the project references that folder, so generate after
   fetching.
4. `cd watch && xcodegen generate && open WatchCaptions.xcodeproj`

## Test (logic)
`CaptionCore`'s tests live in its own repo ([`jonyen/caption-core`](https://github.com/jonyen/caption-core)).
`CaptionRelay`'s tests are local:
```bash
cd CaptionRelay && swift test
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
5. Error check: temporarily point `relayURL` at an unreachable host → app shows
   "Connection lost" / Try Again.
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
