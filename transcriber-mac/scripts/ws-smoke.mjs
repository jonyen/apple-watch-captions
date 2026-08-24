// Streams a 16k mono wav to the sidecar like the relay will, speaking
// protocol v2: config text frame first, 100 ms binary chunks at real-time
// pace, then {"finish":true} (socket stays open) and wait for {"done":true};
// the SERVER closes. Events received before the finish frame are tagged
// [pre-finish] so progressive partials are visible in the output. Usage:
//   node ws-smoke.mjs ws://127.0.0.1:8790 /tmp/hello.wav
import { readFileSync } from "node:fs";
import WebSocket from "ws";
const [url, wavPath] = process.argv.slice(2);
const pcm = readFileSync(wavPath).subarray(44);
const ws = new WebSocket(url);
let finishSent = false;
ws.on("message", (m) => {
  console.log(`${finishSent ? "" : "[pre-finish] "}${m}`);
  if (JSON.parse(String(m)).done) console.log("(done received, awaiting server close)");
});
ws.on("open", async () => {
  ws.send(JSON.stringify({ config: { locale: "en-US", format: "pcm16k" } }));
  for (let off = 0; off < pcm.length; off += 3200) {   // 100 ms chunks
    ws.send(pcm.subarray(off, off + 3200));
    await new Promise((r) => setTimeout(r, 100));
  }
  ws.send(JSON.stringify({ finish: true }));
  finishSent = true;
  console.log("(finish sent)");
});
ws.on("close", () => {
  console.log("(server closed)");
  process.exit(0);
});
setTimeout(() => { console.error("timed out waiting for done/close"); process.exit(1); }, 60000);
