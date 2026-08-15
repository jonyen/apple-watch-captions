# SDD ledger — plan: docs/superpowers/plans/2026-08-15-export-destinations.md

Spec: docs/superpowers/specs/2026-08-14-multi-tenancy-and-exports-design.md, section 6 **as
amended 2026-08-15** (configuration moves off the phone to `/app`). Binding authority.
Branch: export-destinations, off multi-tenant-relay @ 0e73384. No worktree (user's standing
preference from the previous plan).
Baseline: 410 tests passing, `tsc --noEmit` clean.

## Pre-flight conflict scan

### Self-consistency, per task

| Task | Own text agrees with itself? |
|---|---|
| 1 | Yes. `open` checks the version before parsing, so the `v2.` test throws `/version/i`; `"not-sealed"` splits to length 1 and throws. |
| 2 | Yes. `list()` detail is `workspaceName ?? databaseId`; email `connected` is `Boolean(verifiedAt)`. Matches every assertion. |
| 3 | Yes internally — but see P1, which is a gap in what the flow *produces*, not a contradiction. |
| 4 | **No** — see P3. The early-return snippet is shown for both backfills but carries notionBackfill's result shape. |
| 5 | Yes internally; depends on P1. |
| 6 | Yes. TTL 24h vs clock +TTL+1 correctly expires; minting drops the prior row, so the replaced-token test holds. |
| 7 | **No** — see P2. The test fixture uses `Topic:` but `parseSummary` only recognises `Title:`, so the subject assertion would fail against a correct implementation. Also P4. |
| 8 | Yes. |

### Task pairs sharing a file or interface

| Pair | Produces → consumes | Finding |
|---|---|---|
| 1 → 2 | `seal`/`open` | Clean. |
| 2 → 4,5,7,8 | `ExportDestinationStore` | Clean. |
| 2,3,6 → db.ts | three `CREATE TABLE IF NOT EXISTS` additions | Clean; additive and sequential. |
| 3 → 5 | `OAuthStateStore`, `authorizeUrl`, `ExchangeCode` | See P1. |
| 4 → 7 | `FinalizerOptions` | Clean; 4 replaces `export`/`update` with `resolve`, 7 adds `sendTranscriptEmail`. |
| 4 → 8 | `index.ts` resolver wiring | Clean. |
| 5,6,7,8 → server.ts | route additions | Clean; sequential. See P4. |
| 5,7,8 → config.ts | additive fields | Clean. |
| 5 → 8 | callback redirects to `/app/exports` | P5: that route does not exist until Task 8. Benign — sequential, and the redirect target is a 404 only in the interim. |
| 2 → 8 | `adoptLegacyNotion` added to `exportDestinations.ts` | Clean. |

### Rulings made before execution

- **P1 / R1** — **The OAuth callback has no reliable `databaseId`.** My plan maps Notion's
  `duplicated_template_id` to `databaseId`, but that field is only returned when the integration
  uses a template. A normal integration grants access to pages the user picks, and the token
  response carries no database id at all — so the callback would store `databaseId: ""` and
  every export would `POST /databases//pages` and fail. Ruling: after a successful exchange the
  callback must resolve the database itself, via `POST https://api.notion.com/v1/search` with
  `{ filter: { value: "database", property: "object" } }` using the freshly granted token. Use
  `duplicated_template_id` when present; otherwise take the first database the search returns and
  store its title as `workspaceName` so the user can see in `/app` which one was chosen. If the
  search returns none, store nothing and redirect to `?notion=nodatabase`, because a connection
  with no destination is worse than no connection. Carried into Task 5's dispatch, with the
  search behind the same injectable seam as `exchangeNotionCode` so it stays testable.
  *Cost if wrong:* a user who granted several databases gets the first one rather than a chosen
  one; visible in `/app` and fixable by reconnecting.
- **P2 / R2** — Task 7's `transcriptEmail` fixture uses `"Topic: Coffee plans"`, but
  `summaryPrompt.parseSummary` recognises only a `Title:` first line (optionally bold or
  heading-wrapped). As written the test asserts a subject the correct implementation cannot
  produce. Ruling: the fixture becomes `"Title: Coffee plans\n\nThey agreed on 3pm."`.
  *Cost if wrong:* none; it aligns the test with the parser that already exists.
- **P3 / R3** — Task 4's early-return snippet returns `{ exported, skipped, failed }`, which is
  `notionBackfill`'s shape. It applies to `notionBackfill` only. `summaryBackfill` must NOT
  return early on a missing connection — a user with no Notion still wants summaries written to
  disk — so there `resolve` is optional and the patch site uses `exporters?.patchSummary`.
  *Cost if wrong:* summaries would silently stop being generated for every unconnected user.
- **P4 / R4** — Task 7 constructs `emailLimiter` in `startServer` but never says to thread it
  into `handleRequest`, which is how `limiter` and `claimLimiter` already reach the routes. It
  must be threaded the same way. *Cost if wrong:* a compile error, caught immediately.
- **P5** — no ruling needed; sequential.

## Task log

Task 1: minor (deferred): the malformed-value test exercises only the 1-part case, not a
  mid-range like `v1.b.c`.
Task 1: minor (deferred): buffers are not zeroized after use. Standard for Node; not fixable
  meaningfully in JS.
Task 1: complete (commits 0e73384..9a9b9ad, review clean — spec ✅, quality approved; reviewer
  independently traced IV uniqueness, real auth-tag verification, and that no malformed input
  escapes as an unhandled crash)
Task 2: minor (deferred): a `notion` row with `secret = NULL` is corrupt state (putNotion always
  seals one) but `getNotion` reports it identically to "not connected". Worth distinguishing if
  it ever appears.
Task 2: complete (commits 9a9b9ad..242d21d, review clean — spec ✅, quality approved; reviewer
  confirmed `list()` is structurally incapable of emitting a secret, and every query filters on
  user_id rather than accepting and ignoring it)
Task 3: minor (deferred): a state-value collision on INSERT would surface as a raw SQLite
  constraint error. Probability ~0 at 256 bits.
Task 3: carried into Task 5's dispatch — expired and unknown states are indistinguishable to the
  caller by design, so the callback cannot show a distinct "session expired" message; and
  `createCodeExchange` leaves network and JSON-parse failures unwrapped, so Task 5's route must
  catch them rather than letting them escape.
Task 3: complete (commits 242d21d..ffac476, review clean — spec ✅, quality approved; reviewer
  traced every consume path and confirmed no path leaves a reusable row, and that mint's sweep
  filters on expiry so it cannot delete another user's live in-flight state)
Task 4: returned DONE (commit 662cafa) with two concerns. Addressing the first before review.
- **R5** — `index.ts` calling `keyFromEnv(process.env.ENCRYPTION_KEY)` at import time is
  plan-mandated (my text) and wrong. It means a relay upgraded without `ENCRYPTION_KEY` set
  boot-loops — taking down live captioning, which has nothing to do with exports. Captioning is
  the product; export is an add-on, and an add-on's missing secret must not be able to kill it.
  Every other optional feature in `config.ts` already follows the opposite pattern: `notion`,
  `usage`, and `callForwardTo` are all undefined-when-unset with the feature disabled. Ruling:
  the key becomes optional the same way — unset means export destinations are disabled and their
  routes answer 503, while the relay boots and captions normally. Task 1's "fail loudly rather
  than default" reasoning still holds and is untouched: `keyFromEnv` still throws on a present
  but malformed key; what changes is that absent is a valid, feature-off state rather than fatal.
  *Cost if wrong:* an operator who meant to enable exports and forgot the key sees 503s from the
  export routes instead of a boot failure — visible in `/app`, and the docs in Task 8 cover it.
- Second concern (a removed finalizer test) is a coverage judgement, not a correctness one.
  Flagging it to the reviewer rather than pre-deciding: `exportOnce`'s `if (!update) return false`
  branch is still live code even if `UserExporters` makes it unreachable through `resolve`.
Task 4: review spec ✅ (one note), quality Changes Requested — 1 Critical, 1 Important. Fix loop.
- Critical: `finalizer.ts` calls `opts.resolve?.(...)` outside any try, inside a fire-and-forget
  `void run(...)`, with no global unhandledRejection handler. `resolve` reaches `open()`, which
  throws on a bad auth tag or wrong version, plus `JSON.parse` and SQLite errors. So one user
  whose sealed token cannot be opened — rotated key, DB restored from another environment —
  crashes the process on every finalize. Same failure mode commit 5cf204f was written to prevent,
  re-entered through a different door.
- Important: the same throw in both backfills is caught only by the outer
  `runBackfills().catch()`, so one poisoned row aborts the whole per-user loop and stops
  summarisation and export catch-up for every other user.
- **R6** — The reviewer disproved the implementer's case for deleting the finalizer test.
  `exportOnce`'s `if (!update) return false` is still live: `notionBackfill` calls `exportOnce`
  with no updater, and `exportOnce` re-reads the marker itself, so the branch guards the real
  window between the sweep's check and that re-read — reachable in production because
  `runBackfills()` runs at boot while live finalizes are landing markers. Retiring the *finalizer*
  framing is right; retiring the *scenario* is not. Ruling: re-anchor the test onto the caller
  that still expresses the state, and keep the branch. *Cost if wrong:* one test covering a
  narrow race.
- Note for Task 8: `config.notion` is now dead in production and the old "NOTION_TOKEN not set"
  boot log is gone, so an operator upgrading with a global token silently stops exporting until
  each user connects. Task 8's `adoptLegacyNotion` migration covers the data; confirm it also
  restores an operator-visible log line.
Task 4: fix round 1/5 (4 addressed, 1 open — commits 5cf204f..a549229). Critical crash, sweep
  guard, and both minors landed. The restored test does NOT discriminate: re-reviewer deleted
  `if (!update) return false` and traced the fallback — `update(...)` on undefined throws a
  TypeError into the existing catch two lines down, logs, and returns `false`, so every assertion
  in the test holds identically with the branch gone.
- **R7** — The observable difference between having the branch and not is exactly one thing: with
  it, a normal expected condition (marker present, no updater — the boot sweep racing a live
  finalize) completes quietly; without it, that ordinary case logs an error. Ruling: round 2's
  test asserts that no error is logged. That is not log-shape brittleness — a spurious error on a
  routine condition is a real defect, it would mislead an operator diagnosing export failures,
  and it is the only thing that distinguishes the two implementations. *Cost if wrong:* a test
  coupled to the fact that this path stays quiet, which is the property worth protecting.
Task 4: fix round 2/5 (1 addressed, 0 open — commits a549229..fa4799d). Test-only. Implementer
  verified by deleting the guard mid-run: green with it, RED without it, green after restoring.
  Spy is created in beforeEach and restored in afterEach, so it cannot leak into sibling tests.
Task 4: minor (deferred): a per-user sweep failure is logged but not counted in
  `result.failed`/`totals.failed`.
Task 4: complete (commits ffac476..fa4799d, review clean after 2 fix rounds)
Task 5: review spec ✅, quality Changes Requested — 0 Critical, 1 Important. Fix loop.
  Reviewer built a six-row attack table against the unauthenticated callback and found no path
  that binds a workspace to another user's account: `putNotion` has exactly one call site and its
  userId comes only from `consume(state)`. Also confirmed no secret reaches any body, Location
  header, or log, and that the two static redirect literals rule out an open redirect.
- Important: an unconfigured `findNotionDatabase` is mapped to the same user-facing
  `?notion=nodatabase` as "you granted no database", with no log line. Those differ in who must
  act — sharing a database is something the user can fix; an unwired seam is not. The realistic
  failure is Task 8 wiring `exchangeNotionCode` and forgetting this one, after which every
  non-template user gets a permanent polite "share a database" and nothing is ever logged.
- **R8** — Fold in the two weak tests the reviewer identified. "never returns a secret" currently
  passes on any 401/404/500, so it mostly cannot fail; and asserting the access token *inside*
  the `findNotionDatabase` fake throws into the route's own catch, surfacing as a confusing
  redirect mismatch rather than a token mismatch. Both are the failure mode this plan keeps
  hitting. *Cost if wrong:* a slightly larger fix diff.
Task 5: minor (deferred): a template-path connection with no `workspace_name` shows a raw UUID as
  its `/app` detail — the search-title fallback only runs when `databaseId` is absent.
Task 5: minor (deferred): the callback is unauthenticated and unlimited, unlike `/v1/devices`.
  Each request is one indexed SQLite read plus a delete, and does nothing without a valid state.
Task 5: fix round 1/5 (6 addressed, 0 open — commits ec32903..11cc540). Re-review confirmed the
  unwired-seam fix did NOT mirror the bug: a configured search that legitimately finds nothing
  still reaches `nodatabase`, only the unwired case goes to `failed`. Also confirmed the `denied`
  branch consumes the state before returning, which stops an attacker replaying a leaked
  denied-URL with their own code against the same state.
Task 5: minor (deferred): no test asserts the `console.warn` fires for the unwired-seam case.
  Matters only if operator alerting on that line ever becomes load-bearing.
Task 5: complete (commits fa4799d..11cc540, review clean after 1 fix round)
Task 6: review spec ✅, quality Changes Requested — 1 Important, 2 Minor, all in test rigour.
  Implementation verified correct by reading: `mint`'s per-user delete is scoped by user_id, the
  sweep removes only expired rows, `consume` deletes before checking expiry. The gap is that the
  tests would not catch a regression away from any of that.
- Important: no test involves a second user, so a `mint` running an UNSCOPED
  `DELETE FROM email_verifications` — wiping every user's pending row — would pass all six tests.
  Cross-user isolation was a stated requirement with zero coverage.
- Minor: the expiry test does not discriminate delete-before-check from check-before-delete; both
  return null on a single post-expiry call, and the row's absence is never asserted.
- Minor: the unguessability test only checks length and the absence of the literal address, so a
  deterministic hash-derived token would pass.
- **R9** — This vindicates flagging the weak red-before-green evidence. "Cannot find module"
  proves a test file is wired up and nothing more; it cannot distinguish a correct implementation
  from a wrong-but-present one. Ruling: for the rest of this plan, module-not-found is not
  acceptable as red-before-green evidence on its own — an implementer must show a test failing
  against a plausible wrong implementation, not merely against an absent one.
  *Cost if wrong:* slightly more work per task, on the exact failure mode this codebase keeps
  shipping.
Task 6: fix round 1/5 (3 addressed, 0 open — commits 5e88c73..4b777e6). Test-only;
  `emailVerification.ts` byte-identical, verified independently. Each test shown red against the
  exact broken implementation it guards — unscoped delete, check-before-delete, and a
  sha256(userId:address) token — then green after restoring. This is the strong form of evidence
  R9 now requires.
Task 6: complete (commits 11cc540..4b777e6, review clean after 1 fix round)
Task 7: review spec ✅, quality Changes Requested — 2 Important, 4 Minor, 0 Critical.
  Reviewer traced the only path to a transcript send and confirmed `verifiedAt` gates it; that a
  re-submitted address does NOT inherit a prior confirmation (put replaces the whole config blob);
  that confirm cannot verify another user or address and cannot be replayed; and that header
  injection is unreachable — it ran the regex against `\n`, `\r\n`, `\r`, and a bcc payload, all
  rejected, and the provider call JSON-encodes rather than concatenating headers.
- Important 1: `finalizer.ts:85`'s fast path `if (!opts.summarize && !exporters) return;` returns
  BEFORE the new email block, so a relay with no summary provider serving a user with no Notion
  connection never mails a verified address even though email is fully configured. **This guard
  came from my own Task 4 round-1 minor cleanup** — I asked for the condition to reflect reality
  and did not consider that a later task would add work below it. Its comment is now false too.
- Important 2: `finalizer.ts` changed with zero test changes. The two highest-value assertions are
  absent: a throwing `sendTranscriptEmail` being swallowed by `run` (the stated crash hazard, now
  untested), and the verify-then-change-address case, which passes today only as a side effect of
  `put` being a blob replace rather than a merge.
- **R10** — Fold in two Minors that are substantive rather than cosmetic: `DELETE
  /v1/exports/email` leaves the outstanding verification token alive, so following a stale link
  afterwards re-creates the destination **already verified**; and `putEmail` runs before the send,
  so a 502 from the provider destroys the user's previously verified address. Both are data
  correctness, not polish. *Cost if wrong:* a larger fix diff on an otherwise clean task.
- Note for Task 8: `deployWiring.test.ts` gives false assurance — it is named for the whole wire
  but asserts only `trustProxyHeaders` and one `fly.toml` line, while the entire `/v1/exports/*`
  surface is unreachable in production and nothing notices. Task 8 must extend it to cover
  `destinations`, `oauthStates`, `notionOAuth`, `emailVerifications`, `sendEmail`, and
  `publicBaseUrl`, and add `RESEND_API_KEY`/`EMAIL_FROM`/`PUBLIC_BASE_URL` to `fly.toml`.
- Note for Task 8: one-bug-per-mutant is the evidence standard from here. Task 7's composite
  five-bug mutant cannot prove which test catches which bug.
Task 7: fix round 1/5 (6 addressed, 1 new minor — commits e758261..632da3e). Re-review confirmed
  the send-then-write reordering is the strictly safer failure mode, because the confirm handler
  writes from the token's own claim and self-heals; `deleteForUser` is scoped to the caller; and
  the finalizer tests meet the one-bug-per-mutant standard.
- **R11** — Take a second round on the new finding rather than deferring it. Widening the guard
  put the email send behind `mkdirSync` inside a try/catch that returns on failure, so an
  email-only relay does a pointless syscall per finalize and, worse, a directory failure now
  silently swallows the email. That is a narrower reprise of Important 1 from this same round —
  the third time this one guard has mis-scoped work beneath it. Deferring a bug we have now
  created twice in the same five lines is how it becomes permanent. The fix is small: email needs
  no directory, so it should not sit downstream of one. *Cost if wrong:* one more small round on
  a task that is otherwise clean.
Task 7: fix round 2/5 (1 addressed, 0 open — commits 632da3e..63cd8e7). Re-review enumerated all
  six configuration orderings through `run` and found each correct; the combined top-level guard
  is gone, replaced by two independent local gates, which is more precise than what it replaced.
  New test verified red against the actual round-1 commit rather than a mutant.
  The reviewer's deferred item — `exportOnce` not locally wrapped — I checked myself and closed:
  it wraps both its own `await` sites in try/catch and returns false, so it cannot escape.
Task 7: complete (commits 4b777e6..63cd8e7, review clean after 2 fix rounds)
Task 8: review spec ❌, quality Changes Requested — 2 Critical, 2 Important. Fix loop.
- Critical 1: `adoptLegacyNotion` is dead on arrival. `migrateFlatTranscripts` returns null once
  the flat root is empty, and it is the ONLY source of the operator user id. The multi-tenant
  plan deploys first and empties that root; this plan deploys after, so the migration never
  fires, no destination row is written, and `resolveExporters` reads only the store with no
  `config.notion` fallback left anywhere. An operator upgrading with a working global
  NOTION_TOKEN silently stops exporting for every user, permanently — while the boot log implies
  the old path still works. The implementer judged this "likely unreachable"; the reviewer
  verified against `git branch --contains` that it is exactly what happens.
- Critical 2: the comment at `index.ts:91-93` asserts the legacy path "still works" via a
  fallback that does not exist, and `README.md` and `DEPLOY.md` repeat the claim. That sentence
  is what let the gap survive review by its own author.
- Important 1: `notionOAuth` is gated on `config.notionOAuth` alone, not on `destinations`. Set
  the OAuth vars and forget ENCRYPTION_KEY and the relay offers Connect, sends the user to Notion,
  has them grant a real workspace scope, then bounces them to a generic failure with no way to
  fix it — a partially configured relay strictly worse than an unconfigured one.
- Important 2: `deployWiring.test.ts` is a spelling check over the `startServer({…})` literal. It
  catches a dropped option but not an inverted gate, an always-undefined value, or a boot crash —
  nothing in the suite executes `index.ts`, so the report's "verified an unconfigured relay still
  boots" is unsupported by any test.
- **R12** — Fold in the `EMAIL_FROM` trap: committing a placeholder to `fly.toml`'s `[env]` makes
  the send gate effectively RESEND_API_KEY-only, so an operator who sets the key but not a real
  address gets provider rejections instead of the feature staying off. *Cost if wrong:* one more
  config line to reason about.
Task 8: fix round 1/5 (4 addressed, 1 new Important — commits 1942f60..ed9acfc). Re-review walked
  all five adoption cases and the full five-cell gating matrix, and verified the extraction is
  field-for-field identical to the deleted call (17 keys, nothing renamed or dropped).
- **R13** — New Important, and it is caused by the fix: making adoption run every boot means
  `DELETE /v1/exports/notion` no longer sticks. A single-user relay that still has NOTION_TOKEN
  set re-adopts the operator's legacy workspace on the next deploy, so a user's deliberate
  Disconnect silently undoes itself and transcripts resume flowing to a workspace they opted out
  of. I asked whether the new adoption could overwrite an OAuth connection; it cannot — but I did
  not think of Disconnect, and that is the live path. The pre-fix code could not do this because
  adoption fired at most once. Fix it rather than defer: an export destination a user removed
  must stay removed. *Cost if wrong:* an operator who wants re-adoption after a disconnect has to
  reconnect through `/app/exports`, which is the correct place anyway.
- The implementer's own residual concern — "Adopted…" logged on a pure no-op — is the same defect
  seen from the other side: the outcome does not distinguish inserted from already-present, which
  is exactly the signal needed to stop re-adoption.
Task 8: fix round 2/5 (4 addressed, 0 open — commits ed9acfc..45a31c6). Re-review walked the full
  Disconnect cycle — adopt, disconnect, boot, reconnect via OAuth, disconnect, boot — and the
  destination stays absent throughout, because the marker check precedes any inspection of the
  row's current state. Confirmed the marker does NOT block a legitimate first adoption, and that
  ambiguous/not-configured boots return before writing one, so they cannot poison a later valid
  adoption. New table uses CREATE TABLE IF NOT EXISTS with ON DELETE CASCADE matching its
  siblings.
Task 8: minor (deferred): `remove()` has no comment cross-referencing `legacy_notion_resolutions`.
  Grep confirms it is the only `DELETE FROM export_destinations` today, so the risk is future
  fragility — a bulk-cleanup script bypassing it would silently reintroduce the Disconnect bug.
Task 8: complete (commits 63cd8e7..45a31c6, review clean after 2 fix rounds)

ALL 8 TASKS COMPLETE. Branch export-destinations, commits 0e73384..45a31c6, 536 tests passing.

FINAL WHOLE-BRANCH REVIEW: not ready — 2 Important. No cross-tenant path, no secret egress, and
no unverified-address send found; the full secret trace from Notion's response through seal,
storage, unseal, and export is clean. All 13 rulings judged sound.
- I1: `index.ts:187` calls `adoptLegacyNotionIfUnambiguous` at module scope, unguarded. It reaches
  `secretBox.open()`, which throws on a bad auth tag or wrong version — synchronously, at top
  level, with no try. The process exits and Fly boot-loops, killing captioning for an export
  reason. That is precisely what my own R5 forbids, and this is the fourth instance of this
  pattern on the two branches; the boot path is the one call site never closed.
- I2: `fly.toml` hardcodes `PUBLIC_BASE_URL = https://watch-captions-relay.fly.dev`, and
  `DEPLOY.md` tells operators to rename the app on a name clash — now near-certain, since that
  name is taken by this very deploy — while step 7b implies no edit is needed. A from-scratch
  operator therefore sends live Notion authorization codes and live email verification tokens to
  a host they do not control. Neither token is usable there, but both leak along with the user's
  address. The upgrade path works; the from-scratch path does not.
- **R14** — One fix wave per the skill's final-review rule, covering both Importants plus the
  cheap spec-mandated minors: rate-limit the confirm endpoint (spec §6 says it must be), add the
  `remove()` cross-reference guarding R13, make the two DELETE routes 503 like their siblings
  when `destinations` is unset, and stop the boot log reporting `failed: 1` for the ordinary
  sweep-races-finalize case — R7's misleading-signal fix moved the problem one line down rather
  than removing it. *Cost if wrong:* one larger wave instead of several.
- Deferred with reasons, not fixed: spec §6's 401-driven "needs reconnect" state is unimplemented
  and its badge unreachable, because `connected` is `Boolean(secret)` and `putNotion` always seals
  one — closing that needs T2's null-secret ambiguity closed first, so it is a follow-on, not a
  patch. And adoption keying on `soleUserId()` means a stranger who registers before the operator
  pairs a device would receive the operator's legacy database id as their `/app` detail; the token
  itself stays unreadable. Both belong to a later plan.
FINAL FIX WAVE: 5 commits 45a31c6..3ccebfe, 547 tests. Scoped re-review: all six findings closed,
  no new defects. Verified the I1 guard sits at a function boundary so it cannot start a line
  late, and that `exportOnce`'s boolean-to-outcome change has no surviving truthy-string caller —
  the old `done ? exported++ : failed++` is deleted, and `tsc` enforces that ExportOutcome's
  members match BackfillResult's keys.
Deferred from the re-review: the confirm route's 429 returns JSON where its siblings redirect, so
  a rate-limited human following an inbox link sees a raw blob; and the boot warning compares
  `URL.host` rather than `hostname`, so an explicit `:443` would warn spuriously.
BRANCH READY TO MERGE.
