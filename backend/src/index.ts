import { createClient } from "@deepgram/sdk";
import { loadConfig } from "./config";
import { startServer, ProviderOptions } from "./server";
import { DeepgramProvider, DeepgramLike } from "./deepgramProvider";
import { OpenAIProvider } from "./openaiProvider";
import { AssemblyAIProvider } from "./assemblyaiProvider";
import { ChannelSplitProvider } from "./channelSplitProvider";
import { UnavailableProvider } from "./unavailableProvider";
import { TranscriptionProvider } from "./transcriptionProvider";
import { TranscriptStore } from "./transcriptStore";
import { createClaudeSummarizer } from "./summarizer";
import { createFinalizer } from "./finalizer";
import { createUsageService } from "./usageService";

const config = loadConfig(process.env);
const deepgram = createClient(config.deepgramApiKey) as unknown as DeepgramLike;

const summarize = config.anthropicApiKey
  ? createClaudeSummarizer(config.anthropicApiKey)
  : undefined;
if (!summarize) {
  console.log("ANTHROPIC_API_KEY not set — transcripts are saved without summaries");
}

const transcripts = new TranscriptStore({
  dir: config.transcriptsDir,
  onFinalize: createFinalizer({ dir: config.transcriptsDir, summarize }),
});

/**
 * Deepgram transcribes the 2-channel stream natively; OpenAI and AssemblyAI
 * are mono-only, so dual-channel sessions get a ChannelSplitProvider running
 * one upstream connection per channel.
 */
function createProvider(opts?: ProviderOptions): TranscriptionProvider {
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

  switch (opts?.provider) {
    case "openai":
      return monoOnly("OpenAI", config.openaiApiKey, (key) => new OpenAIProvider(key));
    case "assemblyai":
      return monoOnly("AssemblyAI", config.assemblyaiApiKey, (key) => new AssemblyAIProvider(key));
    default:
      return new DeepgramProvider(
        deepgram,
        dual ? { channels: 2, multichannel: true } : undefined,
      );
  }
}

const server = startServer({
  port: config.port,
  authToken: config.authToken,
  createProvider,
  transcripts,
  transcriptsDir: config.transcriptsDir,
  usage: createUsageService({ env: process.env }),
});

const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : config.port;
console.log(`Caption relay listening on ws://0.0.0.0:${port}/stream`);
console.log(`Transcripts in ${config.transcriptsDir}; viewer at /app`);
