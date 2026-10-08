import { describe, expect, it } from 'vitest';
import { decodeDmx } from '../../src/audio/dmx';

function sound(samples: readonly number[], sampleRate = 11025): Uint8Array {
  const bytes = new Uint8Array(8 + 16 + samples.length + 16);
  const header = new DataView(bytes.buffer);
  header.setUint16(0, 3, true);
  header.setUint16(2, sampleRate, true);
  header.setUint32(4, bytes.length - 8, true);
  bytes.fill(128, 8);
  bytes.set(samples, 24);
  return bytes;
}

describe('decodeDmx', () => {
  it('removes DMX padding and centers unsigned PCM without resampling', () => {
    const bytes = sound([0, 127, 128, 129, 255], 22050);
    bytes.fill(255, 8, 24);
    bytes.fill(0, 29);
    expect(decodeDmx(bytes)).toEqual({
      sampleRate: 22050,
      samples: new Float32Array([-1, -1 / 128, 0, 1 / 128, 127 / 128]),
    });
  });

  it('reads a lump view at its own byte offset and ignores bytes beyond the declared data', () => {
    const lump = sound([64, 192]);
    const container = new Uint8Array(lump.length + 12).fill(255);
    container.set(lump, 5);
    expect(decodeDmx(container.subarray(5, 5 + lump.length + 3)).samples)
      .toEqual(new Float32Array([-0.5, 0.5]));
  });

  it('rejects truncated headers and declared data outside the lump', () => {
    expect(() => decodeDmx(new Uint8Array(7))).toThrow(/header/i);
    const bytes = sound([128]);
    new DataView(bytes.buffer).setUint32(4, bytes.length, true);
    expect(() => decodeDmx(bytes)).toThrow(/length/i);
  });

  it('rejects other sound formats, a zero sample rate, and missing padding', () => {
    const wrongFormat = sound([128]);
    new DataView(wrongFormat.buffer).setUint16(0, 0, true);
    expect(() => decodeDmx(wrongFormat)).toThrow(/format/i);
    expect(() => decodeDmx(sound([128], 0))).toThrow(/rate/i);
    const short = sound([128]);
    new DataView(short.buffer).setUint32(4, 31, true);
    expect(() => decodeDmx(short)).toThrow(/padding/i);
  });
});
