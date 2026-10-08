import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyMusEvent, createMusicRenderer, OPL_SAMPLE_RATE } from '../../src/audio/music';
import type { MusDriver } from '../../src/audio/music';
import { findLump, parseWad, readLump } from '../../src/wad/archive';

function driver(): { synth: MusDriver; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return { calls, synth: {
    MLtime: 0,
    OPLplayNote: (...args) => { calls.push(['on', ...args]); },
    OPLreleaseNote: (...args) => { calls.push(['off', ...args]); },
    OPLpitchWheel: (...args) => { calls.push(['pitch', ...args]); },
    OPLchangeControl: (...args) => { calls.push(['control', ...args]); },
    OPLprogramChange: (...args) => { calls.push(['program', ...args]); },
    OPLresetControllers: (...args) => { calls.push(['reset', ...args]); },
    OPLstopMusic: () => { calls.push(['stop']); },
  } };
}

function mus(events: readonly number[]): Uint8Array {
  const data = new Uint8Array(16 + events.length);
  data.set([77, 85, 83, 26]);
  const view = new DataView(data.buffer);
  view.setUint16(4, events.length, true); view.setUint16(6, 16, true);
  data.set(events, 16);
  return data;
}

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
function lump(name: string): Uint8Array {
  const entry = findLump(wad, name);
  if (!entry) throw new Error(`Missing fixture ${name}`);
  return readLump(wad, entry);
}

describe('typed MUS OPL dispatch', () => {
  it('keeps MUS percussion channel 15 and maps pitch to the full MIDI bend range', () => {
    const { synth, calls } = driver();
    applyMusEvent(synth, { type: 'noteOn', tick: 40, channel: 15, note: 35, velocity: 64 });
    applyMusEvent(synth, { type: 'pitchBend', tick: 41, channel: 3, value: 128 });
    applyMusEvent(synth, { type: 'pitchBend', tick: 42, channel: 3, value: 255 });
    expect(calls).toEqual([['on', 15, 35, 64], ['pitch', 3, 8192], ['pitch', 3, 16320]]);
    expect(synth.MLtime).toBe(42);
  });

  it('applies program, volume, sustain and all five system events to the synth', () => {
    const { synth, calls } = driver();
    applyMusEvent(synth, { type: 'controller', tick: 0, channel: 2, controller: 0, value: 17 });
    applyMusEvent(synth, { type: 'controller', tick: 0, channel: 2, controller: 3, value: 90 });
    applyMusEvent(synth, { type: 'controller', tick: 0, channel: 2, controller: 8, value: 127 });
    for (const system of [10, 11, 12, 13, 14] as const) {
      applyMusEvent(synth, { type: 'system', tick: 1, channel: 2, system });
    }
    expect(calls).toEqual([['program', 2, 17], ['control', 2, 3, 90], ['control', 2, 8, 127],
      ['control', 2, 16, 0], ['control', 2, 17, 0], ['control', 2, 18, 0],
      ['control', 2, 19, 0], ['reset', 2, 100]]);
  });

  it('dispatches note-off and stops all voices at score end', () => {
    const { synth, calls } = driver();
    applyMusEvent(synth, { type: 'noteOff', tick: 2, channel: 1, note: 60 });
    applyMusEvent(synth, { type: 'end', tick: 3, channel: 0 });
    expect(calls).toEqual([['off', 1, 60], ['stop']]);
  });
});

describe('bounded native OPL PCM synthesis', () => {
  it('places events on exact 355-sample 140 Hz boundaries at 49700 Hz', () => {
    const bytes = mus([0x90, 0xbc, 100, 1, 0x80, 60, 1, 0x60]);
    const renderer = createMusicRenderer(bytes, lump('GENMIDI'), false);
    expect(OPL_SAMPLE_RATE).toBe(49700);
    const first = renderer.render(355);
    expect(first.samples).toHaveLength(710);
    expect(first.ended).toBe(false);
    expect(first.samples.some(sample => Math.abs(sample) > 0.0001)).toBe(true);
    const second = renderer.render(400);
    expect(second.samples).toHaveLength(710);
    expect(second.ended).toBe(true);
    expect(renderer.render(100).samples).toHaveLength(0);
  });

  it('renders the same waveform when split into differently sized chunks', () => {
    const whole = createMusicRenderer(lump('D_E1M1'), lump('GENMIDI'), false).render(4970).samples;
    const split = createMusicRenderer(lump('D_E1M1'), lump('GENMIDI'), false);
    const a = split.render(711).samples;
    const b = split.render(4259).samples;
    expect(Float32Array.from([...a, ...b])).toEqual(whole);
    expect(whole.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1)).toBe(true);
  });

  it('loops with a fresh synth and bounds even a chunk spanning several loops', () => {
    const bytes = mus([0x90, 0xbc, 100, 1, 0x60]);
    const renderer = createMusicRenderer(bytes, lump('GENMIDI'), true);
    const samples = renderer.render(710).samples;
    expect(samples.subarray(0, 710)).toEqual(samples.subarray(710));
    expect(renderer.render(355).ended).toBe(false);
  });

  it('does not spin on a zero-duration looping score and rejects invalid frame requests', () => {
    const renderer = createMusicRenderer(mus([0x60]), lump('GENMIDI'), true);
    expect(renderer.render(100)).toEqual({ samples: new Float32Array(0), ended: true });
    expect(() => renderer.render(-1)).toThrow(/frame/i);
    expect(() => renderer.render(1.5)).toThrow(/frame/i);
    expect(() => renderer.render(49700 * 11)).toThrow(/frame/i);
  });
});
