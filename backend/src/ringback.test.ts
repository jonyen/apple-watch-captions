import { describe, it, expect } from "vitest";
import { ringbackWav } from "./ringback";

describe("ringbackWav", () => {
  it("is a WAV file Twilio can play", () => {
    const wav = ringbackWav();

    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(8000); // 8 kHz
    expect(wav.readUInt16LE(34)).toBe(16); // 16-bit
  });

  it("declares the data length it actually carries", () => {
    const wav = ringbackWav();
    const declared = wav.readUInt32LE(40);

    expect(declared).toBe(wav.length - 44);
  });

  it("rings for two seconds then rests for two", () => {
    const wav = ringbackWav();
    const at = (second: number) => wav.readInt16LE(44 + Math.floor(second * 8000) * 2);

    // Somewhere inside the tone there is signal; inside the rest there is not.
    let loudest = 0;
    for (let i = 0; i < 8000; i++) loudest = Math.max(loudest, Math.abs(at(i / 8000)));
    expect(loudest).toBeGreaterThan(1000);
    expect(at(3)).toBe(0);
  });
});
