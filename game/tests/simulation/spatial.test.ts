import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap, type BBox, type DoomMap, type MapNode } from '../../src/wad/map';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import {
  boxOnLineSide, buildSpatialMap, findSubsector, pointOnLineSide,
  pointOnNodeSide, traceLines, type FixedLine, type FixedNode,
} from '../../src/simulation/spatial';

type Segment = readonly [readonly [number, number], readonly [number, number]];
const fixed = (value: number) => (value * FRAC_UNIT) | 0;
const emptyBox: BBox = { top: 0, bottom: 0, left: 0, right: 0 };

function map(segments: readonly Segment[], options: {
  readonly cells?: readonly (readonly number[])[];
  readonly width?: number;
  readonly height?: number;
  readonly nodes?: readonly MapNode[];
  readonly subsectorCount?: number;
  readonly originX?: number;
  readonly originY?: number;
} = {}): DoomMap {
  return {
    name: 'FIXTURE',
    vertices: segments.flatMap(segment => segment.map(([x, y]) => ({ x, y }))),
    lines: segments.map((_, index) => ({
      v1: index * 2, v2: index * 2 + 1, flags: 1, special: 0, tag: 0, frontSide: 0, backSide: null,
    })),
    sides: [{ textureOffset: 0, rowOffset: 0, upperTexture: '-', lowerTexture: '-', middleTexture: '-', sector: 0 }],
    sectors: [{ floorHeight: 0, ceilingHeight: 128, floorTexture: 'FLAT', ceilingTexture: 'FLAT', lightLevel: 255, special: 0, tag: 0 }],
    segs: [],
    subsectors: Array.from({ length: options.subsectorCount ?? 1 }, () => ({ firstSeg: 0, segCount: 0, sector: 0 })),
    nodes: options.nodes ?? [], things: [], reject: new Uint8Array([0]),
    blockmap: {
      originX: options.originX ?? 0, originY: options.originY ?? 0,
      width: options.width ?? 1, height: options.height ?? 1,
      cells: options.cells ?? [segments.map((_, index) => index)],
    },
  };
}

function line(segment: Segment): FixedLine {
  const value = buildSpatialMap(map([segment])).lines[0];
  if (!value) throw new Error('Fixture line missing');
  return value;
}

function node(x: number, y: number, dx: number, dy: number): FixedNode {
  return {
    x: fixed(x), y: fixed(y), dx: fixed(dx), dy: fixed(dy),
    boxes: [emptyBox, emptyBox], children: [0x8000, 0x8001],
  };
}

function box(left: number, right: number, bottom: number, top: number): BBox {
  return { left: fixed(left), right: fixed(right), bottom: fixed(bottom), top: fixed(top) };
}

describe('buildSpatialMap', () => {
  it('converts coordinates and origins to 16.16, retaining indices and metadata', () => {
    const source = map([[[-10, 20], [30, -40]]], { originX: -512, originY: 256 });
    const spatial = buildSpatialMap(source);
    expect(spatial.map).toBe(source);
    expect(spatial.vertices).toEqual([{ x: fixed(-10), y: fixed(20) }, { x: fixed(30), y: fixed(-40) }]);
    expect(spatial.lines).toEqual([{
      v1: 0, v2: 1, x: fixed(-10), y: fixed(20), dx: fixed(40), dy: fixed(-60),
      flags: 1, special: 0, tag: 0, frontSector: 0, backSector: null,
      bbox: box(-10, 30, -40, 20),
    }]);
    expect(spatial.blockOriginX).toBe(fixed(-512));
    expect(spatial.blockOriginY).toBe(fixed(256));
  });

  it('wraps vertex subtraction to signed 32-bit arithmetic', () => {
    const spatial = buildSpatialMap(map([[[-32768, 0], [32767, 0]]]));
    expect(spatial.lines[0]?.dx).toBe(-FRAC_UNIT);
  });
});

describe('original line and node side tests', () => {
  it('retains the vertical line boundary and reversed-direction rules', () => {
    const north = line([[0, -64], [0, 64]]);
    const south = line([[0, 64], [0, -64]]);
    expect(pointOnLineSide(0, 0, north)).toBe(1);
    expect(pointOnLineSide(fixed(-1), 0, north)).toBe(1);
    expect(pointOnLineSide(fixed(1), 0, north)).toBe(0);
    expect(pointOnLineSide(0, 0, south)).toBe(0);
    expect(pointOnLineSide(fixed(1), 0, south)).toBe(1);
  });

  it('retains the horizontal line boundary and reversed-direction rules', () => {
    const east = line([[-64, 0], [64, 0]]);
    const west = line([[64, 0], [-64, 0]]);
    expect(pointOnLineSide(0, 0, east)).toBe(0);
    expect(pointOnLineSide(0, fixed(1), east)).toBe(1);
    expect(pointOnLineSide(0, fixed(-1), west)).toBe(1);
    expect(pointOnLineSide(0, 0, west)).toBe(1);
  });

  it('retains the diagonal tie rule and fixed sub-unit precision', () => {
    const diagonal = line([[0, 0], [64, 64]]);
    expect(pointOnLineSide(fixed(32), fixed(32), diagonal)).toBe(1);
    expect(pointOnLineSide(fixed(32), fixed(32) - 1024, diagonal)).toBe(0);
    expect(pointOnLineSide(fixed(32), fixed(32) + 1024, diagonal)).toBe(1);
    expect(pointOnNodeSide(fixed(32), fixed(32), node(0, 0, 64, 64))).toBe(1);
  });

  it('uses the BSP sign shortcut for opposite-sign distances', () => {
    const partition = node(0, 0, 32767, 32767);
    expect(pointOnNodeSide(fixed(32767), fixed(-32768), partition)).toBe(0);
    expect(pointOnNodeSide(fixed(-32768), fixed(32767), partition)).toBe(1);
  });

  it('keeps box boundaries distinct from point boundaries on vertical lines', () => {
    const vertical = line([[0, -64], [0, 64]]);
    expect(boxOnLineSide(box(0, 0, -1, 1), vertical)).toBe(0);
    expect(boxOnLineSide(box(-2, -1, -1, 1), vertical)).toBe(1);
    expect(boxOnLineSide(box(-1, 1, -1, 1), vertical)).toBe(-1);
  });

  it('classifies boxes on horizontal and both diagonal slope directions', () => {
    expect(boxOnLineSide(box(-1, 1, 1, 2), line([[-64, 0], [64, 0]]))).toBe(1);
    expect(boxOnLineSide(box(-1, 1, -1, 1), line([[-64, 0], [64, 0]]))).toBe(-1);
    expect(boxOnLineSide(box(1, 2, 4, 5), line([[0, 0], [64, 64]]))).toBe(1);
    expect(boxOnLineSide(box(1, 2, 1, 2), line([[0, 0], [64, 64]]))).toBe(-1);
    expect(boxOnLineSide(box(1, 2, 1, 2), line([[0, 0], [64, -64]]))).toBe(1);
    expect(boxOnLineSide(box(-1, 1, -1, 1), line([[0, 0], [64, -64]]))).toBe(-1);
  });
});

describe('findSubsector', () => {
  it('uses the last BSP node as the root and follows the original boundary tie', () => {
    const partition: MapNode = { x: 0, y: 0, dx: 0, dy: 64, boxes: [emptyBox, emptyBox], children: [0x8000, 0x8001] };
    const spatial = buildSpatialMap(map([], { nodes: [partition], subsectorCount: 2 }));
    expect(findSubsector(spatial, fixed(1), 0)).toBe(0);
    expect(findSubsector(spatial, fixed(-1), 0)).toBe(1);
    expect(findSubsector(spatial, 0, 0)).toBe(1);
  });

  it('returns the single subsector when a map has no BSP nodes', () => {
    expect(findSubsector(buildSpatialMap(map([])), fixed(123), fixed(-456))).toBe(0);
  });

  it('locates the actual player start in every shareware map', () => {
    const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
    const expected = [103, 246, 168, 186, 133, 349, 143, 16, 196];
    for (let index = 0; index < 9; index++) {
      const source = decodeMap(wad, `E1M${index + 1}`);
      const player = source.things.find(thing => thing.type === 1);
      if (!player) throw new Error('Player start missing');
      expect(findSubsector(buildSpatialMap(source), fixed(player.x), fixed(player.y))).toBe(expected[index]);
    }
  });
});

describe('original blockmap line traversal', () => {
  it.each([[16, 112], [112, 16]])('finds an axis crossing from %i to %i', (from, to) => {
    const spatial = buildSpatialMap(map([[[64, 0], [64, 128]]]));
    expect(traceLines(spatial, fixed(from), fixed(64), fixed(to), fixed(64))).toEqual([{ line: 0, fraction: FRAC_UNIT / 2 }]);
  });

  it('uses the short-trace side test within sixteen map units', () => {
    const spatial = buildSpatialMap(map([[[16, 0], [16, 128]]]));
    expect(traceLines(spatial, fixed(12), fixed(64), fixed(20), fixed(64))).toEqual([{ line: 0, fraction: FRAC_UNIT / 2 }]);
  });

  it('filters intersections behind the origin and beyond the endpoint', () => {
    const spatial = buildSpatialMap(map([[[0, 0], [0, 128]], [[128, 0], [128, 128]]]));
    expect(traceLines(spatial, fixed(16), fixed(64), fixed(112), fixed(64))).toEqual([]);
  });

  it('retains exact origin and endpoint intercepts', () => {
    const spatial = buildSpatialMap(map([[[16, 0], [16, 128]], [[112, 0], [112, 128]]]));
    expect(traceLines(spatial, fixed(16), fixed(64), fixed(112), fixed(64))).toEqual([
      { line: 0, fraction: 0 }, { line: 1, fraction: FRAC_UNIT },
    ]);
  });

  it('retains the original line-endpoint asymmetry', () => {
    const spatial = buildSpatialMap(map([[[64, 64], [64, 96]], [[64, 32], [64, 64]]]));
    expect(traceLines(spatial, fixed(16), fixed(64), fixed(112), fixed(64))).toEqual([{ line: 0, fraction: FRAC_UNIT / 2 }]);
  });

  it('consumes vanilla dummy line zero first, preserving equal-fraction order', () => {
    const spatial = buildSpatialMap(map([
      [[64, 0], [64, 128]], [[64, 0], [64, 128]], [[64, 128], [64, 0]],
    ], { cells: [[2, 1]] }));
    expect(traceLines(spatial, fixed(16), fixed(64), fixed(112), fixed(64))).toEqual([
      { line: 0, fraction: 32768 }, { line: 2, fraction: 32768 }, { line: 1, fraction: 32768 },
    ]);
  });

  it('walks blocks in original order, deduplicates lines and sorts by distance', () => {
    const spatial = buildSpatialMap(map([
      [[-32, 0], [-32, 128]], [[300, 0], [300, 128]],
      [[64, 0], [64, 128]], [[200, 0], [200, 128]],
    ], { width: 3, cells: [[1, 2], [3], [1]] }));
    expect(traceLines(spatial, fixed(16), fixed(64), fixed(368), fixed(64)).map(intercept => intercept.line)).toEqual([2, 3, 1]);
  });

  it('nudges a grid-boundary origin by one map unit before tracing', () => {
    const spatial = buildSpatialMap(map([[[192, 0], [192, 128]]], { width: 3, cells: [[], [0], [0]] }));
    expect(traceLines(spatial, fixed(128), fixed(64), fixed(256), fixed(64))).toEqual([{ line: 0, fraction: 32509 }]);
  });

  it('does not inspect lines when all visited blocks are outside map bounds', () => {
    const spatial = buildSpatialMap(map([[[-64, 0], [-64, 128]]]));
    expect(traceLines(spatial, fixed(-112), fixed(64), fixed(-16), fixed(64))).toEqual([]);
  });

  it('preserves the vanilla 64-block traversal guard', () => {
    const cells = Array.from({ length: 66 }, (_, index) => index === 64 ? [1] : []);
    const spatial = buildSpatialMap(map([
      [[-32, 0], [-32, 128]], [[8256, 0], [8256, 128]],
    ], { width: 66, cells }));
    expect(traceLines(spatial, fixed(16), fixed(64), fixed(8384), fixed(64))).toEqual([]);
  });

  it('preserves vanilla diagonal grid-corner rounding behavior', () => {
    const spatial = buildSpatialMap(map([
      [[-32, 0], [-32, 128]], [[160, 0], [160, 256]],
    ], { width: 2, height: 2, cells: [[], [], [], [1]] }));
    expect(traceLines(spatial, fixed(64), fixed(64), fixed(192), fixed(192))).toEqual([]);
  });
});
