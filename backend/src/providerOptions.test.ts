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
