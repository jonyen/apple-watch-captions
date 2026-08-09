# Watch-Held Calls (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Twilio answers and holds an inbound call while the Apple Watch reads captions, hears the caller, and speaks back — with neither the phone nor the watch in a call.

**Architecture:** `<Connect><Stream>` makes Twilio the call's owner: the call lives exactly as long as the WebSocket. The relay rings the caller with `<Play>` + `<Redirect>` until the watch is present (a recent `/v1/call` poll), then connects the stream. Caller audio fans out to Deepgram for captions and to a bounded buffer the watch polls for playback; the watch's push-to-talk audio is POSTed, converted to μ-law, and written back over the same socket.

**Tech Stack:** Node/TypeScript relay (vitest), Swift `CaptionCore` package (XCTest), watchOS SwiftUI app (XcodeGen).

**Spec:** `docs/superpowers/specs/2026-08-08-watch-held-call-captioning-design.md`

## Global Constraints

- Relay tests: `cd backend && npx vitest run`. Typecheck: `npx tsc --noEmit`. Both must pass before any commit.
- CaptionCore tests: `cd watch/CaptionCore && swift test`. Must pass before any commit touching it.
- Watch app builds with `cd watch && xcodegen generate && xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions -destination 'platform=watchOS Simulator,id=7BB5A7C6-2524-450C-9CCD-050E35F530C5' build`. **Run `xcodegen generate` after adding any new file** — the `.xcodeproj` is gitignored.
- The mac app shares `CaptionCore` and must keep building: `cd mac && xcodebuild -project Captions.xcodeproj -scheme Captions -destination 'platform=macOS' build`.
- **No test may contact Twilio or Deepgram.** Transcription is `FakeTranscriptionProvider`; Twilio is fake frames through a fake socket. A real WebSocket to the test's own `startServer` is fine — it is this relay, not a vendor.
- **Outbound Twilio frames** are `{"event":"media","streamSid":"…","media":{"payload":"<base64>"}}`. Payload must be μ-law 8 kHz, base64, and **must not contain audio file header bytes**.
- Call sessions stay **ephemeral** — nothing written, summarized or exported.
- Commit after every task. Work on branch `feat/watch-held-calls`.

---

### Task 1: μ-law conversion

**Files:**
- Create: `backend/src/mulaw.ts`
- Test: `backend/src/mulaw.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `decodeMuLaw(data: Buffer): Int16Array`; `encodeMuLaw(samples: Int16Array): Buffer`; `pcm16kToMuLaw8k(pcm: Buffer): Buffer`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/mulaw.test.ts
import { describe, it, expect } from "vitest";
import { decodeMuLaw, encodeMuLaw, pcm16kToMuLaw8k } from "./mulaw";

/** A sine sweep is a fairer test than silence: it exercises the whole range. */
function tone(samples: number, amplitude = 8000): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = Math.round(Math.sin(i * 0.1) * amplitude);
  return out;
}

describe("mu-law", () => {
  it("round-trips within mu-law's quantisation error", () => {
    const original = tone(200);

    const restored = decodeMuLaw(encodeMuLaw(original));

    expect(restored.length).toBe(original.length);
    // mu-law is lossy and coarser at higher amplitudes; 5% of full scale is
    // comfortably inside its error and far tighter than a wrong table.
    for (let i = 0; i < original.length; i++) {
      expect(Math.abs(restored[i] - original[i])).toBeLessThan(32768 * 0.05);
    }
  });

  it("encodes one byte per sample", () => {
    expect(encodeMuLaw(tone(100)).length).toBe(100);
  });

  it("maps silence to mu-law's silence byte", () => {
    // 0xFF is mu-law zero. Twilio sends it for silence; sending anything else
    // for silence is audible as a hiss.
    expect(encodeMuLaw(new Int16Array([0]))[0]).toBe(0xff);
    expect(decodeMuLaw(Buffer.from([0xff]))[0]).toBe(0);
  });

  it("halves the rate converting 16 kHz PCM to 8 kHz mu-law", () => {
    // 400 Int16 samples = 800 bytes at 16 kHz -> 200 mu-law bytes at 8 kHz.
    const pcm = Buffer.alloc(800);
    for (let i = 0; i < 400; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * 8000), i * 2);

    expect(pcm16kToMuLaw8k(pcm).length).toBe(200);
  });

  it("tolerates a PCM buffer that ends mid-sample", () => {
    expect(() => pcm16kToMuLaw8k(Buffer.alloc(801))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/mulaw.test.ts`
Expected: FAIL — cannot resolve `./mulaw`.

- [ ] **Step 3: Implement**

```ts
// backend/src/mulaw.ts

const BIAS = 0x84;
const CLIP = 32635;

/** One Int16 sample to one mu-law byte (ITU-T G.711). */
function encodeSample(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One mu-law byte back to one Int16 sample. */
function decodeSample(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -magnitude : magnitude;
}

export function decodeMuLaw(data: Buffer): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = decodeSample(data[i]);
  return out;
}

export function encodeMuLaw(samples: Int16Array): Buffer {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = encodeSample(samples[i]);
  return out;
}

/**
 * The watch's 16 kHz little-endian Int16 to the 8 kHz mu-law Twilio requires.
 * Averaging each pair rather than dropping one halves the rate without the
 * aliasing that decimation alone would add to speech.
 */
export function pcm16kToMuLaw8k(pcm: Buffer): Buffer {
  // A trailing odd byte is a truncated sample; ignore it rather than read past.
  const pairs = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(pairs);
  for (let i = 0; i < pairs; i++) {
    const a = pcm.readInt16LE(i * 4);
    const b = pcm.readInt16LE(i * 4 + 2);
    out[i] = encodeSample((a + b) >> 1);
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run src/mulaw.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/mulaw.ts backend/src/mulaw.test.ts
git commit -m "feat(relay): mu-law conversion for the call uplink and downlink"
```

---

### Task 2: Watch presence

**Files:**
- Create: `backend/src/callPresence.ts`
- Test: `backend/src/callPresence.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class CallPresence` with `constructor(opts?: { now?: () => number; windowMs?: number })`, `mark(): void`, `isPresent(): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/callPresence.test.ts
import { describe, it, expect } from "vitest";
import { CallPresence } from "./callPresence";

describe("CallPresence", () => {
  it("is absent before the watch has ever polled", () => {
    expect(new CallPresence().isPresent()).toBe(false);
  });

  it("is present immediately after a poll", () => {
    const presence = new CallPresence();
    presence.mark();
    expect(presence.isPresent()).toBe(true);
  });

  it("goes absent once the window lapses", () => {
    let now = 1_000;
    const presence = new CallPresence({ now: () => now, windowMs: 10_000 });
    presence.mark();

    now += 10_000;
    expect(presence.isPresent()).toBe(true); // exactly at the edge still counts

    now += 1;
    expect(presence.isPresent()).toBe(false);
  });

  it("comes back when the watch polls again", () => {
    let now = 1_000;
    const presence = new CallPresence({ now: () => now, windowMs: 10_000 });
    presence.mark();
    now += 20_000;
    expect(presence.isPresent()).toBe(false);

    presence.mark();

    expect(presence.isPresent()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/callPresence.test.ts`
Expected: FAIL — cannot resolve `./callPresence`.

- [ ] **Step 3: Implement**

```ts
// backend/src/callPresence.ts

/** How recently the watch must have polled to count as ready for a call. */
export const PRESENCE_WINDOW_MS = 10_000;

/**
 * Whether the watch is here right now, inferred from how recently it polled
 * `GET /v1/call`.
 *
 * Presence deliberately reuses a signal the watch already sends rather than
 * introducing a registration protocol — and it is the signal a push
 * notification would eventually replace.
 */
export class CallPresence {
  private lastSeen = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(opts: { now?: () => number; windowMs?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? PRESENCE_WINDOW_MS;
  }

  mark(): void {
    this.lastSeen = this.now();
  }

  isPresent(): boolean {
    return this.now() - this.lastSeen <= this.windowMs;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run src/callPresence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/callPresence.ts backend/src/callPresence.test.ts
git commit -m "feat(relay): treat a recent poll as the watch being present"
```

---

### Task 3: Downlink audio buffer

**Files:**
- Create: `backend/src/callAudioBuffer.ts`
- Test: `backend/src/callAudioBuffer.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class CallAudioBuffer` with `constructor(maxBytes?: number)`, `append(data: Buffer): void`, `drain(since: number): { audio: Buffer; seq: number }`, `clear(): void`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/callAudioBuffer.test.ts
import { describe, it, expect } from "vitest";
import { CallAudioBuffer } from "./callAudioBuffer";

describe("CallAudioBuffer", () => {
  it("hands back everything after the caller's cursor", () => {
    const buffer = new CallAudioBuffer();
    buffer.append(Buffer.from([1, 2]));
    buffer.append(Buffer.from([3, 4]));

    const { audio, seq } = buffer.drain(0);

    expect([...audio]).toEqual([1, 2, 3, 4]);
    expect(seq).toBe(2);
  });

  it("hands back only what is new on the next poll", () => {
    const buffer = new CallAudioBuffer();
    buffer.append(Buffer.from([1, 2]));
    const first = buffer.drain(0);
    buffer.append(Buffer.from([3, 4]));

    const second = buffer.drain(first.seq);

    expect([...second.audio]).toEqual([3, 4]);
  });

  it("returns nothing when the caller is already current", () => {
    const buffer = new CallAudioBuffer();
    buffer.append(Buffer.from([1, 2]));
    const { seq } = buffer.drain(0);

    expect(buffer.drain(seq).audio.length).toBe(0);
  });

  // Live audio: a backlog is worse than a gap, because playing stale speech
  // puts the listener further behind rather than catching them up.
  it("drops the oldest audio rather than growing past its bound", () => {
    const buffer = new CallAudioBuffer(4);
    buffer.append(Buffer.from([1, 2]));
    buffer.append(Buffer.from([3, 4]));
    buffer.append(Buffer.from([5, 6]));

    const { audio } = buffer.drain(0);

    expect([...audio]).toEqual([3, 4, 5, 6]);
  });

  it("keeps the cursor monotonic even after dropping", () => {
    const buffer = new CallAudioBuffer(4);
    buffer.append(Buffer.from([1, 2]));
    buffer.append(Buffer.from([3, 4]));
    buffer.append(Buffer.from([5, 6]));

    expect(buffer.drain(0).seq).toBe(3);
  });

  it("forgets everything on clear", () => {
    const buffer = new CallAudioBuffer();
    buffer.append(Buffer.from([1, 2]));

    buffer.clear();

    expect(buffer.drain(0).audio.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/callAudioBuffer.test.ts`
Expected: FAIL — cannot resolve `./callAudioBuffer`.

- [ ] **Step 3: Implement**

```ts
// backend/src/callAudioBuffer.ts

/**
 * Five seconds of mu-law at 8 kHz. Named distinctly because `server.ts`
 * already has a `MAX_AUDIO_BYTES` governing request-body size, and Task 9
 * uses both in the same file.
 */
export const MAX_BUFFERED_AUDIO_BYTES = 40_000;

interface Chunk {
  seq: number;
  data: Buffer;
}

/**
 * The caller's audio waiting for the watch to collect it.
 *
 * Bounded, dropping oldest. This is live audio: if the watch stalls, keeping
 * the backlog would only play stale speech and put the listener further
 * behind. Five seconds rides out a slow poll without letting what you hear
 * drift badly out of step with what you read.
 */
export class CallAudioBuffer {
  private chunks: Chunk[] = [];
  private seq = 0;
  private bytes = 0;

  constructor(private readonly maxBytes: number = MAX_BUFFERED_AUDIO_BYTES) {}

  append(data: Buffer): void {
    if (data.length === 0) return;
    this.seq += 1;
    this.chunks.push({ seq: this.seq, data });
    this.bytes += data.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      this.bytes -= this.chunks.shift()!.data.length;
    }
  }

  /** Everything with a sequence past `since`, plus the newest sequence. */
  drain(since: number): { audio: Buffer; seq: number } {
    const fresh = this.chunks.filter((chunk) => chunk.seq > since);
    return {
      audio: fresh.length > 0 ? Buffer.concat(fresh.map((c) => c.data)) : Buffer.alloc(0),
      seq: this.seq,
    };
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run src/callAudioBuffer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/callAudioBuffer.ts backend/src/callAudioBuffer.test.ts
git commit -m "feat(relay): bounded buffer for the caller's audio"
```

---

### Task 4: Uplink holder

The HTTP route that receives your voice and the WebSocket that sends it to Twilio never meet. This is the seam between them.

**Files:**
- Create: `backend/src/callUplink.ts`
- Test: `backend/src/callUplink.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class CallUplink` with `attach(sender: (mulaw: Buffer) => void): void`, `detach(): void`, `write(mulaw: Buffer): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/callUplink.test.ts
import { describe, it, expect } from "vitest";
import { CallUplink } from "./callUplink";

describe("CallUplink", () => {
  it("refuses to write when no call is attached", () => {
    expect(new CallUplink().write(Buffer.from([1]))).toBe(false);
  });

  it("hands audio to the attached sender", () => {
    const sent: Buffer[] = [];
    const uplink = new CallUplink();
    uplink.attach((mulaw) => sent.push(mulaw));

    expect(uplink.write(Buffer.from([1, 2]))).toBe(true);
    expect([...sent[0]]).toEqual([1, 2]);
  });

  it("stops writing once detached", () => {
    const sent: Buffer[] = [];
    const uplink = new CallUplink();
    uplink.attach((mulaw) => sent.push(mulaw));
    uplink.detach();

    expect(uplink.write(Buffer.from([1]))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  // A new call replaces the old one; audio must never reach a dead socket.
  it("sends to the most recently attached call only", () => {
    const first: Buffer[] = [];
    const second: Buffer[] = [];
    const uplink = new CallUplink();
    uplink.attach((m) => first.push(m));
    uplink.attach((m) => second.push(m));

    uplink.write(Buffer.from([9]));

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/callUplink.test.ts`
Expected: FAIL — cannot resolve `./callUplink`.

- [ ] **Step 3: Implement**

```ts
// backend/src/callUplink.ts

/**
 * Where your voice goes. The HTTP route that receives audio from the watch and
 * the WebSocket that carries it to Twilio never meet directly; the live call
 * attaches its sender here and the route writes through it.
 *
 * Only one call is captioned at a time, so a later attach replaces the earlier
 * one outright — audio must never reach a socket a newer call has replaced.
 */
export class CallUplink {
  private sender: ((mulaw: Buffer) => void) | null = null;

  attach(sender: (mulaw: Buffer) => void): void {
    this.sender = sender;
  }

  detach(): void {
    this.sender = null;
  }

  /** False when no call is live, so a caller can answer 409 rather than 200. */
  write(mulaw: Buffer): boolean {
    if (!this.sender) return false;
    this.sender(mulaw);
    return true;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run src/callUplink.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/callUplink.ts backend/src/callUplink.test.ts
git commit -m "feat(relay): seam between the audio route and the live call"
```

---

### Task 5: Ringback tone

`<Play>` needs a real URL. Silence while the watch is given a chance to answer reads as a broken call.

**Files:**
- Create: `backend/src/ringback.ts`
- Test: `backend/src/ringback.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ringbackWav(): Buffer`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/ringback.test.ts
import { describe, it, expect } from "vitest";
import { ringbackWav } from "./ringback";

describe("ringbackWav", () => {
  it("is a WAV file Twilio can play", () => {
    const wav = ringbackWav();

    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(8000); // 8 kHz
    expect(wav.readUInt16LE(34)).toBe(16); // 16-bit
  });

  it("declares the data length it actually carries", () => {
    const wav = ringbackWav();
    const declared = wav.readUInt32LE(40);

    expect(declared).toBe(wav.length - 44);
  });

  it("rings for two seconds then rests for two", () => {
    const wav = ringbackWav();
    const at = (second: number) => wav.readInt16LE(44 + Math.floor(second * 8000) * 2);

    // Somewhere inside the tone there is signal; inside the rest there is not.
    let loudest = 0;
    for (let i = 0; i < 8000; i++) loudest = Math.max(loudest, Math.abs(at(i / 8000)));
    expect(loudest).toBeGreaterThan(1000);
    expect(at(3)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/ringback.test.ts`
Expected: FAIL — cannot resolve `./ringback`.

- [ ] **Step 3: Implement**

```ts
// backend/src/ringback.ts

const SAMPLE_RATE = 8000;
const TONE_SECONDS = 2;
const REST_SECONDS = 2;
/** North American ringback is a 440 Hz and 480 Hz pair. */
const FREQUENCIES = [440, 480];

/**
 * Four seconds of ringback — two ringing, two silent — as an 8 kHz mono WAV.
 *
 * Generated rather than shipped as an asset: it is forty lines, needs no build
 * step, and the caller has to hear something while the watch is given a chance
 * to answer. Silence there reads as a broken call.
 */
export function ringbackWav(): Buffer {
  const total = (TONE_SECONDS + REST_SECONDS) * SAMPLE_RATE;
  const samples = Buffer.alloc(total * 2);

  for (let i = 0; i < total; i++) {
    let value = 0;
    if (i < TONE_SECONDS * SAMPLE_RATE) {
      for (const hz of FREQUENCIES) {
        value += Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
      }
      value = (value / FREQUENCIES.length) * 8000;
    }
    samples.writeInt16LE(Math.round(value), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples.length, 40);

  return Buffer.concat([header, samples]);
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run src/ringback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ringback.ts backend/src/ringback.test.ts
git commit -m "feat(relay): generate a ringback tone for the waiting caller"
```

---

### Task 6: TwiML for ringing and connecting

**Files:**
- Modify: `backend/src/twiml.ts`
- Test: `backend/src/twiml.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ringbackResponse(opts: { ringbackUrl: string; nextUrl: string }): string`; `connectStreamResponse(opts: { streamUrl: string; streamStatusUrl?: string }): string`. `voiceResponse` is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/twiml.test.ts`:

```ts
describe("ringbackResponse", () => {
  it("rings, then asks Twilio to check again", () => {
    const xml = ringbackResponse({
      ringbackUrl: "https://relay.example/twilio/ringback.wav",
      nextUrl: "https://relay.example/twilio/voice?token=abc&attempt=2",
    });

    expect(xml).toContain("<Play>https://relay.example/twilio/ringback.wav</Play>");
    expect(xml).toContain("&amp;attempt=2");
    expect(xml.indexOf("<Play>")).toBeLessThan(xml.indexOf("<Redirect>"));
  });
});

describe("connectStreamResponse", () => {
  // <Connect> is the blocking, bidirectional form: the call lives exactly as
  // long as the socket. <Start> would return immediately and end the call.
  it("connects a bidirectional stream", () => {
    const xml = connectStreamResponse({
      streamUrl: "wss://relay.example/twilio/stream/abc",
    });

    expect(xml).toContain("<Connect>");
    expect(xml).toContain('<Stream url="wss://relay.example/twilio/stream/abc"');
    expect(xml).not.toContain("<Start>");
    expect(xml).not.toContain("<Dial>");
  });

  it("carries a status callback when given one", () => {
    const xml = connectStreamResponse({
      streamUrl: "wss://relay.example/twilio/stream/abc",
      streamStatusUrl: "https://relay.example/twilio/stream-status?token=abc",
    });

    expect(xml).toContain('statusCallback="https://relay.example/twilio/stream-status?token=abc"');
  });

  // A bidirectional stream carries the caller's audio in both directions;
  // restricting the track would silence half of it.
  it("does not restrict the track", () => {
    expect(connectStreamResponse({ streamUrl: "wss://x/y" })).not.toContain("track=");
  });
});
```

Add `ringbackResponse` and `connectStreamResponse` to that file's import from `./twiml`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/twiml.test.ts`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Implement**

Append to `backend/src/twiml.ts`:

```ts
export interface RingbackOptions {
  /** Where the ringback tone is served from. */
  ringbackUrl: string;
  /** The webhook to come back to, carrying the next attempt number. */
  nextUrl: string;
}

/**
 * Ring the caller once, then ask Twilio to come back and check whether the
 * watch has arrived. The retry count rides in `nextUrl`, so the relay keeps no
 * per-call state about ringing.
 */
export function ringbackResponse({ ringbackUrl, nextUrl }: RingbackOptions): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `<Play>${escapeXml(ringbackUrl)}</Play>`,
    `<Redirect>${escapeXml(nextUrl)}</Redirect>`,
    "</Response>",
  ].join("");
}

export interface ConnectStreamOptions {
  streamUrl: string;
  streamStatusUrl?: string;
}

/**
 * Hand the call to the relay.
 *
 * `<Connect>` is the blocking, bidirectional form: Twilio holds the call open
 * for exactly as long as the WebSocket lives, and audio flows both ways. That
 * is what makes Twilio the call's owner and leaves neither phone nor watch in
 * a call. `<Start>` — phase 1's form — would return immediately and the call
 * would end.
 */
export function connectStreamResponse({
  streamUrl,
  streamStatusUrl,
}: ConnectStreamOptions): string {
  const status = streamStatusUrl
    ? ` statusCallback="${escapeXml(streamStatusUrl)}" statusCallbackMethod="POST"`
    : "";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "<Connect>",
    `<Stream url="${escapeXml(streamUrl)}"${status}/>`,
    "</Connect>",
    "</Response>",
  ].join("");
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run src/twiml.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/twiml.ts backend/src/twiml.test.ts
git commit -m "feat(relay): TwiML for ringing and for connecting a held call"
```

---

### Task 7: Bidirectional stream handler

**Files:**
- Modify: `backend/src/twilioStreamHandler.ts`
- Test: `backend/src/twilioStreamHandler.test.ts`

**Interfaces:**
- Consumes: `CallAudioBuffer` (Task 3), `CallUplink` (Task 4), `pcm16kToMuLaw8k` is NOT used here
- Produces: `interface TwilioSocketLike { on(...): unknown; send(data: string): void }`; `handleTwilioStream(ws, store, calls, downlink: CallAudioBuffer, uplink: CallUplink): void`

- [ ] **Step 1: Write the failing test**

Append to `backend/src/twilioStreamHandler.test.ts`, and extend the existing `FakeSocket` with a `send` recorder plus a `sent` array:

```ts
describe("bidirectional audio", () => {
  it("copies the caller's audio into the downlink buffer", () => {
    const { ws, downlink } = harness();
    ws.send(startFrame("CA1"));

    ws.send(mediaFrame("AAECAw=="));

    expect([...downlink.drain(0).audio]).toEqual([0, 1, 2, 3]);
  });

  // streamSid is required on every outbound frame. The handler previously kept
  // only callSid, and the uplink cannot work without it.
  it("sends uplink audio back to Twilio addressed to the stream", () => {
    const { ws, uplink } = harness();
    ws.send(startFrame("CA1"));

    expect(uplink.write(Buffer.from([0xff, 0xff]))).toBe(true);

    const frame = JSON.parse(ws.sent.at(-1)!);
    expect(frame.event).toBe("media");
    expect(frame.streamSid).toBe("MZ-CA1");
    expect(Buffer.from(frame.media.payload, "base64").length).toBe(2);
  });

  it("stops accepting uplink audio once the call ends", () => {
    const { ws, uplink } = harness();
    ws.send(startFrame("CA1"));
    ws.send({ event: "stop" });

    expect(uplink.write(Buffer.from([0xff]))).toBe(false);
  });

  it("empties the downlink buffer when a call ends, so the next call starts clean", () => {
    const { ws, downlink } = harness();
    ws.send(startFrame("CA1"));
    ws.send(mediaFrame("AAECAw=="));

    ws.send({ event: "stop" });

    expect(downlink.drain(0).audio.length).toBe(0);
  });
});
```

Update `harness()` to construct and return `downlink` and `uplink`, and to pass them to `handleTwilioStream`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/twilioStreamHandler.test.ts`
Expected: FAIL — `handleTwilioStream` takes three arguments.

- [ ] **Step 3: Implement**

In `backend/src/twilioStreamHandler.ts`, extend the socket interface and the signature:

```ts
import { CallAudioBuffer } from "./callAudioBuffer";
import { CallUplink } from "./callUplink";

/** Subset of a WebSocket this handler needs (keeps it testable). */
export interface TwilioSocketLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
  send(data: string): void;
}
```

```ts
export function handleTwilioStream(
  ws: TwilioSocketLike,
  store: SessionStore,
  calls: CurrentCall,
  downlink: CallAudioBuffer,
  uplink: CallUplink,
): void {
  let sessionId: string | null = null;
  // Every outbound frame must name the stream, so this is retained from the
  // start frame rather than discarded as it was in phase 1.
  let streamSid: string | null = null;
```

In `endCall`, before the existing teardown, release the shared state:

```ts
  const endCall = (reason: CallEndReason) => {
    if (!sessionId) return;
    const ending = sessionId;
    sessionId = null;
    streamSid = null;
    uplink.detach();
    // The next call must not inherit this one's audio.
    downlink.clear();
```

In the `start` case, after `calls.begin(...)`, attach the uplink:

```ts
        streamSid = frame.streamSid;
        const sid = frame.streamSid;
        uplink.attach((mulaw) => {
          ws.send(JSON.stringify({
            event: "media",
            streamSid: sid,
            media: { payload: mulaw.toString("base64") },
          }));
        });
```

In the `media` case, fan the audio out to the downlink buffer as well as to transcription:

```ts
      case "media":
        if (sessionId && calls.current()?.sessionId === sessionId) {
          store.feed(sessionId, frame.audio, CALL_SESSION.ephemeral, CALL_SESSION.provider);
          // The same bytes, untranscoded, for the watch to play.
          downlink.append(frame.audio);
        }
        break;
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run src/twilioStreamHandler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/twilioStreamHandler.ts backend/src/twilioStreamHandler.test.ts
git commit -m "feat(relay): carry audio both ways over the Twilio stream"
```

---

### Task 8: Ring, connect, or fall back

**Files:**
- Modify: `backend/src/server.ts`
- Test: `backend/src/server.call.test.ts`

**Interfaces:**
- Consumes: `CallPresence` (Task 2), `ringbackWav` (Task 5), `ringbackResponse` / `connectStreamResponse` (Task 6)
- Produces: `GET /twilio/ringback.wav`; `POST /twilio/voice?attempt=N` returning one of three shapes; `StartServerOptions.waitAttempts?: number`

- [ ] **Step 1: Write the failing test**

Append to `backend/src/server.call.test.ts`. Add `presence` to the harness so tests can mark the watch present:

```ts
describe("ring, connect, or fall back", () => {
  it("rings and asks Twilio to check again when the watch is absent", async () => {
    const { port } = start("+15551234567");

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=good`, {
      method: "POST",
    })).text();

    expect(xml).toContain("<Play>");
    expect(xml).toContain("ringback.wav");
    expect(xml).toContain("attempt=2");
    expect(xml).not.toContain("<Connect>");
  });

  it("connects the stream once the watch has polled", async () => {
    const { port } = start("+15551234567");
    await fetch(`${base(port)}/v1/call?token=good`); // this is what marks presence

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=good`, {
      method: "POST",
    })).text();

    expect(xml).toContain("<Connect>");
    expect(xml).toContain(`wss://127.0.0.1:${port}/twilio/stream/good`);
  });

  it("falls back to the second line once the budget is spent", async () => {
    const { port } = start("+15551234567");

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=good&attempt=99`, {
      method: "POST",
    })).text();

    expect(xml).toContain("<Dial>+15551234567</Dial>");
    expect(xml).not.toContain("<Play>");
  });

  it("serves the ringback tone without a token, because Twilio fetches it", async () => {
    const { port } = start("+15551234567");

    const res = await fetch(`${base(port)}/twilio/ringback.wav`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/wav");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/server.call.test.ts`
Expected: FAIL — `/twilio/voice` always returns the phase 1 shape; ringback 404s.

- [ ] **Step 3: Implement**

In `backend/src/server.ts`, add imports and construct presence beside `currentCall`:

```ts
import { CallPresence } from "./callPresence";
import { CallAudioBuffer } from "./callAudioBuffer";
import { CallUplink } from "./callUplink";
import { ringbackWav } from "./ringback";
import { ringbackResponse, connectStreamResponse } from "./twiml";
```

```ts
  const currentCall = new CurrentCall();
  const presence = new CallPresence();
  const downlink = new CallAudioBuffer();
  const uplink = new CallUplink();
```

Thread `presence`, `downlink` and `uplink` through `handleRequest` and the upgrade handler exactly as `currentCall` already is, and pass `downlink`/`uplink` to `handleTwilioStream`.

Add `waitAttempts` to `StartServerOptions`:

```ts
  /** How many ringback rounds before falling back. Defaults to 5 (~20s). */
  waitAttempts?: number;
```

Serve the tone, before the token-guarded routes — Twilio fetches it with no credentials:

```ts
  // Twilio fetches this itself, with no token, so it must be open. It carries
  // no information beyond a ringing sound.
  if (req.method === "GET" && url.pathname === "/twilio/ringback.wav") {
    const wav = ringbackWav();
    res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
    res.end(wav);
    return;
  }
```

Replace the body of the `/twilio/voice` route after its 401/503 guards:

```ts
    const host = req.headers.host ?? "";
    const encoded = encodeURIComponent(token ?? "");
    const attempt = Number(url.searchParams.get("attempt") ?? "1") || 1;
    const budget = opts.waitAttempts ?? 5;

    res.writeHead(200, { "content-type": "text/xml" });

    if (presence.isPresent()) {
      res.end(connectStreamResponse({
        streamUrl: `wss://${host}${TWILIO_STREAM_PREFIX}${encoded}`,
        streamStatusUrl: `https://${host}/twilio/stream-status?token=${encoded}`,
      }));
      return;
    }

    if (attempt < budget) {
      res.end(ringbackResponse({
        ringbackUrl: `https://${host}/twilio/ringback.wav`,
        nextUrl: `https://${host}/twilio/voice?token=${encoded}&attempt=${attempt + 1}`,
      }));
      return;
    }

    // Out of patience: ring the second line, whose carrier voicemail catches it.
    res.end(voiceResponse({
      streamUrl: `wss://${host}${TWILIO_STREAM_PREFIX}${encoded}`,
      dialTo: opts.callForwardTo,
    }));
```

In the `GET /v1/call` route, mark presence immediately after the token check:

```ts
    // Polling is how the watch says it is here; the ringing decision reads it.
    presence.mark();
```

Finally, delete the `console.log("twilio upgrade rejected: …")` line added while debugging phase 1.

- [ ] **Step 4: Run the full suite**

Run: `cd backend && npx tsc --noEmit && npx vitest run`
Expected: PASS. Phase 1's `/twilio/voice` test asserted the `<Start>`+`<Dial>` shape; it now describes the fallback branch, so update it to request `?attempt=99`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts backend/src/server.call.test.ts
git commit -m "feat(relay): ring, connect, or fall back on an inbound call"
```

---

### Task 9: Audio routes

**Files:**
- Modify: `backend/src/server.ts`
- Test: `backend/src/server.call.test.ts`

**Interfaces:**
- Consumes: `CallAudioBuffer`, `CallUplink`, `pcm16kToMuLaw8k` (Task 1)
- Produces: `GET /v1/call/audio?since=N&token=…` → μ-law body with an `X-Seq` header; `POST /v1/call/audio?token=…` → 204, or 409 when no call is live

- [ ] **Step 1: Write the failing test**

Append to `backend/src/server.call.test.ts`:

```ts
describe("call audio", () => {
  it("serves nothing but a cursor when there is no audio", async () => {
    const { port } = start("+15551234567");

    const res = await fetch(`${base(port)}/v1/call/audio?token=good&since=0`);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-seq")).toBe("0");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("rejects audio requests without a valid token", async () => {
    const { port } = start("+15551234567");
    expect((await fetch(`${base(port)}/v1/call/audio`)).status).toBe(401);
    expect((await fetch(`${base(port)}/v1/call/audio?token=bad`, { method: "POST" })).status)
      .toBe(401);
  });

  // Nothing to speak into: better a clear refusal than silently dropping it.
  it("409s uplink audio when no call is live", async () => {
    const { port } = start("+15551234567");

    const res = await fetch(`${base(port)}/v1/call/audio?token=good`, {
      method: "POST",
      body: Buffer.alloc(800),
    });

    expect(res.status).toBe(409);
  });

  it("carries the caller's audio through to the watch", async () => {
    const { providers, port } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/good`);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start", streamSid: "MZa", start: { callSid: "CAa", streamSid: "MZa" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    ws.send(JSON.stringify({
      event: "media", media: { payload: Buffer.from([0xff, 0xfe]).toString("base64") },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await fetch(`${base(port)}/v1/call/audio?token=good&since=0`);

    expect([...Buffer.from(await res.arrayBuffer())]).toEqual([0xff, 0xfe]);
    expect(Number(res.headers.get("x-seq"))).toBeGreaterThan(0);
    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/server.call.test.ts`
Expected: FAIL — `/v1/call/audio` 404s.

- [ ] **Step 3: Implement**

Add to `handleRequest` in `backend/src/server.ts`, before the `/v1/call` route so the longer path matches first:

```ts
  // The caller's audio, for the watch to play. Binary rather than base64 in
  // JSON: a third less data on the link that is already the bottleneck.
  if (req.method === "GET" && url.pathname === "/v1/call/audio") {
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    const since = Number(url.searchParams.get("since") ?? "0") || 0;
    const { audio, seq } = downlink.drain(since);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": audio.length,
      "x-seq": String(seq),
    });
    res.end(audio);
    return;
  }

  // Your voice, while push-to-talk is held. 16 kHz Int16 in, mu-law 8 kHz out.
  if (req.method === "POST" && url.pathname === "/v1/call/audio") {
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    let body: Buffer = Buffer.from("");
    try {
      body = await readBody(req, MAX_AUDIO_BYTES);
    } catch {
      sendJSON(res, 413, { error: "body too large" });
      return;
    }
    if (!uplink.write(pcm16kToMuLaw8k(body))) {
      sendJSON(res, 409, { error: "no call is live" });
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }
```

Add the import:

```ts
import { pcm16kToMuLaw8k } from "./mulaw";
```

- [ ] **Step 4: Run the full suite**

Run: `cd backend && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts backend/src/server.call.test.ts
git commit -m "feat(relay): audio routes for the watch to hear and speak"
```

---

### Task 10: μ-law decoding on the watch

**Files:**
- Create: `watch/CaptionCore/Sources/CaptionCore/MuLaw.swift`
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/MuLawTests.swift`

**Interfaces:**
- Consumes: nothing
- Produces: `public enum MuLaw { public static func decode(_ data: Data) -> [Int16] }`

- [ ] **Step 1: Write the failing test**

```swift
// watch/CaptionCore/Tests/CaptionCoreTests/MuLawTests.swift
import XCTest
@testable import CaptionCore

final class MuLawTests: XCTestCase {
    func testDecodesOneSamplePerByte() {
        XCTAssertEqual(MuLaw.decode(Data([0xFF, 0xFF, 0xFF])).count, 3)
    }

    /// 0xFF is mu-law zero. Decoding it as anything else is an audible hiss
    /// under everything the caller says.
    func testSilenceDecodesToZero() {
        XCTAssertEqual(MuLaw.decode(Data([0xFF])), [0])
    }

    /// Must match the relay's encoder exactly, or every call is distorted.
    func testKnownValuesMatchTheRelaysTable() {
        XCTAssertEqual(MuLaw.decode(Data([0x00])), [-32124])
        XCTAssertEqual(MuLaw.decode(Data([0x80])), [32124])
        XCTAssertEqual(MuLaw.decode(Data([0x7F])), [0])
    }

    func testEmptyInputDecodesToNothing() {
        XCTAssertEqual(MuLaw.decode(Data()), [])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd watch/CaptionCore && swift test --filter MuLawTests`
Expected: FAIL — `MuLaw` not in scope.

- [ ] **Step 3: Implement**

```swift
// watch/CaptionCore/Sources/CaptionCore/MuLaw.swift
import Foundation

/// Decodes G.711 μ-law, the format telephony audio arrives in.
///
/// Mirrors the relay's encoder exactly. The two must agree sample for sample:
/// a mismatched table is not a decode failure, it is a call that sounds wrong.
public enum MuLaw {
    private static let bias: Int32 = 0x84

    public static func decode(_ data: Data) -> [Int16] {
        data.map { byte in
            let u = Int32(~byte)
            let sign = u & 0x80
            let exponent = (u >> 4) & 0x07
            let mantissa = u & 0x0F
            let magnitude = (((mantissa << 3) + bias) << exponent) - bias
            return Int16(clamping: sign != 0 ? -magnitude : magnitude)
        }
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cd watch/CaptionCore && swift test`
Expected: PASS, including the existing tests.

- [ ] **Step 5: Commit**

```bash
git add watch/CaptionCore/Sources/CaptionCore/MuLaw.swift watch/CaptionCore/Tests/CaptionCoreTests/MuLawTests.swift
git commit -m "feat(watch): decode mu-law telephony audio"
```

---

### Task 11: Downlink polling and jitter policy

**Files:**
- Create: `watch/CaptionCore/Sources/CaptionCore/CallAudio.swift`
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/CallAudioTests.swift`

**Interfaces:**
- Consumes: `MuLaw.decode` (Task 10)
- Produces: `public struct AudioChunk { public let samples: [Int16]; public let seq: Int }`; `public protocol CallAudioClient: Sendable { func fetch(since: Int) async throws -> AudioChunk }`; `@MainActor public final class CallAudio` with `init(client:onSamples:)`, `func poll() async`, `func reset()`, `static let prerollChunks: Int`

- [ ] **Step 1: Write the failing test**

```swift
// watch/CaptionCore/Tests/CaptionCoreTests/CallAudioTests.swift
import XCTest
@testable import CaptionCore

private final class FakeAudioClient: CallAudioClient, @unchecked Sendable {
    var chunks: [AudioChunk] = []
    var error: Error?
    private(set) var asked: [Int] = []

    func fetch(since: Int) async throws -> AudioChunk {
        asked.append(since)
        if let error { throw error }
        return chunks.isEmpty ? AudioChunk(samples: [], seq: since) : chunks.removeFirst()
    }
}

@MainActor
final class CallAudioTests: XCTestCase {
    private func make(_ client: FakeAudioClient) -> (CallAudio, () -> [[Int16]]) {
        var played: [[Int16]] = []
        let audio = CallAudio(client: client) { played.append($0) }
        return (audio, { played })
    }

    func testHandsDecodedSamplesToThePlayer() async {
        let client = FakeAudioClient()
        client.chunks = [AudioChunk(samples: [1, 2, 3], seq: 4)]
        let (audio, played) = make(client)

        await audio.poll()

        XCTAssertEqual(played(), [[1, 2, 3]])
    }

    func testAdvancesTheCursorSoAudioArrivesOnce() async {
        let client = FakeAudioClient()
        client.chunks = [AudioChunk(samples: [1], seq: 7)]
        let (audio, _) = make(client)

        await audio.poll()
        await audio.poll()

        XCTAssertEqual(client.asked, [0, 7])
    }

    /// A dropped poll is a gap in playback, not the end of the call.
    func testAFailedFetchDoesNotAdvanceTheCursor() async {
        let client = FakeAudioClient()
        client.error = HistoryError.message("offline")
        let (audio, played) = make(client)

        await audio.poll()
        await audio.poll()

        XCTAssertEqual(client.asked, [0, 0])
        XCTAssertEqual(played().count, 0)
    }

    func testAnEmptyChunkPlaysNothing() async {
        let client = FakeAudioClient()
        client.chunks = [AudioChunk(samples: [], seq: 3)]
        let (audio, played) = make(client)

        await audio.poll()

        XCTAssertEqual(played().count, 0)
    }

    /// A new call must not resume from the previous call's cursor, or its
    /// first seconds are skipped as already-heard.
    func testResetReturnsTheCursorToTheStart() async {
        let client = FakeAudioClient()
        client.chunks = [AudioChunk(samples: [1], seq: 9)]
        let (audio, _) = make(client)
        await audio.poll()

        audio.reset()
        await audio.poll()

        XCTAssertEqual(client.asked, [0, 0])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd watch/CaptionCore && swift test --filter CallAudioTests`
Expected: FAIL — `CallAudio` not in scope.

- [ ] **Step 3: Implement**

```swift
// watch/CaptionCore/Sources/CaptionCore/CallAudio.swift
import Foundation

/// One poll's worth of the caller's audio.
public struct AudioChunk: Equatable, Sendable {
    public let samples: [Int16]
    public let seq: Int

    public init(samples: [Int16], seq: Int) {
        self.samples = samples
        self.seq = seq
    }
}

/// Fetches the caller's audio from the relay.
public protocol CallAudioClient: Sendable {
    func fetch(since: Int) async throws -> AudioChunk
}

/// Polls the caller's audio and hands it to a player.
///
/// Owns the cursor and the failure policy, so the player only ever deals in
/// samples. A failed fetch deliberately leaves the cursor where it is: the
/// audio it would have carried is gone either way, and advancing past it would
/// also skip whatever arrived alongside.
@MainActor
public final class CallAudio {
    /// How many polls to collect before playback starts. One second of buffer
    /// against a link that batches roughly every second.
    public static let prerollChunks = 1

    private let client: CallAudioClient
    private let onSamples: ([Int16]) -> Void
    private var seq = 0

    public init(client: CallAudioClient, onSamples: @escaping ([Int16]) -> Void) {
        self.client = client
        self.onSamples = onSamples
    }

    /// Start a new call's audio from the beginning.
    public func reset() {
        seq = 0
    }

    public func poll() async {
        guard let chunk = try? await client.fetch(since: seq) else { return }
        seq = max(seq, chunk.seq)
        guard !chunk.samples.isEmpty else { return }
        onSamples(chunk.samples)
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cd watch/CaptionCore && swift test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add watch/CaptionCore/Sources/CaptionCore/CallAudio.swift watch/CaptionCore/Tests/CaptionCoreTests/CallAudioTests.swift
git commit -m "feat(watch): poll the caller's audio for playback"
```

---

### Task 12: Push-to-talk batching

**Files:**
- Create: `watch/CaptionCore/Sources/CaptionCore/CallVoice.swift`
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/CallVoiceTests.swift`

**Interfaces:**
- Consumes: nothing
- Produces: `public protocol CallVoiceClient: Sendable { func send(_ pcm: Data) async throws }`; `@MainActor public final class CallVoice` with `init(client:)`, `@Published private(set) var isTalking: Bool`, `func beginTalking()`, `func endTalking() async`, `func capture(_ pcm: Data)`

- [ ] **Step 1: Write the failing test**

```swift
// watch/CaptionCore/Tests/CaptionCoreTests/CallVoiceTests.swift
import XCTest
@testable import CaptionCore

private final class FakeVoiceClient: CallVoiceClient, @unchecked Sendable {
    private(set) var sent: [Data] = []
    var error: Error?

    func send(_ pcm: Data) async throws {
        if let error { throw error }
        sent.append(pcm)
    }
}

@MainActor
final class CallVoiceTests: XCTestCase {
    /// Audio captured while not talking is the room, not you. Sending it would
    /// put whatever is around you onto the call.
    func testDiscardsAudioCapturedWhileNotTalking() async {
        let client = FakeVoiceClient()
        let voice = CallVoice(client: client)

        voice.capture(Data([1, 2]))
        await voice.endTalking()

        XCTAssertEqual(client.sent.count, 0)
    }

    func testSendsWhatWasCapturedWhileTalking() async {
        let client = FakeVoiceClient()
        let voice = CallVoice(client: client)

        voice.beginTalking()
        voice.capture(Data([1, 2]))
        voice.capture(Data([3, 4]))
        await voice.endTalking()

        XCTAssertEqual(client.sent, [Data([1, 2, 3, 4])])
    }

    func testReportsWhetherYouAreTalking() async {
        let voice = CallVoice(client: FakeVoiceClient())

        XCTAssertFalse(voice.isTalking)
        voice.beginTalking()
        XCTAssertTrue(voice.isTalking)
        await voice.endTalking()
        XCTAssertFalse(voice.isTalking)
    }

    /// A failed send must still release the button, or the UI shows you as
    /// talking forever.
    func testStopsTalkingEvenWhenTheSendFails() async {
        let client = FakeVoiceClient()
        client.error = HistoryError.message("offline")
        let voice = CallVoice(client: client)

        voice.beginTalking()
        voice.capture(Data([1]))
        await voice.endTalking()

        XCTAssertFalse(voice.isTalking)
    }

    func testASecondTurnDoesNotResendTheFirst() async {
        let client = FakeVoiceClient()
        let voice = CallVoice(client: client)
        voice.beginTalking()
        voice.capture(Data([1]))
        await voice.endTalking()

        voice.beginTalking()
        voice.capture(Data([2]))
        await voice.endTalking()

        XCTAssertEqual(client.sent, [Data([1]), Data([2])])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd watch/CaptionCore && swift test --filter CallVoiceTests`
Expected: FAIL — `CallVoice` not in scope.

- [ ] **Step 3: Implement**

```swift
// watch/CaptionCore/Sources/CaptionCore/CallVoice.swift
import Combine
import Foundation

/// Sends your voice to the relay.
public protocol CallVoiceClient: Sendable {
    func send(_ pcm: Data) async throws
}

/// Push-to-talk: collects microphone audio only while the control is held, and
/// sends it as one turn when released.
///
/// The mic keeps running throughout — starting and stopping capture per turn
/// would clip the first word — so anything captured outside a turn is dropped
/// here rather than transmitted. That is also what keeps the room off the call.
@MainActor
public final class CallVoice: ObservableObject {
    @Published public private(set) var isTalking = false

    private let client: CallVoiceClient
    private var turn = Data()

    public init(client: CallVoiceClient) {
        self.client = client
    }

    public func beginTalking() {
        turn = Data()
        isTalking = true
    }

    /// Offer captured audio. Kept only while a turn is open.
    public func capture(_ pcm: Data) {
        guard isTalking else { return }
        turn.append(pcm)
    }

    /// Close the turn and send it. Releasing always stops the talking state,
    /// even when the send fails — otherwise the UI claims you are still
    /// speaking into a call that never heard you.
    public func endTalking() async {
        guard isTalking else { return }
        isTalking = false
        let outgoing = turn
        turn = Data()
        guard !outgoing.isEmpty else { return }
        try? await client.send(outgoing)
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cd watch/CaptionCore && swift test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add watch/CaptionCore/Sources/CaptionCore/CallVoice.swift watch/CaptionCore/Tests/CaptionCoreTests/CallVoiceTests.swift
git commit -m "feat(watch): push-to-talk turns, with the room left off the call"
```

---

### Task 13: Audio client and player

**Files:**
- Create: `watch/WatchCaptions/RelayCallAudioClient.swift`
- Create: `watch/WatchCaptions/CallAudioPlayer.swift`

**Interfaces:**
- Consumes: `CallAudioClient`, `CallVoiceClient`, `AudioChunk`, `MuLaw.decode`
- Produces: `struct RelayCallAudioClient: CallAudioClient, CallVoiceClient`; `final class CallAudioPlayer` with `start() throws`, `stop()`, `play(_ samples: [Int16])`, `var isMuted: Bool`

- [ ] **Step 1: Create the client**

```swift
// watch/WatchCaptions/RelayCallAudioClient.swift
import Foundation
import CaptionCore

/// The relay's call-audio endpoints. Binary bodies rather than base64 in JSON:
/// a third less data on a link that is already the bottleneck.
struct RelayCallAudioClient: CallAudioClient, CallVoiceClient {
    let base: URL
    let token: String

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        // Audio is worthless late; failing fast and polling again beats waiting.
        config.timeoutIntervalForRequest = 5
        return URLSession(configuration: config)
    }()

    func fetch(since: Int) async throws -> AudioChunk {
        var components = URLComponents(
            url: base.appendingPathComponent("v1/call/audio"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "since", value: String(since)),
        ]
        let (data, response) = try await Self.session.data(from: components.url!)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw HistoryError.message("Relay error")
        }
        let seq = Int(http.value(forHTTPHeaderField: "X-Seq") ?? "") ?? since
        return AudioChunk(samples: MuLaw.decode(data), seq: seq)
    }

    func send(_ pcm: Data) async throws {
        var components = URLComponents(
            url: base.appendingPathComponent("v1/call/audio"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = pcm
        let (_, response) = try await Self.session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 204 else {
            throw HistoryError.message("Relay error")
        }
    }
}
```

- [ ] **Step 2: Create the player**

```swift
// watch/WatchCaptions/CallAudioPlayer.swift
import AVFoundation
import CaptionCore

/// Plays the caller's audio as it arrives.
///
/// Audio comes in roughly one-second batches over HTTP, so this schedules each
/// batch onto a player node as it lands rather than trying to keep a smooth
/// clock. Gaps are audible and expected — that is the cost of a transport that
/// cannot hold a socket open.
final class CallAudioPlayer {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    /// Telephony audio, matching what the relay forwards.
    private let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 8_000, channels: 1, interleaved: true)!
    private var converter = PCMConverter()

    /// Silences playback while you talk, so the speaker never feeds the mic.
    var isMuted = false

    /// Microphone audio, as 16 kHz Int16 — the format the relay expects.
    /// Delivered continuously; `CallVoice` decides what belongs to a turn.
    var onCapturedPCM: ((Data) -> Void)?

    /// One engine owns both directions. Capture cannot live in `AudioCapture`
    /// alongside this: that class activates the session as `.record` with
    /// `.measurement`, which would fight the `.playAndRecord`/`.voiceChat`
    /// configuration playback needs and silence one side or the other.
    func start() throws {
        let session = AVAudioSession.sharedInstance()
        // Playback and capture coexist for the whole call rather than
        // renegotiating per turn, which would clip the start of each one.
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker])
        try session.setActive(true)

        converter = PCMConverter()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)

        // `format: nil` taps the bus as it is actually running — the lesson
        // from the blank-captions bug, where a snapshot taken here was stale.
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1_600, format: nil) { [weak self] buffer, _ in
            guard let self, let pcm = self.converter.convert(buffer), !pcm.isEmpty else { return }
            self.onCapturedPCM?(pcm)
        }

        engine.prepare()
        try engine.start()
        player.play()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    func play(_ samples: [Int16]) {
        guard !isMuted, !samples.isEmpty, engine.isRunning else { return }
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        guard let channel = buffer.int16ChannelData else { return }
        samples.withUnsafeBufferPointer { source in
            channel[0].update(from: source.baseAddress!, count: samples.count)
        }
        player.scheduleBuffer(buffer, completionHandler: nil)
    }
}
```

- [ ] **Step 3: Regenerate and build**

Run:
```bash
cd watch && xcodegen generate && xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,id=7BB5A7C6-2524-450C-9CCD-050E35F530C5' build
```
Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**

```bash
git add watch/WatchCaptions/RelayCallAudioClient.swift watch/WatchCaptions/CallAudioPlayer.swift
git commit -m "feat(watch): call audio client and speaker playback"
```

---

### Task 14: Take a call

**Files:**
- Modify: `watch/WatchCaptions/AppModel.swift`
- Modify: `watch/WatchCaptions/WatchCaptionsApp.swift`
- Modify: `watch/WatchCaptions/Views/HomeView.swift`
- Modify: `watch/WatchCaptions/Views/CaptionView.swift`

**Interfaces:**
- Consumes: `CallAudio`, `CallVoice`, `CallAudioPlayer`, `RelayCallAudioClient`, `CaptionIndicator`
- Produces: `AppModel.takeCall()`, `AppModel.endCall()`, `AppModel.callVoice`, `Route.call` reused for waiting and connected alike

- [ ] **Step 1: Wire the model**

In `AppModel`, add beside the existing call properties:

```swift
    /// Push-to-talk state for the call on screen.
    let callVoice: CallVoice
    private let callAudio: CallAudio
    private let audioPlayer = CallAudioPlayer()
    private var callAudioTask: Task<Void, Never>?
```

In `init`, after `callCaptions` is created:

```swift
        let audioClient = RelayCallAudioClient(base: base, token: Secrets.authToken)
        let voice = CallVoice(client: audioClient)
        callVoice = voice
        let player = audioPlayer
        callAudio = CallAudio(client: audioClient) { [player] samples in player.play(samples) }
        // The mic runs for the whole call; CallVoice keeps only what falls
        // inside a push-to-talk turn and discards the rest, so the room never
        // reaches the caller.
        audioPlayer.onCapturedPCM = { [voice] pcm in
            Task { @MainActor in voice.capture(pcm) }
        }
```

Add the actions:

```swift
    /// Wait for a call. Polling is what tells the relay the watch is here, so
    /// this both shows the waiting screen and makes the call reachable.
    func takeCall() {
        path = [.call]
        callCaptions.start()
        callAudio.reset()
        try? audioPlayer.start()
        callAudioTask?.cancel()
        callAudioTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.callAudio.poll()
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    /// Open a turn. Playback mutes for its duration: push-to-talk already
    /// means the speaker is idle while the mic is open, and muting makes that
    /// true even if a buffer was still draining.
    func beginTalking() {
        audioPlayer.isMuted = true
        callVoice.beginTalking()
    }

    func endTalking() async {
        await callVoice.endTalking()
        audioPlayer.isMuted = false
    }

    /// Leave the call. Closing the stream is what ends it — Twilio holds the
    /// call for exactly as long as the socket lives.
    func endCall() {
        callAudioTask?.cancel()
        callAudioTask = nil
        audioPlayer.stop()
        callCaptions.stop()
        path = []
    }
```

Replace `leaveCall()`'s body with a call to `endCall()`, so backing out and tapping End behave identically.

- [ ] **Step 2: Add the menu row**

In `HomeView`, add a row above Transcripts:

```swift
            Button(action: onTakeCall) {
                Label("Take call", systemImage: "phone.badge.waveform")
            }
```

Add `let onTakeCall: () -> Void` to `HomeView`, and pass `{ model.takeCall() }` from `RootView`.

- [ ] **Step 3: Make the captions screen talk**

In `CaptionView`, add push-to-talk to the caption area. Add two properties:

```swift
    /// Present only on a call; nil elsewhere leaves the view exactly as it was.
    var onTalkChanged: ((Bool) -> Void)?
    var isTalking = false
```

and attach the gesture to the existing `ScrollView`, after `.defaultScrollAnchor(.bottom)`:

```swift
        .gesture(
            // The whole caption area is the talk target: it keeps captions
            // full-size on a screen where space is the binding constraint, and
            // scrolling is the Digital Crown so touch is otherwise unused.
            DragGesture(minimumDistance: 0)
                .onChanged { _ in if !isTalking { onTalkChanged?(true) } }
                .onEnded { _ in onTalkChanged?(false) },
            isEnabled: onTalkChanged != nil)
        .overlay(alignment: .bottom) {
            if isTalking {
                // A stray press must be visible, not silent.
                Label("Talking", systemImage: "mic.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(.red, in: Capsule())
            }
        }
```

- [ ] **Step 4: Render the call**

In `WatchCaptionsApp`'s `call` view, pass the talk handlers and mute playback while talking:

```swift
                        CaptionView(
                            store: store,
                            indicator: callCaptions.ended.map(CaptionIndicator.callEnded) ?? .call,
                            onStop: { model.endCall() },
                            onTalkChanged: { talking in
                                Task {
                                    if talking { model.beginTalking() }
                                    else { await model.endTalking() }
                                }
                            },
                            isTalking: model.callVoice.isTalking)
```

Observe `model.callVoice` in `RootView` so the indicator updates, and give `CaptionView`'s existing call site `onTalkChanged: nil` so the microphone-session screen is unchanged.

- [ ] **Step 5: Regenerate, build, and run every suite**

Run:
```bash
cd watch && xcodegen generate && xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,id=7BB5A7C6-2524-450C-9CCD-050E35F530C5' build
cd ../CaptionCore && swift test
cd ../../backend && npx tsc --noEmit && npx vitest run
cd ../mac && xcodebuild -project Captions.xcodeproj -scheme Captions -destination 'platform=macOS' build
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add watch/WatchCaptions
git commit -m "feat(watch): take a call, hear it, and talk back"
```

---

## Manual verification

Automated tests contain neither Twilio nor Deepgram. One real call verifies the path.

1. `fly secrets set TWILIO_FORWARD_TO=<second line>` and deploy.
2. **Verify background audio first.** Start a call, open Captions, and lower your wrist. If playback stops, `UIBackgroundModes: audio` is not holding the app and the rest is moot — fix that before anything else.
3. Tap **Take call** on the watch, then have someone dial the Twilio number. You should hear ringback, then the stream connects and captions appear.
4. Press and hold the captions to talk. Confirm the caller hears you, and that they do **not** hear themselves echoed back.
5. Measure the gap the caller experiences between finishing a sentence and hearing your reply. **This is the number that decides whether phase 2b is worth building.**
6. Let a call ring out without tapping Take call. Confirm it falls back to the second line after ~20s.

## Out of scope

Per the spec: the ring (phase 2b push notifications), Twilio signature validation, multiple concurrent calls, and hearing the caller through your hearing aids — the phone is not in the call.
