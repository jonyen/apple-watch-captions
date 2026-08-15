# Multi-Tenancy and Transcript Exports — Design Spec

**Date:** 2026-08-14
**Status:** Approved design, pre-implementation

## 1. Purpose

The relay is single-tenant. One shared `AUTH_TOKEN` is compiled into every app
build, `SettingsStore` holds exactly one `Settings` object, `TranscriptStore`
writes to one flat directory, and `SessionStore` keys sessions by a bare session
id. A second user on the deployed relay would read the first user's transcripts,
overwrite their settings, and — by guessing a session id — poll their live
captions.

This spec makes the relay multi-tenant and replaces the single global Notion
integration with per-user export destinations the user configures from the
iPhone app.

Two changes decided during design shrink the work rather than growing it:

- **The phone becomes the transcript store of record.** The relay keeps a copy
  so the mac app and the `/app` viewer keep working, but the phone owns the
  data.
- **Settings leave the relay entirely.** They only ever lived there because the
  watch app is `WKWatchOnly` and had no channel to the phone. Switching the
  watch to `WKRunsIndependentlyOfCompanionApp` restores WatchConnectivity, so
  `settingsStore.ts` and `/v1/settings` are deleted instead of scoped.

## 2. Prerequisite: paid Apple Developer Program membership

`ios/project.yml` pins `DEVELOPMENT_TEAM: 7PZN69YDL4`, the free personal team,
and documents that App Groups, push, and other entitlements are unavailable —
which is why the phone and watch agree on a fixed session id rather than
negotiating one.

Every client-side change in this spec — all of section 7 — needs the paid
membership ($99/yr), as does App Store distribution. Sections 3 through 6, the
entire backend, do not, and are sequenced first so implementation is not blocked
on it.

## 3. Identity model

### Schema

SQLite via `better-sqlite3`, one database file on the Fly volume.

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);

CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('watch','phone','mac')),
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE pairing_codes (
  code        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE export_destinations (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('notion','email')),
  config      TEXT NOT NULL,          -- JSON; secrets encrypted at rest
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);
```

Only relay-side destinations appear in `export_destinations`. Files/iCloud and
the share sheet are phone-local and the relay never learns about them.

### Registration

`POST /v1/devices` is the only unauthenticated write.

- Request: `{ "kind": "watch" | "phone" | "mac" }`
- Response: `{ "deviceId": "...", "token": "...", "userId": "..." }`

The server creates a fresh `users` row and a `devices` row pointing at it. The
token is 32 random bytes, base64url-encoded. **Only its SHA-256 is stored**, so
a database leak yields no working credentials.

Unauthenticated registration is an abuse vector: anyone can mint accounts. Since
this spec ships no cloud STT on a free account, a junk account costs one table
row, so per-IP rate limiting (10 registrations per hour) is sufficient. This
must be revisited before any free tier grants metered cloud minutes.

### Pairing

The phone and watch register independently and therefore start as two separate
users. Pairing merges them.

1. Phone calls `POST /v1/pair/code` with its token. Response:
   `{ "code": "483920", "expiresAt": "..." }` — six digits, 10-minute TTL,
   single use.
2. Watch calls `POST /v1/pair/claim { "code": "483920" }` with its own token.
3. The server, in one transaction: verifies the code is unexpired and
   unconsumed, reassigns any transcripts under the watch's current user to the
   phone's user, repoints the watch's `devices.user_id` at the phone's user,
   deletes the now-orphaned user row, and stamps `consumed_at`.
4. Response: `{ "userId": "..." }` — the phone's user id.

**The watch's token never changes**, only what it resolves to. This avoids a
token rotation handshake on a device with no good error-recovery UI.

Failure modes returning `409`: code unknown, expired, or already consumed.
Claiming a code issued by one's own user is a no-op returning `200`.

## 4. Authentication

`verifyToken` is deleted. `auth.ts` becomes:

```ts
export interface Principal {
  userId: string;
  deviceId: string;
}

export function resolveToken(
  db: IdentityStore,
  provided: string | undefined,
): Principal | null;
```

Every currently token-gated route in `server.ts` resolves a `Principal` and
threads `userId` into the store call beneath it. A `null` principal is `401`.

Unauthenticated routes: `GET /healthz`, `POST /v1/devices`.

### Token transport

Tokens move from `?token=` to `Authorization: Bearer`. Query strings are
recorded in access logs, proxy logs, and `Referer` headers, which is
unacceptable once the token is a real user's credential rather than a
single shared development secret.

The `/app` viewer needs no exception. The page itself is unauthenticated static
HTML containing no user data; the user pastes a token into `localStorage` and
the page's own JavaScript fetches data with it at `viewerPage.ts:70`. Because
that is a `fetch` rather than a top-level navigation, it can set an
`Authorization` header, so the viewer moves to bearer tokens along with
everything else.

### Out of scope, flagged

`/twilio/voice` and `/twilio/stream-status` have no authentication at all today
and need Twilio request-signature validation. That is a separate fix and is not
addressed here.

## 5. Scoping existing stores

| Module | Change |
|---|---|
| `sessionStore.ts` | Map key becomes `` `${userId}:${sessionId}` ``. Public methods take `userId`. **This is the live-caption breach.** |
| `transcriptStore.ts` | Every method takes `userId`; paths become `<root>/<userId>/`. `FinalizedTranscript` gains `userId`. File logic is otherwise unchanged. |
| `readerPresence.ts`, `/v1/presence` | Scoped by `userId`, or one user's phone opens another user's watch. |
| `/v1/usage` | Reports the operator's Deepgram and Fly bill, not a per-user figure. Gated behind a new `ADMIN_TOKEN` env var; no longer reachable with a device token. |
| `settings.ts`, `settingsStore.ts`, `/v1/settings` | **Deleted.** Settings move to WatchConnectivity and their canonical shape moves to `CaptionCore` (section 7). See the provider note below. |
| `viewerPage.ts`, `/app` | Page stays unauthenticated static HTML; its `fetch` at line 70 moves the token to an `Authorization` header and the data it reads is scoped by the resolved `userId`. |

### Provider selection after settings leave the relay

`server.ts:62` currently reads `settings.get().provider` to choose the
transcription provider for each new session. Deleting the relay's settings
therefore removes provider selection unless it is replaced.

The provider moves to a per-session parameter, which is what the WebSocket path
already does: `/stream` accepts `?provider=` and validates it against
`PROVIDER_NAMES` at `server.ts:111`. `POST /v1/audio` gains the same parameter
with the same validation, read only when a session is created so that changing
the provider mid-conversation cannot swap engines partway through — matching the
behavior the existing comment at `server.ts:59` describes.

An absent or unrecognized parameter falls back to the relay's configured default
provider rather than failing the request.

## 6. Export destinations

Four destinations, split by where the work naturally lives.

**Amended 2026-08-15, after section 3-5 shipped.** The original split assumed the
phone app would configure all four. It cannot: the phone app needs a paid Apple
Developer Program membership (section 2), so routing configuration through it
would gate every destination on that purchase.

The two relay-side destinations do not need it. Their configuration moves to the
`/app` web viewer, which already exists and already authenticates with a device
token. This is not merely a workaround — Notion's authorization-code flow needs a
registered redirect URI that only the relay can host, so a browser is the natural
home for it, and it avoids the phone-posts-code-to-relay handoff entirely. The
mac app gains the same configuration surface for free.

Delivery therefore splits:

| Destination | Where | Ships in |
|---|---|---|
| Notion via OAuth | relay, configured in `/app` | Plan 2 |
| Email to self | relay, configured in `/app` | Plan 2 |
| Files / iCloud Drive | phone | Plan 3 (needs membership) |
| Share sheet | phone | Plan 3 (needs membership) |

### Phone-side (no relay involvement)

**Files / iCloud Drive as Markdown.** The default, and the only destination with
genuinely zero setup. The user picks a folder once with
`UIDocumentPickerViewController`; each finished transcript is written as one
`.md` file with the summary as front matter and the transcript below. Syncs to
every device the user owns and opens in any editor, which makes Obsidian support
fall out for free.

**Share sheet.** One `UIActivityViewController` presenting the same Markdown.
This is the only honest way to support Apple Notes: Apple has never shipped a
public Notes API on iOS, and Apple's own guidance rules out using Shortcuts
automation as a substitute. Export to Notes is therefore a manual tap per
transcript, never automatic sync — this must be stated plainly in the UI so
users do not expect background syncing. The same tap also reaches Mail,
Messages, Drafts, and every other share-sheet target.

### Relay-side

**Notion via OAuth.** Replaces the global `NOTION_TOKEN` env var.

The authorization-code flow runs in the browser, from `/app`. The user clicks
Connect, the relay redirects to Notion with a `state` value it minted and bound
to their `userId`, and Notion redirects back to
`GET /v1/exports/notion/callback` — a URI registered with the integration, which
only the relay can host. The relay exchanges the code over HTTP Basic using a
`client_secret` that never leaves the server, encrypts the resulting access
token, and writes an `export_destinations` row.

The `state` parameter is load-bearing, not ceremony: without it, an attacker can
hand a victim a callback URL carrying the attacker's own authorization code and
silently bind the victim's transcripts to the attacker's Notion workspace. It
must be single-use, expiring, and verified against the session that started the
flow.

Notion access tokens do not expire and have no refresh token; they stay valid
until the user revokes the integration in Notion's settings. There is no refresh
machinery to build. A revoked token surfaces as a `401` from the Notion API, which
marks the destination as needing re-authorization and surfaces in `/app`.

`notionExporter.ts`, `notionBlocks.ts`, `notionUpdater.ts`, and
`notionBackfill.ts` are retained. The single change is that they read a per-user
token and database id from `export_destinations` instead of `config.ts`. Their
existing never-duplicate and retry-on-boot behavior carries over per user.

**Email to self.** Sent relay-side and automatically, after summarization, using
a transactional email provider (Resend or SES) and a verified sending domain.

This is deliberately not `MFMailComposeViewController`: a phone-side compose
sheet would require the user to tap through a draft for every transcript, which
is manual emailing rather than the set-and-forget behavior the destination is
for. The cost is a new dependency, a sending domain, and SPF/DKIM/DMARC setup.

The address is entered in `/app`. Ownership is verified by a confirmation link
before the first transcript is sent, so the relay cannot be used to mail
arbitrary strangers — the confirmation endpoint is itself the abuse surface, and
must be rate limited and its token single-use and expiring.

This destination sends conversation transcripts, including the speech of
bystanders, to an address the relay was told about. Sending to an unverified
address would make the relay a remailer; sending to a verified but wrong one is
a privacy incident the user cannot undo. Verification is not a formality here.

### Secret storage

`export_destinations.config` holds JSON. Secret fields (the Notion access token)
are encrypted with AES-256-GCM under a key from a new `ENCRYPTION_KEY` env var.
Non-secret fields (Notion database id, email address) are stored in clear text
within the same JSON for debuggability.

## 7. Client changes

### Watch target relocation

`watch/project.yml` drops `WKWatchOnly` and gains
`WKRunsIndependentlyOfCompanionApp: true` plus `WKCompanionAppBundleIdentifier`
pointing at `com.jonyen.phonecaptions`. The watch target moves under the iOS
project so the two ship as one bundle. The keys are mutually exclusive, so this
is a swap, not an addition.

The watch app remains independently installable and fully functional without the
phone — that is precisely what `WKRunsIndependentlyOfCompanionApp` provides — so
the standalone cellular use case survives.

### Device identity

A new `DeviceIdentity.swift` in each app registers with `POST /v1/devices` on
first launch, stores the returned token in the Keychain, and attaches it as a
bearer header to every relay request. `Secrets.swift` retains only `relayURL`;
`authToken` is removed from it.

### Pairing UI

The phone shows the six-digit code with its expiry. The watch gets a digit-entry
screen; on watchOS this is a Digital Crown picker per digit rather than a text
field, since the keyboard is not usable for this.

### Settings over WatchConnectivity

`SettingsModel.swift` on the phone writes to `updateApplicationContext`; the
watch reads it and applies the same `Settings` shape it reads from the relay
today. `RelaySettingsClient.swift` on the watch is deleted.

`updateApplicationContext` delivers the latest value opportunistically and
coalesces intermediate ones, which matches settings semantics exactly — only the
current value matters. Values written while the watch is unreachable are
delivered when it reconnects.

The `Settings` shape, its defaults, and its validation move from
`backend/src/settings.ts` into the `CaptionCore` package. `CaptionCore` is
already a dependency of the watch, phone, and mac targets, so this makes it
impossible for the three to disagree about a default or a valid range — which
was previously guaranteed only by the relay being the single copy.

### Caption legibility

The target audience skews older, and the current presentation serves it poorly
in two independent ways.

**Dynamic Type is ignored.** `CaptionView.swift:44` renders with
`.font(.system(size: textSize))`, a fixed point size. A user who has already
raised Text Size in watchOS Settings sees no effect here. Captions switch to
`@ScaledMetric` so the system accessibility setting scales the configured size,
making the in-app slider an adjustment on top of the system preference rather
than a replacement for it. This is the more important of the two fixes, because
it helps users who never open the app's settings screen.

**The default is too small.** `captionTextSize` moves from 16 to **22**, and
`MAX_TEXT_SIZE` rises from 30 to **40**; `MIN_TEXT_SIZE` stays at 12.

22pt is chosen as the largest size that still keeps roughly three to four words
per line on a 41 mm case. Larger defaults read more easily in isolation but drop
to two or three words per line, at which point a reader loses the thread of a
fast speaker across line breaks. The raised ceiling exists because the range is
the user's choice to make; capping it at 30 decides for someone with more vision
loss than the default anticipates. With Dynamic Type scaling applied on top, the
effective ceiling is higher still.

### Export configuration UI

One `ExportDestination` protocol with local implementations for Files and share
sheet.

Notion and email are **not** configured here — per the section 6 amendment they
are configured in the `/app` web viewer and ship in Plan 2, before this client
work is unblocked. The phone may later surface their status read-only, but it
does not own their setup.

## 8. Migration

A one-shot migration runs at relay boot when transcripts are found at the old
flat root:

1. Create a user and a `mac`-kind device row; print the token to the log once so
   the operator can adopt existing installs.
2. Move every transcript from `<root>/` into `<root>/<userId>/`.
3. Delete the existing `settings.json`; settings now live on the phone.
4. If `NOTION_TOKEN` and `NOTION_DATABASE_ID` are set in the environment, write
   them as that user's `notion` destination row so exports continue
   uninterrupted, then log a deprecation notice for the env vars.

The migration is idempotent: it no-ops when the old root holds no transcripts.

No backward compatibility is provided for currently installed app builds. All
existing installs belong to the operator and will be updated alongside the
relay.

## 9. Testing

Test-driven throughout. New suites:

- `identityStore.test.ts` — registration, token hashing and lookup, pairing code
  issue/claim/expire/double-claim/unknown-code, orphaned user cleanup.
- `exportDestinations.test.ts` — encryption round-trip, per-user isolation,
  revoked-token handling.
- `auth.test.ts` — rewritten for `resolveToken`, replacing the `verifyToken`
  cases.

The load-bearing tests are cross-tenant isolation, asserted against every scoped
surface: user A cannot read B's transcripts, cannot poll B's session, cannot see
B's presence, cannot claim a consumed code, and cannot reach B's export
destinations.

Of the existing 323 tests, the `settingsStore.test.ts` and
`server.settings.test.ts` suites are deleted with the modules they cover; the
remaining store suites gain a `userId` argument.

Notion OAuth and email sending are tested against injected fakes, following the
existing `fakeTranscriptionProvider.ts` pattern. No test requires a network call.

## 10. Order of work

Backend first, since none of it is blocked on the paid membership:

1. `identityStore.ts` with schema and tests, unwired.
2. `resolveToken` and `POST /v1/devices`; convert routes to bearer tokens.
3. Scope `sessionStore.ts` — the live-caption breach.
4. Scope `transcriptStore.ts` and `readerPresence.ts`; write the boot migration.
5. Pairing endpoints.
6. Thread `provider` per session onto `POST /v1/audio`; delete `settings.ts`,
   `settingsStore.ts`, and `/v1/settings`.
7. `export_destinations` table; convert the Notion exporter to per-user tokens.
8. Email destination with confirmation flow.

Then the client, once membership is active:

9. Watch target relocation and `WKRunsIndependentlyOfCompanionApp`.
10. `DeviceIdentity.swift` and Keychain storage in both apps.
11. Pairing UI on both.
12. Move `Settings` into `CaptionCore`; settings over WatchConnectivity; delete
    `RelaySettingsClient.swift`. Raise the caption default to 22pt, the ceiling
    to 40, and switch `CaptionView` to `@ScaledMetric`.
13. Export configuration UI; Files and share sheet destinations.

## 11. Out of scope

- Billing, subscriptions, and per-user metering. No cloud STT quota exists in
  this spec.
- On-device iPhone transcription via `SFSpeechRecognizer`. Its own spec; the
  reference implementation is `mac/MacCaptions/LocalSpeechRelay.swift`.
- Per-user bring-your-own transcription API keys.
- Twilio webhook signature validation.
- Replacing the `/app` viewer's pasted-token-in-`localStorage` login with a real
  session. Bearer headers make it no worse than today, but it remains a weak
  authentication story.
- Google Drive and Dropbox destinations. Google's Drive scopes are restricted
  and carry a recurring OAuth verification review that is not worth the overhead
  at this stage.
- Postgres or multi-instance deployment. SQLite on a single Fly machine is
  sufficient; Litestream for durability is a follow-up.
- App Store submission requirements: privacy policy, Privacy Nutrition Label,
  and bystander recording consent. Tracked separately and required before
  release.
