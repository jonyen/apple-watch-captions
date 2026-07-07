import { createClient } from "@deepgram/sdk";
import { loadConfig } from "./config";
import { startServer } from "./server";
import { DeepgramProvider, DeepgramLike } from "./deepgramProvider";
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

const server = startServer({
  port: config.port,
  authToken: config.authToken,
  createProvider: (opts) =>
    new DeepgramProvider(
      deepgram,
      opts?.channels === 2 ? { channels: 2, multichannel: true } : undefined,
    ),
  transcripts,
  transcriptsDir: config.transcriptsDir,
  usage: createUsageService({ env: process.env }),
});

const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : config.port;
console.log(`Caption relay listening on ws://0.0.0.0:${port}/stream`);
console.log(`Transcripts in ${config.transcriptsDir}; viewer at /app`);
