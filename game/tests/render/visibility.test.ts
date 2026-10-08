import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { visibleGeometry } from '../../src/render/visibility';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { createWorld } from '../../src/simulation/world';
import { parseWad } from '../../src/wad/archive';
import { decodeMap, type BBox, type DoomMap, type MapNode, type MapSector, type MapSide, type Vertex } from '../../src/wad/map';

interface Edge {
  readonly first: Vertex;
  readonly second: Vertex;
  readonly front?: number;
  readonly back?: number;
  readonly middle?: string;
}

const camera = { x: 0, y: 0, angle: 0 };
const sector = (floorHeight = 0, ceilingHeight = 128): MapSector => ({
  floorHeight, ceilingHeight, floorTexture: 'FLOOR', ceilingTexture: 'CEILING',
  lightLevel: 160, special: 0, tag: 0,
});
const box = (left: number, right: number, bottom: number, top: number): BBox => ({ left, right, bottom, top });
const wall = (x: number, bottom = -128, top = 128): Edge => ({ first: { x, y: top }, second: { x, y: bottom } });

function mapFor(leaves: readonly (readonly Edge[])[], sectors: readonly MapSector[] = [sector()], nodes: readonly MapNode[] = []): DoomMap {
  const edges = leaves.flat();
  const vertices = edges.flatMap(edge => [edge.first, edge.second]);
  const sides: MapSide[] = [];
  const lines = edges.map((edge, index) => {
    const frontSide = sides.length;
    sides.push({ sector: edge.front ?? 0, textureOffset: 0, rowOffset: 0, upperTexture: 'UPPER', lowerTexture: 'LOWER', middleTexture: edge.middle ?? 'WALL' });
    const backSide = edge.back === undefined ? null : sides.length;
    if (edge.back !== undefined) sides.push({ sector: edge.back, textureOffset: 0, rowOffset: 0, upperTexture: 'UPPER', lowerTexture: 'LOWER', middleTexture: '-' });
    return { v1: index * 2, v2: index * 2 + 1, flags: backSide === null ? 0 : 4, special: 0, tag: 0, frontSide, backSide };
  });
  let firstSeg = 0;
  return {
    name: 'E1M1', vertices, sectors, sides, lines,
    segs: lines.map((line, index) => ({ v1: line.v1, v2: line.v2, angle: 0, line: index, side: 0, offset: 0 })),
    subsectors: leaves.map(edges => {
      const subsector = { firstSeg, segCount: edges.length, sector: edges[0]?.front ?? 0 };
      firstSeg += edges.length;
      return subsector;
    }),
    nodes, things: [{ x: 0, y: 0, angle: 0, type: 1, flags: 7 }],
    blockmap: { originX: -128, originY: -128, width: 4, height: 4, cells: Array.from({ length: 16 }, () => lines.map((_, index) => index)) },
    reject: new Uint8Array(Math.ceil(sectors.length * sectors.length / 8)),
  };
}

function portalWorld(back: MapSector = sector(), middle = '-') {
  const node: MapNode = {
    x: 64, y: 0, dx: 0, dy: 128,
    boxes: [box(128, 256, -64, 64), box(-64, 64, -128, 128)],
    children: [0x8001, 0x8000],
  };
  return createWorld(mapFor([
    [{ ...wall(64), back: 1, middle }],
    [{ ...wall(128, -64, 64), front: 1 }],
  ], [sector(), back], [node]), { skill: 2 });
}

describe('visibleGeometry', () => {
  it('keeps facing segments and rejects their back faces', () => {
    const edge = wall(64);
    const world = createWorld(mapFor([[edge, { first: edge.second, second: edge.first }]]), { skill: 2 });
    expect([...visibleGeometry(world, camera).visibleSegs]).toEqual([0]);
  });

  it('clips both sides of the horizontal field of view and rejects segments behind the camera', () => {
    const world = createWorld(mapFor([[
      wall(64, 128, 256), wall(64, -256, -128), wall(-64), wall(128, -32, 32),
    ]]), { skill: 2 });
    expect([...visibleGeometry(world, camera).visibleSegs]).toEqual([3]);
  });

  it('wraps west-facing BAM angles across zero without losing visible spans', () => {
    const world = createWorld(mapFor([[{ first: { x: -64, y: -64 }, second: { x: -64, y: 64 } }]]), { skill: 2 });
    expect([...visibleGeometry(world, { ...camera, angle: 0x80000000 }).visibleSegs]).toEqual([0]);
  });

  it('uses the requested field of view in radians', () => {
    const world = createWorld(mapFor([[wall(64, 32, 48)]]), { skill: 2 });
    expect(visibleGeometry(world, camera).visibleSegs.size).toBe(1);
    expect(visibleGeometry(world, { ...camera, horizontalFov: Math.PI / 4 }).visibleSegs.size).toBe(0);
  });

  it('keeps partially clipped left and right segments while discarding an exact edge-only span', () => {
    const world = createWorld(mapFor([[wall(64, 32, 128), wall(64, -128, -32), wall(64, 64, 128)]]), { skill: 2 });
    expect([...visibleGeometry(world, camera).visibleSegs]).toEqual([0, 1]);
  });

  it('retains positive subpixel spans for the Three.js render target', () => {
    const world = createWorld(mapFor([[wall(32767, 0, 1)]]), { skill: 2 });
    expect([...visibleGeometry(world, camera).visibleSegs]).toEqual([0]);
  });

  it('visits the camera child before the far child and omits empty two-sided trigger lines', () => {
    const result = visibleGeometry(portalWorld(), camera);
    expect(result.visibleSubsectors).toEqual([0, 1]);
    expect([...result.visibleSectors]).toEqual([0, 1]);
    expect([...result.visibleSegs]).toEqual([1]);
  });

  it('culls the far subtree behind a closed door, then reveals it when the runtime ceiling rises', () => {
    const world = portalWorld(sector(0, 0));
    expect(visibleGeometry(world, camera).visibleSubsectors).toEqual([0]);
    expect([...visibleGeometry(world, camera).visibleSegs]).toEqual([0]);
    const back = world.sectors[1];
    if (!back) throw new Error('Back sector missing');
    back.ceilingHeight = 128 * FRAC_UNIT;
    expect(visibleGeometry(world, camera).visibleSubsectors).toEqual([0, 1]);
    expect([...visibleGeometry(world, camera).visibleSegs]).toEqual([1]);
  });

  it('treats a back floor at the front ceiling as solid', () => {
    expect(visibleGeometry(portalWorld(sector(128, 256)), camera).visibleSubsectors).toEqual([0]);
  });

  it('keeps raised-floor windows and masked middle textures transparent to occlusion', () => {
    expect([...visibleGeometry(portalWorld(sector(32, 96)), camera).visibleSegs]).toEqual([0, 1]);
    expect([...visibleGeometry(portalWorld(sector(), 'GRATE'), camera).visibleSegs]).toEqual([0, 1]);
  });

  it('preserves the native closed-door comparison for an internally zero-height back sector', () => {
    // R_AddLine compares the back ceiling/floor against the front floor/ceiling.
    expect(visibleGeometry(portalWorld(sector(64, 64)), camera).visibleSubsectors).toEqual([0, 1]);
  });

  it('draws an equal-height portal when runtime textures or light levels differ', () => {
    const world = portalWorld();
    const back = world.sectors[1];
    if (!back) throw new Error('Back sector missing');
    back.lightLevel = 96;
    expect([...visibleGeometry(world, camera).visibleSegs]).toEqual([0, 1]);
    back.lightLevel = 160;
    back.floorTexture = 'OTHER';
    expect([...visibleGeometry(world, camera).visibleSegs]).toEqual([0, 1]);
  });

  it('treats a present back side without the two-sided flag as a solid wall', () => {
    const world = portalWorld();
    world.lineFlags[0] = 0;
    expect(visibleGeometry(world, camera).visibleSubsectors).toEqual([0]);
  });

  it('uses the reversed segment side and opposite front sector when looking through a portal from behind', () => {
    const source = portalWorld().spatial.map;
    const first = source.segs[0];
    const subsector = source.subsectors[0];
    if (!first || !subsector) throw new Error('Portal missing');
    const world = createWorld({
      ...source,
      segs: [{ ...first, v1: first.v2, v2: first.v1, side: 1 }, ...source.segs.slice(1)],
      subsectors: [{ ...subsector, sector: 1 }, ...source.subsectors.slice(1)],
    }, { skill: 2 });
    const view = { x: 192, y: 0, angle: 0x80000000 };
    expect(visibleGeometry(world, view).visibleSubsectors).toEqual([1, 0]);
    expect(visibleGeometry(world, view).visibleSegs.size).toBe(0);
    const front = world.sectors[0];
    if (!front) throw new Error('Opposite sector missing');
    front.ceilingHeight = 0;
    expect([...visibleGeometry(world, view).visibleSegs]).toEqual([0]);
  });

  it('reads changed middle textures from the runtime side state', () => {
    const world = portalWorld();
    const side = world.sides[0];
    if (!side) throw new Error('Side missing');
    side.middleTexture = 'SWITCH';
    expect([...visibleGeometry(world, camera).visibleSegs]).toEqual([0, 1]);
  });

  it('rejects a far bounding box wholly outside the field of view', () => {
    const source = portalWorld().spatial.map;
    const node = source.nodes[0];
    if (!node) throw new Error('Node missing');
    const world = createWorld({ ...source, nodes: [{ ...node, boxes: [box(128, 256, 1024, 2048), node.boxes[1]] }] }, { skill: 2 });
    expect(visibleGeometry(world, camera).visibleSubsectors).toEqual([0]);
  });

  it('keeps the far segment when a nearer solid wall covers only the center of its span', () => {
    const base = portalWorld();
    const map: DoomMap = { ...base.spatial.map, vertices: [{ x: 64, y: 8 }, { x: 64, y: -8 }, { x: 128, y: 64 }, { x: 128, y: -64 }] };
    const world = createWorld(map, { skill: 2 });
    world.lineFlags[0] = 0;
    expect([...visibleGeometry(world, camera).visibleSegs]).toEqual([0, 1]);
  });

  it('merges touching solid spans before testing a far bounding box', () => {
    const node: MapNode = { x: 64, y: 0, dx: 0, dy: 128, boxes: [box(128, 256, -64, 64), box(-64, 64, -128, 128)], children: [0x8001, 0x8000] };
    const world = createWorld(mapFor([[wall(64, 0, 128), wall(64, -128, 0)], [wall(128, -64, 64)]], [sector()], [node]), { skill: 2 });
    const result = visibleGeometry(world, camera);
    expect(result.visibleSubsectors).toEqual([0]);
    expect([...result.visibleSegs]).toEqual([0, 1]);
  });

  it('conservatively visits a bbox containing the camera even when its segments are occluded', () => {
    const source = portalWorld(sector(0, 0)).spatial.map;
    const originalNode = source.nodes[0];
    if (!originalNode) throw new Error('Node missing');
    const world = createWorld({ ...source, nodes: [{ ...originalNode, boxes: [box(-1, 1, -1, 1), originalNode.boxes[1]] }] }, { skill: 2 });
    const result = visibleGeometry(world, camera);
    expect(result.visibleSubsectors).toEqual([0, 1]);
    expect([...result.visibleSegs]).toEqual([0]);
  });

  it('keeps an ambiguous bounding-box edge facing a full half-plane', () => {
    const source = portalWorld(sector(0, 0)).spatial.map;
    const node = source.nodes[0];
    if (!node) throw new Error('Node missing');
    const world = createWorld({ ...source, nodes: [{ ...node, boxes: [box(-1, 0, -64, 64), node.boxes[1]] }] }, { skill: 2 });
    expect(visibleGeometry(world, camera).visibleSubsectors).toEqual([0, 1]);
  });

  it('handles deep shared BSP nodes iteratively and emits each subsector once', () => {
    const nodes: MapNode[] = Array.from({ length: 5000 }, (_, index) => ({
      x: 64, y: 0, dx: 0, dy: 128, boxes: [box(-1, 1, -1, 1), box(-1, 1, -1, 1)],
      children: index === 0 ? [0x8000, 0x8000] : [index - 1, index - 1],
    }));
    const world = createWorld(mapFor([[wall(64)]], [sector()], nodes), { skill: 2 });
    expect(visibleGeometry(world, camera).visibleSubsectors).toEqual([0]);
  });

  it('does not mutate simulation state or consume its random stream', () => {
    const world = portalWorld();
    const before = structuredClone(world);
    visibleGeometry(world, camera);
    expect(world).toEqual(before);
  });

  it.each([0, Math.PI, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid perspective field of view %s', horizontalFov => {
    const world = portalWorld();
    expect(() => visibleGeometry(world, { ...camera, horizontalFov })).toThrow(/field of view/i);
  });

  it('rejects non-finite camera coordinates or angle', () => {
    const world = portalWorld();
    expect(() => visibleGeometry(world, { ...camera, x: Number.NaN })).toThrow(/camera/i);
    expect(() => visibleGeometry(world, { ...camera, angle: Number.POSITIVE_INFINITY })).toThrow(/camera/i);
  });

  const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('selects finite, bounded visible geometry at the original E1M%s start', number => {
    const map = decodeMap(wad, `E1M${number}`);
    const world = createWorld(map, { skill: 2 });
    const player = world.actorsById.get(world.player.actorId);
    if (!player) throw new Error('Player missing');
    const result = visibleGeometry(world, { x: player.x / FRAC_UNIT, y: player.y / FRAC_UNIT, angle: player.angle });
    expect(result.visibleSubsectors.length).toBeGreaterThan(0);
    expect(result.visibleSubsectors.length).toBeLessThan(map.subsectors.length);
    expect(result.visibleSegs.size).toBeGreaterThan(0);
    expect(result.visibleSegs.size).toBeLessThan(map.segs.length);
    expect(result.visibleSubsectors.every(index => Number.isFinite(index) && map.subsectors[index] !== undefined)).toBe(true);
    expect([...result.visibleSegs].every(index => Number.isFinite(index) && map.segs[index] !== undefined)).toBe(true);
    expect([...result.visibleSectors].every(index => Number.isFinite(index) && world.sectors[index] !== undefined)).toBe(true);
  });
});
