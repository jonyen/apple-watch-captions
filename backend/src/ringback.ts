const SAMPLE_RATE = 8000;
const TONE_SECONDS = 2;
const REST_SECONDS = 2;
/** North American ringback is a 440 Hz and 480 Hz pair. */
const FREQUENCIES = [440, 480];

/**
 * Four seconds of ringback — two ringing, two silent — as an 8 kHz mono WAV.
 *
 * Generated rather than shipped as an asset: it is forty lines, needs no build
 * step, and the caller has to hear something while the watch is given a chance
 * to answer. Silence there reads as a broken call.
 */
export function ringbackWav(): Buffer {
  const total = (TONE_SECONDS + REST_SECONDS) * SAMPLE_RATE;
  const samples = Buffer.alloc(total * 2);

  for (let i = 0; i < total; i++) {
    let value = 0;
    if (i < TONE_SECONDS * SAMPLE_RATE) {
      for (const hz of FREQUENCIES) {
        value += Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
      }
      value = (value / FREQUENCIES.length) * 8000;
    }
    samples.writeInt16LE(Math.round(value), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples.length, 40);

  return Buffer.concat([header, samples]);
}
