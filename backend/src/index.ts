import { createClient } from "@deepgram/sdk";
import { loadConfig } from "./config";
import { startServer } from "./server";
import { DeepgramProvider, DeepgramLike } from "./deepgramProvider";

const config = loadConfig(process.env);
const deepgram = createClient(config.deepgramApiKey) as unknown as DeepgramLike;

const server = startServer({
  port: config.port,
  authToken: config.authToken,
  createProvider: () => new DeepgramProvider(deepgram),
});

const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : config.port;
console.log(`Caption relay listening on ws://0.0.0.0:${port}/stream`);
