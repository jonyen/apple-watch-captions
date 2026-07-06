import { createClient } from "@deepgram/sdk";
import { loadConfig } from "./config";
import { startServer } from "./server";
import { DeepgramProvider, DeepgramLike } from "./deepgramProvider";
import { TranscriptStore } from "./transcriptStore";
import { createClaudeSummarizer, summarizeOnFinalize } from "./summarizer";

const config = loadConfig(process.env);
const deepgram = createClient(config.deepgramApiKey) as unknown as DeepgramLike;

const onFinalize = config.anthropicApiKey
  ? summarizeOnFinalize(config.transcriptsDir, createClaudeSummarizer(config.anthropicApiKey))
  : undefined;
if (!onFinalize) {
  console.log("ANTHROPIC_API_KEY not set — transcripts are saved without summaries");
}

const transcripts = new TranscriptStore({
  dir: config.transcriptsDir,
  onFinalize,
});

const server = startServer({
  port: config.port,
  authToken: config.authToken,
  createProvider: () => new DeepgramProvider(deepgram),
  transcripts,
  transcriptsDir: config.transcriptsDir,
});

const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : config.port;
console.log(`Caption relay listening on ws://0.0.0.0:${port}/stream`);
console.log(`Transcripts in ${config.transcriptsDir}; viewer at /app`);
