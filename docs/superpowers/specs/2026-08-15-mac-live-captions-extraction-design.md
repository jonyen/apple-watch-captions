# Mac Live Captions Extraction

**Goal:** Extract the Mac captions app into its own repo as a fast, on-device,
hotkey-summoned live caption overlay — and extract the shared core it stands on
into a package both it and this repo depend on.

**Motivating need:** macOS's built-in Live Captions has no direct keyboard
shortcut (only the ⌥⌘F5 Accessibility Shortcut panel) and starts slowly. The
existing mac app already shows captions in a floating overlay; what it lacks is
a global hotkey and independence from the relay.

**Why not Granola:** Granola transcribes in the background to produce meeting
notes; it has no live caption overlay and is not built for read-along latency.
The overlay is the one part of this stack nothing commercial replaces. The
parts Granola does better — summaries, transcript management — are exactly the
relay-backed features this extraction drops from the Mac app.

## Decisions already made

- **Scope: on-device only.** The Mac app keeps no relay code, no transcripts,
  no usage views, no provider picker. `LocalSpeechRelay` (Apple on-device
  speech) becomes its only engine.
- **CaptionCore becomes its own repo**, reshaped so nothing in it knows a relay
  exists.
- **Repo names:** `jonyen/caption-core` and `jonyen/mac-live-captions`, both
  public (matching `apple-watch-captions`).
- **History preserved** via `git filter-repo` for both extractions.
- **Reconciliation first:** local `main` (48 commits: summaries, call audio)
  and `origin/main` (5 commits: multi-tenant relay, exports, CI) forked at
  `38b9ca1` and must merge before any extraction. Merge shape: `backend/**`
  resolves wholesale to `origin/main` — the local backend delta arrives via
  the multi-tenant port plan, per that spec's division of work — while watch
  UI conflicts (9 hunks, 4 files) are hand-resolved and CaptionCore unions
  cleanly (adds on both sides, no textual conflicts).

## 1. Repo topology

Three repos when done.

**`jonyen/caption-core`** — SPM package, ~280 lines. Contents: `CaptionEngine`
(née `Relay`), `CaptionEvent` (née `ServerMessage`, no `Decodable`),
`CaptionStore`, `SessionController`, `AudioCapturing`,
`MicPermissionProviding`. Platforms: macOS 14, watchOS 10, iOS 16. Tagged
`0.1.0` at extraction.

**`jonyen/mac-live-captions`** — the Mac app. Depends on `caption-core` by git
URL. No network code at all.

**`jonyen/apple-watch-captions`** — keeps watch, iOS, and backend. Loses
`mac/` and `watch/CaptionCore/`; depends on `caption-core` by git URL; regains
the relay-specific types as its own code.

**File dispositions** (from the merged lineage, which unions both sides):

| CaptionCore file | Goes to |
|---|---|
| `Protocols.swift` (Relay half → CaptionEngine; audio/permission protocols) | caption-core |
| `ServerMessage.swift` (as `CaptionEvent`, minus wire decoding) | caption-core |
| `CaptionStore.swift`, `SessionController.swift` | caption-core |
| `SessionMode.swift`, `History.swift`, `Paragraphs.swift`, `ExportWatcher.swift`, `CallCaptions.swift`, `CallAudio.swift`, `CallVoice.swift`, `MuLaw.swift`, `PCMConverter.swift`, `Settings.swift`, `LaunchAction.swift`, `BuildInfo.swift`, `PhoneAudio.swift` | repo-local package inside apple-watch-captions, shared by the watch and iOS targets |

Tests follow their types. `ServerMessageTests` moves into the repo-local
package as `RelayMessageTests` (it tests the wire format, which only the
watch/iOS side has).

**Consumers: three, not two.** `ios/PhoneCaptions` consumes CaptionCore by
relative path (`ios/project.yml`) and imports it in `SampleHandler.swift`,
`RelayUploader.swift`, and `PresenceWatcher.swift`. Every reshape step below
applies to watch, iOS, and mac targets alike.

## 2. The reshape (before the split, in place)

Renames and boundary moves happen on a branch in `apple-watch-captions` where
all three consumers still build together, so breakage surfaces immediately.
Reshaping after the split would mean coordinating a breaking change across
three repos.

**`Relay` → `CaptionEngine`.** `connect(mode:)` becomes parameterless
`start()`; `onMessage` becomes `onEvent`. The watch builds its relay and
`SessionController` once and reuses them with a different mode per session, so
`HTTPRelayClient` gains a settable `var mode: SessionMode` that the watch's
single `startCaptions(mode:)` call site sets immediately before
`controller.start()`. Accepted temporal coupling: mode is relay-specific
config, not a core concept, and there is exactly one call site.

**`ServerMessage` → `CaptionEvent`.** The JSON `Decodable` conformance does
not move to caption-core. The repo-local package gains a
`RelayMessage: Decodable` that parses the relay's wire shape and maps to
`CaptionEvent`. This avoids a retroactive conformance and keeps the wire
format in the only module that has a wire.

**`SessionMode` and `HistoryClient` leave core**, which is what makes
`SessionController.start()` parameterless. The prefill logic (restoring a
resumed transcript's scrollback) moves to the watch. Its generation guard —
which stops a superseded session's late history fetch from prepending into a
newer session — must survive the move, so core exposes the minimum needed to
reconstruct it:

```swift
public private(set) var sessionToken: UUID   // regenerated on every start and stop
public var isRunning: Bool
```

The watch owns the prefill task, re-checks both before prepending (a faithful
port of the existing `running && generation == generation` check), and cancels
it in `endCapture()`. `waitForPrefill` and its tests move with it.

## 3. The Mac app after extraction

**Deleted outright:** `WebSocketRelay.swift`, `RelayAPI.swift`,
`TranscriptsView.swift`, `UsageView.swift` (392 lines), and
`ReconnectPolicyTests` (its subject lives inside `WebSocketRelay.swift`).

**Slimmed:** `SettingsStore` loses the relay URL, Keychain token, and
`configured`. `CaptionProvider` and `compareProviders` disappear —
`LocalSpeechRelay` is the only engine, renamed `AppleSpeechEngine` to match
the `CaptionEngine` protocol (the multi-tenant migration spec's pointer to it
as the iPhone on-device reference implementation gets updated to the new
repo). `AppModel.start()` loses the provider fan-out and `ProviderSession`
array; one session, no override parameter.

**Added — the global hotkey:**

- `HotkeyBinding.swift` — pure value type: `keyCode`, `modifiers`, a
  `⌃⌥⌘C`-style display string, UserDefaults encode/decode. Default `⌃⌥⌘C`;
  cleared = no hotkey. The tested part.
- `GlobalHotkey.swift` — thin Carbon `RegisterEventHotKey` wrapper: register,
  fire callback, unregister. Carbon because it is the only permission-free
  global-hotkey API (event taps and NSEvent global monitors need Accessibility
  approval) and works from an `LSUIElement` app with no window focused. The
  app is not sandboxed, so no entitlement work.
- `HotkeyRecorderField.swift` — `NSViewRepresentable` key-capture field for
  Settings. Click, press a combo, it records; Escape cancels, Delete clears.
- The hotkey calls `AppModel.toggle()`. `start()` already shows the overlay
  panel before any audio work, so the panel appears instantly and captions
  stream in behind it.
- **Launch at login** via `SMAppService.mainApp`, behind a Settings toggle —
  without it the hotkey silently does nothing after a reboot.
- Menu shows the current binding beside "Start Captions".

## 4. Order of operations

1. **Reconcile:** merge local `main` and `origin/main` per the merge shape
   above. Gate: watch, iOS, and mac targets build; full test suites pass;
   backend tests pass on the origin side taken wholesale. Also update the
   multi-tenant port plan's `git show main:backend/...` references to
   `backup/local-main-2026-08-15:` — after this merge, `main` stops meaning
   the local lineage the plan copies from.
2. **Reshape** on a branch: renames, boundary moves, prefill port. Gate:
   CaptionCore `swift test`, watch + iOS + mac `xcodebuild test`, all green,
   watch behavior unchanged.
3. **Split caption-core:** `git filter-repo` on `watch/CaptionCore/` →
   `jonyen/caption-core`, push, tag `0.1.0`.
4. **Split mac:** `git filter-repo` on `mac/` → `jonyen/mac-live-captions`,
   push.
5. **In mac-live-captions:** strip relay code, collapse providers, add hotkey
   + recorder + launch-at-login, depend on caption-core. Gate: build + tests;
   manual verification that the hotkey toggles captions with the app
   unfocused (Carbon registration is not unit-testable).
6. **In apple-watch-captions:** delete `mac/` and `watch/CaptionCore/`, add
   the caption-core dependency (both `watch/project.yml` and
   `ios/project.yml`), keep the repo-local relay types. Gate: watch + iOS build
   and test.

Steps 5 and 6 are independent and can proceed in either order once 3–4 land.

## 5. Testing

| Repo | Keeps / gains |
|---|---|
| caption-core | `CaptionStoreTests`; the permission/ready/audio/error half of `SessionControllerTests` |
| mac-live-captions | `InterleaverTests`, `SmokeTest`; gains `HotkeyBindingTests` (round-trip, display string, cleared case) |
| apple-watch-captions | Full existing suite passes unchanged — the gate on the reshape; gains `RelayMessageTests` and the prefill/`waitForPrefill` tests |

Carbon hotkey registration and the recorder field are verified by running the
app, not by unit tests; the report states what was actually observed.

## Out of scope

- The backend port (owned by `docs/superpowers/plans/2026-08-15-multi-tenant-port.md`).
- Local transcript storage in the Mac app (dropped, not rewritten; Granola
  covers notes).
- Publishing caption-core for anyone but these two consumers (no README
  beyond a paragraph, no semver ceremony past `0.1.0`).
- App distribution (signing/notarization for sharing the Mac app).
