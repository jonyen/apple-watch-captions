# Client device registration and pairing

## Problem

The multi-tenant relay authenticates every request with a per-device bearer
token resolved to a `Principal` (`resolveToken`, shipped in #6). The watch and
iPhone apps still ship a single shared `Secrets.authToken`. So the relay is
multi-tenant and the clients are not: they all present the one retired secret,
which `resolveToken` will not resolve.

This is the last gate before the multi-tenant relay can deploy. Until the
clients register and carry their own tokens, flipping the relay 401s every
install.

The relay half is done. This is client work: two apps calling endpoints that
already exist.

## Scope

Device registration and pairing only — the minimal set that makes the clients
authenticate. Deliberately **out** of this cycle, each its own later work:

- Caption legibility (Dynamic Type, the 22pt default, the 40 ceiling) — §7 of
  the multi-tenancy spec.
- Settings over WatchConnectivity (deleting `RelaySettingsClient`, moving
  `Settings` into the core package).
- Export configuration UI (Files, share sheet).

Grouping those in would enlarge the on-device verification surface without
moving the deploy gate any sooner. They are noted so a later cycle picks them up
rather than rediscovering them.

## What already exists (relay, #6)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /v1/devices` | none (rate-limited) | Register: `{kind}` → `{deviceId, token, userId}`. Token is 32 random bytes; only its SHA-256 is stored. |
| `POST /v1/pair/code` | bearer | Phone issues a 6-digit code, 10-minute TTL, single use. |
| `POST /v1/pair/claim` | bearer | Watch claims a code; server merges the watch's user into the phone's in one transaction, reassigning transcripts. The watch's token is unchanged — only what it resolves to. |

Every other route resolves a `Principal` from `Authorization: Bearer` and 401s a
null. The clients must therefore both register and carry the header.

## Design

### The seam follows the codebase's own pattern

The pure identity logic — the state machine *no token → register → store token →
attach it as a bearer header* — lives in the core package behind a protocol,
unit-tested with a fake, exactly as `MicPermissionProviding` and
`DisplayWakeLocking` already do. The platform Keychain is the thin adapter.

```swift
public protocol SecureTokenStore {
    func read() -> String?
    func write(_ token: String)
}

public protocol DeviceRegistering {
    /// The bearer token for this device, registering on first call if absent.
    func token() async throws -> String
}
```

`DeviceIdentity` in each app wires a `SecureTokenStore` (Keychain-backed) to a
registration call against `POST /v1/devices` with the app's `kind` (`watch` /
`phone`). The result: a stable token read from the Keychain on every later
launch, attached as `Authorization: Bearer` to every relay request.

### Transport swap

Every relay client moves `?token=<AUTH_TOKEN>` → `Authorization: Bearer <token>`:
`HTTPRelayClient`, `RelayHistoryClient`, `RelayCallClient`,
`RelayCallAudioClient` on the watch, the equivalents on the phone, and the `/app`
viewer's `fetch`. `Secrets.swift` keeps `relayURL` and loses `authToken`.

The watch transport stays HTTP — watchOS blocks WebSockets, which is why the
relay is HTTP in the first place — so this is a header change, not a protocol
one. The Twilio stream path keeps its token in the URL path (Twilio drops query
strings); that is relay-internal and untouched here.

### Pairing UI

- **Phone:** a screen that calls `POST /v1/pair/code` and shows the six digits
  with a live expiry countdown.
- **Watch:** a six-position **Digital Crown digit-picker** — the keyboard is not
  usable on watchOS — that calls `POST /v1/pair/claim`. On success the watch is
  now the same user as the phone; its stored token is unchanged.

Claiming surfaces the relay's `409`s (unknown / expired / consumed) as a plain
retry prompt. A code claimed against one's own user is the relay's `200` no-op.

### Watch target relocation

The one piece coupled to the extraction's bundle reshape: `watch/project.yml`
swaps `WKWatchOnly` for `WKRunsIndependentlyOfCompanionApp: true` +
`WKCompanionAppBundleIdentifier` → the phone bundle, so the two ship together
while the watch stays independently installable (the standalone-cellular case
survives). This lands in the same cycle because pairing over the phone assumes
the paired-bundle relationship.

## Dependencies and base

### This is gated on the extraction

A separate session is extracting the core package into a standalone
`github.com/jonyen/caption-core` repo and reshaping it (module structure, and a
`SessionController.start()` that now returns `Bool`). The rebuilt apps consume
that package. Starting client code against today's in-repo core would rebase it
onto the reshaped one — the exact double-work this project has been avoiding.

**Task 1 of the plan is a spike, not code:** once the extraction lands, pin the
extracted `caption-core`'s actual shape — package name, products, and the
auth-relevant surface — before writing against it. The plan states its
assumptions; the spike replaces them with facts.

### Base branch

The rebuild starts from **`backup/local-main-2026-08-15`**, not `main`. That ref
holds parked watch work — the "Tune in" rename, held-call captioning, the
home-screen redesign, the live-caption UI — that exists nowhere else. Starting
from `main` silently drops it. The rebuild is a three-way reconciliation: the
parked watch work, the §7 changes above, and the extracted core as a dependency.

### caption-core consumption

`project.yml` points at a local `../caption-core` checkout during development, so
the app and the core can change together without a publish cycle; release builds
pin a remote tag. This matches how the monorepo let the two co-evolve.

## Testing

Pure logic — the register-if-absent state machine, the bearer attachment, the
`409`/`200` pairing outcomes — is unit-tested in the core package with a fake
`SecureTokenStore` and a fake transport, no network.

Everything that matters about pairing is on-device and manual, because the
watchOS simulator cannot drive the Crown picker reliably (a known limitation
recorded this project's history):

1. Fresh install of both apps registers each as a separate user; each records a
   transcript that lands under its own account.
2. The phone shows a code; the watch enters it on the Crown picker; the claim
   succeeds and the watch's prior transcript now appears under the phone's user.
3. Every relay call from both devices carries a bearer token, not `?token=`.
4. The watch still works with the phone absent (standalone cellular).

Item 2 is the load-bearing one: it proves the merge, which is the whole point of
pairing.

## Out of scope

- The three §7 items listed under Scope.
- Twilio webhook signature validation (a relay concern, tracked separately).
- Any relay change — this cycle adds no endpoint and alters no existing one.
