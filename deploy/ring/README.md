# Deploying the relay + transcriber sidecar to ring

This deploys two services to the user's iMac, `ring` (Apple M4, macOS 26.5),
reachable over Tailscale as `ring`. Both run as **user LaunchAgents** (Aqua
session, uid 501, gui/501 domain) — never as system daemons and never via
`sudo` (ring has no interactive TTY for this user over SSH).

**Hard rule respected throughout:** ring also runs the user's `doorlog` app
behind `tailscale serve`. Nothing here touches Tailscale config, doorlog, or
any other existing launchd job. Ports were checked against
`netstat -an | grep LISTEN` on ring before picking them (see below) and
`tailscale serve`/doorlog's port (8099) was left untouched.

## What's running, where

| Service | Plist label | Port | Binary/entry |
|---|---|---|---|
| Transcriber sidecar | `com.jonyen.caption-transcriber` | `127.0.0.1:8790` | `~/apps/watch-captions-relay/transcriber/caption-transcriber` (built by `swift build -c release` on the Mac Studio/build Mac, copied over — no Xcode on ring) |
| Relay | `com.jonyen.caption-relay` | `0.0.0.0:8080` (Fly's default `PORT`, unclaimed on ring — verified with `netstat`) | `tsx src/index.ts` in `~/apps/watch-captions-relay/backend` |

Both plists have `RunAtLoad` + `KeepAlive` set, and log to
`~/Library/Logs/caption-transcriber.log` / `caption-relay.log`.

Port 8790 matches the spec. Port 8080 was chosen because it's the relay's
own hardcoded default (`backend/src/config.ts`'s `PORT` fallback) and nothing
was listening on it on ring at deploy time (checked via `netstat -an | grep
LISTEN` over ssh — the only occupied ports of note were 8099 for
doorlog/tailscale-serve, plus the usual macOS/system ones: 5900 ARD, 3283
ARD, 22 ssh, 88 kerberos, 5000/7000 AirPlay, 88, 49152 launchd, 17500
Dropbox LanSync, 11434 ollama, etc. — nothing relevant collided).

## Directory layout on ring

```
/Users/jonyen/apps/watch-captions-relay/
  backend/            # rsynced backend/ (excludes node_modules, dist, .env, .git); npm ci --omit=dev run here
  transcriber/
    caption-transcriber   # release binary, copied from the build Mac, adhoc-codesigned
  data/
    transcripts/      # TRANSCRIPTS_DIR; DB_PATH defaults to identity.db beside it
  logs/               # (currently unused — launchd logs go to ~/Library/Logs instead, see plists)
  env                 # secrets, mode 600, NOT in git — see "Secrets" below
  run-relay.sh         # launchd ProgramArguments target for the relay
  run-transcriber.sh   # launchd ProgramArguments target for the sidecar
```

`~/Library/LaunchAgents/com.jonyen.caption-transcriber.plist` and
`com.jonyen.caption-relay.plist` are copies of this directory's plists.

## Step-by-step: what was actually run

1. **Preflight** (`ssh ring '...'`):
   - `sw_vers -productVersion` → 26.5.2, `uname -m` → arm64.
   - `node --version` on the default PATH: not found (non-login ssh shell
     PATH is minimal); `/opt/homebrew/bin/node --version` → **v24.18.0**
     (already ≥ 22.5 — no `brew install node` needed).
   - `brew --version` (with `/opt/homebrew/bin` on PATH) → Homebrew 6.0.18,
     already installed.
   - `doppler --version` → 3.76.0 installed, but
     `doppler configs --project personal` failed: *"Unable to retrieve
     value from system keyring"* / exit status 36 — Doppler is installed on
     ring but **not authenticated** (no interactive login is possible over
     a non-TTY SSH session, and we must not attempt one).
   - `xcodebuild -version` → fails ("requires Xcode"); expected, Command
     Line Tools only. Not needed — the sidecar binary is built on the other
     Mac and copied over.
   - `netstat -an | grep LISTEN` → recorded above; 8080 and 8790 both free.

2. **Doppler vs. env file — decision: env file.** Doppler CLI on ring can't
   authenticate non-interactively and the task must not prompt for
   interactive login over SSH. Fell back to the brief's documented
   alternative: a plain `env` file at
   `~/apps/watch-captions-relay/env`, mode 600, sourced by
   `run-relay.sh` via `set -a; source "$ENV_FILE"; set +a`. This file is
   **not committed** — it exists only on ring.

   Secrets were pulled from the live Fly app (its CLI is authenticated on
   the build Mac, once the token is passed explicitly as `FLY_API_TOKEN`
   read from `~/.fly/config.yml` — `fly auth whoami` alone reported "no
   access token available" for an unrelated reason, but the token in
   `config.yml` worked when exported):

   ```
   fly ssh console -a watch-captions-relay -C env > fly-env.raw.txt
   ```

   redirected straight to a file — **never printed to a terminal/transcript**
   — then reformatted (`awk`, still file-to-file, no values ever displayed)
   into `KEY='value'` lines for exactly the keys the relay's
   `backend/src/config.ts` env surface uses and that still apply off Fly:

   - `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `SUMMARY_PROVIDER` (summaries)
   - `NOTION_TOKEN`, `NOTION_DATABASE_ID` (legacy Notion export)
   - `AUTH_TOKEN`, `TWILIO_AUTH_TOKEN`, `TWILIO_FORWARD_TO` (auth/Twilio —
     kept per the brief even though a grep of `backend/src` shows only
     `TWILIO_FORWARD_TO` is actually read by current code; `AUTH_TOKEN` and
     `TWILIO_AUTH_TOKEN` appear to be unused/legacy on the Fly side too, kept
     for parity rather than dropped silently)

   Then appended manually (not from Fly):

   ```
   TRANSCRIPTION_PROVIDER='apple'
   APPLE_TRANSCRIBER_URL='ws://127.0.0.1:8790'
   PORT='8080'
   TRANSCRIPTS_DIR='/Users/jonyen/apps/watch-captions-relay/data/transcripts'
   NODE_ENV='production'
   ```

   **`DEEPGRAM_API_KEY` and `DEEPGRAM_USAGE_API_KEY` were deliberately
   excluded** — this deployment never uses Deepgram.

   Copied to ring with `scp` (mode 600 set immediately after):
   ```
   scp ring-relay.env ring:/Users/jonyen/apps/watch-captions-relay/env
   ssh ring 'chmod 600 /Users/jonyen/apps/watch-captions-relay/env'
   ```

3. **`sync.sh`** (run from this repo checkout, on the build Mac):
   - `swift build -c release` in `transcriber-mac/` (binary already existed
     from Task 3/4's build in this case — rebuilt idempotently).
   - `ssh ring mkdir -p ...` for `backend/`, `transcriber/`,
     `data/transcripts/`, `logs/`.
   - `rsync -az --delete` of `backend/` → `ring:.../backend/`, excluding
     `node_modules`, `dist`, `.env`, `.git`.
   - `scp` the release binary → `ring:.../transcriber/caption-transcriber`.
   - `ssh ring npm ci --omit=dev` in `backend/` on ring (24 packages
     installed; two `allowScripts`-pending postinstalls warned —
     `esbuild`, `fsevents` — harmless, npm just declines to auto-run
     scripts for packages not on the allowlist; did not investigate
     further since the app ran fine).
   - `ssh ring codesign -s - --force .../caption-transcriber` — ad hoc
     re-signs the copied binary so a headless launchd launch isn't blocked
     by Gatekeeper. (In practice the sidecar launched and served requests
     without any further TCC/Gatekeeper prompt — no interactive click was
     needed. If a future macOS update on ring starts blocking it, the fix
     is: run this same `codesign` command again after any binary update,
     and if that's insufficient, the user needs to launch the binary once
     from Finder/Terminal interactively to clear a Gatekeeper quarantine
     flag, then launchd will manage it from there on.)
   - `scp` the wrapper scripts (`run-relay.sh`, `run-transcriber.sh`).

4. **LaunchAgents:**
   ```
   scp com.jonyen.caption-transcriber.plist com.jonyen.caption-relay.plist \
     ring:/Users/jonyen/Library/LaunchAgents/
   ssh ring 'launchctl bootstrap gui/501 /Users/jonyen/Library/LaunchAgents/com.jonyen.caption-transcriber.plist'
   ssh ring 'launchctl bootstrap gui/501 /Users/jonyen/Library/LaunchAgents/com.jonyen.caption-relay.plist'
   ```
   uid confirmed via `ssh ring id -u` → `501` (not assumed).

   Verified:
   ```
   ssh ring 'launchctl list | grep caption'
   #  45825  0  com.jonyen.caption-transcriber
   #  49200  0  com.jonyen.caption-relay
   ```
   (exit status `0` for both — running, not crash-looping)
   ```
   ssh ring 'curl -sS http://127.0.0.1:8080/healthz'   # -> ok
   ```

5. **Bug found and fixed while getting the relay to boot at all:**
   `backend/src/config.ts` unconditionally threw `"DEEPGRAM_API_KEY is
   required"` regardless of `TRANSCRIPTION_PROVIDER` — a deployment with no
   Deepgram key (exactly what the brief asks for) could never boot. Fixed
   by making `deepgramApiKey` optional on `Config` and only requiring it
   when `TRANSCRIPTION_PROVIDER !== "apple"`; `index.ts`'s
   `createClient(...)` call now falls back to a placeholder string when the
   key is absent (the deepgram client is otherwise unused — confirmed via
   `providerFactory.ts`, which already guards every non-default provider on
   its own API key being present before use). This is a backend fix
   (`backend/src/config.ts`, `backend/src/index.ts`), not a deploy/ring
   file — committed separately from this directory's commit, since it's a
   real correctness bug independent of ring specifically.

6. **Second bug found during the end-to-end proof step:** the relay's
   `/stream` WebSocket handler only ever called `session.close()` (which
   starts the Apple provider's graceful-finish handshake) from the socket's
   own `close`/`error` events — i.e. *after* the client had already
   disconnected, by which point nothing could be sent back to it. Deepgram
   never needed this because it finalizes continuously on VAD pauses
   mid-stream; the Apple sidecar only emits its true final result after an
   explicit `{"finish":true}` handshake (see Task 3's `ws-smoke.mjs`
   protocol). Fixed by having `/stream` recognize an in-band text control
   frame `{"finish":true}` from the client and call `session.close()` right
   then, while the socket is still open — same `backend/src/server.ts`,
   committed alongside the config.ts/index.ts fix above. All 599 existing
   backend tests still pass (`npx vitest run`).

7. **On-ring smoke test (Task 3's `ws-smoke.mjs`, run ON ring against the
   sidecar directly):**
   ```
   ssh ring 'node ws-smoke.mjs ws://127.0.0.1:8790 hello.wav'
   ```
   `hello.wav` copied from `~/Projects/moonshine-coreml/test-assets/hello.wav`
   on the build Mac; `ws-smoke.mjs` and its `node_modules/ws` copied from
   `transcriber-mac/scripts/`. Result: `{"ready":true}` → progressive
   partials → `(finish sent)` → two more partials → one
   `isFinal:true` final ("Hello, this is a test of captions running on the
   watch.") → `{"done":true}` → clean server close. **Pass.**

8. **End-to-end proof, run from the build Mac against ring over the
   tailnet** (this is the actual acceptance bar for this task — the funnel
   from Task 6 is not involved, just plain tailnet reachability at
   `ring:8080`):
   - Registered a throwaway device/token directly against the relay:
     ```
     ssh ring 'curl -sS -X POST http://127.0.0.1:8080/v1/devices \
       -H "Content-Type: application/json" -d "{\"kind\":\"watch\"}"'
     # -> {"deviceId":"...","userId":"...","token":"qHfPtCPaoqgs69tXsyupQDCbxt4vy2sFPoH32bpISAY"}
     ```
   - Streamed `hello.pcm` (raw PCM16 mono 16 kHz — the WAV's 44-byte header
     stripped locally) to `ws://ring:8080/stream?token=<token>` with a small
     one-off script (`relay-e2e-smoke.mjs`, not committed — lived only in
     the session scratchpad and `backend/scripts/` temporarily, removed
     afterward) that streams audio, sends `{"finish":true}`, and waits for
     an `isFinal:true` caption before closing.
   - **Decisive output:**
     ```
     {"type":"ready"}
     {"type":"caption","text":"Hello","isFinal":false}
     ...
     {"type":"caption","text":"Hello, this is a test of captions running on the","isFinal":false}
     (finish sent)
     {"type":"caption","text":"Hello, this is a test of captions running on the watch","isFinal":false}
     {"type":"caption","text":"Hello, this is a test of captions running on the watch.","isFinal":false}
     {"type":"caption","text":"Hello, this is a test of captions running on the watch.","isFinal":true}
     closed 1005 partial=true final=true
     ```
     Partials and a true final both arrived over the relay's `/stream`
     endpoint, from this Mac, over Tailscale, through the whole chain:
     client → relay (ring:8080) → Apple provider → transcriber sidecar
     (ring:8790) → SpeechAnalyzer → back out. **Pass.**

## Re-deploying after a code change

```
deploy/ring/sync.sh          # rsyncs backend/ + copies the sidecar binary + npm ci + codesign
# then, if secrets changed, re-copy the env file manually (never via git)
ssh ring 'launchctl bootout gui/501/com.jonyen.caption-relay 2>/dev/null; \
  launchctl bootstrap gui/501 /Users/jonyen/Library/LaunchAgents/com.jonyen.caption-relay.plist'
ssh ring 'launchctl bootout gui/501/com.jonyen.caption-transcriber 2>/dev/null; \
  launchctl bootstrap gui/501 /Users/jonyen/Library/LaunchAgents/com.jonyen.caption-transcriber.plist'
```

## What remains manual / out of scope for this task

- **Doppler.** `doppler` is installed on ring but not authenticated; nobody
  ran `doppler login` because it needs an interactive browser flow this
  session cannot drive over SSH. If the user later wants ring on Doppler
  instead of the flat `env` file, they need to run `doppler login` on ring
  themselves (in a real Terminal session, not over this kind of SSH), then
  `doppler setup --project personal --config <name>`, and the launch
  scripts would need a small edit to `doppler run -- node ...` instead of
  sourcing the env file.
- **Data migration.** The `data/transcripts/` directory on ring is empty —
  the SQLite schema self-creates on boot (`db.ts`'s `CREATE TABLE IF NOT
  EXISTS`, called via `mkdirSync` + `openDb` in `index.ts`), so the relay
  runs fine, but it starts with zero existing users/devices/transcripts.
  Migrating the real data from the Fly volume is explicitly Task 7's job —
  not attempted here beyond registering one throwaway `watch`-kind device
  for this task's own smoke test (harmless; the user can ignore or delete
  it once Task 7's real data lands).
- **`tailscale funnel`** (public exposure of the relay) is Task 6, not
  touched here — only plain in-tailnet reachability (`ring:8080`) was
  proven.
- **Gatekeeper/TCC on the sidecar.** No prompt was seen in this session (a
  fresh headless `launchctl bootstrap` launch worked immediately after ad
  hoc codesigning), but if a future macOS update starts blocking it, the
  fix is documented in step 3 above.
- **Backend bug fixes** (steps 5–6 above, in `backend/src/config.ts`,
  `backend/src/index.ts`, `backend/src/server.ts`) are committed separately
  from this directory, since they are correctness fixes to the relay
  itself, not ring-specific deployment files.

## Task 6: Tailscale Funnel exposure (public internet access)

The relay (`ring:8080`) is now also reachable from the public internet at:

```
https://ring.tailb6f6c9.ts.net:10000/
```

**Coexistence with doorlog.** `ring` already runs doorlog behind `tailscale
serve`/`funnel`. Before touching anything, `tailscale serve status` was run
and its exact output recorded:

```
# Funnel on:
#     - https://ring.tailb6f6c9.ts.net

https://ring.tailb6f6c9.ts.net (Funnel on)
|-- /                    proxy http://127.0.0.1:8787
|-- /ring/token-exchange proxy http://127.0.0.1:8096

http://ring (tailnet only)
http://ring.tailb6f6c9.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8099

https://ring.tailb6f6c9.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:8100

https://ring.tailb6f6c9.ts.net:9443 (tailnet only)
|-- / proxy http://127.0.0.1:8110
```

Doorlog's mapping lives on port 80 (tailnet-only, `/` → `127.0.0.1:8099`);
the existing public Funnel on 443 proxies unrelated services (`8787`,
`8096`), and 8443/9443 are tailnet-only serve mappings (`8100`, `8110`).
None of these were modified. Tailscale Funnel is only permitted on ports
443, 8443, and 10000 per tailnet; 443 already carries doorlog-adjacent
funnel mappings and 8443 already carries a tailnet-only serve mapping for
an unrelated service, so **10000** — otherwise unused — was chosen for the
relay to guarantee zero interference:

```
ssh ring '/usr/local/bin/tailscale funnel --bg --https=10000 http://127.0.0.1:8080'
```

(`tailscale` isn't on ring's non-interactive SSH `PATH`; invoked via its
full path, `/usr/local/bin/tailscale`, a wrapper around
`/Applications/Tailscale.app/Contents/MacOS/tailscale`. No ACL/policy error
was hit — Funnel was already enabled for this tailnet.)

Output:
```
Available on the internet:

https://ring.tailb6f6c9.ts.net:10000/
|-- proxy http://127.0.0.1:8080

Funnel started and running in the background.
To disable the proxy, run: tailscale funnel --https=10000 off
```

`tailscale serve status` re-run immediately after, confirming doorlog's
mappings (port 80 → 8099, port 443 → 8787/8096, 8443 → 8100, 9443 → 8110)
were untouched — only a new `:10000 (Funnel on)` entry was added:

```
# Funnel on:
#     - https://ring.tailb6f6c9.ts.net:10000
#     - https://ring.tailb6f6c9.ts.net

https://ring.tailb6f6c9.ts.net:10000 (Funnel on)
|-- / proxy http://127.0.0.1:8080

https://ring.tailb6f6c9.ts.net (Funnel on)
|-- /                    proxy http://127.0.0.1:8787
|-- /ring/token-exchange proxy http://127.0.0.1:8096

http://ring (tailnet only)
http://ring.tailb6f6c9.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8099

https://ring.tailb6f6c9.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:8100

https://ring.tailb6f6c9.ts.net:9443 (tailnet only)
|-- / proxy http://127.0.0.1:8110
```

### Verification from off-tailnet (this Mac's public internet path)

**Healthz over the funnel:**
```
curl -sS -i https://ring.tailb6f6c9.ts.net:10000/healthz
# HTTP/2 200
# ok
```

**Unauthenticated rejection.** The funnel URL is public — the relay's
per-device token is the only guard. `/v1/devices` (device registration) is
intentionally open by design, so the check that matters is `/stream`: a
plain WebSocket connect with no `?token=` completes the HTTP upgrade (the
`ws` library reports `OPEN`) but the relay immediately closes it —
confirmed with a throwaway Node client:
```
OPEN (unexpected!)
closed 4001 unauthorized
```
Code `4001` is the relay's own "unauthorized" close code
(`backend/src/server.ts`, `resolveToken` returning no principal), not a
generic transport failure — the same rejection path a plain `curl` GET to
`/stream` also hits from the HTTP side (`404`, since `/stream` has no
non-upgrade route).

**End-to-end WS stream proof**, over the public funnel URL, using a
throwaway token minted via the funnel itself
(`POST https://ring.tailb6f6c9.ts.net:10000/v1/devices`) and `hello.wav`
(the same asset Task 5 used), streamed as raw PCM16 mono 16 kHz to
`wss://ring.tailb6f6c9.ts.net:10000/stream?token=<token>` (same protocol as
Task 5's on-tailnet proof: binary PCM chunks, then `{"finish":true}`):

```
{"type":"ready"}
{"type":"caption","text":"Hello","isFinal":false}
...
{"type":"caption","text":"Hello, this is a test of captions running on the","isFinal":false}
(finish sent)
{"type":"caption","text":"Hello, this is a test of captions running on the watch","isFinal":false}
{"type":"caption","text":"Hello, this is a test of captions running on the watch.","isFinal":false}
{"type":"caption","text":"Hello, this is a test of captions running on the watch.","isFinal":true}
closed 1005 partial=true final=true
```

Partials and a true final both arrived over the public funnel URL,
confirming the full chain (public internet → Tailscale Funnel → relay on
ring:8080 → Apple provider → transcriber sidecar on ring:8790 →
SpeechAnalyzer → back out) works end to end, off-tailnet.

### Notes / concerns for Task 7

- The relay is now reachable from the open internet at
  `https://ring.tailb6f6c9.ts.net:10000/`. Auth is enforced solely by the
  per-device token on `/stream` (and presumably other data-bearing routes —
  not independently re-audited here beyond `/stream` and `/v1/devices`);
  worth a broader auth audit of every route before relying on this for
  anything sensitive long-term.
- `/v1/devices` registration is unauthenticated by design (anyone can mint a
  throwaway device/token) — same as it was over the tailnet in Task 5, now
  simply reachable publicly too. This registered one more throwaway `watch`
  device in the identity DB (on top of Task 5's), for this task's own
  smoke test.
- To disable the funnel later: `ssh ring "/usr/local/bin/tailscale funnel --https=10000 off"`.
- `tailscale` is not on ring's default non-interactive SSH PATH; use
  `/usr/local/bin/tailscale` (a thin wrapper around
  `/Applications/Tailscale.app/Contents/MacOS/tailscale`).

## Concerns for whoever picks up Task 6/7

- The relay's identity DB on ring now has exactly one throwaway `watch`
  device registered by this task's own smoke test. It's harmless but worth
  knowing about before Task 7's real-data migration lands on the same path.
- `AUTH_TOKEN` and `TWILIO_AUTH_TOKEN` were carried over from the Fly
  secrets into ring's `env` file even though nothing in current
  `backend/src` reads them — kept for parity with the brief's instruction
  to keep "all auth/token/Twilio/Notion secrets," but worth a look at
  whether they're genuinely dead weight.
- `npm ci --omit=dev` on ring reported two packages (`esbuild`, `fsevents`)
  with pending `allowScripts` postinstall steps; the app ran correctly
  without them, so this wasn't chased further, but it's worth a glance if
  something subtle breaks later (e.g. vitest/dev-only paths — shouldn't
  matter for `--omit=dev` in production, but noting it).
