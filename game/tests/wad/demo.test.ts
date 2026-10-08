import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeDemo } from '../../src/wad/demo';
import { findLump, parseWad, readLump } from '../../src/wad/archive';

const baseHeader = [109, 2, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0];
function fixture(commands: readonly number[] = [], changes: Readonly<Record<number, number>> = {}): Uint8Array {
  const header = [...baseHeader];
  for (const [offset, value] of Object.entries(changes)) header[Number(offset)] = value;
  return Uint8Array.from([...header, ...commands, 0x80]);
}

describe('classic Doom demo decoding', () => {
  it.each([109, 110])('reads the original 13-byte version %i header', version => {
    const demo = decodeDemo(fixture([], { 0: version, 1: 4, 2: 4, 3: 9, 4: 2, 5: 1, 6: 1, 7: 1 }));
    expect(demo.header).toEqual({ version, skill: 4, episode: 4, mapNumber: 9,
      deathmatch: 2, respawn: true, fast: true, noMonsters: true,
      consolePlayer: 0, playersActive: [true, false, false, false] });
    expect(demo.tics).toEqual([]);
  });

  it('decodes signed movement and short-angle commands without treating payload 0x80 as a marker', () => {
    const demo = decodeDemo(fixture([0x7f, 0x80, 0x80, 0x80, 0x81, 0xff, 0xff, 0xff]));
    expect(demo.tics).toEqual([
      [{ player: 0, command: { forwardMove: 127, sideMove: -128, angleTurn: -32768, buttons: 128 } }],
      [{ player: 0, command: { forwardMove: -127, sideMove: -1, angleTurn: -256, buttons: 255 } }],
    ]);
  });

  it('preserves per-tic player slots and ascending active-player command order', () => {
    const demo = decodeDemo(fixture([
      1, 2, 3, 4, 5, 6, 7, 8,
      9, 10, 11, 12, 13, 14, 15, 16,
    ], { 8: 3, 9: 0, 10: 1, 12: 1 }));
    expect(demo.header.playersActive).toEqual([false, true, false, true]);
    expect(demo.header.consolePlayer).toBe(3);
    expect(demo.tics).toEqual([
      [
        { player: 1, command: { forwardMove: 1, sideMove: 2, angleTurn: 3 * 256, buttons: 4 } },
        { player: 3, command: { forwardMove: 5, sideMove: 6, angleTurn: 7 * 256, buttons: 8 } },
      ],
      [
        { player: 1, command: { forwardMove: 9, sideMove: 10, angleTurn: 11 * 256, buttons: 12 } },
        { player: 3, command: { forwardMove: 13, sideMove: 14, angleTurn: 15 * 256, buttons: 16 } },
      ],
    ]);
  });

  it('reads a sliced lump with a nonzero byte offset and does not mutate it', () => {
    const bytes = fixture([50, 0, 127, 1]), storage = new Uint8Array(bytes.length + 9);
    storage.set(bytes, 5);
    const view = storage.subarray(5, 5 + bytes.length), copy = view.slice();
    expect(decodeDemo(view).tics[0]?.[0]?.command.angleTurn).toBe(32512);
    expect(view).toEqual(copy);
  });

  it('stops at the original command-start marker and ignores unused bytes after it', () => {
    const bytes = Uint8Array.from([...fixture([1, 2, 3, 4]), 1, 2, 3]);
    expect(decodeDemo(bytes).tics).toHaveLength(1);
  });

  it.each([0, 1, 12])('rejects a truncated %i-byte header', length => {
    expect(() => decodeDemo(new Uint8Array(length))).toThrow(/header/i);
  });

  it.each([0, 104, 108, 111, 255])('rejects unsupported demo version %i', version => {
    expect(() => decodeDemo(fixture([], { 0: version }))).toThrow(/version.*109.*110/i);
  });

  it.each([
    [1, 5, 'skill'], [2, 0, 'episode'], [2, 5, 'episode'], [3, 0, 'map'], [3, 10, 'map'],
    [4, 3, 'deathmatch'], [8, 4, 'console player'],
  ] as const)('rejects out-of-range header byte %i=%i', (offset, value, field) => {
    expect(() => decodeDemo(fixture([], { [offset]: value }))).toThrow(new RegExp(field, 'i'));
  });

  it.each([5, 6, 7, 9, 10, 11, 12])('rejects invalid boolean header byte at %i', offset => {
    expect(() => decodeDemo(fixture([], { [offset]: 2 }))).toThrow(/flag/i);
  });

  it('rejects a header with no active players or an inactive console player', () => {
    expect(() => decodeDemo(fixture([], { 9: 0 }))).toThrow(/active player/i);
    expect(() => decodeDemo(fixture([], { 8: 1 }))).toThrow(/console player.*inactive/i);
  });

  it('requires an end marker after a complete final command', () => {
    const bytes = fixture([1, 2, 3, 4]);
    expect(() => decodeDemo(bytes.subarray(0, bytes.length - 1))).toThrow(/end marker/i);
    expect(() => decodeDemo(Uint8Array.from(baseHeader))).toThrow(/end marker/i);
  });

  it.each([1, 2, 3])('rejects a command payload with only %i bytes', length => {
    const bytes = Uint8Array.from([...baseHeader, ...[1, 2, 3].slice(0, length)]);
    expect(() => decodeDemo(bytes)).toThrow(/truncated.*command/i);
  });

  it('rejects an end marker between player commands in a multiplayer tic', () => {
    expect(() => decodeDemo(fixture([1, 2, 3, 4], { 10: 1 }))).toThrow(/incomplete.*tic/i);
  });

  it('accepts all four player slots without flattening their commands', () => {
    const bytes = fixture(Array.from({ length: 16 }, (_, index) => index), { 10: 1, 11: 1, 12: 1 });
    expect(decodeDemo(bytes).tics.map(tic => tic.map(command => command.player))).toEqual([[0, 1, 2, 3]]);
  });
});

describe('bundled original demos', () => {
  const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
  it.each([['DEMO1', 5, 5026], ['DEMO2', 3, 3836], ['DEMO3', 7, 2134]] as const)
  ('decodes the verified %s header and complete command count', (name, mapNumber, count) => {
    const lump = findLump(wad, name);
    if (!lump) throw new Error(`Missing fixture ${name}`);
    const demo = decodeDemo(readLump(wad, lump));
    expect(demo.header).toEqual({ version: 109, skill: 2, episode: 1, mapNumber,
      deathmatch: 0, respawn: false, fast: false, noMonsters: false,
      consolePlayer: 0, playersActive: [true, false, false, false] });
    expect(demo.tics).toHaveLength(count);
    expect(demo.tics.every(tic => tic.length === 1 && tic[0]?.player === 0)).toBe(true);
  });
});
