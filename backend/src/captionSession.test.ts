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

  it("forwards the transcript channel on caption messages", () => {
    const provider = new FakeTranscriptionProvider();
    const sent: OutboundMessage[] = [];
    new CaptionSession(provider, (m) => sent.push(m));
    provider.emitTranscript({ text: "hi", isFinal: true, channel: 1 });
    provider.emitTranscript({ text: "yo", isFinal: true });
    expect(sent[0]).toEqual({ type: "caption", text: "hi", isFinal: true, channel: 1 });
    expect("channel" in sent[1]).toBe(false);
  });
});
