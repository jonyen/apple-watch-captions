import { Config } from "./config";
import { ProviderOptions } from "./providerOptions";
import { TranscriptionProvider } from "./transcriptionProvider";
import { DeepgramProvider, DeepgramLike, telephonyOptions } from "./deepgramProvider";
import { OpenAIProvider } from "./openaiProvider";
import { AssemblyAIProvider } from "./assemblyaiProvider";
import { AppleTranscriptionProvider, WebSocketLike } from "./appleProvider";
import { ChannelSplitProvider } from "./channelSplitProvider";
import { UnavailableProvider } from "./unavailableProvider";

export interface ProviderFactoryDeps {
  deepgram: DeepgramLike;
  /** Injectable for tests; defaults to a real `ws` connection. */
  appleWsFactory?: (url: string) => WebSocketLike;
}

/**
 * Builds the function that turns a session's `ProviderOptions` into a
 * `TranscriptionProvider`, given the loaded config and the deepgram client
 * (the one dependency that can't be built from config alone).
 *
 * Pulled out of `index.ts` for the same reason `buildServerOptions` was
 * (see `serverOptions.ts`): a switch this consequential — picking the live
 * speech backend for every session — needs a unit test that can assert on
 * what it actually constructs, not just that `index.ts`'s source text
 * mentions the right provider name. `deployWiring.test.ts` covers the
 * remaining gap: that `index.ts` actually wires this factory into
 * `buildServerOptions` rather than building providers some other way.
 *
 * Deepgram transcribes the 2-channel stream natively; OpenAI, AssemblyAI and
 * Apple are mono-only, so dual-channel sessions get a ChannelSplitProvider
 * running one upstream connection per channel.
 */
export function buildProviderFactory(
  config: Config,
  deps: ProviderFactoryDeps,
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
        // Telephony (Twilio) audio arrives as mu-law 8 kHz; the mic/system
        // path is 16 kHz PCM. Both are mono, so channel-split still applies.
        const make = () =>
          new AppleTranscriptionProvider(config.appleTranscriberUrl, {
            format: opts?.telephony ? "mulaw8k" : "pcm16k",
            ...(deps.appleWsFactory ? { wsFactory: deps.appleWsFactory } : {}),
          });
        return dual ? new ChannelSplitProvider(make) : make();
      }
      default:
        // Telephony is mono by definition — one caller, one track — so it
        // never combines with the dual-channel path.
        if (opts?.telephony) {
          return new DeepgramProvider(deps.deepgram, telephonyOptions(config.deepgramPhoneModel));
        }
        return new DeepgramProvider(
          deps.deepgram,
          dual ? { channels: 2, multichannel: true } : undefined,
        );
    }
  };
}
