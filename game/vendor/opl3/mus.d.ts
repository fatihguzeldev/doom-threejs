import type { GenMidiInstrument } from '../../src/audio/genmidi';
import type OPL3 from './opl3.js';
export default class MUS {
  constructor(opl: OPL3, options: { instruments: readonly GenMidiInstrument[] });
  MLtime: number;
  load(data: Uint8Array): void;
  rewind(): void;
  OPLplayNote(channel: number, note: number, volume: number): void;
  OPLreleaseNote(channel: number, note: number): void;
  OPLpitchWheel(channel: number, pitch: number): void;
  OPLchangeControl(channel: number, controller: number, value: number): void;
  OPLprogramChange(channel: number, value: number): void;
  OPLresetControllers(channel: number, volume: number): void;
  OPLstopMusic(): void;
}
