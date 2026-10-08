import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap, type DoomMap, type MapNode } from '../../src/wad/map';
import { ActorType, MobjFlag } from '../../src/simulation/data/actors';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { createWorld, removeActor, spawnActor, type World } from '../../src/simulation/world';
import { checkSight, traceActors, tracePath } from '../../src/simulation/trace';

const fixed = (n: number) => (n * FRAC_UNIT) | 0;
const box = { top: 256, bottom: 0, left: 0, right: 256 };

function fixture(options: {
  readonly lineX?: number;
  readonly oneSided?: boolean;
  readonly rightFloor?: number;
  readonly rightCeiling?: number;
  readonly width?: number;
  readonly height?: number;
  readonly cells?: readonly (readonly number[])[];
  readonly nodes?: readonly MapNode[];
} = {}): World {
  const lineX = options.lineX ?? 128, width = options.width ?? 2, height = options.height ?? 2;
  const map: DoomMap = {
    name: 'E1M1', vertices: [{ x: lineX, y: 0 }, { x: lineX, y: 256 }],
    lines: [{ v1: 0, v2: 1, flags: options.oneSided ? 1 : 4, special: 0, tag: 0,
      frontSide: 0, backSide: options.oneSided ? null : 1 }],
    sides: [0, 1].map(sector => ({ sector, textureOffset: 0, rowOffset: 0,
      upperTexture: '-', lowerTexture: '-', middleTexture: '-' })),
    sectors: [0, 1].map(i => ({ floorHeight: i ? options.rightFloor ?? 0 : 0,
      ceilingHeight: i ? options.rightCeiling ?? 128 : 128, floorTexture: 'FLAT', ceilingTexture: 'CEIL',
      lightLevel: 255, special: 0, tag: 0 })),
    segs: [0, 1].map(side => ({ v1: 0, v2: 1, angle: 0, line: 0, side: side as 0 | 1, offset: 0 })),
    subsectors: [{ firstSeg: 0, segCount: 1, sector: 0 }, { firstSeg: 1, segCount: 1, sector: 1 }],
    nodes: options.nodes ?? [{ x: lineX, y: 0, dx: 0, dy: 1, boxes: [box, box], children: [0x8001, 0x8000] }],
    things: [{ x: 16, y: 64, type: 1, angle: 0, flags: 7 }], reject: new Uint8Array(1),
    blockmap: { originX: 0, originY: 0, width, height,
      cells: options.cells ?? Array.from({ length: width * height }, () => [0]) },
  };
  return createWorld(map, { skill: 2 });
}

function hidePlayer(world: World): void {
  const actor = world.actorsById.get(world.player.actorId);
  if (!actor) throw new Error('Missing fixture player');
  removeActor(world, actor);
}

describe('native actor trace', () => {
  it('intersects the original corner diagonal at an axis crossing', () => {
    const world = fixture(); hidePlayer(world);
    const actor = spawnActor(world, ActorType.MT_BARREL, fixed(64), fixed(64));
    expect(traceActors(world, fixed(16), fixed(64), fixed(112), fixed(64))).toEqual([
      { kind: 'actor', actor, fraction: FRAC_UNIT / 2 },
    ]);
  });

  it('preserves head insertion on equal fractions and does not filter pickup actors', () => {
    const world = fixture(); hidePlayer(world);
    const first = spawnActor(world, ActorType.MT_BARREL, fixed(64), fixed(64));
    const second = spawnActor(world, ActorType.MT_CLIP, fixed(64), fixed(64));
    expect(traceActors(world, fixed(16), fixed(64), fixed(112), fixed(64)).map(hit => hit.actor.id)).toEqual([second.id, first.id]);
  });

  it('excludes removed and NOBLOCKMAP actors without filtering by shootable flags', () => {
    const world = fixture(); hidePlayer(world);
    const removed = spawnActor(world, ActorType.MT_BARREL, fixed(64), fixed(64));
    spawnActor(world, ActorType.MT_PUFF, fixed(64), fixed(64));
    removeActor(world, removed);
    expect(traceActors(world, fixed(16), fixed(64), fixed(112), fixed(64))).toEqual([]);
  });

  it('does not scan neighboring center cells even if an actor radius overlaps the ray', () => {
    const world = fixture(); hidePlayer(world);
    const actor = spawnActor(world, ActorType.MT_SPIDER, fixed(64), fixed(160));
    expect(actor.radius).toBeGreaterThan(fixed(100));
    expect(traceActors(world, fixed(16), fixed(64), fixed(112), fixed(64))).toEqual([]);
  });

  it('nudges a block boundary start by one unit before computing actor fractions', () => {
    const world = fixture(); hidePlayer(world);
    const actor = spawnActor(world, ActorType.MT_BARREL, fixed(192), fixed(64));
    expect(traceActors(world, fixed(128), fixed(64), fixed(256), fixed(64))).toEqual([
      { kind: 'actor', actor, fraction: 32509 },
    ]);
  });

  it('retains the original exact-45-degree diagonal miss', () => {
    const world = fixture(); hidePlayer(world);
    spawnActor(world, ActorType.MT_BARREL, fixed(80), fixed(80));
    expect(traceActors(world, fixed(64), fixed(64), fixed(112), fixed(112))).toEqual([]);
  });

  it('repeats actor intercepts when the original DDA stalls at a grid corner', () => {
    const world = fixture(); hidePlayer(world);
    const actor = spawnActor(world, ActorType.MT_BARREL, fixed(112), fixed(96));
    const hits = traceActors(world, fixed(96), fixed(64), fixed(160), fixed(192));
    expect(hits).toHaveLength(64);
    expect(hits.every(hit => hit.actor === actor)).toBe(true);
  });

  it('stops after 64 cells and ignores actors behind or beyond the segment', () => {
    const world = fixture({ width: 66, height: 1 }); hidePlayer(world);
    spawnActor(world, ActorType.MT_BARREL, fixed(8256), fixed(64));
    expect(traceActors(world, fixed(16), fixed(64), fixed(8384), fixed(64))).toEqual([]);
    spawnActor(world, ActorType.MT_BARREL, fixed(8), fixed(64));
    spawnActor(world, ActorType.MT_BARREL, fixed(112), fixed(64));
    expect(traceActors(world, fixed(32), fixed(64), fixed(64), fixed(64))).toEqual([]);
  });
});

describe('merged line and actor path order', () => {
  it('visits a line before equal-distance actors in the same block', () => {
    const world = fixture({ lineX: 64 }); hidePlayer(world);
    const first = spawnActor(world, ActorType.MT_CLIP, fixed(64), fixed(64));
    const second = spawnActor(world, ActorType.MT_BARREL, fixed(64), fixed(64));
    expect(tracePath(world, fixed(16), fixed(64), fixed(112), fixed(64))).toEqual([
      { kind: 'line', line: 0, fraction: FRAC_UNIT / 2 },
      { kind: 'actor', actor: second, fraction: FRAC_UNIT / 2 },
      { kind: 'actor', actor: first, fraction: FRAC_UNIT / 2 },
    ]);
  });

  it('retains earlier-cell actors before an equal-distance line first encountered later', () => {
    const original = fixture({ lineX: -32 });
    const source = original.spatial.map;
    const world = createWorld({ ...source,
      vertices: [...source.vertices, { x: 128, y: 0 }, { x: 128, y: 256 }],
      lines: [...source.lines, { v1: 2, v2: 3, flags: 4, special: 0, tag: 0, frontSide: 0, backSide: 1 }],
      blockmap: { ...source.blockmap, cells: [[], [1], [], [1]] },
    }, { skill: 2 });
    hidePlayer(world);
    const actor = spawnActor(world, ActorType.MT_BARREL, fixed(120), fixed(72));
    expect(tracePath(world, fixed(16), fixed(64), fixed(240), fixed(64))).toEqual([
      { kind: 'actor', actor, fraction: FRAC_UNIT / 2 },
      { kind: 'line', line: 1, fraction: FRAC_UNIT / 2 },
    ]);
    expect(actor.flags & MobjFlag.MF_SHOOTABLE).not.toBe(0);
  });

  it('supports line-only and actor-only consumers without changing fractions', () => {
    const world = fixture({ lineX: 64 }); hidePlayer(world);
    const actor = spawnActor(world, ActorType.MT_BARREL, fixed(80), fixed(64));
    expect(tracePath(world, fixed(16), fixed(64), fixed(112), fixed(64), { actors: false })).toEqual([
      { kind: 'line', line: 0, fraction: FRAC_UNIT / 2 },
    ]);
    expect(tracePath(world, fixed(16), fixed(64), fixed(112), fixed(64), { lines: false })).toEqual([
      { kind: 'actor', actor, fraction: 43690 },
    ]);
    expect(tracePath(world, fixed(16), fixed(64), fixed(112), fixed(64), { lines: false, actors: false })).toEqual([]);
  });
});

describe('BSP line of sight', () => {
  function pair(world: World) {
    const from = world.actorsById.get(world.player.actorId);
    if (!from) throw new Error('Missing observer');
    const to = spawnActor(world, ActorType.MT_POSSESSED, fixed(240), fixed(64));
    return [from, to] as const;
  }

  it('passes equal-height portals and blocks one-sided walls', () => {
    const clear = fixture(), [from, to] = pair(clear);
    expect(checkSight(clear, from, to)).toBe(true);
    const blocked = fixture({ oneSided: true }), [fromBlocked, toBlocked] = pair(blocked);
    expect(checkSight(blocked, fromBlocked, toBlocked)).toBe(false);
  });

  it('uses asymmetric sector REJECT bits before BSP traversal', () => {
    const world = fixture(), [from, to] = pair(world);
    world.spatial.map.reject[0] = 1 << 1;
    expect(checkSight(world, from, to)).toBe(false);
    expect(checkSight(world, to, from)).toBe(true);
  });

  it('uses runtime door heights and refuses a fully closed portal', () => {
    const world = fixture(), [from, to] = pair(world), right = world.sectors[1];
    if (!right) throw new Error('Missing portal sector');
    right.ceilingHeight = right.floorHeight;
    expect(checkSight(world, from, to)).toBe(false);
    right.ceilingHeight = fixed(128);
    expect(checkSight(world, from, to)).toBe(true);
  });

  it.each([[48, true], [49, false]])('clips target visibility at the %i unit floor edge', (floor, visible) => {
    const world = fixture({ rightFloor: floor }), [from, to] = pair(world);
    to.z = 0;
    expect(checkSight(world, from, to)).toBe(visible);
  });

  it.each([[22, true], [21, false]])('clips target visibility at the %i unit ceiling edge', (ceiling, visible) => {
    const world = fixture({ rightCeiling: ceiling }), [from, to] = pair(world);
    expect(checkSight(world, from, to)).toBe(visible);
  });

  it('does not let a sparse blockmap hide a one-sided BSP wall', () => {
    const world = fixture({ oneSided: true, cells: [[], [], [], []] }), [from, to] = pair(world);
    expect(checkSight(world, from, to)).toBe(false);
  });

  it('handles a map with no nodes through subsector zero', () => {
    const original = fixture({ oneSided: true });
    const map: DoomMap = { ...original.spatial.map, nodes: [],
      subsectors: [{ firstSeg: 0, segCount: 1, sector: 0 }] };
    const world = createWorld(map, { skill: 2 }), [from, to] = pair(world);
    expect(checkSight(world, from, to)).toBe(false);
  });

  it('preserves the horizontal sight-side X-versus-Y typo in original p_sight.c', () => {
    const source = fixture({ oneSided: true }).spatial.map;
    const world = createWorld({ ...source,
      nodes: [{ x: 0, y: 16, dx: 1, dy: 0, boxes: [box, box], children: [0x8000, 0x8001] }],
      subsectors: [{ firstSeg: 0, segCount: 1, sector: 0 }, { firstSeg: 1, segCount: 0, sector: 1 }],
    }, { skill: 2 });
    const [from, to] = pair(world);
    expect(from.x).toBe(fixed(16));
    expect(from.sector).toBe(1);
    expect(to.sector).toBe(1);
    // Source X equals node Y, so sight visits the otherwise untouched leaf zero.
    expect(checkSight(world, from, to)).toBe(false);
  });

  it('handles deep shared BSP branches without recursion or exponential revisits', () => {
    const nodes: MapNode[] = Array.from({ length: 5000 }, (_, i) => ({
      x: 128, y: 0, dx: 0, dy: 1, boxes: [box, box],
      children: i === 0 ? [0x8001, 0x8000] : [i - 1, i - 1],
    }));
    const world = fixture({ nodes }), [from, to] = pair(world);
    expect(checkSight(world, from, to)).toBe(true);
  });
});

describe('original shareware trace integration', () => {
  const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('traces and checks local sight in E1M%i', mapNumber => {
    const world = createWorld(decodeMap(wad, `E1M${mapNumber}`), { skill: 2 });
    const actor = world.actorsById.get(world.player.actorId);
    if (!actor) throw new Error('Missing original map player');
    expect(checkSight(world, actor, actor)).toBe(true);
    const hits = tracePath(world, actor.x, actor.y, (actor.x + fixed(1024)) | 0, actor.y);
    expect(hits.every(hit => hit.fraction >= 0 && hit.fraction <= FRAC_UNIT)).toBe(true);
    expect(hits.map(hit => hit.fraction)).toEqual(hits.map(hit => hit.fraction).sort((a, b) => a - b));
  });
});
