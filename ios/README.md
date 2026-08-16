# Phone Captions (iOS)

Captions what your phone can hear, read on the Apple Watch — with nothing to
press on the phone.

The app keeps the microphone running from launch, including with the phone
locked in a pocket, but sends nothing until the Watch is actually reading.
Opening **iPhone audio** on the Watch is what starts the stream; leaving that
screen stops it a few seconds later.

```
 iPhone (always running)                Fly.io relay              Apple Watch
┌──────────────────────┐               ┌──────────────┐         ┌───────────┐
│ mic → PCMConverter   │  POST /v1/audio│ session      │  POST   │ empty body│
│ → 16 kHz mono Int16  │ ──────────────►│ "phone-audio"│◄────────│ role=     │
│                      │  only while    │              │  events │ reader    │
│ GET /v1/presence ────┼───────────────►│ reader seen  │────────►│ captions  │
│ every 3s             │  reader: true? │ in last 10s  │         │ on wrist  │
└──────────────────────┘               └──────────────┘         └───────────┘
```

## Why presence gating

An always-on capture that always streamed would cost roughly 115 MB of data an
hour, keep the cellular radio out of idle continuously, and — the part that
actually decides it — bill streaming transcription by the minute around the
clock, on the order of $200 a month to caption mostly silence.

Gating on a reader turns all three into costs proportional to use, and it makes
the user experience *better* rather than worse: there is nothing to start on the
phone, because opening the Watch screen is the trigger.

Presence is a fading fact rather than a connection. watchOS allows no persistent
connection here (TN3135), so there is no disconnect to observe — only polls that
stop arriving. The relay's `ReaderPresence` answers "read within the last ten
seconds", the Watch marks it on the request it was already making
(`role=reader`), and the phone asks every three seconds.

## Why a separate phone app

The Watch app is `WKWatchOnly` — standalone, with no iPhone companion — so this
is its own app rather than part of it. Converting to a companion would
restructure bundle layout and provisioning for no gain.

You open it once. After that it runs on its own, and the Watch drives it.

## What it can and cannot hear

The microphone hears what is in the air: the phone's own speaker, and the room.
It does not hear audio going to headphones, and it never hears a phone call —
iOS gives no third-party app access to telephony audio at any price. That gap is
what the Twilio watch-held-call design addresses instead.

An earlier version of this app took a different route: a **ReplayKit broadcast
upload extension**, which captures the playback audio of the app on screen
digitally, headphones included. It worked — a spike confirmed the audio arrives
and is not muted even for Apple Fitness+, which was the risk that could have
killed it — but it was abandoned over how it felt to use:

- No API can start a broadcast; it takes three taps through Control Center every
  single time.
- A red status bar for the whole session.
- **Locking the phone ends the broadcast** — measured: `broadcastFinished()`
  fires immediately after the lock button, a clean system stop.

That last point is fatal for a phone in a pocket, which is the case this exists
for. The broadcast version is in git history (`ios/PhoneCaptionsUpload`) if the
headphone case ever becomes worth its ceremony.

## Build and run

```bash
cd ios
cp Shared/Secrets.example.swift Shared/Secrets.swift   # then edit relay URL + token
xcodegen generate && open PhoneCaptions.xcodeproj
```

Requires a physical iPhone. Signed by a **free personal team**, which shapes two
things:

- **No entitlements.** App Groups, push, and the rest are paid-membership
  capabilities, and free provisioning refuses a build that requests one. That is
  why the phone and the Watch agree on a fixed session id
  (`PhoneAudio.sessionID`, in CaptionRelay) rather than negotiating one.
- **Seven days.** The build stops launching after a week; rebuild and reinstall.
  An always-on utility that expires weekly is the strongest argument for paying
  the $99.

Trust the certificate on first install: Settings → General → VPN & Device
Management.

## Using it

1. Open Phone Captions once and leave **Listening** on.
2. On the Watch, open Captions and tap **iPhone audio**.

The phone shows which of three states it is in: off, listening with nothing
sent, or streaming. Resting state is the middle one, and looking idle is the
point — it means nothing is being spent.

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

- **If iOS terminates the app, nothing on the Watch can restart it.** Mic capture
  cannot begin from a background launch, so after a reboot or a memory kill the
  phone app has to be opened once by hand.
- Room audio, not a clean digital feed: distance and noise matter.
- Nothing from headphones, and nothing from calls.
- One session id means one phone. Fine for one person; not a design for two.
