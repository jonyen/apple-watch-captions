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
import { createNotionExporter, createNotionSummaryPatcher } from "./notionExporter";
import { backfillNotion } from "./notionBackfill";
import { backfillSummaries } from "./summaryBackfill";
import { createUsageService } from "./usageService";

const config = loadConfig(process.env);
const deepgram = createClient(config.deepgramApiKey) as unknown as DeepgramLike;

const summarize = config.anthropicApiKey
  ? createClaudeSummarizer(config.anthropicApiKey)
  : undefined;
if (!summarize) {
  console.log("ANTHROPIC_API_KEY not set — transcripts are saved without summaries");
}

const exportTranscript = config.notion ? createNotionExporter(config.notion) : undefined;
if (!exportTranscript) {
  console.log("NOTION_TOKEN/NOTION_DATABASE_ID not set — transcripts are not exported to Notion");
}

const transcripts = new TranscriptStore({
  dir: config.transcriptsDir,
  onFinalize: createFinalizer({
    dir: config.transcriptsDir,
    summarize,
    export: exportTranscript,
  }),
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

/**
 * Catch up on stored transcripts: summarize any that never got one (the key
 * was unset, out of credit, or erroring at the time), then export anything
 * that never reached Notion. Summaries run first so a transcript exported in
 * the same sweep carries its summary.
 */
async function runBackfills(): Promise<void> {
  if (summarize) {
    const r = await backfillSummaries({
      dir: config.transcriptsDir,
      summarize,
      patchPage: config.notion ? createNotionSummaryPatcher(config.notion) : undefined,
    });
    if (r.summarized || r.failed) {
      console.log(
        `Summary backfill: ${r.summarized} written, ${r.patched} added to Notion, ${r.failed} failed`,
      );
    }
  }
  if (exportTranscript) {
    const r = await backfillNotion({ dir: config.transcriptsDir, export: exportTranscript });
    if (r.exported || r.failed) {
      console.log(`Notion backfill: ${r.exported} exported, ${r.failed} failed`);
    }
  }
}

void runBackfills().catch((err) => console.error("backfill failed:", err));
