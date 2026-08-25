import { describe, it, expect } from "vitest";
import { PROVIDER_NAMES, ProviderOptions } from "./providerOptions";
import { PROVIDER_NAMES as VIA_SERVER } from "./server";

describe("provider options", () => {
  // "deepgram" is retired but deliberately still *recognized* — see
  // providerOptions.ts. It resolves to an UnavailableProvider, covered in
  // providerFactory.test.ts.
  it("lists the provider names the relay recognizes", () => {
    expect(PROVIDER_NAMES).toEqual(["deepgram", "openai", "assemblyai", "apple"]);
  });

  // server.ts re-exports these, so existing importers keep working.
  it("stays importable from server", () => {
    expect(VIA_SERVER).toEqual(PROVIDER_NAMES);
  });

  it("can request a specific provider and channel count", () => {
    const opts: ProviderOptions = { provider: "apple", channels: 2 };
    expect(opts.provider).toBe("apple");
    expect(opts.channels).toBe(2);
  });
});
