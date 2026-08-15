import { describe, it, expect } from "vitest";
import { createResendSender, transcriptEmail, createTranscriptEmailSender } from "./emailSender";
import { FinalizedTranscript } from "./transcriptStore";
import { ExportDestinationStore } from "./exportDestinations";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import { randomBytes } from "crypto";

const transcript: FinalizedTranscript = {
  name: "2026-01-01T00-00-00Z_s1",
  userId: "alice",
  sessionId: "s1",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:05:00.000Z",
  segments: [
    { at: "2026-01-01T00:00:30.000Z", text: "first line" },
    { at: "2026-01-01T00:01:00.000Z", text: "second line" },
  ],
};

describe("createResendSender", () => {
  it("posts the message with the api key and sender", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), init };
      return { ok: true, text: async () => "" };
    }) as unknown as typeof fetch;

    await createResendSender("re_key", "relay@example.com", fakeFetch)({
      to: "a@example.com",
      subject: "Subject",
      text: "Body",
    });

    expect(seen!.url).toBe("https://api.resend.com/emails");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      from: "relay@example.com",
      to: "a@example.com",
      subject: "Subject",
      text: "Body",
    });
  });

  it("throws when the provider rejects the send", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 422,
      text: async () => "domain not verified",
    })) as unknown as typeof fetch;
    await expect(
      createResendSender("re_key", "relay@example.com", fakeFetch)({
        to: "a@example.com",
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(/422/);
  });
});

describe("transcriptEmail", () => {
  it("uses the summary title as the subject when there is one", () => {
    const { subject } = transcriptEmail(transcript, "Title: Coffee plans\n\nThey agreed on 3pm.");
    expect(subject).toContain("Coffee plans");
  });

  it("falls back to the date when there is no summary", () => {
    const { subject } = transcriptEmail(transcript, null);
    expect(subject).toContain("2026-01-01");
  });

  it("includes the summary and every caption line", () => {
    const { text } = transcriptEmail(transcript, "Title: Coffee plans\n\nThey agreed on 3pm.");
    expect(text).toContain("They agreed on 3pm.");
    expect(text).toContain("first line");
    expect(text).toContain("second line");
  });
});

describe("createTranscriptEmailSender", () => {
  function setup() {
    const db = openDb(":memory:");
    const identity = new IdentityStore(db);
    const userId = identity.registerDevice("phone").userId;
    const destinations = new ExportDestinationStore(db, randomBytes(32));
    const sent: { to: string; subject: string; text: string }[] = [];
    const sendEmail = async (args: { to: string; subject: string; text: string }) => {
      sent.push(args);
    };
    return { destinations, sent, sendEmail, userId };
  }

  it("does not send to an address that has never been verified", async () => {
    const { destinations, sent, sendEmail, userId } = setup();
    destinations.putEmail(userId, { address: "a@example.com" });
    const send = createTranscriptEmailSender(destinations, sendEmail);
    await send(userId, { ...transcript, userId }, null);
    expect(sent).toEqual([]);
  });

  it("does nothing when the user has no email destination at all", async () => {
    const { destinations, sent, sendEmail, userId } = setup();
    const send = createTranscriptEmailSender(destinations, sendEmail);
    await send(userId, { ...transcript, userId }, null);
    expect(sent).toEqual([]);
  });

  it("sends to an address once it is verified", async () => {
    const { destinations, sent, sendEmail, userId } = setup();
    destinations.putEmail(userId, {
      address: "a@example.com",
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });
    const send = createTranscriptEmailSender(destinations, sendEmail);
    await send(userId, { ...transcript, userId }, "Title: Coffee plans\n\nThey agreed on 3pm.");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("a@example.com");
    expect(sent[0].subject).toContain("Coffee plans");
    expect(sent[0].text).toContain("first line");
  });
});
