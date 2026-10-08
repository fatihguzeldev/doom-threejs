import { describe, expect, it } from 'vitest';
import { findLump, mapLumps, parseWad, readLump } from '../../src/wad/archive';

interface FixtureLump {
  readonly name: string;
  readonly data?: readonly number[];
  readonly offset?: number;
  readonly size?: number;
}

const mapNames = [
  'THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS',
  'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP',
] as const;

function fixture(lumps: readonly FixtureLump[], kind = 'IWAD'): Uint8Array {
  const payloadSize = lumps.reduce((total, lump) => total + (lump.data?.length ?? 0), 0);
  const directory = 12 + payloadSize;
  const bytes = new Uint8Array(directory + lumps.length * 16);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(kind));
  view.setUint32(4, lumps.length, true);
  view.setUint32(8, directory, true);
  let offset = 12;
  lumps.forEach((lump, index) => {
    const data = lump.data ?? [];
    bytes.set(data, offset);
    const record = directory + index * 16;
    view.setUint32(record, lump.offset ?? offset, true);
    view.setUint32(record + 4, lump.size ?? data.length, true);
    bytes.set(new TextEncoder().encode(lump.name).subarray(0, 8), record + 8);
    offset += data.length;
  });
  return bytes;
}

describe('parseWad', () => {
  it.each(['IWAD', 'PWAD'])('reads a valid %s directory and payload', (kind) => {
    const bytes = fixture([{ name: 'PLAYPAL', data: [0, 127, 255] }], kind);
    const wad = parseWad(bytes);
    expect(wad.kind).toBe(kind);
    expect(wad.bytes).toBe(bytes);
    expect(wad.lumps).toEqual([{ name: 'PLAYPAL', offset: 12, size: 3 }]);
    const lump = findLump(wad, 'PLAYPAL');
    if (!lump) throw new Error('Fixture lump missing');
    expect([...readLump(wad, lump)]).toEqual([0, 127, 255]);
  });

  it('reads a byte view at an unaligned offset in a larger buffer', () => {
    const bytes = fixture([{ name: 'SAMPLE', data: [4, 5, 6] }]);
    const storage = new Uint8Array(bytes.length + 5);
    storage.set(bytes, 3);
    const wad = parseWad(storage.subarray(3, 3 + bytes.length));
    const lump = findLump(wad, 'SAMPLE');
    if (!lump) throw new Error('Fixture lump missing');
    expect([...readLump(wad, lump)]).toEqual([4, 5, 6]);
  });

  it('accepts an empty directory', () => {
    expect(parseWad(fixture([])).lumps).toEqual([]);
  });

  it('accepts zero-length markers with meaningless file positions', () => {
    const wad = parseWad(fixture([
      { name: 'S_START', offset: 0xffffffff },
      { name: 'S_END', offset: 0 },
    ]));
    for (const lump of wad.lumps) expect(readLump(wad, lump).length).toBe(0);
  });

  it.each([0, 4, 11])('rejects a truncated %i-byte header', (length) => {
    expect(() => parseWad(new Uint8Array(length))).toThrow(/header/i);
  });

  it('rejects a signature other than IWAD or PWAD', () => {
    expect(() => parseWad(fixture([], 'NOPE'))).toThrow(/IWAD.*PWAD/i);
  });

  it('rejects a directory offset beyond the file', () => {
    const bytes = fixture([]);
    new DataView(bytes.buffer).setUint32(8, bytes.length + 1, true);
    expect(() => parseWad(bytes)).toThrow(/directory/i);
  });

  it('rejects a directory overlapping the header', () => {
    const bytes = fixture([{ name: 'THING' }]);
    new DataView(bytes.buffer).setUint32(8, 4, true);
    expect(() => parseWad(bytes)).toThrow(/directory/i);
  });

  it('rejects a truncated directory record', () => {
    const bytes = fixture([{ name: 'ONE' }, { name: 'TWO' }]);
    expect(() => parseWad(bytes.subarray(0, bytes.length - 1))).toThrow(/directory/i);
  });

  it('rejects large directory arithmetic without wrapping to zero', () => {
    const bytes = fixture([]);
    new DataView(bytes.buffer).setUint32(4, 0x10000000, true);
    expect(() => parseWad(bytes)).toThrow(/directory/i);
  });

  it('rejects a nonempty lump beyond the file', () => {
    const bytes = fixture([{ name: 'BROKEN', offset: 0xffffffff, size: 1 }]);
    expect(() => parseWad(bytes)).toThrow(/BROKEN.*range/i);
  });

  it('rejects a lump whose end overflows a 32-bit sum', () => {
    const bytes = fixture([{ name: 'BROKEN', offset: 12, size: 0xfffffff8 }]);
    expect(() => parseWad(bytes)).toThrow(/BROKEN.*range/i);
  });

  it('preserves valid eight-character names', () => {
    expect(parseWad(fixture([{ name: 'ABCDEFGH' }])).lumps[0]?.name).toBe('ABCDEFGH');
  });

  it('ignores unused name bytes after the first NUL', () => {
    const bytes = fixture([{ name: 'NAME' }]);
    bytes[12 + 8 + 7] = 0xff;
    expect(parseWad(bytes).lumps[0]?.name).toBe('NAME');
  });

  it.each([0x1f, 0x7f, 0xff])('rejects invalid name byte %i before the terminator', (value) => {
    const bytes = fixture([{ name: 'NAME' }]);
    bytes[12 + 8] = value;
    expect(() => parseWad(bytes)).toThrow(/name.*ASCII/i);
  });
});

describe('lump lookup and reading', () => {
  it('returns the latest matching directory entry, ignoring case', () => {
    const wad = parseWad(fixture([
      { name: 'SW18_7', data: [1] },
      { name: 'OTHER', data: [2] },
      { name: 'sw18_7', data: [3] },
    ]));
    const lump = findLump(wad, 'Sw18_7');
    if (!lump) throw new Error('Fixture lump missing');
    expect([...readLump(wad, lump)]).toEqual([3]);
    expect(findLump(wad, 'MISSING')).toBeUndefined();
  });

  it('returns a payload view without copying the archive', () => {
    const wad = parseWad(fixture([{ name: 'DATA', data: [7, 8] }]));
    const lump = findLump(wad, 'DATA');
    if (!lump) throw new Error('Fixture lump missing');
    expect(readLump(wad, lump).buffer).toBe(wad.bytes.buffer);
  });

  it.each([
    { name: 'BAD', offset: -1, size: 1 },
    { name: 'BAD', offset: 1.5, size: 1 },
    { name: 'BAD', offset: 12, size: -1 },
    { name: 'BAD', offset: 12, size: 100 },
  ])('rejects an invalid caller-provided lump descriptor', (lump) => {
    expect(() => readLump(parseWad(fixture([])), lump)).toThrow(/range/i);
  });
});

describe('mapLumps', () => {
  it('selects map data relative to its marker, even when names repeat', () => {
    const wad = parseWad(fixture([
      { name: 'E1M1' },
      ...mapNames.map(name => ({ name, data: [1] })),
      { name: 'E1M2' },
      ...mapNames.map(name => ({ name, data: [2] })),
    ]));
    const first = mapLumps(wad, 'e1m1').get('THINGS');
    const second = mapLumps(wad, 'E1M2').get('THINGS');
    if (!first || !second) throw new Error('Fixture map data missing');
    expect([...readLump(wad, first)]).toEqual([1]);
    expect([...readLump(wad, second)]).toEqual([2]);
    expect([...mapLumps(wad, 'E1M1').keys()]).toEqual(mapNames);
  });

  it('selects the latest map marker in an override directory', () => {
    const wad = parseWad(fixture([
      { name: 'E1M1' },
      ...mapNames.map(name => ({ name, data: [1] })),
      { name: 'E1M1' },
      ...mapNames.map(name => ({ name, data: [9] })),
    ]));
    const lump = mapLumps(wad, 'E1M1').get('THINGS');
    if (!lump) throw new Error('Fixture map data missing');
    expect([...readLump(wad, lump)]).toEqual([9]);
  });

  it('rejects a missing map marker', () => {
    expect(() => mapLumps(parseWad(fixture([])), 'E1M1')).toThrow(/map.*E1M1.*not found/i);
  });

  it('rejects an incomplete map without using global matching lumps', () => {
    const wad = parseWad(fixture([
      { name: 'E1M1' },
      ...mapNames.map(name => ({ name })),
      { name: 'E1M2' },
      { name: 'THINGS' },
    ]));
    expect(() => mapLumps(wad, 'E1M2')).toThrow(/E1M2.*LINEDEFS/i);
  });

  it('rejects map entries interrupted by the next map marker', () => {
    const wad = parseWad(fixture([
      { name: 'E1M1' }, { name: 'THINGS' }, { name: 'E1M2' },
      ...mapNames.map(name => ({ name })),
    ]));
    expect(() => mapLumps(wad, 'E1M1')).toThrow(/E1M1.*LINEDEFS/i);
  });
});
