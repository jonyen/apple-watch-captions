# Migrating the live relay to multi-tenancy

## Problem

Two lineages of this repo diverged and both are real.

`main` carries the multi-tenant rewrite: per-device auth, pairing, per-user
transcript scoping, and per-user export destinations with encrypted secrets. It
has never been deployed.

A local branch — preserved as `backup/local-main-2026-08-15` — carries 48
commits the rewrite never saw: expansive transcript summaries, a `resummarize`
CLI, a summarizer-provider chooser, and two-way Twilio call audio. That branch
is what the production relay is actually running.

So the deployed service matches no branch, and deploying `main` as it stands
would regress features in daily use.

| Lost by deploying `main` unchanged | Consequence |
|---|---|
| Expansive summary prompt | Summaries revert to a short overview plus flat bullets |
| `resummarize.ts` | No way to regenerate summaries under a newer prompt |
| `chooseSummarizer.ts` | Provider selection between Claude and Gemini disappears |
| `callUplink`, `callAudioBuffer`, `callPresence`, `mulaw`, `ringback` | Two-way call audio stops; the watch's **Tune in** action has no relay behind it |

The multi-tenancy spec also states plainly that *"no backward compatibility is
provided for currently installed app builds"*. The watch app in daily use stops
working the moment the relay flips.

## Goal

One deploy that loses nothing: the multi-tenant relay, carrying the features the
single-tenant relay already had, with watch and iPhone able to authenticate
against it from the first minute.

## 1. Port before deploying

The port moves four things onto the multi-tenant base. They are not equally
risky and should be attempted in this order, cheapest first, so an expensive
surprise is found while the cheap work is already banked.

1. **The summary prompt.** `SUMMARY_SYSTEM_PROMPT` is a standalone string.
   Mechanical.
2. **`chooseSummarizer.ts`.** Provider selection from configured keys. Mechanical.
3. **`resummarize.ts`.** Needs one real change: the multi-tenant
   `backfillSummaries` takes a `userId` and its transcript root is per user, so
   the CLI must iterate user directories rather than one flat root. Small, but
   not a copy.
4. **Two-way call audio.** Verified: structural, not mechanical. Nothing in
   the five files persists — calls stay ephemeral end to end — and two of them
   (`mulaw`, `ringback`) are pure functions that move as-is. But the other
   three are in-memory call state that the single-tenant `server.ts` creates
   once per process: whose watch is ready (`callPresence`), whose caller's
   audio is waiting (`callAudioBuffer`), whose call the hangup handle ends
   (`callUplink`). Ported unchanged, those globals are a live cross-tenant
   hole, because device registration is open: any registered token could mark
   presence, drain another user's caller audio, speak into their call, or
   hang it up — the same single-global-slot flaw the base already fixed in
   `CurrentCall` by keying it per user. The smallest correct scoping is that
   same fix: key presence, downlink, and uplink by `userId`. The Twilio
   number maps to a user through the device token already embedded in its
   webhook URL — the base's `/twilio/voice` already resolves that token to a
   principal — so a call routes only to its owner's watch, and no new
   identity design is needed. The port is also a merge, not a copy, in
   `twilioStreamHandler` and `CurrentCall`: the base's versions carry the
   `userId`, the local versions carry the audio plumbing and the `twoWay`
   flag, and the ported code needs both halves.

**Item 4 is settled: structural, so it runs as its own task** after the three
mechanical ports. It is days, not a week — the per-user keying repeats a
pattern the base already uses three times over (`CurrentCall`, `SessionStore`,
`ReaderPresence`), and the cross-tenant call tests that must not regress
already exist. It can honestly ship for the operator alone, but only because
single-user-ness then lives in the Twilio configuration — one number, carrying
the operator's device token — not in the code: the per-user keying must happen
regardless, since keeping the process globals and documenting "single user"
would not be a limitation but a leak any self-registered device could exploit.

## 2. Cutover

Approach: snapshot and flip. A parallel-app cutover was considered and rejected —
it doubles cost for a window, and validating the call path there means
repointing the Twilio webhook away from production anyway, so it does not
actually buy an untouched fallback.

1. Rebuild watch and iPhone with device registration (section 3). **Do not
   deploy before these builds exist and install.**
2. Take an **explicit** volume snapshot. Fly's automatic dailies exist with
   five-day retention, but the window between the last daily and the migration
   is exactly the data at risk.
3. Deploy. The boot migration creates a user and a `mac`-kind device row, moves
   every transcript from `<root>/` to `<root>/<userId>/`, deletes
   `settings.json`, and — if `NOTION_TOKEN` and `NOTION_DATABASE_ID` are still
   set — writes them as that user's `notion` destination so exports continue.
   It is idempotent and no-ops on an already-migrated root.
4. Capture the adoption token printed once to the log (`fly logs`). It is the
   only copy.
5. Adopt it into watch and iPhone.
6. Retire the deprecated env vars once exports are confirmed working.

### Rollback

Rollback is **restore then redeploy**, in that order, and the order matters: the
migration relocates transcripts into a per-user directory, and the old
single-tenant code cannot find them there. Redeploying the old image alone
yields a relay that appears healthy and shows an empty transcript list.

1. Restore the pre-migration snapshot.
2. Redeploy the prior image.
3. Reinstall the prior client builds.

Keep the prior Fly release version and the prior client builds identified in
writing before starting, so step 2 is a lookup and not an investigation.

## 3. Clients

Watch and iPhone must work on day one. Both need `DeviceIdentity`, Keychain
storage, and a pairing path, per the multi-tenancy spec's client steps.

The iPhone is the natural place to run pairing: it has a keyboard and a browser,
and it is where the destination picker lands.

### The mac app is extracted, not deleted

Its captioning duplicates the watch and iPhone against a third client that would
otherwise need the same registration work. It leaves this repo by extraction —
carried out separately — which preserves `LocalSpeechRelay.swift` by
construction. That matters: the multi-tenancy spec names that file as the
reference implementation for on-device iPhone transcription, which section 5
makes the free tier of the expansion plan.

### CaptionCore is extracted alongside it, and has two traps

`CaptionCore` lives at `watch/CaptionCore` and is consumed by **three** targets
on `main` — watch, mac, **and iOS** — each by relative path. So its extraction is
not a mac-app cleanup; it is surgery on the iPhone app, which this migration
makes day-one critical.

It is also diverged, like everything else here:

| Only on local `main` | Only on `main` |
|---|---|
| `CallAudio.swift`, `CallVoice.swift`, `MuLaw.swift` | `PhoneAudio.swift`, `Settings.swift` |

Extracting from either lineage silently drops the other's files. Taking `main`
loses exactly the two-way call audio section 1 item 4 is porting forward; taking
local `main` loses the settings the multi-tenant iOS app needs. **CaptionCore
must be reconciled before extraction, or the extraction must merge both sets
deliberately.**

### Division of work

The extraction runs separately from this migration. To keep them from colliding:

- **Parallel-safe:** section 1's port. It is entirely under `backend/` and
  touches nothing the extraction does.
- **Blocked on the extraction:** the client work above. `DeviceIdentity`,
  Keychain storage, and pairing land in the watch and iPhone targets and likely
  in `CaptionCore` itself.

This plan therefore covers the backend port only. Client pairing and the
destination picker follow once `CaptionCore` has settled.

## 4. Destination picker

The phone **chooses**; the browser **configures**.

Notion and email stay configured in the browser, because the relay must host the
OAuth redirect URI regardless — wrapping that in the app hides the round trip
without removing it. The phone lists every destination and selects which receive
each session, including the phone-only ones (Files, iCloud, share sheet) that
need no relay involvement at all.

This keeps the phone free of `client_secret` handling and leaves the existing
relay-side flows untouched.

## 5. What expansion makes load-bearing

Other users will either supply their own Deepgram key or take captions from a
paired iPhone. That answers the cost question the multi-tenancy spec left open —
the operator never pays for another user's transcription — but it promotes two
of that spec's out-of-scope items into pillars:

- **Bring-your-own transcription key** becomes the paid tier. `secretBox` and the
  `export_destinations` pattern already provide per-user AES-256-GCM secret
  storage, so this is a new row type rather than new cryptography.
- **On-device iPhone transcription** becomes the free tier, and needs its own
  spec. watchOS has no `Speech.framework` at all, so the phone is the only place
  it can run — which is also why a watch-only user cannot be on the free tier.

Three items remain genuinely unresolved and should not be quietly inherited:

| Item | What it blocks |
|---|---|
| `/app` viewer authenticates by pasted token in `localStorage` | Any user other than the operator reading transcripts in a browser |
| SQLite on one Fly machine, no Litestream | Durability: one volume failure loses every user's data, not just the operator's |
| No privacy policy, Privacy Nutrition Label, or bystander-consent flow | App Store submission, which the multi-tenancy spec lists as required before release |

Twilio webhook signature validation is also still absent, so anyone who learns
the URL can drive the call path. That is a pre-existing gap, not one this
migration introduces, but it grows teeth once the relay is not a single-user toy.

## 6. Testing

The port carries its own tests forward; the multi-tenant suites already cover
cross-tenant isolation, which is the property that must not regress.

The load-bearing verification is post-cutover and manual, because it spans a
migration that runs once:

1. Every transcript that existed before the deploy is listed afterwards, under
   the adopted user.
2. A new session records, summarizes with the **expansive** prompt, and exports.
3. **Tune in** reaches live call audio, if section 1 item 4 was ported.
4. The watch and iPhone authenticate with their own device tokens, not a shared
   secret.

Item 1 is the one that justifies the snapshot: if it fails, roll back rather
than repair forward.

## Rejected alternatives

- **Deploy `main` now and port afterwards.** Fastest to multi-tenancy, but it
  spends days with degraded summaries and a dead Tune in button, and the client
  rebuild is required either way — so the window buys nothing.
- **Dual-auth transition.** Accepting both `AUTH_TOKEN` and per-device tokens
  removes client-timing pressure, but contradicts the spec's explicit stance and
  adds a second auth path in the component where a mistake means cross-tenant
  data leakage. The cost of getting it wrong is far above the convenience.
- **Keeping the mac app.** A third client needing the same registration work,
  duplicating capability the watch and iPhone already provide.
