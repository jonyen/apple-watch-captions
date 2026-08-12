# Phone Captions (iOS)

Captions whatever is playing on the iPhone, read on the Apple Watch.

A ReplayKit **broadcast upload extension** receives the playback audio of the app
on screen, resamples it to the relay's wire format, and posts it into a fixed
relay session. The Watch polls that same session under **iPhone audio** on its
menu and shows the captions. Nothing is saved: the session is marked ephemeral,
so the relay writes no transcript, runs no summary, and exports nothing.

```
 iPhone                                  Fly.io relay              Apple Watch
┌──────────────────────┐  POST /v1/audio ┌──────────────┐  POST   ┌───────────┐
│ app audio (44.1 kHz  │ ───────────────►│ session      │◄────────│ empty body│
│ stereo Int16)        │  session=       │ "phone-audio"│  events │ captions  │
│ → PCMConverter       │  phone-audio    │              │────────►│ on wrist  │
│ → 16 kHz mono Int16  │                 └──────────────┘         └───────────┘
└──────────────────────┘
```

No relay change was needed: `feed` and `drain` are already keyed by session, with
the cursor carried per request, so a producer and a reader share one session
without either knowing about the other.

## Status: parked

Built and building on both sides, **not yet tested end to end**. The reason is
the user experience rather than the code: starting a broadcast takes three taps
through Control Center, shows a red status bar throughout, and ends whenever the
phone locks — and none of that is fixable, since iOS offers no way to start a
broadcast programmatically.

For audio playing out of the phone's speaker, the Watch's own microphone captions
the same thing in one tap, with no phone app at all. The broadcast path earns its
keep only when the audio never reaches the air (headphones) or the phone is out
of earshot.

## Why a separate phone app

A broadcast upload extension can only ship inside an iOS app; there is no
standalone extension. `PhoneCaptions.app` exists to host it and to offer the
start button. After the first launch it need never be opened again — Control
Center → long-press Screen Recording → Phone Captions works without it.

It is a separate app rather than part of the Watch app because that app is
`WKWatchOnly` — standalone, with no iPhone companion. Adding an iOS extension
needs an iOS app target, and converting to a companion app would restructure
bundle layout and provisioning for no gain.

## What the spike established

Before any of this was built, a throwaway version measured whether the idea was
possible at all — because a broadcast extension might receive nothing, or receive
buffers full of zeroes for protected content, which looks identical to success
unless you check the samples.

Findings (2026-08-12, iPhone 16, iOS 26.6):

| Test | Result |
|---|---|
| YouTube | ~43 buffers/sec, `peak 1.000  rms 0.567` while playing, silence before |
| Apple Fitness+ | Same — **not DRM-blocked**, the risk that could have killed the idea |
| Format | 44.1 kHz, 2 ch, 16-bit int, interleaved |
| Screen | Not blanked; ~61 video fps throughout, Fitness+ included |
| Locking the phone | **Ends the broadcast** — `broadcastFinished()` right after the lock button, a clean system stop rather than a crash |

Not tested: AirPods routing and Apple Music. Both would need running before
relying on them.

The measured levels are hot — `rms 0.567` with `peak 1.000` pinned every second is
louder than normal program material should read — so treat the absolute numbers
as approximate. The silence-to-signal transition is what carries the finding, and
that is unambiguous.

## Build and run

Requires a physical iPhone. Broadcast extensions do not work in the Simulator.

```bash
cd ios
cp Shared/Secrets.example.swift Shared/Secrets.swift   # then edit relay URL + token
xcodegen generate && open PhoneCaptions.xcodeproj
```

This builds under a **free personal team**, which shapes two things:

- **No entitlements.** App Groups, push, and the rest are paid-membership
  capabilities, and free provisioning refuses a build that requests one. That is
  why the extension and the Watch agree on a fixed session id
  (`PhoneAudio.sessionID`, in CaptionCore) rather than negotiating one — a
  broadcast extension cannot reach its containing app without an App Group.
- **Seven days.** The build stops launching after a week; rebuild and reinstall.

Trust the certificate on first install: Settings → General → VPN & Device
Management.

## Using it

1. Open Phone Captions once, tap **Start / Stop Broadcast**, choose Phone
   Captions, then Start Broadcast. Afterwards Control Center → long-press Screen
   Recording reaches it without opening the app.
2. On the Watch, open Captions and tap **iPhone audio**.

Leaving the Watch screen stops reading but leaves the broadcast running — the
same distinction as leaving call captions without hanging up.

## Diagnostics

The extension has no UI, and without an App Group it cannot write anywhere the
app can read, so it logs to the `com.jonyen.phonecaptions` subsystem at `notice`
level — persisted to disk, so the phone can be away from the Mac and still have
the record when it comes back.

```bash
sudo /usr/bin/log collect --device-name "Jon Yen iPhone" \
  --start "2026-08-12 11:00:00" --output ~/phone.logarchive
sudo chown -R $(whoami) ~/phone.logarchive
/usr/bin/log show ~/phone.logarchive \
  --predicate 'subsystem == "com.jonyen.phonecaptions"' --style compact
```

`log` is a zsh builtin, hence the absolute path. Collecting from a device needs
root; `log stream --device-name` no longer exists on macOS 26.

## Known limits

- The broadcast ends when the phone locks.
- It cannot be started programmatically: three taps, every time.
- Telephony audio is out of reach — ReplayKit never sees a phone or FaceTime
  call. That gap is what the Twilio watch-held-call design addresses instead.
- One session id means one phone. Fine for one person; not a design for two.
