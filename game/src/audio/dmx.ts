export interface DmxSound {
  readonly sampleRate: number;
  readonly samples: Float32Array;
}

export function decodeDmx(bytes: Uint8Array): DmxSound {
  if (bytes.byteLength < 8) throw new Error('Truncated DMX sound header');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.getUint16(0, true) !== 3) throw new Error('Unsupported DMX sound format');

  const sampleRate = data.getUint16(2, true);
  const length = data.getUint32(4, true);
  if (sampleRate === 0) throw new Error('Invalid DMX sample rate');
  if (length > bytes.byteLength - 8) throw new Error('DMX sound length exceeds the lump');
  if (length < 32) throw new Error('DMX sound is missing its padding');

  // DMX skips 16 samples at each end; see Chocolate Doom's CacheSFX:
  // https://github.com/chocolate-doom/chocolate-doom/blob/master/src/i_sdlsound.c
  const samples = new Float32Array(length - 32);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = (data.getUint8(24 + index) - 128) / 128;
  }
  return { sampleRate, samples };
}
