import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeGenMidi } from '../../src/audio/genmidi';
import { findLump, parseWad, readLump } from '../../src/wad/archive';

function bank(): Uint8Array {
  const data = new Uint8Array(8 + 175 * 36 + 175 * 32);
  data.set(new TextEncoder().encode('#OPL_II#'));
  return data;
}

describe('GENMIDI instrument bank', () => {
  it('decodes both voices, flags and signed note offsets from a lump view', () => {
    const bytes = bank();
    const view = new DataView(bytes.buffer);
    view.setUint16(8, 5, true);
    bytes[10] = 143; bytes[11] = 60;
    bytes.set([48, 240, 243, 1, 64, 20, 10, 49, 241, 244, 2, 128, 7], 12);
    view.setInt16(26, -12, true);
    view.setInt16(42, 24, true);
    bytes.set(new TextEncoder().encode('two voice piano'), 8 + 175 * 36);
    const padded = new Uint8Array(bytes.length + 9);
    padded.set(bytes, 7);
    const instruments = decodeGenMidi(padded.subarray(7, 7 + bytes.length));
    expect(instruments).toHaveLength(175);
    expect(instruments[0]).toMatchObject({ name: 'two voice piano', flags: 5,
      fixedPitch: true, doubleVoice: true, fineTuning: 143, fixedNote: 60,
      voices: [{ modulatorTremolo: 48, modulatorAttack: 240, modulatorSustain: 243,
        modulatorWaveform: 1, modulatorKey: 64, modulatorOutput: 20, feedback: 10,
        carrierTremolo: 49, carrierAttack: 241, carrierSustain: 244,
        carrierWaveform: 2, carrierKey: 128, carrierOutput: 7, baseNoteOffset: -12 },
      { baseNoteOffset: 24 }] });
  });

  it('accepts the binary bank without optional display names', () => {
    expect(decodeGenMidi(bank().subarray(0, 8 + 175 * 36))[174]?.name).toBe('');
  });

  it('rejects truncated instruments and wrong signatures', () => {
    expect(() => decodeGenMidi(bank().subarray(0, 8 + 175 * 36 - 1))).toThrow(/truncated/i);
    const bytes = bank(); bytes[0] = 0;
    expect(() => decodeGenMidi(bytes)).toThrow(/signature/i);
  });

  it('reads all melodic and percussion instruments from original GENMIDI', () => {
    const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
    const lump = findLump(wad, 'GENMIDI');
    if (!lump) throw new Error('Missing GENMIDI');
    const instruments = decodeGenMidi(readLump(wad, lump));
    expect(instruments).toHaveLength(175);
    expect(instruments[0]?.name).toBe('Acoustic Grand Piano');
    expect(instruments[128]?.name).toBe('Acoustic Bass Drum');
    expect(instruments[174]?.name).toBe('Open Triangle');
    expect(instruments.flatMap(instrument => instrument.voices)
      .every(voice => voice.carrierOutput >= 0 && voice.carrierOutput <= 63)).toBe(true);
  });
});
