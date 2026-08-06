# Twilio Call Captioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Caption a live phone call on the Apple Watch by having Twilio fork the caller's audio into the existing relay.

**Architecture:** Twilio answers an inbound call, forks the caller's audio to a new WebSocket endpoint on the relay, and dials the user's real phone. The relay feeds that audio into an ephemeral `SessionStore` session — the same machinery the watch and mac already use — and the watch reads captions from a new read-only `GET /v1/call` endpoint. Call sessions store nothing.

**Tech Stack:** Node/TypeScript relay (vitest), Swift `CaptionCore` package (XCTest), watchOS SwiftUI app (XcodeGen).

**Spec:** `docs/superpowers/specs/2026-08-05-twilio-call-captioning-design.md`

## Global Constraints

- Relay tests run with `cd backend && npx vitest run`. Typecheck with `npx tsc --noEmit`. Both must pass before any commit.
- CaptionCore tests run with `cd watch/CaptionCore && swift test`. Must pass before any commit touching it.
- The watch app builds with `cd watch && xcodegen generate && xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions -destination 'platform=watchOS Simulator,id=7BB5A7C6-2524-450C-9CCD-050E35F530C5' build`. **Run `xcodegen generate` after adding any new file to the app target** — the `.xcodeproj` is gitignored and generated from `project.yml`.
- Call sessions are **always ephemeral**. Every `SessionStore.feed` call from the Twilio path passes `ephemeral = true`. No transcript file, no summary, no Notion export.
- Audio is **never transcoded**. Twilio's base64 μ-law 8 kHz bytes go to Deepgram unchanged.
- The stream forks `track="inbound_track"` only — the caller's audio, never the user's.
- **No test may contact Twilio or Deepgram.** Transcription is always `FakeTranscriptionProvider`; Twilio is always fake frames. A real WebSocket to the test's own `startServer` instance is fine and expected — it is this relay, not a vendor.
- Commit after every task. Work on branch `feat/call-captioning`.

---

### Task 1: Extract `ProviderOptions` into its own module

`SessionStore` needs `ProviderOptions` (Task 2), but `server.ts` already imports `SessionStore` — importing the type back would be a cycle. Move the type out and re-export it so no existing call site changes.

**Files:**
- Create: `backend/src/providerOptions.ts`
- Modify: `backend/src/server.ts:19-26`
- Test: `backend/src/providerOptions.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `PROVIDER_NAMES: readonly ["deepgram","openai","assemblyai"]`, `type ProviderName`, `interface ProviderOptions { channels?: number; provider?: ProviderName; telephony?: boolean }`. Still importable from `./server` as before.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/providerOptions.test.ts
import { describe, it, expect } from "vitest";
import { PROVIDER_NAMES, ProviderOptions } from "./providerOptions";
import { PROVIDER_NAMES as VIA_SERVER } from "./server";

describe("provider options", () => {
  it("lists the providers the relay implements", () => {
    expect(PROVIDER_NAMES).toEqual(["deepgram", "openai", "assemblyai"]);
  });

  // server.ts re-exports these, so existing importers keep working.
  it("stays importable from server", () => {
    expect(VIA_SERVER).toEqual(PROVIDER_NAMES);
  });

  it("can describe a telephony session", () => {
    const opts: ProviderOptions = { telephony: true };
    expect(opts.telephony).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/providerOptions.test.ts`
Expected: FAIL — cannot resolve `./providerOptions`.

- [ ] **Step 3: Create the module**

```ts
// backend/src/providerOptions.ts
export const PROVIDER_NAMES = ["deepgram", "openai", "assemblyai"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ProviderOptions {
  channels?: number;
  /** Requested transcription backend; absent = deepgram. */
  provider?: ProviderName;
  /**
   * Telephony audio: μ-law 8 kHz off a phone call rather than 16 kHz PCM from
   * a microphone. Decides the Deepgram encoding and model for the session.
   */
  telephony?: boolean;
}
```

- [ ] **Step 4: Re-export from `server.ts`**

In `backend/src/server.ts`, delete lines 19-26 (the `PROVIDER_NAMES`, `ProviderName`, and `ProviderOptions` declarations) and add near the other imports:

```ts
import { PROVIDER_NAMES, ProviderOptions } from "./providerOptions";

export * from "./providerOptions";
```

- [ ] **Step 5: Run the full suite**

Run: `cd backend && npx tsc --noEmit && npx vitest run`
Expected: all tests pass — this is a pure refactor. `index.ts` and `server.test.ts` import these from `./server` and must keep working untouched.

- [ ] **Step 6: Commit**

```bash
git add backend/src/providerOptions.ts backend/src/providerOptions.test.ts backend/src/server.ts
git commit -m "refactor(relay): move ProviderOptions out of server.ts

SessionStore needs the type and server.ts already imports SessionStore, so
importing it back would be a cycle. Re-exported so no call site changes."
```

---

### Task 2: `SessionStore` passes provider options to the factory

Today `SessionStore` builds providers with `createProvider()` — no arguments — so a session created through it can never be telephony, dual-channel, or a non-default provider.

**Files:**
- Modify: `backend/src/sessionStore.ts:23-37` (options), `:62-66` (`feed`), `:121-146` (`getOrCreate`)
- Test: `backend/src/sessionStore.test.ts`

**Interfaces:**
- Consumes: `ProviderOptions` from Task 1
- Produces: `SessionStore.feed(id: string, pcm: Buffer, ephemeral?: boolean, providerOpts?: ProviderOptions): void`

- [ ] **Step 1: Write the failing test**

Append to `backend/src/sessionStore.test.ts`:

```ts
describe("provider options", () => {
  it("passes them to the factory when the session is created", () => {
    const seen: (ProviderOptions | undefined)[] = [];
    const store = new SessionStore({
      createProvider: (opts) => {
        seen.push(opts);
        return new FakeTranscriptionProvider();
      },
    });

    store.feed("s1", Buffer.alloc(0), true, { telephony: true });

    expect(seen).toEqual([{ telephony: true }]);
  });

  // The provider is built once, at creation. A later post cannot change what
  // a conversation already in progress is being transcribed as.
  it("ignores them for a session that already exists", () => {
    const seen: (ProviderOptions | undefined)[] = [];
    const store = new SessionStore({
      createProvider: (opts) => {
        seen.push(opts);
        return new FakeTranscriptionProvider();
      },
    });

    store.feed("s1", Buffer.alloc(0), true, { telephony: true });
    store.feed("s1", Buffer.alloc(0), true, { telephony: false });

    expect(seen).toHaveLength(1);
  });
});
```

Add to the imports at the top of that file:

```ts
import { ProviderOptions } from "./providerOptions";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/sessionStore.test.ts`
Expected: FAIL — `feed` takes 3 arguments, and `seen` is `[undefined]`.

- [ ] **Step 3: Thread the options through**

In `backend/src/sessionStore.ts`, add the import:

```ts
import { ProviderOptions } from "./providerOptions";
```

Change the factory type in `SessionStoreOptions`:

```ts
  /** Factory for a fresh provider per session (Deepgram in prod, fake in tests). */
  createProvider: (opts?: ProviderOptions) => TranscriptionProvider;
```

Change the field declaration:

```ts
  private readonly createProvider: (opts?: ProviderOptions) => TranscriptionProvider;
```

Change `feed` and `getOrCreate`:

```ts
  feed(id: string, pcm: Buffer, ephemeral = false, providerOpts?: ProviderOptions): void {
    const session = this.getOrCreate(id, ephemeral, providerOpts);
    session.lastActivity = this.now();
    if (pcm.length > 0) session.caption.handleAudio(pcm);
  }
```

```ts
  private getOrCreate(
    id: string,
    ephemeral: boolean,
    providerOpts?: ProviderOptions,
  ): Session {
    const existing = this.sessions.get(id);
    if (existing) return existing;

    const provider = this.createProvider(providerOpts);
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/sessionStore.ts backend/src/sessionStore.test.ts
git commit -m "feat(relay): let SessionStore sessions choose their provider options

Without this a call routed through SessionStore would get 16 kHz PCM
settings and transcribe phone audio as noise."
```

---

### Task 3: Telephony Deepgram options and config

**Files:**
- Modify: `backend/src/deepgramProvider.ts` (add `telephonyOptions`)
- Modify: `backend/src/config.ts:2-20` (interface), `:39-50` (loader)
- Modify: `backend/src/index.ts:69-93` (`createProvider`)
- Test: `backend/src/deepgramProvider.test.ts`, `backend/src/config.test.ts`

**Interfaces:**
- Consumes: `ProviderOptions.telephony` from Task 1
- Produces: `telephonyOptions(model: string): Record<string, unknown>`; `Config.deepgramPhoneModel: string`; `Config.twilioForwardTo?: string`

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/deepgramProvider.test.ts`:

```ts
describe("telephonyOptions", () => {
  // Twilio media payloads are audio/x-mulaw at 8000 Hz. Deepgram takes those
  // directly, which is why the relay never transcodes.
  it("describes mu-law 8 kHz phone audio", () => {
    expect(telephonyOptions("flux-general-en")).toEqual({
      encoding: "mulaw",
      sample_rate: 8000,
      model: "flux-general-en",
    });
  });
});
```

Add `telephonyOptions` to that file's import from `./deepgramProvider`.

Append to `backend/src/config.test.ts`:

```ts
describe("call captioning config", () => {
  const base = { AUTH_TOKEN: "t", DEEPGRAM_API_KEY: "k" };

  it("defaults the phone model to the low-latency conversational model", () => {
    expect(loadConfig(base).deepgramPhoneModel).toBe("flux-general-en");
  });

  it("allows the phone model to be overridden", () => {
    expect(loadConfig({ ...base, DEEPGRAM_PHONE_MODEL: "phonecall" }).deepgramPhoneModel)
      .toBe("phonecall");
  });

  it("reads the number calls are forwarded to", () => {
    expect(loadConfig(base).twilioForwardTo).toBeUndefined();
    expect(loadConfig({ ...base, TWILIO_FORWARD_TO: "+15551234567" }).twilioForwardTo)
      .toBe("+15551234567");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/deepgramProvider.test.ts src/config.test.ts`
Expected: FAIL — `telephonyOptions` is not exported; `deepgramPhoneModel` is undefined.

- [ ] **Step 3: Implement**

Add to `backend/src/deepgramProvider.ts`, below `DEEPGRAM_LIVE_OPTIONS`:

```ts
/**
 * Live options for telephony audio. Twilio sends audio/x-mulaw at 8000 Hz and
 * Deepgram accepts exactly that, so the relay forwards the bytes untouched.
 */
export function telephonyOptions(model: string): Record<string, unknown> {
  return { encoding: "mulaw", sample_rate: 8000, model };
}
```

Add to the `Config` interface in `backend/src/config.ts`:

```ts
  /** Deepgram model for phone audio. Overridable — the right one is an open question. */
  deepgramPhoneModel: string;
  /** Optional; the number Twilio bridges an inbound captioned call to. */
  twilioForwardTo?: string;
```

Add to the object returned by `loadConfig`:

```ts
    deepgramPhoneModel: env.DEEPGRAM_PHONE_MODEL || "flux-general-en",
    twilioForwardTo: env.TWILIO_FORWARD_TO || undefined,
```

In `backend/src/index.ts`, import `telephonyOptions` alongside `DeepgramProvider`, then change the `default:` branch of `createProvider`:

```ts
    default:
      // Telephony is mono by definition — one caller, one track — so it never
      // combines with the dual-channel path.
      if (opts?.telephony) {
        return new DeepgramProvider(deepgram, telephonyOptions(config.deepgramPhoneModel));
      }
      return new DeepgramProvider(
        deepgram,
        dual ? { channels: 2, multichannel: true } : undefined,
      );
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/deepgramProvider.ts backend/src/deepgramProvider.test.ts backend/src/config.ts backend/src/config.test.ts backend/src/index.ts
git commit -m "feat(relay): Deepgram options for mu-law 8 kHz phone audio

Model is an env var, not a constant: latency decides whether reading a
call is usable, and Flux vs phonecall vs nova-3 is worth measuring."
```

---

### Task 4: Parse Twilio media-stream frames

**Files:**
- Create: `backend/src/twilioFrames.ts`
- Test: `backend/src/twilioFrames.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type TwilioFrame = { type: "connected" } | { type: "start"; callSid: string; streamSid: string } | { type: "media"; audio: Buffer } | { type: "stop" } | { type: "ignored" }`; `parseTwilioFrame(raw: string): TwilioFrame`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/twilioFrames.test.ts
import { describe, it, expect } from "vitest";
import { parseTwilioFrame } from "./twilioFrames";

describe("parseTwilioFrame", () => {
  it("reads the handshake", () => {
    expect(parseTwilioFrame(JSON.stringify({ event: "connected", protocol: "Call" })))
      .toEqual({ type: "connected" });
  });

  it("reads the call and stream ids off the start frame", () => {
    const raw = JSON.stringify({
      event: "start",
      streamSid: "MZ123",
      start: { callSid: "CA456", streamSid: "MZ123", tracks: ["inbound"] },
    });

    expect(parseTwilioFrame(raw)).toEqual({
      type: "start",
      callSid: "CA456",
      streamSid: "MZ123",
    });
  });

  it("base64-decodes media payloads", () => {
    const raw = JSON.stringify({
      event: "media",
      streamSid: "MZ123",
      media: { track: "inbound", chunk: "1", timestamp: "5", payload: "AAECAw==" },
    });

    const frame = parseTwilioFrame(raw);

    expect(frame.type).toBe("media");
    expect(frame.type === "media" && [...frame.audio]).toEqual([0, 1, 2, 3]);
  });

  it("reads the stop frame", () => {
    expect(parseTwilioFrame(JSON.stringify({ event: "stop", streamSid: "MZ123" })))
      .toEqual({ type: "stop" });
  });

  // A live call must survive a frame it does not understand. Every one of these
  // is "nothing happened", never a throw.
  it("ignores frames it cannot use rather than throwing", () => {
    expect(parseTwilioFrame("not json")).toEqual({ type: "ignored" });
    expect(parseTwilioFrame("null")).toEqual({ type: "ignored" });
    expect(parseTwilioFrame(JSON.stringify({ event: "dtmf", dtmf: { digit: "1" } })))
      .toEqual({ type: "ignored" });
    expect(parseTwilioFrame(JSON.stringify({ event: "mark" }))).toEqual({ type: "ignored" });
    expect(parseTwilioFrame(JSON.stringify({ event: "start", start: {} })))
      .toEqual({ type: "ignored" });
    expect(parseTwilioFrame(JSON.stringify({ event: "media", media: {} })))
      .toEqual({ type: "ignored" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/twilioFrames.test.ts`
Expected: FAIL — cannot resolve `./twilioFrames`.

- [ ] **Step 3: Implement**

```ts
// backend/src/twilioFrames.ts

/** One decoded frame from a Twilio Media Stream WebSocket. */
export type TwilioFrame =
  | { type: "connected" }
  | { type: "start"; callSid: string; streamSid: string }
  | { type: "media"; audio: Buffer }
  | { type: "stop" }
  /** Understood but uninteresting, or unparseable. Never an error. */
  | { type: "ignored" };

/**
 * Decode one raw frame. Anything malformed, unknown, or missing the fields we
 * depend on reads as `ignored` — a single bad frame must not end a live call.
 */
export function parseTwilioFrame(raw: string): TwilioFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "ignored" };
  }
  if (typeof parsed !== "object" || parsed === null) return { type: "ignored" };
  const frame = parsed as Record<string, any>;

  switch (frame.event) {
    case "connected":
      return { type: "connected" };
    case "start": {
      const callSid = frame.start?.callSid;
      const streamSid = frame.start?.streamSid ?? frame.streamSid;
      if (typeof callSid !== "string" || typeof streamSid !== "string") {
        return { type: "ignored" };
      }
      return { type: "start", callSid, streamSid };
    }
    case "media": {
      const payload = frame.media?.payload;
      if (typeof payload !== "string") return { type: "ignored" };
      return { type: "media", audio: Buffer.from(payload, "base64") };
    }
    case "stop":
      return { type: "stop" };
    default:
      return { type: "ignored" };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run src/twilioFrames.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/twilioFrames.ts backend/src/twilioFrames.test.ts
git commit -m "feat(relay): decode Twilio media-stream frames"
```

---

### Task 5: Build the TwiML response

**Files:**
- Create: `backend/src/twiml.ts`
- Test: `backend/src/twiml.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `voiceResponse(opts: { streamUrl: string; dialTo: string }): string`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/twiml.test.ts
import { describe, it, expect } from "vitest";
import { voiceResponse } from "./twiml";

describe("voiceResponse", () => {
  it("forks the caller's audio and then dials through", () => {
    const xml = voiceResponse({
      streamUrl: "wss://relay.example/twilio/stream?token=abc",
      dialTo: "+15551234567",
    });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<Stream url="wss://relay.example/twilio/stream?token=abc"');
    // inbound_track is the caller. Forking both would caption the user too.
    expect(xml).toContain('track="inbound_track"');
    expect(xml).toContain("<Dial>+15551234567</Dial>");
    // <Start> is the non-blocking form, so <Dial> still runs.
    expect(xml.indexOf("<Start>")).toBeLessThan(xml.indexOf("<Dial>"));
  });

  // A token with an ampersand would otherwise produce XML Twilio cannot parse,
  // and the call would fail with no obvious cause.
  it("escapes XML metacharacters in the stream URL", () => {
    const xml = voiceResponse({
      streamUrl: "wss://relay.example/twilio/stream?token=a&b<c",
      dialTo: "+15551234567",
    });

    expect(xml).toContain("token=a&amp;b&lt;c");
    expect(xml).not.toContain("token=a&b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/twiml.test.ts`
Expected: FAIL — cannot resolve `./twiml`.

- [ ] **Step 3: Implement**

```ts
// backend/src/twiml.ts

export interface VoiceResponseOptions {
  /** Where Twilio should open the media stream. */
  streamUrl: string;
  /** The number to bridge the caller to. */
  dialTo: string;
}

/**
 * TwiML for an inbound captioned call: fork the caller's audio to the relay,
 * then bridge the call onward.
 *
 * `<Start><Stream>` is deliberately the non-blocking form — Twilio sets the
 * stream up and immediately continues to the next verb, so the caller hears
 * normal ringing while audio is already flowing. `<Connect><Stream>` would
 * block until the socket closed and the call would never be bridged.
 */
export function voiceResponse({ streamUrl, dialTo }: VoiceResponseOptions): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "<Start>",
    `<Stream url="${escapeXml(streamUrl)}" track="inbound_track"/>`,
    "</Start>",
    `<Dial>${escapeXml(dialTo)}</Dial>`,
    "</Response>",
  ].join("");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run src/twiml.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/twiml.ts backend/src/twiml.test.ts
git commit -m "feat(relay): build TwiML that forks caller audio and bridges the call"
```

---

### Task 6: Track the current call

**Files:**
- Create: `backend/src/currentCall.ts`
- Test: `backend/src/currentCall.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type CallEndReason = "ended" | "stream_lost"`; `interface ActiveCall { sessionId: string; callSid: string }`; `class CurrentCall` with `begin(sessionId, callSid)`, `end(sessionId, reason): boolean`, `current(): ActiveCall | null`, `lastReason(): CallEndReason | null`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/currentCall.test.ts
import { describe, it, expect } from "vitest";
import { CurrentCall } from "./currentCall";

describe("CurrentCall", () => {
  it("has no call to begin with", () => {
    const calls = new CurrentCall();
    expect(calls.current()).toBeNull();
    expect(calls.lastReason()).toBeNull();
  });

  it("holds the call it was given", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1");
    expect(calls.current()).toEqual({ sessionId: "CA1", callSid: "CA1" });
  });

  it("records how the call ended", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1");

    expect(calls.end("CA1", "ended")).toBe(true);

    expect(calls.current()).toBeNull();
    expect(calls.lastReason()).toBe("ended");
  });

  // A dying socket from a call that was already replaced must not clear the
  // call that replaced it.
  it("ignores an end from a call that is no longer current", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1");
    calls.begin("CA2", "CA2");

    expect(calls.end("CA1", "stream_lost")).toBe(false);

    expect(calls.current()).toEqual({ sessionId: "CA2", callSid: "CA2" });
    expect(calls.lastReason()).toBeNull();
  });

  it("clears a stale end reason when a new call begins", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1");
    calls.end("CA1", "stream_lost");

    calls.begin("CA2", "CA2");

    expect(calls.lastReason()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/currentCall.test.ts`
Expected: FAIL — cannot resolve `./currentCall`.

- [ ] **Step 3: Implement**

```ts
// backend/src/currentCall.ts

export type CallEndReason = "ended" | "stream_lost";

export interface ActiveCall {
  /** The SessionStore session carrying this call's captions. */
  sessionId: string;
  callSid: string;
}

/**
 * The one call the relay is currently captioning, and how the last one ended.
 *
 * Presence is a first-class thing rather than a variable inside a route
 * handler because the watch polls for it: `GET /v1/call` answers "is a call
 * live right now?" and "here are its captions" in the same request.
 *
 * One call at a time. A second concurrent call replaces the first.
 */
export class CurrentCall {
  private active: ActiveCall | null = null;
  private reason: CallEndReason | null = null;

  begin(sessionId: string, callSid: string): void {
    this.active = { sessionId, callSid };
    this.reason = null;
  }

  /**
   * End `sessionId` if it is the current call. Returns false when it is not —
   * a socket dying for a call that was already replaced must not clear its
   * replacement.
   */
  end(sessionId: string, reason: CallEndReason): boolean {
    if (this.active?.sessionId !== sessionId) return false;
    this.active = null;
    this.reason = reason;
    return true;
  }

  current(): ActiveCall | null {
    return this.active;
  }

  /** How the most recent call ended, or null if one is live or none has run. */
  lastReason(): CallEndReason | null {
    return this.reason;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run src/currentCall.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/currentCall.ts backend/src/currentCall.test.ts
git commit -m "feat(relay): track the call currently being captioned"
```

---

### Task 7: `POST /twilio/voice` returns TwiML

**Files:**
- Modify: `backend/src/server.ts` (add `callForwardTo` to `StartServerOptions`; add the route in `handleRequest` before the `/v1/transcripts` block)
- Modify: `backend/src/index.ts` (pass `callForwardTo: config.twilioForwardTo`)
- Test: `backend/src/server.call.test.ts`

**Interfaces:**
- Consumes: `voiceResponse` (Task 5), `Config.twilioForwardTo` (Task 3)
- Produces: `StartServerOptions.callForwardTo?: string`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/server.call.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

function start(callForwardTo?: string) {
  const providers: FakeTranscriptionProvider[] = [];
  const server = startServer({
    port: 0,
    authToken: "good",
    createProvider: () => {
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
    callForwardTo,
  });
  running = server;
  return { providers, port: (server.address() as AddressInfo).port };
}

const base = (port: number) => `http://127.0.0.1:${port}`;

describe("POST /twilio/voice", () => {
  it("returns TwiML pointing the stream at this relay", async () => {
    const { port } = start("+15551234567");

    const res = await fetch(`${base(port)}/twilio/voice?token=good`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const xml = await res.text();
    expect(xml).toContain(`wss://127.0.0.1:${port}/twilio/stream?token=good`);
    expect(xml).toContain('track="inbound_track"');
    expect(xml).toContain("<Dial>+15551234567</Dial>");
  });

  it("rejects a request without a valid token", async () => {
    const { port } = start("+15551234567");
    expect((await fetch(`${base(port)}/twilio/voice`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base(port)}/twilio/voice?token=bad`, { method: "POST" })).status)
      .toBe(401);
  });

  // Better to refuse than to answer with TwiML that dials nowhere.
  it("503s when no forwarding number is configured", async () => {
    const { port } = start(undefined);
    const res = await fetch(`${base(port)}/twilio/voice?token=good`, { method: "POST" });
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/server.call.test.ts`
Expected: FAIL — 404, and `callForwardTo` is not a known option.

- [ ] **Step 3: Implement**

Add to `StartServerOptions` in `backend/src/server.ts`:

```ts
  /** Optional; the number an inbound captioned call is bridged to. Enables /twilio/voice. */
  callForwardTo?: string;
```

Import the builder near the other imports:

```ts
import { voiceResponse } from "./twiml";
```

Add the route inside `handleRequest`, immediately after the `/app` block and before the `/v1/transcripts` block:

```ts
  // Twilio asks what to do with an inbound call. Answer: fork the caller's
  // audio to this relay, then bridge the call onward.
  if (req.method === "POST" && url.pathname === "/twilio/voice") {
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    if (!opts.callForwardTo) {
      sendJSON(res, 503, { error: "call captioning not configured" });
      return;
    }
    // The host Twilio reached us on is the host it should stream back to, so
    // there is no public-URL setting to keep in sync with the deployment.
    const streamUrl =
      `wss://${req.headers.host ?? ""}/twilio/stream` +
      `?token=${encodeURIComponent(token ?? "")}`;
    res.writeHead(200, { "content-type": "text/xml" });
    res.end(voiceResponse({ streamUrl, dialTo: opts.callForwardTo }));
    return;
  }
```

In `backend/src/index.ts`, add to the `startServer({...})` call:

```ts
  callForwardTo: config.twilioForwardTo,
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts backend/src/server.call.test.ts backend/src/index.ts
git commit -m "feat(relay): answer Twilio's voice webhook with streaming TwiML"
```

---

### Task 8: The media-stream WebSocket endpoint

**Files:**
- Create: `backend/src/twilioStreamHandler.ts`
- Modify: `backend/src/server.ts:66-90` (upgrade routing), `startServer` (construct `CurrentCall`)
- Test: `backend/src/twilioStreamHandler.test.ts`

**Interfaces:**
- Consumes: `parseTwilioFrame` (Task 4), `CurrentCall` (Task 6), `SessionStore.feed(...providerOpts)` (Task 2)
- Produces: `interface TwilioSocketLike { on(event: string, cb: (...args: any[]) => void): unknown }`; `handleTwilioStream(ws: TwilioSocketLike, store: SessionStore, calls: CurrentCall): void`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/twilioStreamHandler.test.ts
import { describe, it, expect } from "vitest";
import { handleTwilioStream, TwilioSocketLike } from "./twilioStreamHandler";
import { SessionStore } from "./sessionStore";
import { CurrentCall } from "./currentCall";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { ProviderOptions } from "./providerOptions";

/** A socket the test drives directly, standing in for Twilio. */
class FakeSocket implements TwilioSocketLike {
  private handlers = new Map<string, (...args: any[]) => void>();
  on(event: string, cb: (...args: any[]) => void) {
    this.handlers.set(event, cb);
    return this;
  }
  send(frame: object) {
    this.handlers.get("message")?.(Buffer.from(JSON.stringify(frame)));
  }
  close() {
    this.handlers.get("close")?.();
  }
}

function harness() {
  const providers: FakeTranscriptionProvider[] = [];
  const seen: (ProviderOptions | undefined)[] = [];
  const store = new SessionStore({
    createProvider: (opts) => {
      seen.push(opts);
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
  });
  const calls = new CurrentCall();
  const ws = new FakeSocket();
  handleTwilioStream(ws, store, calls);
  return { ws, store, calls, providers, seen };
}

const startFrame = (callSid: string) => ({
  event: "start",
  streamSid: `MZ-${callSid}`,
  start: { callSid, streamSid: `MZ-${callSid}` },
});

const mediaFrame = (payload: string) => ({
  event: "media",
  media: { track: "inbound", chunk: "1", timestamp: "5", payload },
});

describe("handleTwilioStream", () => {
  it("begins a telephony session on the start frame", () => {
    const { ws, calls, seen } = harness();

    ws.send(startFrame("CA1"));

    expect(calls.current()).toEqual({ sessionId: "CA1", callSid: "CA1" });
    expect(seen).toEqual([{ telephony: true }]);
  });

  it("feeds decoded audio to the session", () => {
    const { ws, providers } = harness();
    ws.send(startFrame("CA1"));

    ws.send(mediaFrame("AAECAw=="));

    expect(providers[0].receivedAudio.map((c) => [...c])).toEqual([[0, 1, 2, 3]]);
  });

  it("drops audio arriving before the start frame", () => {
    const { ws, providers } = harness();

    ws.send(mediaFrame("AAECAw=="));

    expect(providers).toHaveLength(0);
  });

  it("ends the call on the stop frame", () => {
    const { ws, calls, providers } = harness();
    ws.send(startFrame("CA1"));

    ws.send({ event: "stop" });

    expect(calls.current()).toBeNull();
    expect(calls.lastReason()).toBe("ended");
    expect(providers[0].closed).toBe(true);
  });

  // A socket that dies under a live call is not the call ending, and saying so
  // would be a lie on the user's wrist.
  it("reports a socket that closes without a stop frame as lost", () => {
    const { ws, calls, providers } = harness();
    ws.send(startFrame("CA1"));

    ws.close();

    expect(calls.lastReason()).toBe("stream_lost");
    expect(providers[0].closed).toBe(true);
  });

  it("does not report an end twice", () => {
    const { ws, calls } = harness();
    ws.send(startFrame("CA1"));
    ws.send({ event: "stop" });

    ws.close();

    expect(calls.lastReason()).toBe("ended");
  });

  it("survives a frame it cannot parse", () => {
    const { ws, calls } = harness();
    ws.send(startFrame("CA1"));

    ws.send({ event: "dtmf", dtmf: { digit: "1" } });

    expect(calls.current()).toEqual({ sessionId: "CA1", callSid: "CA1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/twilioStreamHandler.test.ts`
Expected: FAIL — cannot resolve `./twilioStreamHandler`.

- [ ] **Step 3: Implement the handler**

```ts
// backend/src/twilioStreamHandler.ts
import { SessionStore } from "./sessionStore";
import { CurrentCall, CallEndReason } from "./currentCall";
import { parseTwilioFrame } from "./twilioFrames";

/** Subset of a WebSocket this handler needs (keeps it testable). */
export interface TwilioSocketLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
}

/** Call sessions are always ephemeral and always telephony audio. */
const CALL_SESSION = { ephemeral: true, provider: { telephony: true } } as const;

/**
 * Drive one Twilio Media Stream: begin a session on `start`, feed it audio,
 * and end it on `stop` or on the socket dying.
 *
 * The Twilio `callSid` is the session id, so a call is traceable end to end
 * from the Twilio console into the relay's logs.
 */
export function handleTwilioStream(
  ws: TwilioSocketLike,
  store: SessionStore,
  calls: CurrentCall,
): void {
  let sessionId: string | null = null;

  const endCall = (reason: CallEndReason) => {
    if (!sessionId) return;
    const ending = sessionId;
    sessionId = null;
    // Only tear down the SessionStore side if this call was still the current
    // one; a newer call may already have replaced it.
    if (calls.end(ending, reason)) store.stop(ending);
  };

  ws.on("message", (data: Buffer) => {
    const frame = parseTwilioFrame(data.toString("utf8"));
    switch (frame.type) {
      case "start": {
        // Newest call wins. Close the old one first so CurrentCall never holds
        // a session SessionStore has already dropped.
        const previous = calls.current();
        if (previous) {
          calls.end(previous.sessionId, "ended");
          store.stop(previous.sessionId);
        }
        sessionId = frame.callSid;
        calls.begin(sessionId, frame.callSid);
        // Empty feed creates the session and opens the upstream connection, so
        // transcription is warming up before the first audio arrives.
        store.feed(sessionId, Buffer.alloc(0), CALL_SESSION.ephemeral, CALL_SESSION.provider);
        break;
      }
      case "media":
        if (sessionId) {
          store.feed(sessionId, frame.audio, CALL_SESSION.ephemeral, CALL_SESSION.provider);
        }
        break;
      case "stop":
        endCall("ended");
        break;
      default:
        break;
    }
  });

  ws.on("close", () => endCall("stream_lost"));
  ws.on("error", () => endCall("stream_lost"));
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx vitest run src/twilioStreamHandler.test.ts`
Expected: PASS.

- [ ] **Step 5: Route the upgrade**

In `backend/src/server.ts`, add imports:

```ts
import { CurrentCall } from "./currentCall";
import { handleTwilioStream } from "./twilioStreamHandler";
```

Inside `startServer`, next to where `store` is constructed, add:

```ts
  const currentCall = new CurrentCall();
```

Replace the body of the `http.on("upgrade", …)` handler's opening lines so `/twilio/stream` is routed before the `/stream` check:

```ts
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token") ?? undefined;

    if (url.pathname === "/twilio/stream") {
      if (!verifyToken(token, opts.authToken)) {
        wss.handleUpgrade(req, socket, head, (ws) => ws.close(4001, "unauthorized"));
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        handleTwilioStream(ws as unknown as TwilioSocketLike, store, currentCall));
      return;
    }

    if (url.pathname !== "/stream") {
      socket.destroy();
      return;
    }
    // …existing /stream handling continues unchanged, but delete its own
    // `const token = …` line since token is now read above.
```

Add `TwilioSocketLike` to the import from `./twilioStreamHandler`.

- [ ] **Step 6: Run the full suite**

Run: `cd backend && npx tsc --noEmit && npx vitest run`
Expected: PASS — the existing `/stream` tests must still pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/twilioStreamHandler.ts backend/src/twilioStreamHandler.test.ts backend/src/server.ts
git commit -m "feat(relay): accept Twilio media streams as a caption transport"
```

---

### Task 9: `GET /v1/call` — presence and captions in one poll

**Files:**
- Modify: `backend/src/server.ts` (route in `handleRequest`, before `/v1/transcripts`)
- Test: `backend/src/server.call.test.ts` (append)

**Interfaces:**
- Consumes: `CurrentCall` (Task 6), `SessionStore.drain` (existing)
- Produces: `GET /v1/call?since=N&token=…` → `{ active: boolean; reason?: CallEndReason; events: Array<{seq:number} & OutboundMessage>; seq: number }`

- [ ] **Step 1: Write the failing test**

Append to `backend/src/server.call.test.ts`:

```ts
import WebSocket from "ws";

describe("GET /v1/call", () => {
  it("reports no call when none is live", async () => {
    const { port } = start("+15551234567");

    const res = await fetch(`${base(port)}/v1/call?token=good`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false, events: [], seq: 0 });
  });

  it("rejects a poll without a valid token", async () => {
    const { port } = start("+15551234567");
    expect((await fetch(`${base(port)}/v1/call`)).status).toBe(401);
    expect((await fetch(`${base(port)}/v1/call?token=bad`)).status).toBe(401);
  });
});
```

Also add an end-to-end test that opens a real WebSocket to `/twilio/stream`, sends a start frame and a caption, and reads it back from `/v1/call`. It uses the `ws` package already in `backend`'s dependencies, imported above:

```ts
it("serves captions from the live call", async () => {
  const { providers, port } = start("+15551234567");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream?token=good`);
  await new Promise((resolve) => ws.on("open", resolve));

  ws.send(JSON.stringify({
    event: "start",
    streamSid: "MZ1",
    start: { callSid: "CA1", streamSid: "MZ1" },
  }));
  // Give the server a tick to process the frame and create the session.
  await new Promise((resolve) => setTimeout(resolve, 50));
  providers[0].emitReady();
  providers[0].emitTranscript({ text: "hello there", isFinal: true });

  const body = await (await fetch(`${base(port)}/v1/call?token=good`)).json();

  expect(body.active).toBe(true);
  expect(body.events.some((e: any) => e.type === "caption" && e.text === "hello there"))
    .toBe(true);
  ws.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/server.call.test.ts`
Expected: FAIL — `/v1/call` 404s.

- [ ] **Step 3: Implement**

Add to `handleRequest` in `backend/src/server.ts`, before the `/v1/transcripts` block. Note it needs access to `currentCall`, so add a `calls: CurrentCall` parameter to `handleRequest` and pass it from the `createServer` callback alongside `store`:

```ts
  // Presence and captions in one request: the watch uses this both to notice a
  // call is live and to read it. Read-only — unlike /v1/audio it never creates
  // a session, so polling when no call exists costs nothing upstream.
  if (req.method === "GET" && url.pathname === "/v1/call") {
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    const since = Number(url.searchParams.get("since") ?? "0") || 0;
    const active = calls.current();
    if (!active) {
      const reason = calls.lastReason();
      sendJSON(res, 200, {
        active: false,
        ...(reason ? { reason } : {}),
        events: [],
        seq: since,
      });
      return;
    }
    const { events, seq } = store.drain(active.sessionId, since);
    sendJSON(res, 200, { active: true, events: flatten(events), seq });
    return;
  }
```

- [ ] **Step 4: Run the full suite**

Run: `cd backend && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts backend/src/server.call.test.ts
git commit -m "feat(relay): serve live call captions from GET /v1/call"
```

---

### Task 10: `CallUpdate` and its decoding in CaptionCore

**Files:**
- Create: `watch/CaptionCore/Sources/CaptionCore/CallCaptions.swift`
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/CallCaptionsTests.swift`

**Interfaces:**
- Consumes: `ServerMessage` (existing)
- Produces: `enum CallEndReason: String { case ended; case streamLost = "stream_lost" }`; `struct CallUpdate { active: Bool; reason: CallEndReason?; events: [ServerMessage]; seq: Int }`; `protocol CallClient { func poll(since: Int) async throws -> CallUpdate }`; `func decodeCallUpdate(_ json: [String: Any]) -> CallUpdate`

- [ ] **Step 1: Write the failing test**

```swift
// watch/CaptionCore/Tests/CaptionCoreTests/CallCaptionsTests.swift
import XCTest
@testable import CaptionCore

final class CallUpdateDecodingTests: XCTestCase {
    func testDecodesALiveCallWithCaptions() {
        let update = decodeCallUpdate([
            "active": true,
            "seq": 4,
            "events": [
                ["seq": 3, "type": "caption", "text": "hello", "isFinal": false],
                ["seq": 4, "type": "caption", "text": "hello there", "isFinal": true],
            ],
        ])

        XCTAssertTrue(update.active)
        XCTAssertEqual(update.seq, 4)
        XCTAssertEqual(update.events, [
            .caption(text: "hello", isFinal: false, channel: nil),
            .caption(text: "hello there", isFinal: true, channel: nil),
        ])
        XCTAssertNil(update.reason)
    }

    func testDecodesACallThatEnded() {
        let update = decodeCallUpdate(["active": false, "reason": "ended", "seq": 9])

        XCTAssertFalse(update.active)
        XCTAssertEqual(update.reason, .ended)
    }

    /// A stream that died under a live call is a different thing to say than
    /// "the call ended", so the wire value has to survive decoding.
    func testDecodesALostStream() {
        XCTAssertEqual(
            decodeCallUpdate(["active": false, "reason": "stream_lost"]).reason, .streamLost)
    }

    func testDecodesRelayErrors() {
        let update = decodeCallUpdate([
            "active": true,
            "events": [["type": "error", "message": "transcription connection lost"]],
        ])

        XCTAssertEqual(update.events, [.error(message: "transcription connection lost")])
    }

    /// An unexpected body must not read as a live call.
    func testAnEmptyBodyReadsAsNoCall() {
        let update = decodeCallUpdate([:])

        XCTAssertFalse(update.active)
        XCTAssertEqual(update.events, [])
        XCTAssertEqual(update.seq, 0)
    }

    func testSkipsEventTypesItDoesNotKnow() {
        let update = decodeCallUpdate([
            "active": true,
            "events": [["type": "wat"], ["type": "caption", "text": "hi", "isFinal": true]],
        ])

        XCTAssertEqual(update.events, [.caption(text: "hi", isFinal: true, channel: nil)])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd watch/CaptionCore && swift test --filter CallUpdateDecoding`
Expected: FAIL — `decodeCallUpdate` not in scope.

- [ ] **Step 3: Implement the types and decoding**

```swift
// watch/CaptionCore/Sources/CaptionCore/CallCaptions.swift
import Foundation

/// Why the call being captioned stopped.
public enum CallEndReason: String, Equatable, Sendable {
    /// The caller hung up.
    case ended
    /// The audio stream died while the call was still up. Captions stopped;
    /// the call may not have.
    case streamLost = "stream_lost"
}

/// One answer from `GET /v1/call`: whether a call is live, and what has been
/// said since the sequence number asked for.
public struct CallUpdate: Equatable, Sendable {
    public let active: Bool
    public let reason: CallEndReason?
    public let events: [ServerMessage]
    public let seq: Int

    public init(active: Bool, reason: CallEndReason?, events: [ServerMessage], seq: Int) {
        self.active = active
        self.reason = reason
        self.events = events
        self.seq = seq
    }
}

/// Reads the call the relay is currently captioning.
public protocol CallClient: Sendable {
    func poll(since: Int) async throws -> CallUpdate
}

/// Decode `GET /v1/call`. Anything unrecognized reads as "no call": a body we
/// cannot understand must never present as a live conversation.
public func decodeCallUpdate(_ json: [String: Any]) -> CallUpdate {
    let events = (json["events"] as? [[String: Any]] ?? []).compactMap(decodeCallEvent)
    return CallUpdate(
        active: json["active"] as? Bool ?? false,
        reason: (json["reason"] as? String).flatMap(CallEndReason.init(rawValue:)),
        events: events,
        seq: json["seq"] as? Int ?? 0)
}

private func decodeCallEvent(_ event: [String: Any]) -> ServerMessage? {
    switch event["type"] as? String {
    case "ready":
        return .ready
    case "caption":
        return .caption(
            text: event["text"] as? String ?? "",
            isFinal: event["isFinal"] as? Bool ?? false,
            channel: event["channel"] as? Int)
    case "error":
        return .error(message: event["message"] as? String ?? "error")
    default:
        return nil
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cd watch/CaptionCore && swift test --filter CallUpdateDecoding`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add watch/CaptionCore/Sources/CaptionCore/CallCaptions.swift watch/CaptionCore/Tests/CaptionCoreTests/CallCaptionsTests.swift
git commit -m "feat(watch): decode live call updates from the relay"
```

---

### Task 11: `CallCaptions` — the poll loop

**Files:**
- Modify: `watch/CaptionCore/Sources/CaptionCore/CallCaptions.swift` (append)
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/CallCaptionsTests.swift` (append)

**Interfaces:**
- Consumes: `CallClient`, `CallUpdate`, `CaptionStore` (existing)
- Produces: `@MainActor final class CallCaptions` with `init(client:store:)`, `@Published private(set) var ended: CallEndReason?`, `func start()`, `func stop()`, `func poll() async -> Bool`, `static let pollInterval: TimeInterval`

- [ ] **Step 1: Write the failing test**

Append to `CallCaptionsTests.swift`:

```swift
private final class FakeCallClient: CallClient, @unchecked Sendable {
    var updates: [CallUpdate] = []
    var error: Error?
    private(set) var polledSince: [Int] = []

    func poll(since: Int) async throws -> CallUpdate {
        polledSince.append(since)
        if let error { throw error }
        return updates.isEmpty
            ? CallUpdate(active: true, reason: nil, events: [], seq: since)
            : updates.removeFirst()
    }
}

@MainActor
final class CallCaptionsTests: XCTestCase {
    private func make(_ client: FakeCallClient) -> (CallCaptions, CaptionStore) {
        let store = CaptionStore()
        return (CallCaptions(client: client, store: store), store)
    }

    func testCaptionsReachTheStore() async {
        let client = FakeCallClient()
        client.updates = [CallUpdate(
            active: true, reason: nil,
            events: [.ready, .caption(text: "hello there", isFinal: true, channel: nil)],
            seq: 2)]
        let (captions, store) = make(client)

        let keepGoing = await captions.poll()

        XCTAssertTrue(keepGoing)
        XCTAssertEqual(store.paragraphs.map(\.text), ["hello there"])
        XCTAssertEqual(store.state, .listening)
    }

    func testAdvancesTheCursorSoCaptionsArriveOnce() async {
        let client = FakeCallClient()
        client.updates = [CallUpdate(active: true, reason: nil, events: [], seq: 7)]
        let (captions, _) = make(client)

        _ = await captions.poll()
        _ = await captions.poll()

        XCTAssertEqual(client.polledSince, [0, 7])
    }

    func testEndsWhenTheCallEnds() async {
        let client = FakeCallClient()
        client.updates = [
            CallUpdate(active: true, reason: nil, events: [], seq: 1),
            CallUpdate(active: false, reason: .ended, events: [], seq: 1),
        ]
        let (captions, _) = make(client)

        _ = await captions.poll()
        let keepGoing = await captions.poll()

        XCTAssertFalse(keepGoing)
        XCTAssertEqual(captions.ended, .ended)
    }

    /// Captions dying under a live call is a different thing to show than the
    /// call ending, so the reason has to survive to the screen.
    func testALostStreamIsReportedAsItsOwnThing() async {
        let client = FakeCallClient()
        client.updates = [
            CallUpdate(active: true, reason: nil, events: [], seq: 1),
            CallUpdate(active: false, reason: .streamLost, events: [], seq: 1),
        ]
        let (captions, _) = make(client)

        _ = await captions.poll()
        _ = await captions.poll()

        XCTAssertEqual(captions.ended, .streamLost)
    }

    /// A watch out of range is not the call ending.
    func testATransientFailureKeepsPolling() async {
        let client = FakeCallClient()
        client.error = HistoryError.message("offline")
        let (captions, _) = make(client)

        let keepGoing = await captions.poll()

        XCTAssertTrue(keepGoing)
        XCTAssertNil(captions.ended)
    }

    /// Entering call mode races the relay noticing the call. An inactive first
    /// answer must not end a call that has not started.
    func testAnInactiveFirstAnswerDoesNotEndTheCall() async {
        let client = FakeCallClient()
        client.updates = [CallUpdate(active: false, reason: nil, events: [], seq: 0)]
        let (captions, _) = make(client)

        let keepGoing = await captions.poll()

        XCTAssertTrue(keepGoing)
        XCTAssertNil(captions.ended)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd watch/CaptionCore && swift test --filter CallCaptionsTests`
Expected: FAIL — `CallCaptions` not in scope.

- [ ] **Step 3: Implement**

Append to `watch/CaptionCore/Sources/CaptionCore/CallCaptions.swift`:

```swift
/// Reads a live call onto the screen.
///
/// Deliberately not `SessionController`: that orchestrates permission,
/// connection, and microphone capture, and a call needs none of them. The audio
/// is Twilio's, so this never touches the mic or the audio session — there is
/// nothing here to contend with the phone call itself.
@MainActor
public final class CallCaptions: ObservableObject {
    /// Set once the call is over, with why. Nil while it is live.
    @Published public private(set) var ended: CallEndReason?

    public static let pollInterval: TimeInterval = 1

    private let client: CallClient
    private let store: CaptionStore
    private var seq = 0
    /// A call was seen live. Until then an inactive answer just means the relay
    /// has not noticed the call yet, not that it is over.
    private var wasActive = false
    private var task: Task<Void, Never>?

    public init(client: CallClient, store: CaptionStore) {
        self.client = client
        self.store = store
    }

    /// Begin reading. Safe to call again; the previous loop is replaced.
    public func start() {
        store.reset()
        seq = 0
        wasActive = false
        ended = nil
        task?.cancel()
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                guard await self.poll() else { return }
                try? await Task.sleep(
                    nanoseconds: UInt64(Self.pollInterval * 1_000_000_000))
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    /// One poll. False when the call is over and polling should stop. A failed
    /// request keeps the loop alive — a watch out of range is not an answer.
    @discardableResult
    public func poll() async -> Bool {
        guard let update = try? await client.poll(since: seq) else { return true }
        seq = max(seq, update.seq)
        for event in update.events { store.apply(event) }
        if update.active {
            wasActive = true
            return true
        }
        guard wasActive else { return true }
        ended = update.reason ?? .ended
        return false
    }
}
```

- [ ] **Step 4: Run the full CaptionCore suite**

Run: `cd watch/CaptionCore && swift test`
Expected: PASS, including the 117 existing tests.

- [ ] **Step 5: Commit**

```bash
git add watch/CaptionCore/Sources/CaptionCore/CallCaptions.swift watch/CaptionCore/Tests/CaptionCoreTests/CallCaptionsTests.swift
git commit -m "feat(watch): poll a live call onto the captions screen

Separate from SessionController on purpose: a call needs no permission and
no microphone, so the watch never contends with the call for audio."
```

---

### Task 12: Wire call mode into the watch app

**Files:**
- Create: `watch/WatchCaptions/RelayCallClient.swift`
- Modify: `watch/WatchCaptions/AppModel.swift` (route, model wiring, launch detection)
- Modify: `watch/WatchCaptions/Views/CaptionView.swift` (indicator states)
- Modify: `watch/WatchCaptions/WatchCaptionsApp.swift` (both `CaptionView` call sites)

**Interfaces:**
- Consumes: `CallCaptions`, `CallClient`, `CallEndReason`, `decodeCallUpdate` (Tasks 10–11)
- Produces: `AppModel.Route.call`; `AppModel.callCaptions: CallCaptions`;
  `AppModel.leaveCall()`; `enum CaptionIndicator { case recording; case liveOnly;
  case call; case callEnded(CallEndReason) }`;
  `CaptionView(store:indicator:onStop:)` where `onStop: (() -> Void)?`

The indicator change is folded in rather than split out: `Route.call` needs a
`navigationDestination` case, which needs the new `CaptionView` signature. Split
apart, neither half compiles alone.

- [ ] **Step 1: Create the HTTP client**

```swift
// watch/WatchCaptions/RelayCallClient.swift
import Foundation
import CaptionCore

/// Reads the relay's current call over plain HTTP, the only networking
/// watchOS allows here (TN3135). Decoding lives in CaptionCore, where it is
/// unit-tested against the relay's real response shape.
struct RelayCallClient: CallClient {
    let base: URL
    let token: String

    /// Short timeout on purpose: this runs on every foreground to decide
    /// whether to open call captions, so an unreachable relay has to fail fast
    /// and let the app land on the menu rather than hang.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 5
        return URLSession(configuration: config)
    }()

    func poll(since: Int) async throws -> CallUpdate {
        var components = URLComponents(
            url: base.appendingPathComponent("v1/call"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "since", value: String(since)),
        ]
        let (data, response) = try await Self.session.data(from: components.url!)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw HistoryError.message("Relay error")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HistoryError.message("Unreadable response")
        }
        return decodeCallUpdate(json)
    }
}
```

- [ ] **Step 2: Add the route and the model**

In `watch/WatchCaptions/AppModel.swift`, add to the `Route` enum:

```swift
        /// Reading a phone call the relay is captioning.
        case call
```

Add stored properties next to `exports`:

```swift
    /// Reads a live phone call. Shares `store` with mic sessions — the two are
    /// never live at once.
    let callCaptions: CallCaptions
    private let callClient: RelayCallClient
```

In `init`, after `exports` is created:

```swift
        let callClient = RelayCallClient(base: base, token: Secrets.authToken)
        self.callClient = callClient
        callCaptions = CallCaptions(client: callClient, store: store)
```

- [ ] **Step 3: Detect a live call on launch**

In `launch()`, immediately after the existing `guard !capturing, path.isEmpty else { return }` and before the `switch launchAction(...)`, insert:

```swift
        // A call in progress is the most likely reason the app is being opened
        // at all, so it wins over the menu and over resuming a past session.
        if await enterCallIfLive() { return }
```

Add the method to the Sessions section:

```swift
    /// Open call captions when the relay says a call is live. False on no call
    /// or on any failure, so an unreachable relay lands on the menu.
    private func enterCallIfLive() async -> Bool {
        guard let update = try? await callClient.poll(since: 0), update.active else {
            return false
        }
        path = [.call]
        callCaptions.start()
        return true
    }

    /// Leave call captions. The call itself is unaffected — this only stops
    /// reading it.
    func leaveCall() {
        callCaptions.stop()
        path = []
    }
```

- [ ] **Step 4: Replace the caption indicator boolean**

`CaptionView` takes `isLive: Bool` today. Four states now exist, and a call has
no Stop button — stopping captions is not hanging up, and offering it on the
toolbar would imply it is.

In `watch/WatchCaptions/Views/CaptionView.swift`, add above `struct CaptionView`:

```swift
/// What the dot in the corner is saying.
enum CaptionIndicator {
    /// A mic session being written down.
    case recording
    /// A mic session keeping nothing.
    case liveOnly
    /// Reading a live phone call.
    case call
    /// The call is over, or its captions are.
    case callEnded(CallEndReason)

    var label: String {
        switch self {
        case .recording: return "Recording"
        case .liveOnly: return "Live only, not saved"
        case .call: return "Captioning a call"
        case .callEnded(.ended): return "Call ended"
        case .callEnded(.streamLost): return "Captions stopped"
        }
    }
}
```

Change the view's properties:

```swift
    @ObservedObject var store: CaptionStore
    let indicator: CaptionIndicator
    /// Absent when there is nothing for the user to stop — reading a call is
    /// not the same as hanging up, and offering Stop would imply it was.
    let onStop: (() -> Void)?
```

Replace the `.overlay(alignment: .topTrailing)` indicator group:

```swift
        .overlay(alignment: .topTrailing) {
            Group {
                switch indicator {
                case .recording:
                    Circle().fill(.green)
                case .liveOnly:
                    Circle().strokeBorder(.green, lineWidth: 1.5)
                case .call:
                    Circle().fill(.blue)
                case .callEnded:
                    Circle().fill(.secondary)
                }
            }
            .frame(width: 7, height: 7)
            .accessibilityElement()
            .accessibilityLabel(indicator.label)
        }
```

Make the toolbar conditional:

```swift
        .toolbar {
            if let onStop {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: onStop) {
                        Label("Stop", systemImage: "stop.fill")
                    }
                }
            }
        }
```

Add `import CaptionCore` if it is not already there.

- [ ] **Step 5: Update the mic-session call site and render the call screen**

In `watch/WatchCaptions/WatchCaptionsApp.swift`, in the `captions` view builder:

```swift
        case .listening:
            CaptionView(
                store: store,
                indicator: model.live ? .liveOnly : .recording,
                onStop: { model.stop() })
```

Add an observed object to `RootView`:

```swift
    @ObservedObject private var callCaptions: CallCaptions
```

assign it in `init` (`callCaptions = model.callCaptions`), and add the
destination case:

```swift
                    case .call:
                        CaptionView(
                            store: store,
                            indicator: callCaptions.ended.map(CaptionIndicator.callEnded) ?? .call,
                            onStop: nil)
                            // Leaving stops reading the call. It does not hang up.
                            .onDisappear { model.leaveCall() }
```

- [ ] **Step 6: Regenerate and build**

Run:
```bash
cd watch && xcodegen generate && xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,id=7BB5A7C6-2524-450C-9CCD-050E35F530C5' build
```
Expected: BUILD SUCCEEDED.

- [ ] **Step 7: Run every suite**

Run:
```bash
cd backend && npx tsc --noEmit && npx vitest run
cd ../watch/CaptionCore && swift test
cd ../../mac && xcodebuild -project Captions.xcodeproj -scheme Captions -destination 'platform=macOS' build
```
Expected: all pass. The mac app shares `CaptionCore` and must still build.

- [ ] **Step 8: Commit**

```bash
git add watch/WatchCaptions/RelayCallClient.swift watch/WatchCaptions/AppModel.swift \
        watch/WatchCaptions/WatchCaptionsApp.swift watch/WatchCaptions/Views/CaptionView.swift
git commit -m "feat(watch): read a live call on the wrist

Opening the app during a call goes straight to its captions, checked with
a short timeout so an unreachable relay lands on the menu instead. No Stop
button on a call — stopping captions is not hanging up, and offering it
would say it was."
```

---

## Manual verification

Automated tests deliberately contain neither Twilio nor Deepgram. The prototype is verified by making one real call.

1. `fly secrets set TWILIO_FORWARD_TO=+1…` and deploy the relay.
2. In the Twilio console, set the number's voice webhook to `POST https://watch-captions-relay.fly.dev/twilio/voice?token=<AUTH_TOKEN>`.
3. Set the number's **fallback URL** to a static TwiML bin containing only `<Response><Dial>+1…</Dial></Response>`, so a relay outage degrades to a plain forwarded call instead of a failed one.
4. Call the Twilio number from another phone. Answer on your real phone.
5. Open the watch app. It should go straight to call captions.
6. **Measure the lag** between the caller speaking and the words appearing. This is the number that decides whether the prototype succeeded.
7. Hang up. The watch should keep the captions on screen with an ended indicator.
8. Try `DEEPGRAM_PHONE_MODEL=phonecall` and compare accuracy and lag against the `flux-general-en` default.

## Out of scope

Per the spec, and deliberately: Twilio signature validation, media-stream reconnect, call queueing, caller-ID display, both sides of the conversation, saved call transcripts, and keeping your real number.
