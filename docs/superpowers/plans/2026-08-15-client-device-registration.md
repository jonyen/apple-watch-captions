# Client Device Registration & Pairing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the watch and iPhone apps register for their own per-device tokens and pair into one account, so the multi-tenant relay can deploy without 401ing every install.

**Architecture:** The relay side is done (#6). This is client work: a `SecureTokenStore` seam and registration state machine in the core package (unit-tested with fakes), a per-app `DeviceIdentity` that Keychains the token, a `?token=` → `Authorization: Bearer` swap across every relay client, and the phone-code / watch-Crown pairing UI.

**Tech Stack:** Swift 5.9+, SwiftUI, XCTest, XcodeGen, the extracted `caption-core` SPM package.

**Spec:** `docs/superpowers/specs/2026-08-15-client-device-registration-design.md`

## Global Constraints

- **This plan is GATED on the extraction session finishing.** It consumes the reshaped, extracted `github.com/jonyen/caption-core`. Do not start Task 2+ until Task 1's spike confirms the extraction has landed and pins the package's real shape.
- **Base branch is `backup/local-main-2026-08-15`.** It holds parked watch work (the "Tune in" rename, held-call captioning, the home-screen redesign, the live-caption UI) that exists nowhere else. Branch the rebuild from it — NOT from `main` — or that work is silently dropped.
- **No relay changes.** This cycle adds no endpoint and alters none. If a task seems to need a relay change, stop and report — the relay contract is fixed at #6.
- **Registration + pairing only.** Caption legibility, WatchConnectivity settings, and the export UI are out of scope (later cycles) even where the code sits next to them.
- **The watch transport stays HTTP.** watchOS blocks WebSockets; the relay is HTTP for that reason. This is a header change, not a protocol change. The Twilio stream path keeps its token in the URL path (Twilio drops query strings) — untouched.
- Relay contract (fixed): `POST /v1/devices {kind} → {deviceId, token, userId}`; `POST /v1/pair/code` (bearer) `→ {code, expiresAt}`; `POST /v1/pair/claim {code}` (bearer) `→ {userId}`. 409 on unknown/expired/consumed code; 200 no-op on self-claim.

## Provisional file paths

The tasks below reference paths as they exist on `backup/local-main-2026-08-15`
(`watch/CaptionCore/…`, `watch/WatchCaptions/…`, `ios/…`). The extraction moves
the core into a standalone `caption-core` repo and may rename modules. **Task 1's
spike resolves every path against the extraction's actual output**; treat the
paths here as the pre-extraction reference, not gospel.

---

### Task 1: Spike — pin the extracted caption-core and confirm the base

No production code. Deliverable: a written map that later tasks build on.

**Files:**
- Create: `docs/superpowers/specs/2026-08-15-client-device-registration-design.md` addendum (append a "Post-extraction facts" section)

**Interfaces:**
- Consumes: the extraction session's output (the `caption-core` repo, tag 0.1.0).
- Produces: the concrete package name, products, module import, seam location, and the `SessionController.start()` signature that Tasks 2–7 reference.

- [ ] **Step 1: Confirm the extraction landed**

Verify `github.com/jonyen/caption-core` exists at tag `0.1.0` (or the current tag), and that the mac app + package extraction is merged. If it has not landed, STOP — this whole plan is blocked, and that is the correct outcome to report.

- [ ] **Step 2: Pin the package facts**

Record, from the actual repo: the SPM package name, its library product name(s), the module name apps `import`, and where protocols like `MicPermissionProviding` now live (the file that Task 2's `SecureTokenStore` joins). Note the `SessionController.start()` signature — the extraction changed it to return `Bool`; confirm the final shape.

- [ ] **Step 3: Confirm the base merge is clean**

Dry-run a merge of `backup/local-main-2026-08-15`'s app targets against the extracted core: does the parked watch work (`CallAudio`/`CallVoice`/`MuLaw`, the Tune in home screen) still compile against the reshaped core, or did the extraction rename something it uses? Record any reconciliation the rebuild must do before Task 2.

- [ ] **Step 4: Write the addendum and commit**

Append the findings to the spec. Commit `docs: pin the extracted caption-core for the client rebuild`.

---

### Task 2: The token seam and registration logic in the core

Pure logic, fully unit-tested, no Keychain, no network. **This lands in the extracted `caption-core` repo** (a local checkout during dev, per the spec); its own tests run in that package, and the apps pick it up through their local-path dependency once Task 3 repoints them. Tag a new core version (e.g. 0.1.1) at the end so release builds can pin it.

**Files:**
- Modify: the core package's protocols file (per Task 1's spike)
- Create: `DeviceRegistration.swift` in the core package + its test
- Test: `DeviceRegistrationTests.swift`

**Interfaces:**
- Consumes: Task 1's package facts; the core's existing injectable-transport pattern.
- Produces:
  - `public protocol SecureTokenStore { func read() -> String?; func write(_ token: String) }`
  - `public protocol DeviceRegistrar { func register(kind: String) async throws -> String }` (the network call, faked in tests)
  - `public actor DeviceRegistration` with `func token() async throws -> String` — returns the stored token, or registers once and stores it if absent.

- [ ] **Step 1: Write the failing tests**

```swift
final class DeviceRegistrationTests: XCTestCase {
  func testRegistersOnceWhenNoTokenStored() async throws {
    let store = FakeStore(nil)
    let registrar = FakeRegistrar(returning: "tok-A")
    let id = DeviceRegistration(kind: "watch", store: store, registrar: registrar)
    let t = try await id.token()
    XCTAssertEqual(t, "tok-A")
    XCTAssertEqual(store.written, "tok-A")          // persisted
    XCTAssertEqual(registrar.calls, 1)
  }

  func testReturnsStoredTokenWithoutRegistering() async throws {
    let store = FakeStore("tok-existing")
    let registrar = FakeRegistrar(returning: "tok-new")
    let id = DeviceRegistration(kind: "watch", store: store, registrar: registrar)
    XCTAssertEqual(try await id.token(), "tok-existing")
    XCTAssertEqual(registrar.calls, 0)              // no network when already have one
  }

  func testConcurrentFirstCallsRegisterOnce() async throws {
    // Two token() calls before the first completes must not double-register.
    let store = FakeStore(nil)
    let registrar = FakeRegistrar(returning: "tok-A", delayMs: 20)
    let id = DeviceRegistration(kind: "watch", store: store, registrar: registrar)
    async let a = id.token(); async let b = id.token()
    _ = try await (a, b)
    XCTAssertEqual(registrar.calls, 1)              // the actor serializes it
  }
}
```

Write `FakeStore` (an in-memory `SecureTokenStore` recording `written`) and `FakeRegistrar` (returns a fixed token, counts `calls`, optional delay).

- [ ] **Step 2: Run to verify they fail**

Run the core package's test command (per Task 1). Expected: FAIL — the types don't exist.

- [ ] **Step 3: Implement**

Add the two protocols to the protocols file. Implement `DeviceRegistration` as an `actor` (the actor is what makes `testConcurrentFirstCallsRegisterOnce` pass without a lock): `token()` returns `store.read()` if present; otherwise `await registrar.register(kind:)`, `store.write` it, return it.

- [ ] **Step 4: Run to verify they pass**

Expected: PASS, all three, plus the package's existing suite unchanged.

- [ ] **Step 5: Commit** `feat(core): device registration state machine behind a token-store seam`

---

### Task 3: Keychain adapter and DeviceIdentity per app

The platform half — the only files that touch the Keychain and the network.

**Files:**
- Create: `KeychainTokenStore.swift` (watch app), `KeychainTokenStore.swift` (iOS app) — or one shared file if the targets share a group
- Create: `DeviceRegistrar` HTTP implementation (`RelayDeviceRegistrar.swift`) per app
- Create: `DeviceIdentity.swift` per app wiring the two into a `DeviceRegistration`

**Interfaces:**
- Consumes: `SecureTokenStore`, `DeviceRegistrar`, `DeviceRegistration` from Task 2.
- Produces: `DeviceIdentity.shared.token() async throws -> String` per app, backed by the Keychain and `POST /v1/devices`.

- [ ] **Step 0: Repoint the app dependency to the extracted core**

Each app's `project.yml` still names the in-repo `CaptionCore` path, which the extraction removed. Repoint both to the local `../caption-core` checkout (dev); release builds pin the tag from Task 2. Confirm both apps resolve the package and build against it before wiring anything below.

- [ ] **Step 1: Keychain store**

Implement `SecureTokenStore` over `Security.framework` (`SecItemAdd`/`SecItemCopyMatching`/`SecItemUpdate`), a single generic-password item keyed by service = bundle id + `"relay-device-token"`. No test target on the apps — this is verified on-device in Task 8; keep it minimal and obvious.

- [ ] **Step 2: HTTP registrar**

`RelayDeviceRegistrar` POSTs `{kind}` to `relayURL`'s `/v1/devices` and returns `token` from the JSON. Bearer not needed — registration is the one unauthenticated write.

- [ ] **Step 3: DeviceIdentity**

`DeviceIdentity` constructs a `DeviceRegistration(kind:store:registrar:)` with the two above and exposes `token()`. `kind` is `"watch"` / `"phone"` per app.

- [ ] **Step 4: Build both apps**

Build watch and iOS for the simulator; both compile against the extracted core. No behavior wired yet — Task 4 consumes `DeviceIdentity`.

- [ ] **Step 5: Commit** `feat(client): Keychain-backed device identity for watch and phone`

---

### Task 4: Bearer transport swap

**Files:**
- Modify: `HTTPRelayClient.swift`, `RelayHistoryClient.swift`, `RelayCallClient.swift`, `RelayCallAudioClient.swift` (watch); the iOS relay client(s); `viewerPage.ts` (the `/app` fetch)
- Modify: `Secrets.swift` / `Secrets.example.swift` (both apps) — drop `authToken`
- Modify: `AppModel.swift` (watch) and the iOS equivalent — resolve the token from `DeviceIdentity` before constructing clients

**Interfaces:**
- Consumes: `DeviceIdentity.token()` from Task 3.
- Produces: every relay request carries `Authorization: Bearer <token>`; nothing sends `?token=`.

- [ ] **Step 1: Swap each client from query to header**

Each client currently takes `init(base:token:)` and appends `?token=` in its URL builder (e.g. `HTTPRelayClient.url(path:since:)` adds a `token` query item). Remove the query item; instead set `req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")` on each `URLRequest`. The `init(base:token:)` signature is unchanged — only where the token rides.

- [ ] **Step 2: Source the token from DeviceIdentity**

At app launch (`AppModel.init` / iOS equivalent), the clients are built with `Secrets.authToken`. Replace that: `await DeviceIdentity.shared.token()` once, then construct the clients with the resolved token. The watch token is stable after first registration (pairing does not rotate it, per the relay contract), so resolving once per launch is correct. Handle the first-launch async: the app already has a launch path that awaits (mic permission) — register there, before the first relay call.

- [ ] **Step 3: Drop the shared secret**

Remove `authToken` from `Secrets.swift` and `Secrets.example.swift` in both apps; keep `relayURL`. Grep both app targets for `authToken` — zero hits when done.

- [ ] **Step 4: `/app` viewer**

`viewerPage.ts:70`'s `fetch` moves its token from the query string to an `Authorization` header (the page already holds the token in `localStorage`; this is a `fetch`, so it can set the header).

- [ ] **Step 5: Build both apps + run the backend suite**

Both apps build. `cd backend && npm test` stays green — the relay already accepts bearer tokens (#6), so nothing server-side moves; this only proves the viewer change didn't break its tests.

- [ ] **Step 6: Commit** `feat(client): carry the device token as a bearer header, not a query param`

---

### Task 5: Pairing relay calls

**Files:**
- Create: `Pairing.swift` in the core (or per app, per Task 1) + test
- Test: `PairingTests.swift`

**Interfaces:**
- Consumes: `DeviceIdentity.token()`; an injectable transport.
- Produces:
  - `func issueCode() async throws -> PairingCode` (phone) → `POST /v1/pair/code`
  - `func claim(code: String) async throws -> ClaimOutcome` (watch) → `POST /v1/pair/claim`, mapping 409 → `.rejected(reason)` and 200 → `.paired(userId)` / `.alreadyPaired`.

- [ ] **Step 1: Write the failing tests**

Against a fake transport: `issueCode` returns the parsed `{code, expiresAt}`; `claim` maps a 200 body to `.paired`, a 409 to `.rejected` without throwing (a rejected code is a user-retry, not an error). Assert the bearer header is attached to both.

- [ ] **Step 2: Run to verify they fail; Step 3: implement; Step 4: verify pass.**

- [ ] **Step 5: Commit** `feat(client): pairing code issue and claim against the relay`

---

### Task 6: Pairing UI

**Files:**
- Create: `PairingView.swift` (iOS — code display), `PairingView.swift` (watch — Crown picker)
- Modify: each app's navigation to reach it (a Settings/menu entry)

**Interfaces:**
- Consumes: Task 5's `issueCode` / `claim`.
- Produces: the two screens. No unit tests — SwiftUI views verified on-device (Task 8); the logic they call is already tested in Task 5.

- [ ] **Step 1: Phone code screen**

Calls `issueCode()`, shows the six digits large, with a live countdown to `expiresAt` and a re-issue button when it lapses.

- [ ] **Step 2: Watch Crown picker**

Six digit positions, each a Digital Crown `Picker` 0–9 (no keyboard on watchOS). A confirm button calls `claim(code:)`; `.rejected` shows a plain retry message, `.paired` dismisses. **Note:** the watchOS simulator cannot drive the Crown reliably — this screen is verified by hand in Task 8, not in the sim.

- [ ] **Step 3: Build both apps.**

- [ ] **Step 4: Commit** `feat(client): pairing screens — phone code, watch Crown entry`

---

### Task 7: Watch target relocation

**Files:**
- Modify: `watch/project.yml` (or the relocated project per Task 1)

**Interfaces:**
- Consumes: nothing.
- Produces: the watch app ships alongside the phone as a companion while staying independently installable.

- [ ] **Step 1: Swap the WK keys**

Drop `WKWatchOnly`; add `WKRunsIndependentlyOfCompanionApp: true` and `WKCompanionAppBundleIdentifier` → the phone bundle id (`com.jonyen.phonecaptions`, confirm against the extraction's output). The keys are mutually exclusive, so this is a swap.

- [ ] **Step 2: Regenerate + build**

`xcodegen generate`; build the watch app for the device destination. It must still install and launch standalone.

- [ ] **Step 3: Commit** `feat(watch): ship as an independent companion of the phone app`

---

### Task 8: On-device verification (human-run)

No code. The claims this cycle rests on are only observable on real hardware, and the watchOS simulator cannot drive the Crown picker.

**Files:**
- Modify: the spec — record what was observed.

- [ ] **Step 1: Fresh install both apps** on a physical watch + iPhone (unlock the watch, keep it on the wrist, or CoreDevice reports a misleading "no DDI").

- [ ] **Step 2: Each registers as its own user.** Record a short session on each; each transcript lands under its own account (check `/app` with each device's token).

- [ ] **Step 3: Pair them.** Phone shows a code; enter it on the watch Crown picker; claim succeeds. **The watch's earlier transcript now appears under the phone's user** — this is the load-bearing check; it proves the merge.

- [ ] **Step 4: Every call carries a bearer token**, none carries `?token=` (watch a request in the relay logs).

- [ ] **Step 5: Standalone still works** — put the phone out of range; the watch still captions over cellular.

- [ ] **Step 6: Record the results in the spec and commit.** If Step 3 fails, stop and report rather than shipping — pairing is the whole point.
