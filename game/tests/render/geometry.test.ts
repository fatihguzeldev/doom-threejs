import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { buildSpatialMap, findSubsector } from '../../src/simulation/spatial';
import { createWorld } from '../../src/simulation/world';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import type { BBox, DoomMap, MapNode, MapSector, Vertex } from '../../src/wad/map';
import { createResources } from '../../src/wad/resources';
import { buildSubsectorPolygons, wallQuads } from '../../src/render/geometry';

const sector = (floorHeight = 0, ceilingHeight = 128): MapSector => ({
  floorHeight, ceilingHeight, floorTexture: 'FLAT', ceilingTexture: 'FLAT',
  lightLevel: 160, special: 0, tag: 0,
});
const emptyBox: BBox = { left: 0, right: 0, bottom: 0, top: 0 };
type Edge = readonly [number, number];

function geometryMap(vertices: readonly Vertex[], leaves: readonly (readonly Edge[])[], nodes: readonly MapNode[] = []): DoomMap {
  const edges = leaves.flat();
  let firstSeg = 0;
  return {
    name: 'E1M1', vertices,
    sectors: [sector()],
    sides: [{ textureOffset: 0, rowOffset: 0, upperTexture: 'UPPER', lowerTexture: 'LOWER', middleTexture: 'MID', sector: 0 }],
    lines: edges.map(([v1, v2]) => ({ v1, v2, flags: 0, special: 0, tag: 0, frontSide: 0, backSide: null })),
    segs: edges.map(([v1, v2], line) => ({ v1, v2, angle: 0, line, side: 0, offset: 0 })),
    subsectors: leaves.map(edges => {
      const result = { firstSeg, segCount: edges.length, sector: 0 };
      firstSeg += edges.length;
      return result;
    }),
    nodes, things: [{ x: 32, y: 32, angle: 0, type: 1, flags: 7 }],
    blockmap: { originX: 0, originY: 0, width: 1, height: 1, cells: [edges.map((_, index) => index)] },
    reject: new Uint8Array(1),
  };
}

function area(polygon: readonly Vertex[]): number {
  return polygon.reduce((sum, point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    if (!next) throw new Error('Polygon vertex missing');
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function contains(polygon: readonly Vertex[], point: Vertex): boolean {
  return polygon.every((first, index) => {
    const second = polygon[(index + 1) % polygon.length];
    if (!second) throw new Error('Polygon vertex missing');
    return (second.x - first.x) * (point.y - first.y) - (second.y - first.y) * (point.x - first.x) >= -0.01;
  });
}

function wallWorld(options: { readonly back?: boolean; readonly flags?: number; readonly middle?: string } = {}) {
  const map = geometryMap([{ x: 0, y: 0 }, { x: 64, y: 0 }], [[[0, 1]]]);
  const source: DoomMap = {
    ...map,
    sectors: options.back ? [sector(), sector(32, 96)] : [sector()],
    sides: [
      { textureOffset: 7, rowOffset: 5, upperTexture: 'UPPER', lowerTexture: 'LOWER', middleTexture: options.middle ?? (options.back ? '-' : 'MID'), sector: 0 },
      { textureOffset: 11, rowOffset: 0, upperTexture: 'UPPER', lowerTexture: 'LOWER', middleTexture: 'BACK', sector: 1 },
    ],
    lines: [{ v1: 0, v2: 1, flags: options.flags ?? (options.back ? 4 : 0), special: 0, tag: 0, frontSide: 0, backSide: options.back ? 1 : null }],
    segs: [{ v1: 0, v2: 1, angle: 0, line: 0, side: 0, offset: 13 }],
    things: [{ x: 32, y: -32, angle: 0, type: 1, flags: 7 }],
  };
  return createWorld(source, { skill: 2 });
}

describe('buildSubsectorPolygons', () => {
  it('clips a convex room from a larger bounding rectangle without mutating its map', () => {
    const source = geometryMap([
      { x: 0, y: 0 }, { x: 0, y: 64 }, { x: 64, y: 64 }, { x: 64, y: 0 },
      { x: -256, y: -256 }, { x: 256, y: 256 },
    ], [[[0, 1], [1, 2], [2, 3], [3, 0]]]);
    const original = structuredClone(source);
    const polygon = buildSubsectorPolygons(source)[0];
    if (!polygon) throw new Error('Room polygon missing');
    expect(area(polygon)).toBeCloseTo(4096);
    expect(polygon).toHaveLength(4);
    expect(contains(polygon, { x: 32, y: 32 })).toBe(true);
    expect(contains(polygon, { x: 80, y: 32 })).toBe(false);
    expect(source).toEqual(original);
  });

  it('uses node child zero for cross <= 0 and child one for the opposite half plane', () => {
    const node: MapNode = { x: 0, y: 0, dx: 64, dy: 64, boxes: [emptyBox, emptyBox], children: [0x8000, 0x8001] };
    const edges: readonly Edge[] = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const polygons = buildSubsectorPolygons(geometryMap([
      { x: 0, y: 0 }, { x: 0, y: 64 }, { x: 64, y: 64 }, { x: 64, y: 0 },
    ], [edges, edges], [node]));
    expect(polygons.map(area)).toEqual([2048, 2048]);
    expect(contains(polygons[0] ?? [], { x: 48, y: 16 })).toBe(true);
    expect(contains(polygons[1] ?? [], { x: 16, y: 48 })).toBe(true);
  });

  it('splits a concave L room into convex leaves while BSP planes close omitted portal edges', () => {
    const node: MapNode = { x: 0, y: 64, dx: 128, dy: 0, boxes: [emptyBox, emptyBox], children: [0x8000, 0x8001] };
    const polygons = buildSubsectorPolygons(geometryMap([
      { x: 0, y: 0 }, { x: 0, y: 64 }, { x: 0, y: 128 }, { x: 64, y: 128 },
      { x: 64, y: 64 }, { x: 128, y: 64 }, { x: 128, y: 0 },
    ], [
      [[0, 1], [4, 5], [5, 6], [6, 0]],
      [[1, 2], [2, 3], [3, 4]],
    ], [node]));
    expect(polygons.map(area)).toEqual([8192, 4096]);
    expect(polygons.every(polygon => polygon.length === 4)).toBe(true);
    expect(polygons.some(polygon => contains(polygon, { x: 96, y: 96 }))).toBe(false);
  });

  it('leaves opposing coincident BSP half planes empty rather than expanding a zero-area strip', () => {
    const edges: readonly Edge[] = [[0, 1], [1, 2], [2, 3], [3, 0]];
    const nodes: readonly MapNode[] = [
      { x: 0, y: 32, dx: 64, dy: 0, boxes: [emptyBox, emptyBox], children: [0x8000, 0x8002] },
      { x: 0, y: 32, dx: -64, dy: 0, boxes: [emptyBox, emptyBox], children: [0x8001, 0] },
    ];
    const source = geometryMap([
      { x: 0, y: 0 }, { x: 0, y: 64 }, { x: 64, y: 64 }, { x: 64, y: 0 },
    ], [edges, edges, [[0, 1]]], nodes);
    const polygons = buildSubsectorPolygons(source);
    expect(polygons.map(area)).toEqual([2048, 2048, 0]);
    expect(polygons[2]).toEqual([]);
    expect(findSubsector(buildSpatialMap(source), 16 * FRAC_UNIT, 16 * FRAC_UNIT)).toBe(0);
    expect(findSubsector(buildSpatialMap(source), 16 * FRAC_UNIT, 48 * FRAC_UNIT)).toBe(1);
  });
});

describe('wallQuads', () => {
  it('emits inward-facing map-space walls and includes sidedef plus split SEG horizontal offsets', () => {
    const world = wallWorld();
    const quads = wallQuads(world, () => 64);
    expect(quads).toHaveLength(1);
    expect(quads[0]).toEqual({
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 64, y: 0, z: 0 }, { x: 64, y: 0, z: 128 }, { x: 0, y: 0, z: 128 }],
      texture: 'MID', u1: 20, u2: 84, v1: 133, v2: 5,
      lightLevel: 160, masked: false, sector: 0, seg: 0,
    });
  });

  it('bottom-pegs a one-sided middle using floor plus texture height and row offset', () => {
    const world = wallWorld({ flags: 16 });
    const front = world.sectors[0];
    if (!front) throw new Error('Sector missing');
    front.floorHeight = 10 * FRAC_UNIT;
    front.ceilingHeight = 150 * FRAC_UNIT;
    const quad = wallQuads(world, () => 64)[0];
    expect(quad?.v1).toBe(69);
    expect(quad?.v2).toBe(-71);
  });

  it('emits upper and lower differences with original default vertical anchors', () => {
    const quads = wallQuads(wallWorld({ back: true }), () => 64);
    expect(quads.map(quad => [quad.texture, quad.vertices[0].z, quad.vertices[2].z, quad.v1, quad.v2])).toEqual([
      ['UPPER', 96, 128, 69, 37], ['LOWER', 0, 32, 37, 5],
    ]);
  });

  it('applies DONTPEGTOP to upper and DONTPEGBOTTOM to lower wall anchors', () => {
    const quads = wallQuads(wallWorld({ back: true, flags: 4 | 8 | 16 }), () => 64);
    expect(quads.map(quad => [quad.texture, quad.v1, quad.v2])).toEqual([
      ['UPPER', 37, 5], ['LOWER', 133, 101],
    ]);
  });

  it('clips masked middles to the portal opening and one texture height instead of repeating', () => {
    const quads = wallQuads(wallWorld({ back: true, middle: 'FENCE' }), () => 24);
    const middle = quads.find(quad => quad.masked);
    expect(middle?.texture).toBe('FENCE');
    expect(middle?.vertices[0].z).toBe(77);
    expect(middle?.vertices[2].z).toBe(96);
    expect([middle?.v1, middle?.v2]).toEqual([24, 5]);
  });

  it('bottom-pegs masked middles against the higher floor', () => {
    const middle = wallQuads(wallWorld({ back: true, flags: 4 | 16, middle: 'FENCE' }), () => 24).find(quad => quad.masked);
    expect(middle?.vertices[0].z).toBe(37);
    expect(middle?.vertices[2].z).toBe(61);
    expect([middle?.v1, middle?.v2]).toEqual([24, 0]);
  });

  it('suppresses sky-to-sky upper walls and uses the sky hack ceiling for lower pegging', () => {
    const world = wallWorld({ back: true, flags: 4 | 16 });
    for (const sector of world.sectors) sector.ceilingTexture = 'F_SKY1';
    const quads = wallQuads(world, () => 64);
    expect(quads.map(quad => quad.texture)).toEqual(['LOWER']);
    expect([quads[0]?.v1, quads[0]?.v2]).toEqual([101, 69]);
  });

  it('recalculates closed doors and moving sector heights from World without changing the source map', () => {
    const world = wallWorld({ back: true, middle: 'FENCE' });
    const back = world.sectors[1];
    if (!back) throw new Error('Back sector missing');
    back.floorHeight = back.ceilingHeight = 0;
    const closed = wallQuads(world, () => 64);
    expect(closed).toHaveLength(1);
    expect([closed[0]?.vertices[0].z, closed[0]?.vertices[2].z]).toEqual([0, 128]);
    back.ceilingHeight = 64 * FRAC_UNIT;
    expect(wallQuads(world, () => 64).some(quad => quad.masked)).toBe(true);
    expect(world.spatial.map.sectors[1]?.ceilingHeight).toBe(96);
  });

  it('reads reverse-side segs from the correct runtime sidedef and front sector', () => {
    const world = wallWorld({ back: true });
    const source = world.spatial.map;
    const reversed = createWorld({ ...source, segs: [{ v1: 1, v2: 0, angle: 32768, line: 0, side: 1, offset: 3 }], subsectors: [{ firstSeg: 0, segCount: 1, sector: 1 }] }, { skill: 2 });
    const quad = wallQuads(reversed, () => 64)[0];
    expect(quad?.texture).toBe('BACK');
    expect(quad?.sector).toBe(1);
    expect([quad?.u1, quad?.u2]).toEqual([14, 78]);
    expect(quad?.vertices[0].x).toBe(64);
  });

  it('skips absent textures and zero-area spans without querying their texture height', () => {
    const world = wallWorld({ middle: '-' });
    expect(wallQuads(world, () => { throw new Error('Absent texture must not resolve'); })).toEqual([]);
    const front = world.sectors[0];
    if (!front) throw new Error('Sector missing');
    front.ceilingHeight = front.floorHeight;
    world.sides[0] = { textureOffset: 0, rowOffset: 0, upperTexture: '-', lowerTexture: '-', middleTexture: 'MID' };
    expect(wallQuads(world, () => { throw new Error('Empty span must not resolve'); })).toEqual([]);
  });
});

describe('shareware floor and wall geometry', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('covers native floor samples and preserves finite wall UVs in E1M%i', number => {
    const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
    const map = decodeMap(wad, `E1M${number}`);
    const spatial = buildSpatialMap(map);
    const polygons = buildSubsectorPolygons(map);
    expect(polygons).toHaveLength(map.subsectors.length);
    for (const [index, polygon] of polygons.entries()) {
      // Vanilla maps include unreachable leaves between opposing coincident planes.
      if (polygon.length === 0) continue;
      expect(polygon.length).toBeGreaterThanOrEqual(3);
      expect(area(polygon)).toBeGreaterThan(0);
      const center = polygon.reduce((center, point) => ({ x: center.x + point.x / polygon.length, y: center.y + point.y / polygon.length }), { x: 0, y: 0 });
      expect(Number.isFinite(center.x) && Number.isFinite(center.y)).toBe(true);
      const nativeLeaf = findSubsector(spatial, Math.round(center.x * FRAC_UNIT), Math.round(center.y * FRAC_UNIT));
      expect(map.subsectors[nativeLeaf]?.sector).toBe(map.subsectors[index]?.sector);
    }
    const start = map.things.find(thing => thing.type === 1);
    if (!start) throw new Error('Map start missing');
    const startLeaf = findSubsector(spatial, start.x * FRAC_UNIT, start.y * FRAC_UNIT);
    expect(contains(polygons[startLeaf] ?? [], start)).toBe(true);
    const resources = createResources(wad);
    const quads = wallQuads(createWorld(map, { skill: 2, noMonsters: true }), name => resources.wall(name).height);
    expect(quads.length).toBeGreaterThan(0);
    for (const quad of quads) {
      expect([quad.u1, quad.u2, quad.v1, quad.v2, ...quad.vertices.flatMap(vertex => [vertex.x, vertex.y, vertex.z])].every(Number.isFinite)).toBe(true);
      expect(quad.vertices[2].z).toBeGreaterThan(quad.vertices[0].z);
    }
  });
});
