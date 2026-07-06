import { createClient } from "@deepgram/sdk";
import { loadConfig } from "./config";
import { startServer } from "./server";
import { DeepgramProvider, DeepgramLike } from "./deepgramProvider";
import { TranscriptStore } from "./transcriptStore";
import { createClaudeSummarizer } from "./summarizer";
import { createFinalizer } from "./finalizer";
import { createTranscriptMailer } from "./mailer";

const config = loadConfig(process.env);
const deepgram = createClient(config.deepgramApiKey) as unknown as DeepgramLike;

const summarize = config.anthropicApiKey
  ? createClaudeSummarizer(config.anthropicApiKey)
  : undefined;
if (!summarize) {
  console.log("ANTHROPIC_API_KEY not set — transcripts are saved without summaries");
}
const sendEmail = config.mail ? createTranscriptMailer(config.mail) : undefined;
if (!sendEmail) {
  console.log(
    "MAIL_USERNAME / MAIL_PASSWORD / NOTIFY_EMAIL_TO not all set — no transcript emails",
  );
}

const transcripts = new TranscriptStore({
  dir: config.transcriptsDir,
  onFinalize: createFinalizer({ dir: config.transcriptsDir, summarize, sendEmail }),
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
