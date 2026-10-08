export type MusController = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type MusSystem = 10 | 11 | 12 | 13 | 14;

interface MusEventTime {
  readonly tick: number;
  readonly channel: number;
}

export type MusEvent = MusEventTime & (
  | { readonly type: 'noteOn'; readonly note: number; readonly velocity: number }
  | { readonly type: 'noteOff'; readonly note: number }
  | { readonly type: 'pitchBend'; readonly value: number }
  | { readonly type: 'system'; readonly system: MusSystem }
  | { readonly type: 'controller'; readonly controller: MusController; readonly value: number }
  | { readonly type: 'end' }
);

export interface MusScore {
  readonly tickRate: 140;
  readonly primaryChannels: number;
  readonly secondaryChannels: number;
  readonly instruments: readonly number[];
  readonly events: readonly MusEvent[];
  readonly durationTicks: number;
}

export function decodeMus(bytes: Uint8Array): MusScore {
  if (bytes.byteLength < 16) throw new Error('Truncated MUS header');
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.getUint32(0, false) !== 0x4d55531a) throw new Error('Invalid MUS signature');

  const length = data.getUint16(4, true);
  const start = data.getUint16(6, true);
  const primaryChannels = data.getUint16(8, true);
  const secondaryChannels = data.getUint16(10, true);
  const instrumentCount = data.getUint16(12, true);
  const instrumentsEnd = 16 + instrumentCount * 2;
  if (primaryChannels > 16 || secondaryChannels > 16) {
    throw new Error('Invalid MUS channel count');
  }
  if (instrumentsEnd > bytes.byteLength || start < instrumentsEnd) {
    throw new Error('MUS instrument list is truncated or overlaps the score');
  }
  if (length === 0 || start + length > bytes.byteLength) {
    throw new Error('MUS score bounds exceed the lump');
  }

  const instruments = Array.from({ length: instrumentCount }, (_, index) =>
    data.getUint16(16 + index * 2, true));
  const velocities = new Uint8Array(16).fill(64);
  const events: MusEvent[] = [];
  const end = start + length;
  let cursor = start;
  let tick = 0;

  function readByte(): number {
    if (cursor >= end) throw new Error('Truncated MUS event payload or time code');
    return data.getUint8(cursor++);
  }

  // Event descriptors and group delays follow the MUS stream, not MIDI channels:
  // https://github.com/chocolate-doom/chocolate-doom/blob/master/src/mus2mid.c
  while (cursor < end) {
    const descriptor = readByte();
    const channel = descriptor & 15;
    const type = (descriptor >> 4) & 7;

    switch (type) {
      case 0:
        events.push({ type: 'noteOff', tick, channel, note: readByte() & 127 });
        break;
      case 1: {
        const note = readByte();
        if ((note & 128) !== 0) velocities[channel] = readByte() & 127;
        events.push({
          type: 'noteOn', tick, channel, note: note & 127,
          velocity: velocities[channel] ?? 64,
        });
        break;
      }
      case 2:
        events.push({ type: 'pitchBend', tick, channel, value: readByte() });
        break;
      case 3: {
        const system = readByte();
        if (system < 10 || system > 14) throw new Error('Invalid MUS system event');
        events.push({ type: 'system', tick, channel, system: system as MusSystem });
        break;
      }
      case 4: {
        const controller = readByte();
        if (controller > 9) throw new Error('Invalid MUS controller event');
        const rawValue = readByte();
        events.push({
          type: 'controller', tick, channel, controller: controller as MusController,
          // MUS conversion masks instruments but saturates other controller values.
          value: controller === 0 ? rawValue & 127 : Math.min(rawValue, 127),
        });
        break;
      }
      case 6:
        events.push({ type: 'end', tick, channel });
        return { tickRate: 140, primaryChannels, secondaryChannels, instruments, events, durationTicks: tick };
      default:
        throw new Error(`Unsupported MUS event type ${type}`);
    }

    if ((descriptor & 128) !== 0) {
      let delay = 0;
      let part: number;
      do {
        part = readByte();
        delay = delay * 128 + (part & 127);
        if (!Number.isSafeInteger(delay)) throw new Error('MUS time code exceeds integer precision');
      } while ((part & 128) !== 0);
      tick += delay;
      if (!Number.isSafeInteger(tick)) throw new Error('MUS timestamp exceeds integer precision');
    }
  }
  throw new Error('MUS score is missing its end marker');
}
