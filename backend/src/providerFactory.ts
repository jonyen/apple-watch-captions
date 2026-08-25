import { Config } from "./config";
import { ProviderOptions } from "./providerOptions";
import { TranscriptionProvider } from "./transcriptionProvider";
import { OpenAIProvider } from "./openaiProvider";
import { AssemblyAIProvider } from "./assemblyaiProvider";
import { AppleTranscriptionProvider, WebSocketLike } from "./appleProvider";
import { ChannelSplitProvider } from "./channelSplitProvider";
import { UnavailableProvider } from "./unavailableProvider";

export interface ProviderFactoryDeps {
  /** Injectable for tests; defaults to a real `ws` connection. */
  appleWsFactory?: (url: string) => WebSocketLike;
}

/**
 * Builds the function that turns a session's `ProviderOptions` into a
 * `TranscriptionProvider`, given the loaded config.
 *
 * Pulled out of `index.ts` for the same reason `buildServerOptions` was
 * (see `serverOptions.ts`): a switch this consequential — picking the live
 * speech backend for every session — needs a unit test that can assert on
 * what it actually constructs, not just that `index.ts`'s source text
 * mentions the right provider name. `deployWiring.test.ts` covers the
 * remaining gap: that `index.ts` actually wires this factory into
 * `buildServerOptions` rather than building providers some other way.
 *
 * Every implemented backend (OpenAI, AssemblyAI, Apple) is mono-only, so
 * dual-channel sessions get a ChannelSplitProvider running one upstream
 * connection per channel. "deepgram" (retired 2026-08, along with the
 * telephony/mu-law path that once rode it) resolves to an
 * UnavailableProvider, the same answer any unconfigured backend gets.
 */
export function buildProviderFactory(
  config: Config,
  deps: ProviderFactoryDeps = {},
): (opts?: ProviderOptions) => TranscriptionProvider {
  return function createProvider(opts?: ProviderOptions): TranscriptionProvider {
    const dual = opts?.channels === 2;
    const monoOnly = (
      name: string,
      apiKey: string | undefined,
      make: (key: string) => TranscriptionProvider,
    ): TranscriptionProvider => {
      if (!apiKey) {
        return new UnavailableProvider(`${name} is not configured on the relay`);
      }
      return dual ? new ChannelSplitProvider(() => make(apiKey)) : make(apiKey);
    };

    const provider = opts?.provider ?? config.transcriptionProvider;

    switch (provider) {
      case "openai":
        return monoOnly("OpenAI", config.openaiApiKey, (key) => new OpenAIProvider(key));
      case "assemblyai":
        return monoOnly("AssemblyAI", config.assemblyaiApiKey, (key) => new AssemblyAIProvider(key));
      case "apple": {
        const make = () =>
          new AppleTranscriptionProvider(config.appleTranscriberUrl, {
            format: "pcm16k",
            ...(deps.appleWsFactory ? { wsFactory: deps.appleWsFactory } : {}),
          });
        return dual ? new ChannelSplitProvider(make) : make();
      }
      default:
        // "deepgram" — the only remaining ProviderName — is retired: no
        // client and no key exist anymore. Kept recognizable so an old
        // session requesting it gets this clear error rather than a silent
        // fallback (see PROVIDER_NAMES in providerOptions.ts).
        return new UnavailableProvider("deepgram is not configured on the relay");
    }
  };
}
