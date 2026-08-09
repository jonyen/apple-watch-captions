import { describe, it, expect } from "vitest";
import { decodeMuLaw, encodeMuLaw, pcm16kToMuLaw8k } from "./mulaw";

/** A sine sweep is a fairer test than silence: it exercises the whole range. */
function tone(samples: number, amplitude = 8000): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = Math.round(Math.sin(i * 0.1) * amplitude);
  return out;
}

describe("mu-law", () => {
  it("round-trips within mu-law's quantisation error", () => {
    const original = tone(200);

    const restored = decodeMuLaw(encodeMuLaw(original));

    expect(restored.length).toBe(original.length);
    // mu-law is lossy and coarser at higher amplitudes; 5% of full scale is
    // comfortably inside its error and far tighter than a wrong table.
    for (let i = 0; i < original.length; i++) {
      expect(Math.abs(restored[i] - original[i])).toBeLessThan(32768 * 0.05);
    }
  });

  it("encodes one byte per sample", () => {
    expect(encodeMuLaw(tone(100)).length).toBe(100);
  });

  it("maps silence to mu-law's silence byte", () => {
    // 0xFF is mu-law zero. Twilio sends it for silence; sending anything else
    // for silence is audible as a hiss.
    expect(encodeMuLaw(new Int16Array([0]))[0]).toBe(0xff);
    expect(decodeMuLaw(Buffer.from([0xff]))[0]).toBe(0);
  });

  it("halves the rate converting 16 kHz PCM to 8 kHz mu-law", () => {
    // 400 Int16 samples = 800 bytes at 16 kHz -> 200 mu-law bytes at 8 kHz.
    const pcm = Buffer.alloc(800);
    for (let i = 0; i < 400; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * 8000), i * 2);

    expect(pcm16kToMuLaw8k(pcm).length).toBe(200);
  });

  it("tolerates a PCM buffer that ends mid-sample", () => {
    expect(() => pcm16kToMuLaw8k(Buffer.alloc(801))).not.toThrow();
  });
});
