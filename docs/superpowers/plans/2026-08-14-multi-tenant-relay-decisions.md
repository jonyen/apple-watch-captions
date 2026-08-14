# SDD ledger — plan: docs/superpowers/plans/2026-08-14-multi-tenant-relay.md

Spec: docs/superpowers/specs/2026-08-14-multi-tenancy-and-exports-design.md (read; binding authority)
Branch: multi-tenant-relay (off phone-audio-captions @ 1ecfeef). User declined a worktree; new branch in place.
Baseline: 326 tests passing, `tsc --noEmit` clean.

## Pre-flight conflict scan

### Self-consistency, per task

| Task | Own text agrees with itself? |
|---|---|
| 1 | **No** — "is idempotent when reopened" opens two separate `:memory:` databases, which are independent. The test cannot fail. See R5. |
| 2 | Yes. 32-byte base64url is 43 chars, satisfying `toBeGreaterThan(20)`. |
| 3 | Yes. TTL 10 min vs clock +11 min correctly expires. |
| 4 | Yes internally, but Step 5 asserts a build break — see R1. |
| 5 | **No** — deletes `authToken` from options while routes still read `opts.authToken`. See R2. |
| 6 | Yes. |
| 7 | **No** — Step 3 tells the implementer to let `tsc` flag transcript calls. See R3. |
| 8 | Yes. |
| 9 | Yes. |
| 10 | **No** — Step 3 lists `renameSync, existsSync, rmSync` as new imports; `moveTranscripts` also calls `mkdirSync` and `readdirSync`. See R4. |
| 11 | Yes. |
| 12 | Yes. |

### Task pairs sharing a file or interface

| Pair | Produces → consumes | Finding |
|---|---|---|
| 1 → 2 | `openDb`, `Db` | Clean. |
| 2 → 3 | `IdentityStore`, `Principal` | Clean; 3 extends the class 2 creates. |
| 2 → 4 | `IdentityStore.resolve` | Clean. |
| 4 → 5 | `bearerToken` | **Conflict.** 4 deletes the `verifyToken` export; `server.ts` still imports it, so its ESM import throws at load and Task 5's tests cannot even run. Vitest does not type-check, so this surfaces as a runtime `SyntaxError`, not a compile error. See R1. |
| 5 → 6 | `StartServerOptions.identity` | **Conflict.** See R2. |
| 6 → 7,8,9,10,11 | `principalFor`, `Principal` | Clean. |
| 7 → 8 | `SessionStore` transcript calls | **Conflict**, and the dangerous kind: `append(userId, id, text)` against the unscoped 3-arg signature silently binds `sessionId=userId, text=sessionId`. Wrong data, not a crash. See R3. |
| 7 → 8 | `server.tenancy.test.ts` | Clean; 8 appends to the file 7 creates. |
| 8 → 10 | `userDir`, `transcriptsRoot` | Clean. |
| 8 → 12 | `userDir`, `FinalizedTranscript.userId` | Clean. |
| 6 → 11 | `/v1/settings` route | 6 converts a route 11 deletes. Wasted work, not a conflict. See R6. |
| 6 → 12 | `opts.adminToken` → `config.adminToken` | Clean. |

### Rulings made before execution

- **R1** — Task 4 keeps `verifyToken` exported and untouched alongside the new `bearerToken`/`resolveToken`; Task 6 deletes it as part of converting the routes. Task 4's Step 5 changes from "confirm the build fails" to "confirm `npm test` and `npm run build` are both clean." *Why:* the plan's claimed-intentional break is not merely a type error — `server.ts`'s ESM import of a now-missing export throws at module load, so Task 5 could not run its own tests. *Cost if wrong:* one dead export lives for two tasks.
- **R2** — Task 5 marks `authToken?: string` optional rather than deleting it, and adds `identity`. Task 6 deletes it. *Why:* same reason as R1; routes still read `opts.authToken` until Task 6. *Cost if wrong:* an optional field briefly has two auth mechanisms present, neither ambiguous.
- **R3** — Task 7 does **not** modify any `this.transcripts?.*` call. It keys sessions by `${userId}:${id}` and adds `userId`/`id` to the `Session` record; Task 8 changes the transcript calls when the signatures actually change. *Why:* the plan's instruction to let `tsc` flag it produces silent argument misbinding at runtime, and vitest does not type-check. *Cost if wrong:* Task 7 leaves transcripts unscoped for one task, which Task 8 closes.
- **R4** — Task 10 adds `mkdirSync` and `readdirSync` to its `fs` imports alongside `renameSync`, `existsSync`, `rmSync`. *Why:* `moveTranscripts` calls all five. *Cost if wrong:* none; it is a missing import.
- **R5** — Task 1's third test becomes a real idempotency check: open a **temp file** database twice and assert the second `openDb` neither throws nor drops data. *Why:* two `:memory:` handles share nothing, so the test as written asserts nothing. *Cost if wrong:* none; a stronger test.
- **R6** — Task 6 converts `/v1/settings` along with every other route even though Task 11 deletes it. *Why:* leaving one route on the old mechanism while `verifyToken` is being removed reintroduces R1. *Cost if wrong:* a few lines written and then deleted.

## Task log

Task 1: implementer returned DONE_WITH_CONCERNS (commit a977b68). Deviation: could not use a
static `import { DatabaseSync } from "node:sqlite"`.

- **R7** — Accept `import type` + `process.getBuiltinModule("node:sqlite")` in `db.ts`.
  *Verified myself, not taken on trust:* a probe test with the plain static import fails under
  vitest 2.1.9 with `Failed to load url sqlite (resolved id: sqlite)` — vite-node treats a
  `node:x` specifier as builtin only when bare `x` is also a builtin, which is false for
  `node:sqlite`. Also probed `test.server.deps.external: [/^node:sqlite$/]`, which does **not**
  fix it. The remaining clean fix is upgrading vitest to v3, a devDependency change with a
  326-test blast radius mid-plan. *Cost if wrong:* one non-idiomatic, heavily commented import
  line in `db.ts`; `process.getBuiltinModule` is stdlib (Node 22.3+) and behaves identically
  under tsx and vitest.
- Deferred (not blocking): upgrade vitest to v3 and restore the idiomatic import.

Task 1: minor (deferred): idempotency test leaves db1/db2 handles unclosed at test end.
Task 1: minor (deferred): no test covers the `devices.kind` CHECK or `token_hash` UNIQUE
  constraints. Carried into Task 2's dispatch — Task 2 writes the first real device inserts.
Task 1: complete (commits 1ecfeef..a977b68, review clean — spec ✅, quality approved)

Task 2: minor (deferred): `registerDevice` inserts into `users` then `devices` without a
  transaction; a failed device insert would strand a `users` row. Inconsistent with Task 3's
  transactional `claimPairingCode`.
Task 2: minor (deferred): constraint tests insert raw rows rather than going through the public
  API. Reasoning holds only while every caller respects the `DeviceKind` type — carried into
  Task 5's dispatch, which must validate `kind` at the HTTP boundary, not cast it.
Task 2: watch item (not a finding): `resolve` stamps `last_seen_at`, so every authenticated
  request is a write on node:sqlite's single writer. Plan-mandated, and fine if auth is
  per-request rather than per-audio-frame. Carried into Task 6's dispatch to confirm against the
  real call sites — /v1/audio is polled roughly once per second per device.
Task 2: complete (commits a977b68..d4557d2, review clean — spec ✅, quality approved)

Task 3: review spec ✅, quality approved, but one **Important** finding — entering the fix loop.
- **R8** — Fix the pairing-code collision check now rather than deferring it. The check is
  `SELECT code FROM pairing_codes WHERE code = ?`, which matches every row ever inserted;
  nothing purges consumed or expired rows. The 1,000,000-code space therefore only ever
  shrinks, and once saturated every `issuePairingCode` exhausts its 5 retries and throws.
  The code is inherited verbatim from the plan's own Step 3, so this is a plan defect, not an
  implementer error — the plan is the argument, the spec is the authority, and the spec says
  codes are single-use with a 10-minute TTL, which means dead rows are garbage by definition.
  *Why fix rather than defer:* two-line change, on a security-adjacent path, and it makes the
  existing comment ("collision with a live code") true instead of false.
  *Cost if wrong:* a slightly larger Task 3 diff.
Task 3: minor (deferred): expiry boundary (`<=` at the exact expiry instant) is untested; the
  test jumps 11 minutes past a 10-minute TTL.
Task 3: minor (deferred): orphan-survival path (abandoned user retains a second device) is
  sound by inspection but untested.
Task 3: minor (deferred): if `ROLLBACK` itself throws, it masks the original error.
Task 3: fix round 1/5 (1 addressed, 0 open — collision probe now sweeps dead rows first, keyed
  to the injected clock; 2 new tests verified failing pre-fix; commits cfd0f27..6058459)
Task 3: minor (deferred): purge is global rather than user-scoped and has no supporting index
  on `consumed_at`/`expires_at`; no background sweep.
Task 3: complete (commits d4557d2..6058459, review clean after 1 fix round)

Task 4: minor (deferred): `bearerToken`'s `\s` separator would accept an embedded CRLF as the
  scheme/token separator. Not exploitable — Node's HTTP parser rejects raw CR/LF in header
  values first — but `[ \t]` would be tighter.
Task 4: complete (commits 6058459..6d19073, review clean — spec ✅, quality approved)

Task 5 pre-dispatch note: the plan's Step 3 says to change `handleRequest` "to carry `limiter`
  instead of `settings`" and then, in the same sentence, to keep `settings`. Contradictory.
  Ruling: **R9** — keep the `settings` parameter and ADD `limiter`; Task 11 removes `settings`.
  *Cost if wrong:* one parameter lives two tasks longer than needed.

Task 5: returned DONE_WITH_CONCERNS (commit 36d57f0) with two deviations from my correction.
- **R10** — Accept `identity?: IdentityStore` optional rather than required. My correction said
  "required", but every pre-existing `startServer(...)` call site (test files and `index.ts`)
  omits it, and those were to stay untouched — required would fail the type check. The route
  answers 503 when it is absent. Task 6 makes it required and updates the call sites, which is
  work Task 6 already owns. *Cost if wrong:* one task's window in which a misconfigured server
  returns 503 from `/v1/devices` rather than failing at construction.
- **R11** — Accept `verifyToken(token, opts.authToken ?? "")` at the 11 legacy call sites, a
  direct consequence of making `authToken` optional. `verifyToken` returns false for an empty
  expected token, so an unset `authToken` fails closed and rejects every legacy route. That is
  the correct direction for an auth guard. All 11 disappear in Task 6. *Cost if wrong:* none;
  the behaviour is strictly more restrictive than before.
Task 5: review spec ✅, quality **Changes Requested** — one Critical. Entering the fix loop.
- **R12** — Fix the rate-limiter key now. `req.socket.remoteAddress` is my plan's code verbatim,
  and it is wrong for the actual deployment: `fly.toml` runs the relay behind Fly's
  `http_service` proxy, which terminates the client connection, so every request presents the
  proxy's address. The only unauthenticated write in the system would then share one global
  10-per-hour bucket — locking out real users while doing nothing against an attacker with more
  than one source. Fix: prefer `Fly-Client-IP`, then the first `X-Forwarded-For` entry, and only
  behind an explicit trust flag, since blindly trusting a client-supplied forwarding header lets
  any caller spoof its identity and evade the limit entirely. Default the flag off (safe when
  directly exposed); Task 12 turns it on from config for the Fly deployment.
  *Cost if wrong:* a config flag that must be set correctly per deployment.
- **R13** — Fold the two Minors into the same round rather than deferring: the unbounded `hits`
  map (entries are only pruned when that same address returns, and `auto_stop_machines = "off"`
  means the process never restarts) and the untested 503 branch. Both live in the exact code
  being edited. *Cost if wrong:* a slightly larger fix diff.
- Reviewer's Important — `index.ts` never wires `identity`, so `/v1/devices` 503s in production
  — is **already owned by Task 12** (Step 6 wires `identity` into `startServer`). Not a gap;
  confirmed against the plan. No action this round.
Task 5: fix round 1/5 (3 addressed, 1 new — commits 36d57f0..fa67ed0). Re-review confirmed all
  three findings addressed, but surfaced new forgeable surface in the fix itself.
- **R14** — Drop the `X-Forwarded-For` fallback entirely rather than commenting around it. My
  round-1 instruction to take the left-most XFF entry was wrong: Fly's proxy **appends** its
  observed address rather than replacing the header, so a client sending
  `X-Forwarded-For: <victim>` arrives as `<victim>, <real>` and the left-most rule keys on the
  attacker's chosen value. The correct left/right choice for an append-style proxy is the
  right-most entry, but `Fly-Client-IP` is authoritative and always present on this deployment,
  which makes the whole XFF branch unreachable in production while remaining live and forgeable
  in code. Deleting it removes the bypass instead of documenting it. A future non-Fly proxy gets
  explicit, deliberate support rather than inheriting a guess.
  *Cost if wrong:* a deployment behind a non-Fly proxy needs a small deliberate change before
  its rate limit keys correctly — which is the intended outcome, not an accident.
Task 5: fix round 2/5 (1 addressed, 1 new minor — commits fa67ed0..c5d4858). XFF branch deleted;
  re-review verified by hand that the new test fails against round 1's code.
- **R15** — Fix the stale `trustProxyHeaders` JSDoc immediately rather than deferring it as the
  Minor it technically is. Six later tasks all edit `server.ts`, and a comment asserting that a
  security control trusts a header the code deliberately ignores is what gets "restored" by a
  future implementer. *Cost if wrong:* one extra comment-only round.
Task 5: fix round 3/5 (2 addressed, 0 open — comment-only; commits c5d4858..c2c2ea3)
Task 5: minor (deferred): `evictStale` is an O(n) full-map scan per registration.
Task 5: minor (deferred): duplicate `Fly-Client-IP` headers would be comma-joined by Node and
  used verbatim as the key. Inert only because Fly's edge replaces the header; now documented.
Task 5: complete (commits 6d19073..c2c2ea3, review clean after 3 fix rounds)

Task 6 pre-dispatch ruling:
- **R16** — Fold a `last_seen_at` write throttle into Task 6. Task 2's review flagged that
  `resolve()` writes on every authenticated request; Task 6 is what makes that real, because
  `/v1/audio` is polled roughly once per second per device while captioning. That is one SQLite
  write per second per device for a field that is purely diagnostic. Throttle to at most one
  update per device per 5 minutes. Touching `identityStore.ts` from Task 6 is mild scope creep,
  but this is the task that creates the load. *Cost if wrong:* `last_seen_at` is accurate only
  to within 5 minutes, which is well inside its usefulness as a liveness hint.
- Deferred (not blocking): enable SQLite WAL mode in `db.ts`, which would also cut the cost of
  these writes. Out of scope for Task 6; worth doing before real traffic.

Task 6: returned DONE_WITH_CONCERNS (commit 072e2ae), both concerns about scope.
- **R17** — Accept the reach into `config.ts` and `index.ts`. My own success criterion for the
  task was that `grep -rn "verifyToken\|authToken" backend/src` returns nothing, and `config.ts`
  held an `authToken` field plus a hard `AUTH_TOKEN is required` throw. Leaving it would have
  shipped a dead required env var that fails boot for a credential nothing reads. Wiring
  `IdentityStore` into `index.ts` follows from making `identity` required. *Cost if wrong:*
  Task 12 must reconcile rather than author `config.ts`/`index.ts` from scratch — carried into
  its dispatch below.
- **R18** — `fly.toml`, `Dockerfile`, `README.md`, `DEPLOY.md`, and `MONITORING.md` still tell
  operators to set `AUTH_TOKEN`, which no longer exists. The implementer correctly left them
  (Task 12's file list), but the plan's Task 12 never mentions the three docs. Adding them to
  Task 12's scope: deploy instructions that set a dead secret and omit the live ones are worse
  than no instructions. *Cost if wrong:* a slightly larger Task 12.
- Verify at review: test count moved 367 → 365. Reviewer reconciled it exactly (6 removed,
  4 added) and confirmed no rejection assertion was flipped to an acceptance. Closed.
Task 6: review spec ✅, quality approved, no Critical, per-route table confirms no route lost
  its check. Two Important — entering the fix loop.
- **R19** — Fix the fresh-volume boot crash now. `index.ts` opens
  `join(transcriptsDir, "identity.db")` at module load, but nothing creates `transcriptsDir`
  until `TranscriptStore.append` does it lazily. `fly.toml` mounts an empty volume at `/data`
  with `TRANSCRIPTS_DIR=/data/transcripts`, so a fresh volume or region move throws
  `SQLITE_CANTOPEN` at import — a boot loop, not a degraded start. Hidden today only because the
  live volume already has the directory. *Cost if wrong:* one `mkdirSync`.
- **R20** — Fold Minors 3-6 into the same round: constant-time compare for `adminToken` (now the
  system's only shared secret), a `NaN` guard on a corrupt `last_seen_at` that would otherwise
  freeze the field forever, a positive assertion that the first `resolve` does stamp it, and the
  viewer's user-facing copy still saying "relay auth token" when it now wants a device token.
  All cheap, all in code this round already touches. *Cost if wrong:* larger fix diff.
- Minor 7 (a pure `const identity = opts.identity` alias) — left alone, cosmetic.
- **R21** — `/v1/usage` now answers 401 to everything in production, because `index.ts` passes no
  `adminToken`. Previously it was reachable with `AUTH_TOKEN`. Not a Task 6 defect, but it must
  be an explicit Task 12 *wiring* item, not merely a `MONITORING.md` edit, or the endpoint stays
  silently dead. Carried into Task 12's dispatch.
- Note (Plan 3, not this plan): `principalFor` accepts `?token=` on every route, so device tokens
  still reach access logs. It must stay until the Swift clients send headers — both
  `Secrets.example.swift` files still reference `AUTH_TOKEN`. Narrow the query fallback to the
  Twilio paths once Plan 3 lands.
Task 6: fix round 1/5 (5 addressed, 0 open — commits 072e2ae..500d030)
Task 6: complete (commits c2c2ea3..500d030, review clean after 1 fix round)

Task 7 pre-dispatch note: `/v1/call` reads `store.has(active.sessionId)` from `CurrentCall`, and
  `handleTwilioStream` creates sessions directly. Once `SessionStore` is keyed by user, both need
  a `userId`. The plan does not say where the Twilio path's user comes from. Ruling: **R22** —
  it comes from the principal resolved at WebSocket upgrade time, which Task 6 already resolves
  and currently discards. The implementer must thread it into `handleTwilioStream` and
  `CurrentCall` rather than inventing a sentinel user. *Cost if wrong:* Twilio call captions
  would land under the wrong user, or under none.

Task 7: review spec ❌, quality Changes Requested — **2 Critical**. Entering the fix loop.
- Critical 1: `/v1/call` resolves the session under `active.userId` (the call's owner) instead of
  the polling principal's, so any authenticated user reads another's live call captions and
  status with no session id needed. Worse, `drain` mutates: `GET /v1/call?since=99999999` prunes
  the victim's undelivered caption buffer — a cross-tenant **write**. This is the exact leak
  Task 7 exists to close, relocated from `/v1/audio` to `/v1/call`.
- Critical 2: two of the four isolation tests cannot fail. `FakeTranscriptionProvider` emits
  nothing unless explicitly driven, so `drain` returns `[]` under scoped and unscoped keying
  alike. The only route-level cross-tenant test passes against pre-change code.
- **R23** — My own dispatch contributed to Critical 1. I told the implementer the Twilio
  session's *owner* is the upgrade-time principal (R22), which is right, and they reasonably
  extended ownership into the *read* key, which is wrong. Ownership decides who a session
  belongs to; the polling principal decides who may read it. Both fixes go in this round.
  *Cost if wrong:* `/v1/call` reports no active call when the poller is not the call's owner —
  correct for every real topology, since the phone and watch pair into one user.
- Verified clean by the reviewer: correction 1 honoured (no `this.transcripts?.*` arity changed),
  all `SessionStore` methods keyed by user, `reapIdle`/`closeAll` cannot cross users, Twilio
  threading has no path that creates a session without a user.
Task 7: fix round 1/5 (2 Critical + 2 Minor addressed, 1 residual — commits 6056815..416a70d).
  Implementer proved the isolation tests discriminate by reintroducing the unscoped-key bug in a
  throwaway worktree, not merely by asserting they do.
- **R24** — Fix the residual `lastReason()` leak in `/v1/call`'s `!active` branch rather than
  deferring it. `CurrentCall` is process-global, so after one user's call ended any other
  authenticated poller received `{active:false, reason:"ended"}` — the same disclosure we had
  just suppressed one branch over, plus a functional bug where an unrelated watch announces a
  call that was never theirs. *Cost if wrong:* one more round on a small diff.
Task 7: fix round 2/5 (1 addressed, 0 open — commits 416a70d..564071f). Re-review confirmed no
  over-suppression: the owner still receives their reason after an end, a replace, and a reap.
Task 7: complete (commits 500d030..564071f, review clean after 2 fix rounds)

Task 8: review spec ✅, quality Changes Requested — 3 Important, no Critical. Fix loop.
- Important 1: `userDir` is a denylist (`..`, `/`, `\`, `\0`, empty) and accepts `.`, which
  `join`s to the root itself — collapsing a "user" onto the shared root that still holds the
  legacy flat transcripts pre-Task-12. Containment holds, so not Critical, but it defeats the
  one-dir-per-user invariant the guard exists for. Fix: allowlist `/^[A-Za-z0-9_-]+$/`, mirroring
  the existing `isSafeName`, which subsumes every other case including Unicode look-alikes.
- Important 2: no test drives a caption through `SessionStore` into a real `TranscriptStore` and
  asserts it lands in the owner's directory. The fakes drop `userId`, so a future edit passing
  `id` as `userId` at any of the four call sites would fail no test — the exact class of bug
  Task 7 shipped.
- Important 3: `finalizer.ts` calls `userDir` and a new `mkdirSync` outside any try/catch inside
  an `async run()` invoked as `void run(...)`. A throw is an unhandled rejection, which by
  default terminates the process — in a function documented "best-effort".
- **R25** — Fix all three this round. *Cost if wrong:* a larger diff on a task already green.
- **Known interim regression, accepted:** `runBackfills` still sweeps the flat root, which now
  holds only per-user subdirectories, so both backfills are no-ops for new transcripts between
  Task 8 and Task 12. Task 12's brief explicitly owns this. Recording it here so it is not
  mistaken for a defect if the branch is exercised before Task 12 lands.
- Report nit for the implementer: it cites a "Security requirement" section of the brief that
  does not exist — that requirement came from my dispatch, and the brief's Step 3 comment
  actually says the opposite ("they need no sanitizing"). Code is right, citation is wrong.
Task 8: fix round 1/5 (3 Important + 3 Minor addressed, 0 open — commits 0c4f124..63c32e7).
  Re-review confirmed the tightened allowlist still admits real `randomUUID()` ids, every
  `userDir` caller fails closed, and the new end-to-end test was proven to catch an injected
  `append(id, id, ...)` regression.
Task 8: minor (deferred): `server.ts`'s two `userDir` call sites rely on the outer
  `handleRequest(...).catch()` rather than a local guard. Pre-existing, unreachable while
  `principal.userId` is always a real UUID.
Task 8: complete (commits 564071f..63c32e7, review clean after 1 fix round)

Task 9: minor (deferred): the length-prefixed key helper is now copied into three stores rather
  than shared. Reviewer independently agreed with keeping the copies — one pure line, no shared
  state, and all three verified byte-identical. Extract only if a fourth store appears or they
  drift.
Task 9: minor (deferred): `ReaderPresence.clear()` is still uncalled from production code.
  Confirmed pre-existing, not introduced here.
Task 9: complete (commits 63c32e7..c97c487, review clean first pass — spec ✅, quality approved)

Task 10: review spec ✅, quality Changes Requested — 2 Important, 0 Critical. Fix loop.
  Implementer found two real bugs in my brief's `moveTranscripts` pseudocode and proved them by
  running their collision test against the literal version: `renameSync` silently overwrote a
  same-named destination file, and an unconditional `rmSync(recursive:true)` deleted the very
  files its own per-file catch had just spared — the comment claiming "a stranded file is
  recoverable" was false in its own code. Their replacement was judged correct on merits.
- **R26** — Important 1: `rmSync(from, {recursive:true})` is guarded by a `stranded` counter
  computed from a `readdirSync` snapshot. `TranscriptStore.append` still writes under the OLD
  userId for any in-flight session, and re-creates the directory if needed, so a caption landing
  between the loop and the removal is deleted. Fix: `rmdirSync(from)` non-recursive, which fails
  `ENOTEMPTY` and makes the guarantee a filesystem invariant rather than a counter the code has
  to get right. *Cost if wrong:* none; strictly safer.
- **R27** — Important 2: `/v1/pair/claim` has no attempt limiter, which is an account-takeover
  path. `/v1/devices` is open, so an attacker self-registers and brute-forces the 6-digit code
  inside its 10-minute window; a hit moves their device onto the victim's `userId` and hands
  them the victim's entire transcript directory. Fix now rather than defer — the exposure lands
  in this diff and the limiter already exists in scope. *Cost if wrong:* a legitimate user who
  mistypes many times waits out a window.
- Minor (carried to Task 12): captions appended AFTER `moveTranscripts` returns are stranded in
  the old user's directory permanently — nothing sweeps it.
- Minor (deferred): `existsSync`-then-`renameSync` is itself TOCTOU across two simultaneous
  claims into one destination. Needs two watches with identical filenames pairing at once.
- Minor (deferred): `readBody` reports a stream abort as 413 "body too large". Pre-existing,
  shared with `/v1/devices`.
Task 10: fix round 1/5 (2 Important + 2 Minor addressed, 0 open — commits b0c7453..e633394).
  Re-review confirmed the claim limiter is keyed on `deviceId` (stable across a claim, since
  `claimPairingCode` only updates `user_id`), that `peek` runs before the code lookup so an
  exhausted device gets zero real guesses and no existence oracle, and that a successful claim
  does not consume budget. Attacker ceiling: 10 registrations/hour/IP × 5 attempts = 50 guesses
  against a 1,000,000-code space in its 10-minute life, down from near-certain success.
Task 10: minor (deferred): the claim limiter is in-memory and per-process, so a multi-IP attacker
  scales linearly and a multi-instance deploy multiplies budgets — the same caveat the
  registration limiter already carries.
Task 10: minor (deferred): a successful claim does not clear prior failures, so four typos then
  success leaves one attempt for a second pairing inside the same window.
Task 10: complete (commits c97c487..e633394, review clean after 1 fix round)

Task 11: complete (commits e633394..1da0733, review clean first pass — spec ✅, quality approved).
  Test count 400 → 383 reconciled exactly: 20 settings tests deleted, 3 provider tests added.
  `settingsStore.test.ts` never existed in repo history — verified via `git log --all`, not taken
  on trust. `grep -rni "settings" backend/src/*.ts` now exits 1.

Task 12 state check before dispatch (Task 6 already reached into these files, per R17):
  - `config.ts` has NO `authToken` and NO `adminToken`/`dbPath` yet.
  - `index.ts` already has `mkdirSync` + `openDb(join(transcriptsDir, "identity.db"))` inline and
    passes `transcriptsRoot`, but passes NO `adminToken` — so `/v1/usage` is closed in production
    (R21) until this task wires it.
  - `runBackfills` still passes `dir: config.transcriptsDir`, the flat root, which now holds only
    per-user subdirectories — both backfills are silent no-ops for every new transcript.

Task 12: review spec ❌, quality Changes Requested — **1 Critical, 2 Important**. Fix loop.
- Critical: `migrateFlatTranscripts` excludes only `settings.json`, but `config.dbPath` defaults
  to `join(transcriptsDir, "identity.db")` and `index.ts` opens it BEFORE the migration runs, so
  `identity.db` is a loose file at the root when `readdirSync` sees it. The migration moves the
  identity database into a user directory. Reviewer reproduced it against the real modules:
  boot 1 moves `identity.db`, boot 2 opens a fresh empty DB, mints another user, and reprints a
  new token. Consequences: the printed adoption token is dead on arrival, every registered device
  loses its token on every restart, and the migration never becomes idempotent in production —
  it mints a new orphan user per boot forever. This is a total identity wipe, and it makes the
  orphaning this task existed to fix strictly worse.
- **R28** — Fix by allowlisting transcript suffixes (`.jsonl`, `.summary.md`, `.notion.json`)
  rather than denylisting `settings.json`. An allowlist also disposes of dotfiles and of SQLite
  sidecars (`-journal`, and `-wal`/`-shm` if journal mode ever changes). *Cost if wrong:* a
  future transcript artifact with a new suffix would not migrate, which fails visibly rather
  than destroying data.
- Why every test missed it: all of them build the store with `openDb(":memory:")`, so no database
  file ever exists at the root. The added restart test would have caught it verbatim had the
  store been file-backed at `join(root, "identity.db")`.
- Important: `README.md:86` still documents `GET`/`PUT /v1/settings` as live in the Transport API
  table; Task 11 deleted those routes, and README.md was edited in this very diff.
- Important: `config.test.ts` red-before-green was never observed — the report says so plainly.
  The Critical above is the concrete cost of that discipline gap.
Task 12: fix round 1/5 (1 Critical + 2 Important + 3 Minor addressed, 0 open — commits
  1573906..de87817). Re-review walked the full history of `transcriptStore.ts` to prove the
  allowlist is complete against every artifact ever written, confirmed `settings.json` cleanup is
  independent of the filter and still fires, and confirmed the new file-backed test fails against
  the pre-fix denylist. Idempotence actually improves: previously ANY stray non-transcript file
  at the root minted a fresh user every boot.
Task 12: minor (deferred): the file-backed test asserts the token resolves BEFORE run 2 rather
  than after; covered indirectly by the final `readdirSync` equality, but weaker than specified.
Task 12: minor (deferred): a root containing only `settings.json` is correct but untested in
  isolation — the existing test also seeds a `.jsonl`.
Task 12: minor (deferred): `moveTranscripts` in `server.ts` still moves every entry unfiltered.
  Safe today (it runs between per-user directories), but it would sweep a database if `DB_PATH`
  were ever pointed inside one. The migration's allowlist is the safer shape.
Task 12: complete (commits 1da0733..de87817, review clean after 1 fix round)

ALL 12 TASKS COMPLETE. Branch multi-tenant-relay, commits 1ecfeef..de87817, 393 tests passing.

FINAL WHOLE-BRANCH REVIEW: not ready to merge. No cross-tenant READ leak found; route-by-route
scope map verified; all three key helpers verified byte-identical; no test found that cannot fail.
Two Criticals block, and both are my follow-through errors rather than implementer errors:
- F1: `trustProxyHeaders` is never wired. R12 explicitly assigned this to Task 12 and I never
  carried it into Task 12's dispatch. On Fly the registration limiter therefore degrades to one
  global 10/hour bucket — ten requests from anyone kill onboarding for every user for an hour,
  while providing zero protection against the attacker it was written for. No test can catch it:
  `server.devices.test.ts` tests the flag, not the caller.
- F2: any self-registered device can terminate another user's live call.
  `twilioStreamHandler.ts:44-53` evicts `calls.current()` unconditionally, regardless of owner.
  R23 reasoned about who may *poll* a call and never about who may *evict* one; I scoped
  `CurrentCall`'s read and reason but left its single global slot unscoped.
- **R29** — Fix F1, F2, F4, F5, and the Minors in ONE fix dispatch per the skill's final-review
  rule, then one scoped re-review. Promote Task 3's deferred "purge has no index" minor into it:
  it is the amplification half of F4, an unindexed full-table DELETE on the single writer driven
  by an unrated endpoint.
- **R30** — F3 (open registration grants unmetered access to the operator's Deepgram key) is NOT
  a code defect and NOT mine to decide. The branch faithfully implements the spec; the spec's own
  "revisit before a free tier grants metered cloud minutes" trigger has already fired, because
  `/v1/audio` reaches the operator's Deepgram key with no per-user cap and tokens never expire.
  Documenting it as an explicit accepted risk with a follow-on, and surfacing it to the user as a
  decision to make before this is ever exposed publicly. *Cost if wrong:* a real bill.

