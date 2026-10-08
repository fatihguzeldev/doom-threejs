import { describe, expect, it } from 'vitest';
import { decodeMus } from '../../src/audio/mus';

function score(events: readonly number[], instruments: readonly number[] = []): Uint8Array {
  const start = 16 + instruments.length * 2;
  const bytes = new Uint8Array(start + events.length);
  bytes.set([0x4d, 0x55, 0x53, 0x1a]);
  const header = new DataView(bytes.buffer);
  header.setUint16(4, events.length, true);
  header.setUint16(6, start, true);
  header.setUint16(8, 2, true);
  header.setUint16(10, 1, true);
  header.setUint16(12, instruments.length, true);
  instruments.forEach((instrument, index) => header.setUint16(16 + index * 2, instrument, true));
  bytes.set(events, start);
  return bytes;
}

describe('decodeMus', () => {
  it('preserves simultaneous events, 140 Hz timing, and independent channel velocity memory', () => {
    const bytes = score([
      0x10, 60,
      0x11, 0x80 | 61, 100,
      0x9f, 0x80 | 35, 90, 0x81, 0x0c,
      0x11, 62,
      0x10, 63,
      0x81, 61, 0,
      0x1f, 36,
      0x60,
    ], [0, 181]);
    expect(decodeMus(bytes)).toEqual({
      tickRate: 140,
      primaryChannels: 2,
      secondaryChannels: 1,
      instruments: [0, 181],
      durationTicks: 140,
      events: [
        { type: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 64 },
        { type: 'noteOn', tick: 0, channel: 1, note: 61, velocity: 100 },
        { type: 'noteOn', tick: 0, channel: 15, note: 35, velocity: 90 },
        { type: 'noteOn', tick: 140, channel: 1, note: 62, velocity: 100 },
        { type: 'noteOn', tick: 140, channel: 0, note: 63, velocity: 64 },
        { type: 'noteOff', tick: 140, channel: 1, note: 61 },
        { type: 'noteOn', tick: 140, channel: 15, note: 36, velocity: 90 },
        { type: 'end', tick: 140, channel: 0 },
      ],
    });
  });

  it('retains native MUS controller and system IDs and the full pitch byte', () => {
    expect(decodeMus(score([
      0x42, 0, 17,
      0x42, 3, 127,
      0x22, 128,
      0x22, 255,
      0x32, 10,
      0xb2, 14, 7,
      0xe0,
    ])).events).toEqual([
      { type: 'controller', tick: 0, channel: 2, controller: 0, value: 17 },
      { type: 'controller', tick: 0, channel: 2, controller: 3, value: 127 },
      { type: 'pitchBend', tick: 0, channel: 2, value: 128 },
      { type: 'pitchBend', tick: 0, channel: 2, value: 255 },
      { type: 'system', tick: 0, channel: 2, system: 10 },
      { type: 'system', tick: 0, channel: 2, system: 14 },
      { type: 'end', tick: 7, channel: 0 },
    ]);
  });

  it('normalizes eight-bit payload quirks accepted by the original MUS conversion path', () => {
    expect(decodeMus(score([
      0x10, 0x80 | 60, 255,
      0x00, 0x80 | 60,
      0x40, 0, 128,
      0x40, 3, 128,
      0x60,
    ])).events).toEqual([
      { type: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 127 },
      { type: 'noteOff', tick: 0, channel: 0, note: 60 },
      { type: 'controller', tick: 0, channel: 0, controller: 0, value: 0 },
      { type: 'controller', tick: 0, channel: 0, controller: 3, value: 127 },
      { type: 'end', tick: 0, channel: 0 },
    ]);
  });

  it('does not borrow event payload or an end marker from outside the declared score', () => {
    const bytes = score([0x10, 0x80 | 60, 100, 0x60]);
    new DataView(bytes.buffer).setUint16(4, 2, true);
    expect(() => decodeMus(bytes)).toThrow(/truncated/i);
    expect(() => decodeMus(score([0x10, 60]))).toThrow(/end/i);
  });

  it('rejects bad signatures, truncated headers, overlapping instrument lists and score bounds', () => {
    expect(() => decodeMus(new Uint8Array(15))).toThrow(/header/i);
    const badSignature = score([0x60]);
    badSignature[3] = 0;
    expect(() => decodeMus(badSignature)).toThrow(/signature/i);
    const overlapsInstruments = score([0x60], [1]);
    new DataView(overlapsInstruments.buffer).setUint16(6, 16, true);
    expect(() => decodeMus(overlapsInstruments)).toThrow(/instrument/i);
    const outside = score([0x60]);
    new DataView(outside.buffer).setUint16(4, 2, true);
    expect(() => decodeMus(outside)).toThrow(/bounds/i);
  });

  it.each([
    [0x50],
    [0x70],
    [0x30, 9, 0x60],
    [0x30, 15, 0x60],
    [0x40, 10, 1, 0x60],
    [0x10, 0x80 | 60],
    [0x20],
    [0x90, 60, 0x81],
  ])('rejects invalid events and truncated payloads or time codes: %j', (...events) => {
    expect(() => decodeMus(score(events))).toThrow();
  });

  it('rejects time codes beyond integer precision instead of rounding event timestamps', () => {
    expect(() => decodeMus(score([0x90, 60, ...Array<number>(8).fill(0xff), 0x7f, 0x60])))
      .toThrow(/time/i);
  });

  it('accepts typed-array views and resets default velocity for each decoded score', () => {
    decodeMus(score([0x10, 0x80 | 60, 1, 0x60]));
    const bytes = score([0x10, 60, 0x60]);
    const container = new Uint8Array(bytes.length + 3);
    container.set(bytes, 3);
    expect(decodeMus(container.subarray(3)).events[0])
      .toEqual({ type: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 64 });
  });
});
