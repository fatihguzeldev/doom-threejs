import OPL3 from '../../vendor/opl3/opl3.js';
import MUS from '../../vendor/opl3/mus.js';
import { decodeGenMidi } from './genmidi';
import { decodeMus } from './mus';
import type { MusEvent } from './mus';

export const OPL_SAMPLE_RATE = 49700;
const FRAMES_PER_MUS_TICK = OPL_SAMPLE_RATE / 140;

export interface MusDriver {
  MLtime: number;
  OPLplayNote(channel: number, note: number, volume: number): void;
  OPLreleaseNote(channel: number, note: number): void;
  OPLpitchWheel(channel: number, pitch: number): void;
  OPLchangeControl(channel: number, controller: number, value: number): void;
  OPLprogramChange(channel: number, value: number): void;
  OPLresetControllers(channel: number, volume: number): void;
  OPLstopMusic(): void;
}

export function applyMusEvent(driver: MusDriver, event: MusEvent): void {
  driver.MLtime = event.tick;
  switch (event.type) {
    case 'noteOn': driver.OPLplayNote(event.channel, event.note, event.velocity); break;
    case 'noteOff': driver.OPLreleaseNote(event.channel, event.note); break;
    case 'pitchBend': driver.OPLpitchWheel(event.channel, event.value * 64); break;
    case 'controller':
      if (event.controller === 0) driver.OPLprogramChange(event.channel, event.value);
      else driver.OPLchangeControl(event.channel, event.controller, event.value);
      break;
    case 'system':
      // MUS system events 10..14 translate to MIDI 120,123,126,127,121.
      // Apply them here: the upstream raw MUS parser only emits MIDI metadata.
      if (event.system === 14) driver.OPLresetControllers(event.channel, 100);
      else driver.OPLchangeControl(event.channel, event.system + 6, 0);
      break;
    case 'end': driver.OPLstopMusic(); break;
  }
}

export interface MusicChunk {
  readonly samples: Float32Array<ArrayBuffer>;
  readonly ended: boolean;
}

export interface MusicRenderer { render(frames: number): MusicChunk }

export function createMusicRenderer(musBytes: Uint8Array, genMidiBytes: Uint8Array,
  loop: boolean): MusicRenderer {
  const score = decodeMus(musBytes);
  const instruments = decodeGenMidi(genMidiBytes);
  // Vendor load() takes a whole ArrayBuffer; copy a WAD subarray to its origin.
  const source = new Uint8Array(musBytes);
  let chip: OPL3;
  let driver: MUS;
  let eventIndex = 0;
  let frame = 0;
  let ended = score.durationTicks === 0;

  function rewind(): void {
    chip = new OPL3();
    driver = new MUS(chip, { instruments });
    driver.load(source);
    eventIndex = 0;
    frame = 0;
  }
  rewind();

  return { render(frames): MusicChunk {
    if (!Number.isInteger(frames) || frames < 0 || frames > OPL_SAMPLE_RATE * 10) {
      throw new Error('Invalid OPL chunk frame count');
    }
    const output = new Float32Array(frames * 2);
    let written = 0;
    while (written < frames && !ended) {
      let event = score.events[eventIndex];
      while (event && event.tick * FRAMES_PER_MUS_TICK <= frame) {
        applyMusEvent(driver, event);
        eventIndex++;
        if (event.type === 'end') {
          if (loop) rewind();
          else ended = true;
          break;
        }
        event = score.events[eventIndex];
      }
      if (ended) break;
      const next = score.events[eventIndex];
      if (!next) { ended = true; break; }
      const count = Math.min(frames - written, next.tick * FRAMES_PER_MUS_TICK - frame);
      if (count === 0) continue;
      chip.read(output.subarray(written * 2, (written + count) * 2));
      written += count;
      frame += count;
    }
    // A chunk ending exactly on score end still reports completion immediately.
    if (!ended && !loop && frame === score.durationTicks * FRAMES_PER_MUS_TICK) {
      applyMusEvent(driver, { type: 'end', channel: 0, tick: score.durationTicks });
      ended = true;
    }
    return { samples: written === frames ? output : output.slice(0, written * 2), ended };
  } };
}
