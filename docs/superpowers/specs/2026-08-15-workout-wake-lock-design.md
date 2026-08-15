# Keeping the screen lit while captioning: a workout session with nothing to show for it

## Problem

Captions are unreadable the moment the screen dims. Set the watch on a table
during a talk and watchOS drops to the Always-On dimmed state within seconds,
which is exactly the situation the app is most useful in and least usable in.

Capture is not the problem. `UIBackgroundModes: audio` keeps the microphone and
the relay POSTs alive, and `WatchCaptionsApp.swift` deliberately does nothing on
`.background` / `.inactive`, so a dimmed or locked watch is still transcribing.
The transcript and the Notion page land either way. What is lost is only the
ability to *read* the captions while they happen.

## What the SDK actually allows

Checked against the WatchOS 26.5 SDK rather than recalled:

| Want | API | Verdict |
|---|---|---|
| Keep the display lit | — | No equivalent of `isIdleTimerDisabled` exists in WatchKit |
| Detect dimming | `EnvironmentValues.isLuminanceReduced` | Exists, but read-only — reports dimming, cannot prevent it |
| Stay frontmost | `WKExtendedRuntimeSession` | Keeps the app up, still dimmed; dies on `ResignedFrontmost`, has an `expirationDate` |
| Keep the display lit | `HKWorkoutSession` | The only mechanism that does it |
| Stop wrist-off locking | — | Nothing. The one wrist symbol in the SDK is `LAPolicyDeviceOwnerAuthenticationWithWristDetection`, which *requires* auth |

### Scope correction

This design addresses dimming only. **It does not stop the watch locking when
taken off the wrist** — there is no API behind that, only Settings → Passcode →
Wrist Detection. Half of the original ask stays a device setting.

### The toggle does not cover call captioning

"Keep screen on" only applies to microphone captioning sessions. The wake lock
is acquired and released inside `SessionController`, and call captioning
(`AppModel.takeCall()` and `callCaptions`) does not go through
`SessionController` — it is a separate path with its own lifecycle. Turning
the toggle on and then tapping "Take call" leaves the screen dimming exactly
as it did before this feature existed.

Hoisting wake-lock ownership up to `AppModel` so it covers both paths is a
restructure this design never scoped, and it is not being made here. The home
screen makes this easy to miss: "Take call" sits in the row directly below
"Keep screen on," which invites reading the toggle as covering everything
below it rather than only the mic session it actually guards.

## Design

### A workout session with no builder

Start an `HKWorkoutSession`, call `startActivity(with:)`, call `end()` when
captioning stops. Never construct an `HKLiveWorkoutBuilder`.

No builder means no samples are collected and `finishWorkout()` is never called,
so no `HKWorkout` is written. The expectation is that nothing appears in Fitness
history and no exercise credit accrues — the lit screen is a property of an
active session, not of the data it records. Both halves of that claim are
unverified today and must be confirmed on-device before this ships (see
Verification).

The conventional Apple pattern pairs the session with a live builder. Here that
would collect heart-rate and energy samples for the sole purpose of discarding
them: more code, more data, same screen.

### The seam

`CaptionCore` stays free of HealthKit, mirroring how `MicPermissionProviding`
already keeps `AVFoundation` out of it:

```swift
public protocol DisplayWakeLocking {
    func acquire() async
    func release()
}
```

`SessionController` takes it as an injected dependency and grows
`start(mode:keepAwake:)`. It acquires on start when the flag is set, and
releases in `stop()` unconditionally — release is idempotent, so a lock can
never outlive the session that took it.

Lifecycle ownership belongs in `SessionController` rather than `AppModel`
because that is already where the start/stop pairing lives, next to audio
capture and mic permission. It is also the layer with unit tests.

`WorkoutWakeLock`, in the watch target, is the only file that imports HealthKit:
availability check, share authorization for workouts, an `.other` / `.indoor`
configuration, and a retained session and delegate.

### Opting in

A "Keep screen on" toggle on the home screen, persisted with `@AppStorage`,
applied to whatever session starts next. `AppModel` reads it and passes it to
`start(mode:keepAwake:)`.

Off by default. A workout session on every glance-and-caption would trade a
permission prompt and a phantom workout for a lit screen nobody asked for; the
propped-on-a-table case is deliberate enough to deserve a deliberate toggle.

The home screen is tight on the 40mm case — the first row is already a split
button — so this lands as a toggle row, not another destination to navigate.

### Configuration

| Change | Where |
|---|---|
| `workout-processing` added to `UIBackgroundModes` | `project.yml` |
| `NSHealthUpdateUsageDescription` | `project.yml` |
| HealthKit entitlement | `project.yml` |

Only `NSHealthUpdateUsageDescription` is listed because the app requests share
authorization and reads nothing. If HealthKit refuses to authorize without
`NSHealthShareUsageDescription` as well, add it rather than widening the
requested scope to match it.

Automatic signing should extend the App ID, and is the most likely thing to
snag.

### Failure behavior

Fail open, quietly. HealthKit unavailable, authorization denied, or a session
that refuses to start all resolve the same way: log it, keep captioning, let the
screen dim as it does today. No alert — interrupting the session you are trying
to read to tell you it will be harder to read is worse than the dimming.

The toggle stays on and simply has no effect. It describes an intent, not a
guarantee.

## Testing

`CaptionCore` tests inject a `FakeWakeLock` and assert the pairing:

- acquired on start when `keepAwake` is set
- not acquired when it is not
- released on stop
- released even when the session fails or the mic is denied

### Verification

The HealthKit half has no unit test and the simulator will not answer honestly.
On-device, after a real session:

1. The screen stays lit for the duration.
2. **Fitness shows no workout and the rings are unmoved.**
3. The workout does not disturb the existing `.record` / `.measurement` audio
   session — captions keep arriving.

Installing to the watch needs it unlocked and on the wrist, or CoreDevice
reports a misleading `12040 "no DDI"`.

## Unknowns

- **Does a builderless session keep the screen lit?** The behavior is believed
  to follow the active session. If it does not, the fallback is to add the
  builder back and still never finish it.
- **Does discarding really mean no exercise credit?** Verification step 2 is
  what decides this. If credit accrues anyway, the honest options are to accept
  it or abandon the approach — not to hide it.

## Rejected alternatives

- **`WKExtendedRuntimeSession`.** No HealthKit, no phantom workout, and no lit
  screen: it keeps the app frontmost in the dimmed state. It does not solve the
  problem.
- **An Always-On-aware caption view.** Reading `isLuminanceReduced` to render
  fewer, larger, higher-contrast lines makes dimming survivable rather than
  preventing it. Cheaper and entitlement-free, and worth doing on its own
  merits — but it is a different feature, not this one.
- **Saving the workout.** An honest record of the time, at the cost of filling
  Fitness and the rings with sitting-still "workouts". Rejected as the default;
  not offered as a setting, since it is a preference set once and never revisited.
