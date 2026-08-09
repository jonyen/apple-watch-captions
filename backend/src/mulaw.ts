const BIAS = 0x84;
const CLIP = 32635;

/** One Int16 sample to one mu-law byte (ITU-T G.711). */
function encodeSample(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One mu-law byte back to one Int16 sample. */
function decodeSample(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -magnitude : magnitude;
}

export function decodeMuLaw(data: Buffer): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = decodeSample(data[i]);
  return out;
}

export function encodeMuLaw(samples: Int16Array): Buffer {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = encodeSample(samples[i]);
  return out;
}

/**
 * The watch's 16 kHz little-endian Int16 to the 8 kHz mu-law Twilio requires.
 * Averaging each pair rather than dropping one halves the rate without the
 * aliasing that decimation alone would add to speech.
 */
export function pcm16kToMuLaw8k(pcm: Buffer): Buffer {
  // A trailing odd byte is a truncated sample; ignore it rather than read past.
  const pairs = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(pairs);
  for (let i = 0; i < pairs; i++) {
    const a = pcm.readInt16LE(i * 4);
    const b = pcm.readInt16LE(i * 4 + 2);
    out[i] = encodeSample((a + b) >> 1);
  }
  return out;
}
