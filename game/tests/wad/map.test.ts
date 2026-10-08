import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';

const lumpNames = [
  'THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS',
  'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP',
] as const;
type MapLumpName = typeof lumpNames[number];

function words(...values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return bytes;
}

function join(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function name(value: string): Uint8Array {
  const bytes = new Uint8Array(8);
  bytes.set(new TextEncoder().encode(value));
  return bytes;
}

function sector(): Uint8Array {
  return join(words(-24, 128), name('FLOOR0_1'), name('CEIL1_1'), words(192, 9, 7));
}

function side(sectorIndex = 0): Uint8Array {
  return join(words(-16, -8), name('TOP'), name('BOTTOM'), name('MID'), words(sectorIndex));
}

function node(firstChild: number, secondChild: number): Uint8Array {
  return words(-7, 11, -32, 16, 128, -128, -256, 256, 64, -64, -96, 96, firstChild, secondChild);
}

function defaults(): Record<MapLumpName, Uint8Array> {
  return {
    THINGS: words(-15, 21, 90, 1, 7),
    LINEDEFS: words(0, 1, 1, 0, 4, 0, 0xffff),
    SIDEDEFS: side(),
    VERTEXES: words(-10, 20, 30, -40),
    SEGS: words(0, 1, 0x8000, 0, 0, -32),
    SSECTORS: words(1, 0),
    NODES: new Uint8Array(),
    SECTORS: sector(),
    REJECT: new Uint8Array([0]),
    BLOCKMAP: words(-512, 256, 1, 1, 5, 0, 0, 0xffff),
  };
}

function fixture(changes: Partial<Record<MapLumpName, Uint8Array>> = {}) {
  const lumps = defaults();
  Object.assign(lumps, changes);
  const payload = join(...lumpNames.map(lumpName => lumps[lumpName]));
  const bytes = new Uint8Array(12 + payload.length + 11 * 16);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('IWAD'));
  view.setUint32(4, 11, true);
  view.setUint32(8, 12 + payload.length, true);
  bytes.set(payload, 12);
  bytes.set(name('E1M1'), 12 + payload.length + 8);
  let offset = 12;
  lumpNames.forEach((lumpName, index) => {
    const record = 12 + payload.length + (index + 1) * 16;
    view.setUint32(record, offset, true);
    view.setUint32(record + 4, lumps[lumpName].length, true);
    bytes.set(name(lumpName), record + 8);
    offset += lumps[lumpName].length;
  });
  return parseWad(bytes);
}

function changeWord(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const result = bytes.slice();
  new DataView(result.buffer).setUint16(offset, value, true);
  return result;
}

describe('decodeMap', () => {
  it('decodes signed map coordinates, heights and offsets without fixed-point conversion', () => {
    const map = decodeMap(fixture(), 'E1M1');
    expect(map.vertices).toEqual([{ x: -10, y: 20 }, { x: 30, y: -40 }]);
    expect(map.sectors).toEqual([{
      floorHeight: -24, ceilingHeight: 128, floorTexture: 'FLOOR0_1',
      ceilingTexture: 'CEIL1_1', lightLevel: 192, special: 9, tag: 7,
    }]);
    expect(map.sides).toEqual([{
      textureOffset: -16, rowOffset: -8, upperTexture: 'TOP',
      lowerTexture: 'BOTTOM', middleTexture: 'MID', sector: 0,
    }]);
    expect(map.segs).toEqual([{ v1: 0, v2: 1, angle: 0x8000, line: 0, side: 0, offset: -32 }]);
    expect(map.things).toEqual([{ x: -15, y: 21, angle: 90, type: 1, flags: 7 }]);
  });

  it('decodes unsigned flags and types, and the absent-back-side sentinel', () => {
    const map = decodeMap(fixture({ THINGS: words(0, 0, 0xffff, 0xffff, 0xffff) }), 'E1M1');
    expect(map.lines).toEqual([{ v1: 0, v2: 1, flags: 1, special: 0, tag: 4, frontSide: 0, backSide: null }]);
    expect(map.things[0]).toMatchObject({ angle: 0xffff, type: 0xffff, flags: 0xffff });
    expect(map.subsectors).toEqual([{ firstSeg: 0, segCount: 1, sector: 0 }]);
  });

  it('preserves BSP bounding-box order and unsigned leaf children', () => {
    const map = decodeMap(fixture({ NODES: node(0x8000, 0x8000) }), 'E1M1');
    expect(map.nodes).toEqual([{
      x: -7, y: 11, dx: -32, dy: 16,
      boxes: [
        { top: 128, bottom: -128, left: -256, right: 256 },
        { top: 64, bottom: -64, left: -96, right: 96 },
      ],
      children: [0x8000, 0x8000],
    }]);
  });

  it('decodes blockmap origins and excludes list headers and terminators', () => {
    const map = decodeMap(fixture(), 'E1M1');
    expect(map.blockmap).toEqual({ originX: -512, originY: 256, width: 1, height: 1, cells: [[0]] });
    expect([...map.reject]).toEqual([0]);
  });

  it('decodes empty and shared blockmap cell lists', () => {
    const map = decodeMap(fixture({ BLOCKMAP: words(0, 0, 3, 1, 7, 7, 10, 0, 0, 0xffff, 0, 0xffff) }), 'E1M1');
    expect(map.blockmap.cells).toEqual([[0], [0], []]);
  });

  it.each([
    ['THINGS', 10], ['LINEDEFS', 14], ['SIDEDEFS', 30], ['VERTEXES', 4],
    ['SEGS', 12], ['SSECTORS', 4], ['NODES', 28], ['SECTORS', 26],
  ] as const)('rejects a truncated %s record', (lumpName, size) => {
    expect(() => decodeMap(fixture({ [lumpName]: new Uint8Array(size - 1) }), 'E1M1')).toThrow(new RegExp(`${lumpName}.*record`, 'i'));
  });

  it.each([
    { lumpName: 'LINEDEFS', offset: 0, value: 2, error: 'vertex' },
    { lumpName: 'LINEDEFS', offset: 2, value: 2, error: 'vertex' },
    { lumpName: 'LINEDEFS', offset: 10, value: 1, error: 'side' },
    { lumpName: 'LINEDEFS', offset: 12, value: 1, error: 'side' },
    { lumpName: 'SIDEDEFS', offset: 28, value: 1, error: 'sector' },
    { lumpName: 'SEGS', offset: 0, value: 2, error: 'vertex' },
    { lumpName: 'SEGS', offset: 6, value: 1, error: 'line' },
    { lumpName: 'SEGS', offset: 8, value: 2, error: 'side' },
  ] as const)('rejects an out-of-range $lumpName reference at byte $offset', ({ lumpName, offset, value, error }) => {
    const bytes = changeWord(defaults()[lumpName], offset, value);
    expect(() => decodeMap(fixture({ [lumpName]: bytes }), 'E1M1')).toThrow(new RegExp(error, 'i'));
  });

  it('rejects a segment selecting an absent back side', () => {
    expect(() => decodeMap(fixture({ SEGS: words(0, 1, 0, 0, 1, 0) }), 'E1M1')).toThrow(/seg.*back side/i);
  });

  it.each([words(0, 0), words(2, 0), words(1, 1)])('rejects an invalid subsector segment span', (bytes) => {
    expect(() => decodeMap(fixture({ SSECTORS: bytes }), 'E1M1')).toThrow(/subsector.*seg/i);
  });

  it('rejects subsector segments belonging to different sectors', () => {
    const wad = fixture({
      SECTORS: join(sector(), sector()),
      SIDEDEFS: join(side(0), side(1)),
      LINEDEFS: words(0, 1, 4, 0, 0, 0, 1),
      SEGS: join(words(0, 1, 0, 0, 0, 0), words(1, 0, 0, 0, 1, 0)),
      SSECTORS: words(2, 0),
    });
    expect(() => decodeMap(wad, 'E1M1')).toThrow(/subsector.*sector/i);
  });

  it.each([0x8001, 1])('rejects an invalid BSP child %i', (child) => {
    expect(() => decodeMap(fixture({ NODES: node(child, 0x8000) }), 'E1M1')).toThrow(/BSP.*child/i);
  });

  it('rejects a self-referencing BSP node', () => {
    expect(() => decodeMap(fixture({ NODES: node(0, 0x8000) }), 'E1M1')).toThrow(/BSP.*cycle/i);
  });

  it('rejects cycles between BSP nodes', () => {
    const wad = fixture({ NODES: join(node(1, 0x8000), node(0, 0x8000)) });
    expect(() => decodeMap(wad, 'E1M1')).toThrow(/BSP.*cycle/i);
  });

  it('validates deep BSP trees without using the call stack', () => {
    const count = 20000;
    const nodes = join(...Array.from({ length: count }, (_, index) => node(index === 0 ? 0x8000 : index - 1, 0x8000)));
    expect(decodeMap(fixture({ NODES: nodes }), 'E1M1').nodes.length).toBe(count);
  });

  it('rejects more than one subsector without a BSP tree', () => {
    expect(() => decodeMap(fixture({ SSECTORS: join(words(1, 0), words(1, 0)) }), 'E1M1')).toThrow(/BSP.*root/i);
  });

  it('rejects a truncated blockmap header', () => {
    expect(() => decodeMap(fixture({ BLOCKMAP: new Uint8Array(7) }), 'E1M1')).toThrow(/blockmap.*header/i);
  });

  it('rejects odd-sized blockmap data', () => {
    expect(() => decodeMap(fixture({ BLOCKMAP: new Uint8Array(9) }), 'E1M1')).toThrow(/blockmap.*word/i);
  });

  it.each([words(0, 0, 0, 1), words(0, 0, 0xffff, 0xffff)])('rejects invalid blockmap dimensions', (bytes) => {
    expect(() => decodeMap(fixture({ BLOCKMAP: bytes }), 'E1M1')).toThrow(/blockmap.*dimensions/i);
  });

  it.each([0, 4, 8, 0xffff])('rejects blockmap list offset %i', (offset) => {
    expect(() => decodeMap(fixture({ BLOCKMAP: words(0, 0, 1, 1, offset, 0, 0, 0xffff) }), 'E1M1')).toThrow(/blockmap.*offset/i);
  });

  it('rejects a blockmap list without its leading zero', () => {
    expect(() => decodeMap(fixture({ BLOCKMAP: words(0, 0, 1, 1, 5, 1, 0xffff) }), 'E1M1')).toThrow(/blockmap.*zero/i);
  });

  it('rejects a blockmap list without a terminator', () => {
    expect(() => decodeMap(fixture({ BLOCKMAP: words(0, 0, 1, 1, 5, 0, 0) }), 'E1M1')).toThrow(/blockmap.*terminator/i);
  });

  it('rejects invalid blockmap line references', () => {
    expect(() => decodeMap(fixture({ BLOCKMAP: words(0, 0, 1, 1, 5, 0, 1, 0xffff) }), 'E1M1')).toThrow(/blockmap.*line/i);
  });

  it('bounds work and storage for many overlapping blockmap list tails', () => {
    const offsets = Array.from({ length: 256 }, (_, index) => 260 + index);
    const zeros = Array.from({ length: 300 }, () => 0);
    const wad = fixture({ BLOCKMAP: words(0, 0, 256, 1, ...offsets, ...zeros, 0xffff) });
    expect(() => decodeMap(wad, 'E1M1')).toThrow(/blockmap.*budget/i);
  });

  it('rejects a REJECT matrix shorter than its sector count requires', () => {
    expect(() => decodeMap(fixture({ SECTORS: join(sector(), sector(), sector()) }), 'E1M1')).toThrow(/REJECT.*2 bytes/i);
  });

  it('decodes every map in the canonical Doom shareware IWAD', () => {
    const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
    const maps = Array.from({ length: 9 }, (_, index) => decodeMap(wad, `E1M${index + 1}`));
    expect(maps.map(map => map.name)).toEqual(['E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8', 'E1M9']);
    expect(maps[0]?.vertices.length).toBe(467);
    expect(maps[0]?.sectors.length).toBe(85);
    expect(maps[5]?.lines.length).toBe(1352);
    expect(maps[7]?.things.length).toBe(126);
  });
});
