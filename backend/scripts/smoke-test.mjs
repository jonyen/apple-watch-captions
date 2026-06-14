import { WebSocket } from "ws";
import { readFileSync } from "fs";

const [, , urlBase, token, pcmPath] = process.argv;
if (!urlBase || !token || !pcmPath) {
  console.error("usage: node smoke-test.mjs <ws-url> <token> <pcm-file>");
  process.exit(1);
}

const pcm = readFileSync(pcmPath);
const ws = new WebSocket(`${urlBase}?token=${token}`);

function startStreaming() {
  // Send in ~100ms chunks; Deepgram tolerates faster-than-realtime.
  const CHUNK = 3200; // 100ms of 16kHz 16-bit mono
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= pcm.length) {
      clearInterval(timer);
      setTimeout(() => ws.close(), 2000); // allow final transcripts to arrive
      return;
    }
    ws.send(pcm.subarray(offset, offset + CHUNK));
    offset += CHUNK;
  }, 100);
}

let started = false;
ws.on("message", (data) => {
  const text = data.toString();
  console.log(text);
  // Wait for the server's ready signal before streaming audio.
  if (!started && text.includes('"ready"')) {
    started = true;
    startStreaming();
  }
});
ws.on("close", (code) => {
  console.log("closed", code);
  process.exit(0);
});
ws.on("error", (e) => {
  console.error("error", e.message);
  process.exit(1);
});
