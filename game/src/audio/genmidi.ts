export interface GenMidiVoice {
  readonly modulatorTremolo: number;
  readonly modulatorAttack: number;
  readonly modulatorSustain: number;
  readonly modulatorWaveform: number;
  readonly modulatorKey: number;
  readonly modulatorOutput: number;
  readonly feedback: number;
  readonly carrierTremolo: number;
  readonly carrierAttack: number;
  readonly carrierSustain: number;
  readonly carrierWaveform: number;
  readonly carrierKey: number;
  readonly carrierOutput: number;
  readonly baseNoteOffset: number;
}

export interface GenMidiInstrument {
  readonly name: string;
  readonly flags: number;
  readonly fixedPitch: boolean;
  readonly doubleVoice: boolean;
  readonly fineTuning: number;
  readonly fixedNote: number;
  readonly voices: readonly [GenMidiVoice, GenMidiVoice];
}

// GENMIDI consists of 128 melodic and 47 percussion instruments, two 16-byte
// operator voices each: https://github.com/doomjs/wad-genmidi/blob/master/genmidi.js
export function decodeGenMidi(bytes: Uint8Array): readonly GenMidiInstrument[] {
  const bankEnd = 8 + 175 * 36;
  if (bytes.length < bankEnd) throw new Error('Truncated GENMIDI instrument bank');
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== '#OPL_II#') {
    throw new Error('Invalid GENMIDI signature');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function voice(offset: number): GenMidiVoice {
    return {
      modulatorTremolo: view.getUint8(offset), modulatorAttack: view.getUint8(offset + 1),
      modulatorSustain: view.getUint8(offset + 2), modulatorWaveform: view.getUint8(offset + 3),
      modulatorKey: view.getUint8(offset + 4), modulatorOutput: view.getUint8(offset + 5),
      feedback: view.getUint8(offset + 6), carrierTremolo: view.getUint8(offset + 7),
      carrierAttack: view.getUint8(offset + 8), carrierSustain: view.getUint8(offset + 9),
      carrierWaveform: view.getUint8(offset + 10), carrierKey: view.getUint8(offset + 11),
      carrierOutput: view.getUint8(offset + 12), baseNoteOffset: view.getInt16(offset + 14, true),
    };
  }
  return Array.from({ length: 175 }, (_, index) => {
    const offset = 8 + index * 36;
    const flags = view.getUint16(offset, true);
    const nameBytes = bytes.subarray(bankEnd + index * 32, bankEnd + (index + 1) * 32);
    const zero = nameBytes.indexOf(0);
    return {
      name: new TextDecoder().decode(zero < 0 ? nameBytes : nameBytes.subarray(0, zero)),
      flags, fixedPitch: (flags & 1) !== 0, doubleVoice: (flags & 4) !== 0,
      fineTuning: view.getUint8(offset + 2), fixedNote: view.getUint8(offset + 3),
      voices: [voice(offset + 4), voice(offset + 20)] as const,
    };
  });
}
