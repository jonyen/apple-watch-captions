import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { buildProviderFactory } from "./providerFactory";
import { Config } from "./config";
import { WebSocketLike } from "./appleProvider";
import { ChannelSplitProvider } from "./channelSplitProvider";
import { UnavailableProvider } from "./unavailableProvider";

/** Minimal stand-in for the apple sidecar's WebSocket connection. */
class FakeSocket extends EventEmitter implements WebSocketLike {
  sent: (Buffer | string)[] = [];
  readyState = 0;
  send(data: Buffer | string) {
    this.sent.push(data);
  }
  close() {}
  on(event: string, cb: (...args: any[]) => void) {
    super.on(event, cb);
    return this;
  }
  sentText(): any[] {
    return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d as string));
  }
}

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8080,
    transcriptsDir: "./data/transcripts",
    dbPath: "./data/transcripts/identity.db",
    trustProxyHeaders: false,
    transcriptionProvider: "apple",
    appleTranscriberUrl: "ws://127.0.0.1:8790",
    trainingCaptureMaxBytes: 20 * 1024 * 1024 * 1024,
    ...overrides,
  };
}

function fakeAppleWs() {
  const urls: string[] = [];
  const sockets: FakeSocket[] = [];
  const appleWsFactory = (url: string): WebSocketLike => {
    urls.push(url);
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  return { urls, sockets, appleWsFactory };
}

describe("buildProviderFactory", () => {
  it("builds an Apple provider against the configured sidecar URL with pcm16k", () => {
    const { urls, sockets, appleWsFactory } = fakeAppleWs();
    const createProvider = buildProviderFactory(
      fakeConfig({ appleTranscriberUrl: "ws://127.0.0.1:9999" }),
      { appleWsFactory },
    );
    createProvider({ provider: "apple" });
    expect(urls).toEqual(["ws://127.0.0.1:9999"]);
    sockets[0].emit("open");
    expect(sockets[0].sentText()).toEqual([{ config: { format: "pcm16k" } }]);
  });

  it("wraps dual-channel Apple sessions in a ChannelSplitProvider running two sidecars", () => {
    const { sockets, appleWsFactory } = fakeAppleWs();
    const createProvider = buildProviderFactory(fakeConfig(), { appleWsFactory });
    const provider = createProvider({ provider: "apple", channels: 2 });
    expect(provider).toBeInstanceOf(ChannelSplitProvider);
    expect(sockets).toHaveLength(2);
  });

  it("honors the configured default provider when a session requests none", () => {
    const { sockets, appleWsFactory } = fakeAppleWs();
    const createProvider = buildProviderFactory(fakeConfig({ transcriptionProvider: "apple" }), {
      appleWsFactory,
    });
    createProvider();
    expect(sockets).toHaveLength(1);
  });

  it("lets a session's explicit provider override the relay's configured default", () => {
    const { sockets, appleWsFactory } = fakeAppleWs();
    const createProvider = buildProviderFactory(fakeConfig({ transcriptionProvider: "openai" }), {
      appleWsFactory,
    });
    createProvider({ provider: "apple" });
    expect(sockets).toHaveLength(1);
  });

  // Deepgram is retired (2026-08): the name is still recognized so a session
  // asking for it gets the same clear session error any unconfigured backend
  // gets, rather than a silent fallback — but no key can ever configure it.
  it("always reports deepgram unavailable", () => {
    const { sockets, appleWsFactory } = fakeAppleWs();
    const createProvider = buildProviderFactory(fakeConfig(), { appleWsFactory });
    const provider = createProvider({ provider: "deepgram" });
    expect(provider).toBeInstanceOf(UnavailableProvider);
    expect(sockets).toHaveLength(0);
  });

  it("reports OpenAI unavailable when no key is configured", () => {
    const createProvider = buildProviderFactory(fakeConfig());
    const provider = createProvider({ provider: "openai" });
    expect(provider).toBeInstanceOf(UnavailableProvider);
  });
});
