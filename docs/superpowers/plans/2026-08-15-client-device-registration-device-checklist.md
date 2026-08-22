# Task 8 — On-Device Verification Checklist

The client cycle (Tasks 1–7, branch `docs/client-device-registration`, tip
`45f3025`) is code-complete: 132 package tests green, both apps build. What
remains is the set of claims only real hardware can settle. This is the
script for settling them, with every command verified against the code it
exercises.

**Time:** ~45 minutes, plus one 10-minute wait if you mistype the pairing
code five times (see Phase 5).

**The one check that matters most** is Phase 3: after using the phone app
*and* running a screen broadcast, the relay must know **exactly one phone
device**. That is the end-to-end proof of the shared-Keychain identity
design — everything else is supporting evidence.

---

## Phase 0 — Stand up a staging relay (~10 min)

**You cannot test against production.** `watch-captions-relay.fly.dev` still
runs the single-tenant relay; it has no `/v1/devices`, so every registration
would 404 before anything else could be tested. Do **not** deploy the
multi-tenant relay to production for this — that is the cutover, it has its
own checklist in the migration spec (§2, including the volume snapshot and
the Twilio webhook repoint), and doing it before PR #11 merges would regress
summaries and call audio.

A staging app costs a few cents for the hour and touches nothing:

```bash
cd ~/Projects/apple-watch-captions
git checkout docs/client-device-registration && git pull
# main does NOT contain this cycle's code — building from it fails at xcodegen
cd backend
fly apps create watch-captions-relay-staging
fly volumes create transcripts --size 1 -a watch-captions-relay-staging --region sjc --yes
fly secrets set -a watch-captions-relay-staging \
  DEEPGRAM_API_KEY="$(doppler secrets get DEEPGRAM_API_KEY --project personal --config prd_watchcaptions --plain)"
fly deploy -a watch-captions-relay-staging
curl https://watch-captions-relay-staging.fly.dev/healthz   # → ok
```

Notes:
- `DEEPGRAM_API_KEY` is the only required secret (`config.ts:72`). Notion,
  email, and encryption are all optional and irrelevant to this test.
- `fly.toml` already sets `TRUST_PROXY_HEADERS = "true"`, which the
  registration rate limiter needs on Fly.
- Registration is limited to **10 per IP per hour**. A full run costs ~2-3
  registrations, so about three complete restarts fit in one hour; scripted
  reinstall loops will not.

**Inspecting relay state.** There is deliberately no HTTP endpoint listing
devices. Inspect the identity database directly (Node 24 image, `node:sqlite`
built in):

```bash
fly ssh console -a watch-captions-relay-staging -C "node -e '
const {DatabaseSync} = process.getBuiltinModule(\"node:sqlite\");
const db = new DatabaseSync(\"/data/transcripts/identity.db\");
console.log(\"users:\", db.prepare(\"select id from users\").all());
console.log(\"devices:\", db.prepare(\"select kind, user_id, id, created_at from devices\").all());
'"
```

Save that as an alias — you will run it after nearly every phase. Transcript
directories: `fly ssh console -a watch-captions-relay-staging -C "ls /data/transcripts"`
(one directory per user, plus `identity.db`).

---

## Phase 1 — Build and install both apps (~10 min)

**1. Point both apps at staging.** `Secrets.swift` is gitignored; create it
from the example in each app:

```swift
// watch/WatchCaptions/Secrets.swift
enum Secrets {
    static let relayURL = URL(string: "wss://watch-captions-relay-staging.fly.dev/stream")!
}
// ios/Shared/Secrets.swift
enum Secrets {
    static let relayURL = URL(string: "https://watch-captions-relay-staging.fly.dev")!
}
```

(The watch's is `wss://…/stream`; `RelayOrigin` derives the HTTPS origin from
it. The iOS one is the bare origin. Both apps carry no auth token — that is
the point.)

**2. Regenerate and build:**

```bash
cd watch && xcodegen generate && cd ../ios && xcodegen generate && cd ..
```

**3. Install to devices.** First device build needs
`-allowProvisioningUpdates` — the iOS targets carry a **new Keychain Sharing
entitlement** (this project's first), and automatic signing must register it
with the App ID, the same way it added HealthKit before:

```bash
cd ios && xcodebuild -project PhoneCaptions.xcodeproj -scheme PhoneCaptions \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates build
cd ../watch && xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'generic/platform=watchOS' -allowProvisioningUpdates build
```

Then install and launch through Xcode (or the CLI device tools). Gotchas
from this project's own history:
- The watch must be **unlocked and on your wrist** or CoreDevice reports a
  misleading `12040 "no DDI"`.
- A `CoreDeviceError 4000` ("disconnected immediately") on install is
  usually transient — retry once before diagnosing.
- Launch fails with "device is locked" if the watch dozed between install
  and launch; wake it and relaunch.

☐ Both apps installed and launch on hardware.

---

## Phase 2 — Prove the entitlement before trusting behavior (~5 min)

The Keychain-sharing design is only as real as the signed entitlement.
Check the *built product*, not the source:

```bash
APP=$(find ~/Library/Developer/Xcode/DerivedData -path "*Debug-iphoneos/PhoneCaptions.app" -not -path "*/PlugIns/*" 2>/dev/null | head -1)
codesign -d --entitlements - "$APP" | grep -A3 keychain
codesign -d --entitlements - "$APP/PlugIns/PhoneCaptionsUpload.appex" | grep -A3 keychain
```

☐ **Both** show the access group as exactly:
`7PZN69YDL4.com.jonyen.phonecaptions.shared`
— matching the Swift literal in `ios/Shared/DeviceIdentity.swift:41`
character for character. A `$(AppIdentifierPrefix)` that resolved to
anything else, or a group present on one binary but not the other, fails
this phase; stop and report rather than continuing.

**Set up the failure detector now:** open **Console.app**, select the
iPhone, and build the filter as two tokens: **Subsystem begins with**
`com.jonyen.phonecaptions` and **Category** `keychain`. Begins-with matters:
the app logs under `com.jonyen.phonecaptions` but the broadcast extension —
the process whose Keychain write Phase 3 actually tests — logs under
`com.jonyen.phonecaptions.upload`, and an exact-match filter silently
excludes it. If the entitlement is refused at runtime, the **only** symptom
anywhere is `Keychain add failed: -34018` in this stream. Nothing in the app
UI will tell you. Leave it running through Phase 3.

**One desk check while you're here** — no client can even *form* a
query-string token (the relay keeps a `?token=` fallback for the old viewer,
so bearer-only transport is proven in the clients, not observable on the
server):

```bash
grep -rn "token=" watch/WatchCaptions ios/Shared ios/PhoneCaptions ios/PhoneCaptionsUpload
```

☐ Zero hits — no app code can send a token any way but the bearer header.

---

## Phase 3 — THE check: one phone, not two (~5 min)

The upload extension is a separate process. The design makes it share the
app's device identity through the Keychain group; the failure mode is that
each registers separately and broadcast captions land under a phantom
second account.

1. ☐ Open the phone app → Settings → **Pair a Watch**. The code screen
   appearing proves registration + bearer auth work end to end (the code
   request is authenticated). Don't use the code yet; back out.

   *Expected quirk:* the Settings screen's caption-size controls may show a
   relay error — `/v1/settings` no longer exists on the multi-tenant relay.
   Known, unrelated to this test, tracked separately.

2. ☐ Start a **screen broadcast** with captions (Control Center → screen
   record long-press → PhoneCaptions), let it run ~10 s, stop it.

3. ☐ **Teardown check** (the race the code specifically guards): note the
   time you stopped the broadcast, then
   `fly ssh console -a watch-captions-relay-staging -C "ls -la /data/transcripts"`
   — the phone user's directory holds **one** `.jsonl` for that session, and
   re-listing a minute later shows it unchanged. A *second* file sharing the
   same session suffix, or one that keeps growing after the stop, means a
   `v1/audio` landed after `v1/stop` and re-opened the session — the exact
   post-stop window and extension-teardown fixes (I1/I2) failing on real
   hardware. Report it; don't rationalize it.
4. ☐ Run the device-inspection one-liner. **Verdict:**
   - `devices` has **exactly one row with `kind: "phone"`** → the design
     holds. ✅
   - Two phone rows with different `user_id`s → the extension minted its
     own identity. Check Console for `-34018`. **Stop here** — everything
     after this would test a broken foundation.

---

## Phase 4 — The watch registers as its own user (~5 min)

1. ☐ Launch the watch app → **New session** → grant mic permission →
   captions stream. (First relay call registers the device.)
2. ☐ Speak a distinctive sentence, stop the session.
3. ☐ Record a short session from the *phone* side too (broadcast from
   Phase 3 already did, if it produced a transcript).
4. ☐ Inspect: `users` has **two** rows; `devices` has the phone (+shared
   extension) under one, `kind: "watch"` under the other.
   `ls /data/transcripts` shows **two user directories**.

This is the "before" picture the merge must change.

---

## Phase 5 — Pairing: the merge (~5 min)

**Know the lockout first:** five failed claims in 10 minutes and the watch
is refused outright (`429`) for the rest of the window — deliberate
brute-force protection (`server.ts:120`). **The two refusals look
different, and that's your diagnostic:** a wrong/expired/consumed code shows
an orange message with the relay's actual reason; a rate-limit `429` throws
and renders as the red **"Couldn't reach the relay. Check your
connection…"** error. So a "connection" error on a watch whose network is
obviously fine means you're rate-limited — wait out the window, don't
reinstall and don't debug Wi-Fi. Codes expire after **10 minutes**; the
phone screen shows a countdown and can reissue (10 issues/hour).

1. ☐ Phone → Settings → Pair a Watch → note the six digits.
2. ☐ Watch → Home → **Pair with iPhone** → dial each digit with the
   Crown → confirm.
3. ☐ Success indication on the watch, screen pops.
4. ☐ **The proof, three ways:**
   - **Watch UI:** its Transcripts list now shows *both* devices' sessions
     — the union is what the wearer sees after merging.
   - **DB:** the watch device row's `user_id` now equals the phone's; the
     old user row is **gone** (deleted when emptied); **no new device row**
     appeared (the watch's token never changed — pairing repoints it, and a
     fresh row here would mean it re-registered instead).
   - **Disk:** one user directory remains; the watch's transcripts moved
     into it (`moveTranscripts` runs after the DB commit; a failure there
     is logged on the relay, never surfaced to the client — check
     `fly logs -a watch-captions-relay-staging` if files look stranded).

---

## Phase 6 — Standalone survives (~3 min)

`WKRunsIndependentlyOfCompanionApp` replaced `WKWatchOnly`; the standalone
cellular case must still work.

1. ☐ Phone: Airplane Mode (or leave it in another room).
2. ☐ Watch: New session → captions still stream (watch's own Wi-Fi/LTE).
3. ☐ **Reboot persistence:** restart the watch, unlock it once, open the
   app, run a short session — then inspect: the device count is
   **unchanged** (no re-registration; the Keychain item survived the
   reboot). The stricter case — a *pre*-first-unlock read, which
   `kSecAttrAccessibleAfterFirstUnlock` exists for — can't be driven by
   hand and stays accepted-untested; record it as such.
4. ☐ Companion note (observational, no pass/fail): how the watch app now
   appears in the iPhone's Watch app is worth a glance — the companion
   relationship (`WKCompanionAppBundleIdentifier`) couldn't be verified in
   any simulator.

---

## If something fails

| Symptom | Meaning | Next step |
|---|---|---|
| `Keychain add failed: -34018` in Console | Entitlement not granted at runtime | Xcode → PhoneCaptions target → Signing & Capabilities: is Keychain Sharing present with the `…phonecaptions.shared` group? Re-run with `-allowProvisioningUpdates`; check the profile on the developer portal |
| Two `kind:"phone"` device rows | App and extension not sharing the item — group mismatch or one binary unsigned for it | Re-run Phase 2's codesign check on **both** binaries; diff the two outputs |
| Pair screen never shows a code | Phone registration/bearer failing | `fly logs -a …-staging` for the request; check `relayURL` in the built `Secrets.swift` |
| Correct code → orange "didn't work" message | Expired (10 min) or already consumed | Reissue on the phone and retype |
| Red "Couldn't reach the relay" while the network is clearly fine | Rate-limited: 429 after 5 missed claims — it renders as a connection error, not a code error | Wait out the 10-minute window; don't reinstall, don't debug Wi-Fi |
| Watch can't reach staging at all | URL typo, or the `wss://…/stream` form got mangled | Confirm `RelayOrigin` output: the origin is `https://watch-captions-relay-staging.fly.dev` |
| Watch transcripts didn't merge in UI | `moveTranscripts` failure (logged, not surfaced) or claim actually failed | `fly logs` for "transcript move failed during pairing"; re-run the DB check — if `user_id` moved, it's the files; if not, the claim |
| A device that ran an older test build re-registers | Expected once: the iOS access group moved between builds, orphaning the old Keychain item | Ignore the extra device row from the old build, or wipe staging and restart the checklist |

---

## Afterwards

- Tell the session what you observed, phase by phase — it records the
  results in the spec, ticks the plan's Task 8 boxes, and closes the cycle.
- Staging teardown when done: `fly apps destroy watch-captions-relay-staging`.
- This checklist deliberately does **not** cover the production cutover —
  that is the migration spec §2 (snapshot → deploy → adoption token →
  **Twilio webhook repoint** → env retirement), gated on PR #11 merging
  first.
