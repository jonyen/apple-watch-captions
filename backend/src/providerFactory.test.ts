import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { buildProviderFactory } from "./providerFactory";
import { Config } from "./config";
import { DeepgramLike, LiveConnectionLike } from "./deepgramProvider";
import { WebSocketLike } from "./appleProvider";
import { ChannelSplitProvider } from "./channelSplitProvider";
import { UnavailableProvider } from "./unavailableProvider";

/** Minimal stand-in for a Deepgram live connection, just enough to see it was used. */
class FakeLiveConnection extends EventEmitter implements LiveConnectionLike {
  send() {}
  requestClose() {}
  on(event: string, cb: (...args: any[]) => void) {
    super.on(event, cb);
    return this;
  }
}

function fakeDeepgram(): { client: DeepgramLike; conns: FakeLiveConnection[] } {
  const conns: FakeLiveConnection[] = [];
  const client: DeepgramLike = {
    listen: {
      live: () => {
        const conn = new FakeLiveConnection();
        conns.push(conn);
        return conn;
      },
    },
  };
  return { client, conns };
}

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
    deepgramApiKey: "dg-key",
    transcriptsDir: "./data/transcripts",
    dbPath: "./data/transcripts/identity.db",
    deepgramPhoneModel: "phonecall",
    trustProxyHeaders: false,
    appleTranscriberUrl: "ws://127.0.0.1:8790",
    ...overrides,
  };
}

describe("buildProviderFactory", () => {
  it("defaults to Deepgram when nothing requests a provider", () => {
    const { client, conns } = fakeDeepgram();
    const createProvider = buildProviderFactory(fakeConfig(), { deepgram: client });
    createProvider();
    expect(conns).toHaveLength(1);
  });

  it("builds an Apple provider against the configured sidecar URL with pcm16k by default", () => {
    const { client } = fakeDeepgram();
    const urls: string[] = [];
    const sockets: FakeSocket[] = [];
    const appleWsFactory = (url: string): WebSocketLike => {
      urls.push(url);
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const createProvider = buildProviderFactory(
      fakeConfig({ appleTranscriberUrl: "ws://127.0.0.1:9999" }),
      { deepgram: client, appleWsFactory },
    );
    createProvider({ provider: "apple" });
    expect(urls).toEqual(["ws://127.0.0.1:9999"]);
    sockets[0].emit("open");
    expect(sockets[0].sentText()).toEqual([{ config: { format: "pcm16k" } }]);
  });

  it("uses mulaw8k for a telephony Apple session", () => {
    const { client } = fakeDeepgram();
    const sockets: FakeSocket[] = [];
    const appleWsFactory = (): WebSocketLike => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const createProvider = buildProviderFactory(fakeConfig(), {
      deepgram: client,
      appleWsFactory,
    });
    createProvider({ provider: "apple", telephony: true });
    sockets[0].emit("open");
    expect(sockets[0].sentText()).toEqual([{ config: { format: "mulaw8k" } }]);
  });

  it("wraps dual-channel Apple sessions in a ChannelSplitProvider running two sidecars", () => {
    const { client } = fakeDeepgram();
    const sockets: FakeSocket[] = [];
    const appleWsFactory = (): WebSocketLike => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const createProvider = buildProviderFactory(fakeConfig(), {
      deepgram: client,
      appleWsFactory,
    });
    const provider = createProvider({ provider: "apple", channels: 2 });
    expect(provider).toBeInstanceOf(ChannelSplitProvider);
    expect(sockets).toHaveLength(2);
  });

  it("honors TRANSCRIPTION_PROVIDER=apple as the relay's default when a session requests none", () => {
    const { client } = fakeDeepgram();
    const sockets: FakeSocket[] = [];
    const appleWsFactory = (): WebSocketLike => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const createProvider = buildProviderFactory(fakeConfig({ transcriptionProvider: "apple" }), {
      deepgram: client,
      appleWsFactory,
    });
    createProvider();
    expect(sockets).toHaveLength(1);
  });

  it("lets a session's explicit provider override the relay's TRANSCRIPTION_PROVIDER default", () => {
    const { client, conns } = fakeDeepgram();
    const createProvider = buildProviderFactory(fakeConfig({ transcriptionProvider: "apple" }), {
      deepgram: client,
    });
    createProvider({ provider: "deepgram" });
    expect(conns).toHaveLength(1);
  });

  it("reports Deepgram unavailable when no key is configured (e.g. an apple-only deployment)", () => {
    const { client, conns } = fakeDeepgram();
    const createProvider = buildProviderFactory(
      fakeConfig({ deepgramApiKey: undefined, transcriptionProvider: "apple" }),
      { deepgram: client },
    );
    const provider = createProvider({ provider: "deepgram" });
    expect(provider).toBeInstanceOf(UnavailableProvider);
    expect(conns).toHaveLength(0);
  });

  it("reports OpenAI unavailable when no key is configured", () => {
    const { client } = fakeDeepgram();
    const createProvider = buildProviderFactory(fakeConfig(), { deepgram: client });
    const provider = createProvider({ provider: "openai" });
    expect(provider).toBeInstanceOf(UnavailableProvider);
  });
});
