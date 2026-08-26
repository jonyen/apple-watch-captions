# Captions (iOS)

The iPhone half of the roaming transcriber: a `TranscriberCore`/`SpeechAnalyzer`
service that transcribes for the Apple Watch app over `WatchConnectivity`, plus
a read-only view of the watch's transcript history. There is nothing to press
here — the watch drives everything; you open this app once and leave it
running.

```
 Apple Watch                    WatchConnectivity                 iPhone
┌────────────────┐                                          ┌────────────────┐
│ mic → PCM       │ ───────────────────────────────────────►│ WCTranscriberSvc│
│ (Auto mode)     │  raw audio, one session per capture      │ → TranscriberCore│
│                 │ ◄───────────────────────────────────────│  (SpeechAnalyzer)│
│ live captions   │        caption text back                │                 │
└────────────────┘                                          └────────┬────────┘
                                                                       │ kept sessions only
                                                                       ▼
                                                              ForwardingStore
                                                          (batched, retried POSTs)
                                                                       │
                                                                       ▼
                                                              iMac relay (history,
                                                              summaries, Notion)
```

## What it does

- **Transcriber service** (`WCTranscriberService`): the watch owns the
  microphone and the UI; this app is just the phone-side leg. It receives the
  watch's raw PCM over `WatchConnectivity`, runs it through `TranscriberCore`
  (Apple's on-device `SpeechAnalyzer`), and sends caption text straight back —
  one `TranscriberSession` per watch capture, at most one active at a time.
  Used whenever the phone is reachable from the watch — the watch prefers it
  over the iMac relay. With neither reachable the watch captions alone and
  nothing touches the phone at all.
- **ForwardingStore**: for a *kept* session, the phone durably queues every
  final caption line (and the finish event) to an on-disk `ForwardQueue`, and
  replays it against the iMac relay's `POST /v1/captions` /
  `POST /v1/stop` in the background — batched, retried on a 60 s backoff, so a
  session survives even if the phone only reconnects to the network minutes
  after the watch finished. This is what makes the relay's transcript,
  summary, and history exist for a phone-transcribed session; the phone
  itself never runs a summary.
- **Transcripts tab** (`TranscriptsListView` / `TranscriptDetailView`): reads
  the watch's own transcript history from the iMac relay, using the watch's
  bearer token — shared over `WatchConnectivity` once the watch and phone have
  been near each other (`WatchIdentityStore`, keychain-backed, separate from
  the phone's own device identity). Newest-first list, pull-to-refresh,
  read-only; the empty state explains that captions need to run once near the
  phone before anything shows up here.

The app has two tabs: **Transcriber** (the status view above — waiting /
transcribing, sessions served) and **Transcripts**.

## What it can and cannot hear

Nothing — this app never opens the phone's own microphone. All audio it
processes is PCM the watch already captured and forwarded over
`WatchConnectivity`. (An earlier version of this app captured the phone's own
mic and speaker output for a different, now-abandoned "phone as a bluetooth
relay" design; that code and its ReplayKit broadcast extension are gone.)

## Build and run

```bash
cd ios
cp Shared/Secrets.example.swift Shared/Secrets.swift   # then edit relay URL
xcodegen generate && open PhoneCaptions.xcodeproj
```

No auth token to fill in — the phone registers itself with the relay on first
launch (for `ForwardingStore`) and keeps the token it's issued in the Keychain
(`DeviceIdentity`). The watch's own token — used to read its transcript
history in the Transcripts tab — is a separate identity the watch shares over
`WatchConnectivity` (`WatchIdentityStore`), not this one.

The Xcode project **embeds the watch app** (`ios/project.yml`'s `PhoneCaptions`
target depends on `WatchCaptions`) — one iPhone install delivers both and
`WatchConnectivity` links them as real companions
(`isCompanionAppInstalled`); installed as two separate apps they refuse to
pair. `cd ios && xcodegen generate` regenerates the `.xcodeproj` (gitignored)
after any `project.yml` change.

Requires a physical iPhone for on-device `SpeechAnalyzer`. Signed by a **free
personal team**, which shapes two things:

- **Almost no entitlements** — App Groups, push, and the rest are
  paid-membership capabilities, and free provisioning refuses a build that
  requests one.
- **Seven days.** The build stops launching after a week; rebuild and reinstall.
  An always-on utility that expires weekly is the strongest argument for paying
  the $99.

Trust the certificate on first install: Settings → General → VPN & Device
Management.

## Using it

1. Open Captions on the iPhone once and leave it running (it needs no
   interaction after that — there is no "Listening" toggle anymore; the watch
   drives everything).
2. On the Watch, tap **Start**. If the phone is reachable over
   `WatchConnectivity`, it transcribes; if not, the watch falls back to the
   iMac relay, then to on-device Moonshine.

The Transcriber tab shows waiting vs. transcribing and a running count of
sessions served this launch.

## Icon

`PhoneCaptions/Icon/AppIcon.svg` is the editable source; the asset catalog holds
the render. Same gradient and caption bubble as the watch app — these are
siblings — with arcs for the half this app does, which is passing audio on.

```bash
qlmanage -t -s 1024 -o /tmp/icon PhoneCaptions/Icon/AppIcon.svg
cp /tmp/icon/AppIcon.svg.png PhoneCaptions/Assets.xcassets/AppIcon.appiconset/icon-1024.png
```

QuickLook rather than ImageMagick: `magick` renders this SVG with the gradient
dropped and the arcs missing entirely, and it fails silently — check the PNG,
not the exit code.

## Diagnostics

No App Group means the app cannot share a log file with anything, so it logs to
the `com.jonyen.phonecaptions` subsystem at `notice` level — persisted to disk,
so the phone can be away from the Mac and still have the record.

```bash
sudo /usr/bin/log collect --device-name "Jon Yen iPhone" \
  --start "2026-08-12 12:00:00" --output ~/phone.logarchive
sudo chown -R $(whoami) ~/phone.logarchive
/usr/bin/log show ~/phone.logarchive \
  --predicate 'subsystem == "com.jonyen.phonecaptions"' --style compact
```

`log` is a zsh builtin, hence the absolute path. Collecting from a device needs
root; `log stream --device-name` no longer exists on macOS 26.

## Known limits

- **If iOS terminates the app, nothing on the Watch can restart it.** The
  `WCTranscriberService` can't be woken from a background launch, so after a
  reboot or a memory kill the phone app has to be opened once by hand before
  Auto mode can reach it again — until then Auto quietly falls back to the
  iMac relay or on-device Moonshine.
- The Transcripts tab is only as fresh as the last time the watch shared its
  token — that happens once per app launch on the watch when a phone is
  reachable, so a phone that has never been near the watch this way sees the
  empty state.
- Forwarding a kept session to the relay is best-effort: `ForwardingStore`
  retries on a 60 s backoff, but a phone that never regains network access
  never delivers a queued session.
