// Streams a 16k mono wav to the sidecar like the relay will. Usage:
//   node ws-smoke.mjs ws://127.0.0.1:8790 /tmp/hello.wav
import { readFileSync } from "node:fs";
import WebSocket from "ws";
const [url, wavPath] = process.argv.slice(2);
const pcm = readFileSync(wavPath).subarray(44);
const ws = new WebSocket(url);
ws.on("message", (m) => console.log(String(m)));
ws.on("open", async () => {
  for (let off = 0; off < pcm.length; off += 3200) {   // 100 ms chunks
    ws.send(pcm.subarray(off, off + 3200));
    await new Promise((r) => setTimeout(r, 100));
  }
  setTimeout(() => ws.close(), 2000);
});
ws.on("close", () => process.exit(0));
