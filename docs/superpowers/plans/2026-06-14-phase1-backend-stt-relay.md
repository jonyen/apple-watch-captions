# Phase 1 Backend — Live-Mode STT Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js WebSocket service that accepts a live audio stream from an authenticated client, relays it to Deepgram for real-time speech-to-text, and streams caption text back to the client.

**Architecture:** A small TypeScript service. A `WebSocketServer` authenticates each connection by token, then creates a `CaptionSession` that wires a `TranscriptionProvider` (Deepgram in production, a fake in tests) to the client socket. Audio bytes flow client→provider; transcripts flow provider→client as JSON caption messages. All core logic is provider-agnostic and unit-tested with a fake; the Deepgram adapter is the only piece needing a real API key.

**Tech Stack:** Node.js 20+, TypeScript, `ws` (WebSocket), `@deepgram/sdk` (real-time STT), `vitest` (tests).

**Audio/protocol contract (referenced by all tasks):**
- Client connects to `ws://<host>:<port>/stream?token=<AUTH_TOKEN>`.
- Client sends **binary** frames of raw PCM: **16-bit signed little-endian, 16 kHz, mono** (`linear16`).
- Server sends **text** JSON messages to the client:
  - `{"type":"ready"}` once the provider is connected.
  - `{"type":"caption","text":"...","isFinal":true|false}` per transcript.
  - `{"type":"error","message":"..."}` on failure.

---

### Task 1: Project scaffold

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/vitest.config.ts`
- Create: `backend/.gitignore`
- Create: `backend/src/index.ts` (placeholder)

- [ ] **Step 1: Create `backend/package.json`**

```json
{
  "name": "watch-captions-backend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@deepgram/sdk": "^3.9.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.12",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `backend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `backend/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create `backend/.gitignore`**

```
node_modules/
dist/
.env
```

- [ ] **Step 5: Create placeholder `backend/src/index.ts`**

```typescript
// Entry point is implemented in Task 7.
export {};
```

- [ ] **Step 6: Install dependencies**

Run: `cd backend && npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 7: Verify the test runner works (no tests yet)**

Run: `cd backend && npm test`
Expected: vitest reports "No test files found" and exits 0 (or similar). This confirms the toolchain runs.

- [ ] **Step 8: Commit**

```bash
git add backend/
git commit -m "chore: scaffold backend STT relay project"
```

---

### Task 2: Auth token verification

**Files:**
- Create: `backend/src/auth.ts`
- Test: `backend/src/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// backend/src/auth.test.ts
import { describe, it, expect } from "vitest";
import { verifyToken } from "./auth";

describe("verifyToken", () => {
  it("accepts a matching token", () => {
    expect(verifyToken("secret123", "secret123")).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(verifyToken("wrong", "secret123")).toBe(false);
  });

  it("rejects a missing token", () => {
    expect(verifyToken(undefined, "secret123")).toBe(false);
  });

  it("rejects when no expected token is configured", () => {
    expect(verifyToken("anything", "")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/auth.test.ts`
Expected: FAIL — cannot find module `./auth`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// backend/src/auth.ts

/**
 * Returns true only when a non-empty expected token is configured
 * and the provided token matches it exactly.
 */
export function verifyToken(
  provided: string | undefined,
  expected: string,
): boolean {
  if (!expected) return false;
  return provided === expected;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/auth.test.ts`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth.ts backend/src/auth.test.ts
git commit -m "feat: add auth token verification"
```

---

### Task 3: Transcription provider interface + fake

**Files:**
- Create: `backend/src/transcriptionProvider.ts`
- Create: `backend/src/fakeTranscriptionProvider.ts`
- Test: `backend/src/fakeTranscriptionProvider.test.ts`

- [ ] **Step 1: Define the provider interface**

```typescript
// backend/src/transcriptionProvider.ts

export interface Transcript {
  text: string;
  isFinal: boolean;
}

/**
 * Abstraction over a streaming speech-to-text backend.
 * Implementations: DeepgramTranscriptionProvider (prod), FakeTranscriptionProvider (tests).
 */
export interface TranscriptionProvider {
  /** Register a handler called for each transcript the provider emits. */
  onTranscript(handler: (t: Transcript) => void): void;
  /** Register a handler called once the provider is ready to receive audio. */
  onReady(handler: () => void): void;
  /** Register a handler called on a provider error. */
  onError(handler: (message: string) => void): void;
  /** Feed raw PCM audio bytes to the provider. */
  sendAudio(chunk: Buffer): void;
  /** Close the provider connection. */
  close(): void;
}
```

- [ ] **Step 2: Write the failing test for the fake**

```typescript
// backend/src/fakeTranscriptionProvider.test.ts
import { describe, it, expect } from "vitest";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

describe("FakeTranscriptionProvider", () => {
  it("records audio it receives", () => {
    const p = new FakeTranscriptionProvider();
    p.sendAudio(Buffer.from("abc"));
    p.sendAudio(Buffer.from("de"));
    expect(Buffer.concat(p.receivedAudio).toString()).toBe("abcde");
  });

  it("emits ready when emitReady() is called", () => {
    const p = new FakeTranscriptionProvider();
    let ready = false;
    p.onReady(() => (ready = true));
    p.emitReady();
    expect(ready).toBe(true);
  });

  it("forwards emitted transcripts to the handler", () => {
    const p = new FakeTranscriptionProvider();
    const got: string[] = [];
    p.onTranscript((t) => got.push(`${t.text}:${t.isFinal}`));
    p.emitTranscript({ text: "hello", isFinal: false });
    p.emitTranscript({ text: "hello world", isFinal: true });
    expect(got).toEqual(["hello:false", "hello world:true"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx vitest run src/fakeTranscriptionProvider.test.ts`
Expected: FAIL — cannot find module `./fakeTranscriptionProvider`.

- [ ] **Step 4: Implement the fake**

```typescript
// backend/src/fakeTranscriptionProvider.ts
import { TranscriptionProvider, Transcript } from "./transcriptionProvider";

/**
 * Test double. Records audio and lets tests drive ready/transcript/error events.
 */
export class FakeTranscriptionProvider implements TranscriptionProvider {
  receivedAudio: Buffer[] = [];
  closed = false;

  private transcriptHandler: (t: Transcript) => void = () => {};
  private readyHandler: () => void = () => {};
  private errorHandler: (message: string) => void = () => {};

  onTranscript(handler: (t: Transcript) => void): void {
    this.transcriptHandler = handler;
  }
  onReady(handler: () => void): void {
    this.readyHandler = handler;
  }
  onError(handler: (message: string) => void): void {
    this.errorHandler = handler;
  }
  sendAudio(chunk: Buffer): void {
    this.receivedAudio.push(chunk);
  }
  close(): void {
    this.closed = true;
  }

  // --- test drivers ---
  emitReady(): void {
    this.readyHandler();
  }
  emitTranscript(t: Transcript): void {
    this.transcriptHandler(t);
  }
  emitError(message: string): void {
    this.errorHandler(message);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx vitest run src/fakeTranscriptionProvider.test.ts`
Expected: PASS — 3 tests passing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/transcriptionProvider.ts backend/src/fakeTranscriptionProvider.ts backend/src/fakeTranscriptionProvider.test.ts
git commit -m "feat: add transcription provider interface and fake"
```

---

### Task 4: CaptionSession core logic

**Files:**
- Create: `backend/src/captionSession.ts`
- Test: `backend/src/captionSession.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// backend/src/captionSession.test.ts
import { describe, it, expect } from "vitest";
import { CaptionSession, OutboundMessage } from "./captionSession";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

function setup() {
  const provider = new FakeTranscriptionProvider();
  const sent: OutboundMessage[] = [];
  const session = new CaptionSession(provider, (m) => sent.push(m));
  return { provider, sent, session };
}

describe("CaptionSession", () => {
  it("sends a ready message when the provider is ready", () => {
    const { provider, sent } = setup();
    provider.emitReady();
    expect(sent).toEqual([{ type: "ready" }]);
  });

  it("forwards audio to the provider", () => {
    const { provider, session } = setup();
    session.handleAudio(Buffer.from("pcm"));
    expect(Buffer.concat(provider.receivedAudio).toString()).toBe("pcm");
  });

  it("converts transcripts into caption messages", () => {
    const { provider, sent } = setup();
    provider.emitTranscript({ text: "hi", isFinal: false });
    provider.emitTranscript({ text: "hi there", isFinal: true });
    expect(sent).toEqual([
      { type: "caption", text: "hi", isFinal: false },
      { type: "caption", text: "hi there", isFinal: true },
    ]);
  });

  it("drops empty transcripts", () => {
    const { provider, sent } = setup();
    provider.emitTranscript({ text: "", isFinal: false });
    expect(sent).toEqual([]);
  });

  it("sends an error message on provider error", () => {
    const { provider, sent } = setup();
    provider.emitError("boom");
    expect(sent).toEqual([{ type: "error", message: "boom" }]);
  });

  it("closes the provider when closed", () => {
    const { provider, session } = setup();
    session.close();
    expect(provider.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/captionSession.test.ts`
Expected: FAIL — cannot find module `./captionSession`.

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/captionSession.ts
import { TranscriptionProvider } from "./transcriptionProvider";

export type OutboundMessage =
  | { type: "ready" }
  | { type: "caption"; text: string; isFinal: boolean }
  | { type: "error"; message: string };

/**
 * Wires a TranscriptionProvider to a client send-callback.
 * Provider-agnostic: all production wiring lives in server.ts.
 */
export class CaptionSession {
  constructor(
    private provider: TranscriptionProvider,
    private send: (message: OutboundMessage) => void,
  ) {
    this.provider.onReady(() => this.send({ type: "ready" }));
    this.provider.onTranscript((t) => {
      if (t.text.length === 0) return;
      this.send({ type: "caption", text: t.text, isFinal: t.isFinal });
    });
    this.provider.onError((message) => this.send({ type: "error", message }));
  }

  handleAudio(chunk: Buffer): void {
    this.provider.sendAudio(chunk);
  }

  close(): void {
    this.provider.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/captionSession.test.ts`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/captionSession.ts backend/src/captionSession.test.ts
git commit -m "feat: add CaptionSession core logic"
```

---

### Task 5: WebSocket server wiring (integration-tested with the fake)

**Files:**
- Create: `backend/src/server.ts`
- Test: `backend/src/server.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// backend/src/server.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { AddressInfo } from "net";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

/** Start a server whose providers are fakes the test can capture. */
function startWithFakes(authToken: string) {
  const providers: FakeTranscriptionProvider[] = [];
  const server = startServer({
    port: 0,
    authToken,
    createProvider: () => {
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
  });
  running = server;
  const port = (server.address() as AddressInfo).port;
  return { server, providers, port };
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
}

describe("caption server", () => {
  it("rejects a connection with a bad token", async () => {
    const { port } = startWithFakes("good");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=bad`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
    });
    expect(code).toBe(4001);
  });

  it("relays transcripts from provider to client as caption messages", async () => {
    const { providers, port } = startWithFakes("good");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=good`);
    await new Promise((r) => ws.on("open", r));

    // Provider was created on connection; drive it.
    const provider = providers[0];
    provider.emitReady();
    const ready = await waitForMessage(ws);
    expect(ready).toEqual({ type: "ready" });

    ws.send(Buffer.from("audio-bytes"));
    // Audio reached the provider.
    await new Promise((r) => setTimeout(r, 20));
    expect(Buffer.concat(provider.receivedAudio).toString()).toBe("audio-bytes");

    provider.emitTranscript({ text: "hello world", isFinal: true });
    const caption = await waitForMessage(ws);
    expect(caption).toEqual({ type: "caption", text: "hello world", isFinal: true });

    ws.close();
  });

  it("closes the provider when the client disconnects", async () => {
    const { providers, port } = startWithFakes("good");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=good`);
    await new Promise((r) => ws.on("open", r));
    const provider = providers[0];
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(provider.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/server.test.ts`
Expected: FAIL — cannot find module `./server`.

- [ ] **Step 3: Implement the server**

```typescript
// backend/src/server.ts
import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { verifyToken } from "./auth";
import { CaptionSession, OutboundMessage } from "./captionSession";
import { TranscriptionProvider } from "./transcriptionProvider";

export interface StartServerOptions {
  port: number;
  authToken: string;
  /** Factory for a fresh provider per connection (Deepgram in prod, fake in tests). */
  createProvider: () => TranscriptionProvider;
}

export interface CaptionServer {
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}

export function startServer(opts: StartServerOptions): CaptionServer {
  const http: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/stream") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      // 4001 = application-level "unauthorized" close code.
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(4001, "unauthorized"));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, opts));
  });

  http.listen(opts.port);

  return {
    address: () => http.address(),
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

function handleConnection(ws: WebSocket, opts: StartServerOptions): void {
  const provider = opts.createProvider();
  const send = (message: OutboundMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const session = new CaptionSession(provider, send);

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) session.handleAudio(data);
  });
  ws.on("close", () => session.close());
  ws.on("error", () => session.close());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/server.test.ts`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Run the full suite**

Run: `cd backend && npm test`
Expected: PASS — all tests across all files green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/server.ts backend/src/server.test.ts
git commit -m "feat: add WebSocket caption server wiring"
```

---

### Task 6: Deepgram provider adapter

**Files:**
- Create: `backend/src/deepgramProvider.ts`
- Test: `backend/src/deepgramProvider.test.ts`

This adapter implements `TranscriptionProvider` against the Deepgram SDK. Its event-mapping
logic is unit-tested by injecting a fake Deepgram live-connection object; no network or API key
is needed for the test. A real-key smoke test is described in Task 8.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/src/deepgramProvider.test.ts
import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import { DeepgramProvider, DeepgramLike, LiveConnectionLike } from "./deepgramProvider";

/** Minimal stand-in for a Deepgram live connection. */
class FakeLiveConnection extends EventEmitter implements LiveConnectionLike {
  sent: Buffer[] = [];
  finished = false;
  send(data: Buffer) {
    this.sent.push(data);
  }
  finish() {
    this.finished = true;
  }
  on(event: string, cb: (...args: any[]) => void) {
    super.on(event, cb);
    return this;
  }
}

/** Stand-in for the Deepgram client whose listen.live() returns our fake. */
function fakeDeepgram(conn: FakeLiveConnection): DeepgramLike {
  return { listen: { live: () => conn } };
}

function transcriptPayload(text: string, isFinal: boolean) {
  return { is_final: isFinal, channel: { alternatives: [{ transcript: text }] } };
}

describe("DeepgramProvider", () => {
  it("fires onReady when the connection opens", () => {
    const conn = new FakeLiveConnection();
    const p = new DeepgramProvider(fakeDeepgram(conn));
    let ready = false;
    p.onReady(() => (ready = true));
    conn.emit(LiveTranscriptionEvents.Open);
    expect(ready).toBe(true);
  });

  it("forwards audio to the live connection", () => {
    const conn = new FakeLiveConnection();
    const p = new DeepgramProvider(fakeDeepgram(conn));
    p.sendAudio(Buffer.from("pcm"));
    expect(Buffer.concat(conn.sent).toString()).toBe("pcm");
  });

  it("maps Deepgram results to transcripts", () => {
    const conn = new FakeLiveConnection();
    const p = new DeepgramProvider(fakeDeepgram(conn));
    const got: string[] = [];
    p.onTranscript((t) => got.push(`${t.text}:${t.isFinal}`));
    conn.emit(LiveTranscriptionEvents.Transcript, transcriptPayload("hello", false));
    conn.emit(LiveTranscriptionEvents.Transcript, transcriptPayload("hello world", true));
    expect(got).toEqual(["hello:false", "hello world:true"]);
  });

  it("maps Deepgram errors to onError", () => {
    const conn = new FakeLiveConnection();
    const p = new DeepgramProvider(fakeDeepgram(conn));
    let msg = "";
    p.onError((m) => (msg = m));
    conn.emit(LiveTranscriptionEvents.Error, { message: "bad audio" });
    expect(msg).toBe("bad audio");
  });

  it("finishes the connection on close", () => {
    const conn = new FakeLiveConnection();
    const p = new DeepgramProvider(fakeDeepgram(conn));
    p.close();
    expect(conn.finished).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/deepgramProvider.test.ts`
Expected: FAIL — cannot find module `./deepgramProvider`.

- [ ] **Step 3: Implement the adapter**

```typescript
// backend/src/deepgramProvider.ts
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import { TranscriptionProvider, Transcript } from "./transcriptionProvider";

/** Subset of the Deepgram live connection we depend on (keeps it testable). */
export interface LiveConnectionLike {
  send(data: Buffer): void;
  finish(): void;
  on(event: string, cb: (...args: any[]) => void): unknown;
}

/** Subset of the Deepgram client we depend on. */
export interface DeepgramLike {
  listen: {
    live(options?: Record<string, unknown>): LiveConnectionLike;
  };
}

export const DEEPGRAM_LIVE_OPTIONS = {
  model: "nova-2",
  encoding: "linear16",
  sample_rate: 16000,
  channels: 1,
  interim_results: true,
  punctuate: true,
};

export class DeepgramProvider implements TranscriptionProvider {
  private conn: LiveConnectionLike;
  private transcriptHandler: (t: Transcript) => void = () => {};
  private readyHandler: () => void = () => {};
  private errorHandler: (message: string) => void = () => {};

  constructor(deepgram: DeepgramLike) {
    this.conn = deepgram.listen.live(DEEPGRAM_LIVE_OPTIONS);
    this.conn.on(LiveTranscriptionEvents.Open, () => this.readyHandler());
    this.conn.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const text: string =
        data?.channel?.alternatives?.[0]?.transcript ?? "";
      this.transcriptHandler({ text, isFinal: Boolean(data?.is_final) });
    });
    this.conn.on(LiveTranscriptionEvents.Error, (err: any) => {
      this.errorHandler(err?.message ?? "deepgram error");
    });
  }

  onTranscript(handler: (t: Transcript) => void): void {
    this.transcriptHandler = handler;
  }
  onReady(handler: () => void): void {
    this.readyHandler = handler;
  }
  onError(handler: (message: string) => void): void {
    this.errorHandler = handler;
  }
  sendAudio(chunk: Buffer): void {
    this.conn.send(chunk);
  }
  close(): void {
    this.conn.finish();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/deepgramProvider.test.ts`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/deepgramProvider.ts backend/src/deepgramProvider.test.ts
git commit -m "feat: add Deepgram transcription provider adapter"
```

---

### Task 7: Config + entry point

**Files:**
- Create: `backend/src/config.ts`
- Test: `backend/src/config.test.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Write the failing config test**

```typescript
// backend/src/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("reads values from the environment", () => {
    const cfg = loadConfig({
      PORT: "8080",
      AUTH_TOKEN: "secret",
      DEEPGRAM_API_KEY: "dg-key",
    });
    expect(cfg).toEqual({ port: 8080, authToken: "secret", deepgramApiKey: "dg-key" });
  });

  it("defaults the port to 8080 when unset", () => {
    const cfg = loadConfig({ AUTH_TOKEN: "secret", DEEPGRAM_API_KEY: "dg-key" });
    expect(cfg.port).toBe(8080);
  });

  it("throws when AUTH_TOKEN is missing", () => {
    expect(() => loadConfig({ DEEPGRAM_API_KEY: "dg-key" })).toThrow(/AUTH_TOKEN/);
  });

  it("throws when DEEPGRAM_API_KEY is missing", () => {
    expect(() => loadConfig({ AUTH_TOKEN: "secret" })).toThrow(/DEEPGRAM_API_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/config.test.ts`
Expected: FAIL — cannot find module `./config`.

- [ ] **Step 3: Implement config**

```typescript
// backend/src/config.ts

export interface Config {
  port: number;
  authToken: string;
  deepgramApiKey: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const authToken = env.AUTH_TOKEN;
  if (!authToken) throw new Error("AUTH_TOKEN is required");
  const deepgramApiKey = env.DEEPGRAM_API_KEY;
  if (!deepgramApiKey) throw new Error("DEEPGRAM_API_KEY is required");
  const port = env.PORT ? Number(env.PORT) : 8080;
  return { port, authToken, deepgramApiKey };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/config.test.ts`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Implement the entry point**

```typescript
// backend/src/index.ts
import { createClient } from "@deepgram/sdk";
import { loadConfig } from "./config";
import { startServer } from "./server";
import { DeepgramProvider, DeepgramLike } from "./deepgramProvider";

const config = loadConfig(process.env);
const deepgram = createClient(config.deepgramApiKey) as unknown as DeepgramLike;

const server = startServer({
  port: config.port,
  authToken: config.authToken,
  createProvider: () => new DeepgramProvider(deepgram),
});

const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : config.port;
console.log(`Caption relay listening on ws://0.0.0.0:${port}/stream`);
```

- [ ] **Step 6: Verify it builds**

Run: `cd backend && npm run build`
Expected: `tsc` completes with no errors; `dist/` is produced.

- [ ] **Step 7: Commit**

```bash
git add backend/src/config.ts backend/src/config.test.ts backend/src/index.ts
git commit -m "feat: add config loading and server entry point"
```

---

### Task 8: README with run + manual smoke-test instructions

**Files:**
- Create: `backend/README.md`
- Create: `backend/scripts/smoke-test.mjs`

- [ ] **Step 1: Write the README**

````markdown
# Watch Captions — Backend STT Relay

WebSocket service that relays a live PCM audio stream to Deepgram and streams
caption text back to the client.

## Protocol

- Connect: `ws://<host>:<port>/stream?token=<AUTH_TOKEN>`
- Send: binary frames of raw PCM — 16-bit signed little-endian, 16 kHz, mono.
- Receive (JSON text):
  - `{"type":"ready"}`
  - `{"type":"caption","text":"...","isFinal":true|false}`
  - `{"type":"error","message":"..."}`
- Bad token → connection closed with code `4001`.

## Run

```bash
cd backend
npm install
AUTH_TOKEN=dev-secret DEEPGRAM_API_KEY=<your-key> PORT=8080 npm run dev
```

## Test

```bash
npm test          # full unit/integration suite (no API key needed)
```

## Manual smoke test (needs a real Deepgram key)

Streams a 16 kHz mono PCM file to the running server and prints captions.

1. Start the server (see Run).
2. Create a test PCM file from any audio with ffmpeg:
   ```bash
   ffmpeg -i sample.mp3 -ac 1 -ar 16000 -f s16le sample.pcm
   ```
3. Run the smoke test:
   ```bash
   node scripts/smoke-test.mjs ws://127.0.0.1:8080/stream dev-secret sample.pcm
   ```
   Expected: a stream of `caption` lines ending with finalized text matching the audio.
````

- [ ] **Step 2: Write the smoke-test script**

```javascript
// backend/scripts/smoke-test.mjs
import { WebSocket } from "ws";
import { readFileSync } from "fs";

const [, , urlBase, token, pcmPath] = process.argv;
if (!urlBase || !token || !pcmPath) {
  console.error("usage: node smoke-test.mjs <ws-url> <token> <pcm-file>");
  process.exit(1);
}

const pcm = readFileSync(pcmPath);
const ws = new WebSocket(`${urlBase}?token=${token}`);

ws.on("open", () => {
  // Send in ~32 KB chunks ~ realtime-ish; Deepgram tolerates faster-than-realtime.
  const CHUNK = 3200; // 100ms of 16kHz 16-bit mono
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= pcm.length) {
      clearInterval(timer);
      setTimeout(() => ws.close(), 2000); // allow final transcripts to arrive
      return;
    }
    ws.send(pcm.subarray(offset, offset + CHUNK));
    offset += CHUNK;
  }, 100);
});

ws.on("message", (data) => console.log(data.toString()));
ws.on("close", (code) => {
  console.log("closed", code);
  process.exit(0);
});
ws.on("error", (e) => {
  console.error("error", e.message);
  process.exit(1);
});
```

- [ ] **Step 3: Verify the smoke-test script parses**

Run: `cd backend && node --check scripts/smoke-test.mjs`
Expected: no output, exit 0 (syntax OK). (Full run requires a Deepgram key + PCM file.)

- [ ] **Step 4: Commit**

```bash
git add backend/README.md backend/scripts/smoke-test.mjs
git commit -m "docs: add backend README and manual smoke-test script"
```

---

### Task 9: Final full-suite verification

- [ ] **Step 1: Run the entire test suite**

Run: `cd backend && npm test`
Expected: PASS — all tests from Tasks 2–7 green (auth, fake provider, caption session, server, deepgram provider, config).

- [ ] **Step 2: Verify a clean build**

Run: `cd backend && npm run build`
Expected: no TypeScript errors.

- [ ] **Step 3: Confirm the server boots with env vars**

Run: `cd backend && AUTH_TOKEN=dev DEEPGRAM_API_KEY=fake-key node dist/index.js`
Expected: prints `Caption relay listening on ws://0.0.0.0:8080/stream`. (It will not transcribe without a real key, but it must boot and listen.) Stop with Ctrl-C.

- [ ] **Step 4: Commit any final cleanup**

```bash
git add -A
git commit -m "chore: phase 1 backend complete" --allow-empty
```

---

## Notes for the next plan (watchOS app — separate plan)

The watchOS app will connect to `ws://<host>:<port>/stream?token=<AUTH_TOKEN>`, capture mic
audio via `AVAudioEngine`, convert it to **16 kHz mono 16-bit PCM**, send it as binary frames,
and render incoming `caption` messages (replacing the live line on `isFinal:false`, committing it
on `isFinal:true`). The protocol contract above is the integration boundary.
