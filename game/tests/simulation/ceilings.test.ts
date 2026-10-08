import { describe, expect, it, vi } from 'vitest';
import type { DoomMap } from '../../src/wad/map';
import { SfxId } from '../../src/simulation/data/actors';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { doCeiling, stopCeilings, tickCeiling } from '../../src/simulation/specials/ceilings';
import type { CeilingThinker } from '../../src/simulation/specials/types';
import type { PlaneHooks } from '../../src/simulation/specials/planes';
import { createWorld, removeActor, type World } from '../../src/simulation/world';

const fixed = (n: number) => (n * FRAC_UNIT) | 0;

function fixture(count = 1): World {
  const box = { top: 256, bottom: 0, left: 0, right: (count + 1) * 128 };
  const map: DoomMap = {
    name: 'E1M1',
    vertices: Array.from({ length: count }, (_, i) => [
      { x: (i + 1) * 128, y: 0 }, { x: (i + 1) * 128, y: 256 },
    ]).flat(),
    lines: Array.from({ length: count }, (_, i) => ({ v1: i * 2, v2: i * 2 + 1, flags: 4,
      special: 0, tag: 7, frontSide: i * 2, backSide: i * 2 + 1 })),
    sides: Array.from({ length: count }, (_, i) => [i, count].map(sector => ({ sector,
      textureOffset: 0, rowOffset: 0, upperTexture: '-', lowerTexture: '-', middleTexture: '-' }))).flat(),
    sectors: Array.from({ length: count + 1 }, (_, i) => ({ floorHeight: 0, ceilingHeight: i === count ? 256 : 128,
      floorTexture: 'FLAT', ceilingTexture: 'CEIL', lightLevel: 255, special: 0, tag: i === count ? 0 : 7 })),
    segs: [], subsectors: [{ firstSeg: 0, segCount: 0, sector: 0 }, { firstSeg: 0, segCount: 0, sector: count }],
    nodes: [{ x: 128, y: 0, dx: 0, dy: 1, boxes: [box, box], children: [0x8001, 0x8000] }],
    things: [{ x: 64, y: 64, angle: 0, type: 1, flags: 7 }], reject: new Uint8Array(Math.ceil((count + 1) ** 2 / 8)),
    blockmap: { originX: 0, originY: 0, width: count + 2, height: 3,
      cells: Array.from({ length: (count + 2) * 3 }, () => Array.from({ length: count }, (_, i) => i)) },
  };
  return createWorld(map, { skill: 2 });
}

function hooks(): PlaneHooks {
  return { damageActor: vi.fn(), movement: { touchPickup: vi.fn(), damageActor: vi.fn(),
    explodeMissile: vi.fn(), crossSpecial: vi.fn(), runActorAction: vi.fn() } };
}

function ceiling(world: World, index = 0): CeilingThinker {
  const thinker = world.sectors[index]?.specialData;
  if (thinker?.kind !== 'ceiling') throw new Error('Missing ceiling thinker');
  return thinker;
}

function clearPlayer(world: World): void {
  const player = world.actorsById.get(world.player.actorId);
  if (!player) throw new Error('Missing player');
  removeActor(world, player);
  world.events.length = 0;
}

describe('native ceiling creation', () => {
  it.each([
    ['lowerToFloor', false, 0, -1, 1], ['lowerAndCrush', false, 8, -1, 1],
    ['crushAndRaise', true, 8, -1, 1], ['silentCrushAndRaise', true, 8, -1, 1],
    ['fastCrushAndRaise', true, 8, -1, 2],
  ] as const)('configures %s with the source crush flag, destination and speed', (type, crush, bottom, direction, speed) => {
    const world = fixture();
    expect(doCeiling(world, 7, type)).toBe(true);
    const thinker = ceiling(world);
    expect(thinker.crush).toBe(crush);
    expect(thinker.bottomHeight).toBe(fixed(bottom));
    expect(thinker.direction).toBe(direction);
    expect(thinker.speed).toBe(fixed(speed));
    expect(thinker.activeSlot).toBe(0);
    if (crush) expect(thinker.topHeight).toBe(fixed(128));
  });

  it('raises to the highest adjacent ceiling and leaves busy or untagged sectors alone', () => {
    const world = fixture();
    expect(doCeiling(world, 99, 'raiseToHighest')).toBe(false);
    expect(doCeiling(world, 7, 'raiseToHighest')).toBe(true);
    const thinker = ceiling(world);
    expect(thinker.topHeight).toBe(fixed(256));
    expect(thinker.direction).toBe(1);
    expect(doCeiling(world, 7, 'lowerToFloor')).toBe(false);
    expect(world.sectors[0]?.specialData).toBe(thinker);
    expect(world.sectors[1]?.specialData).toBe(null);
  });
});

describe('native ceiling ticking', () => {
  it('removes a one-shot mover only after moving beyond the destination', () => {
    const world = fixture(), callbacks = hooks(); clearPlayer(world);
    doCeiling(world, 7, 'lowerToFloor');
    const thinker = ceiling(world), sector = world.sectors[0];
    if (!sector) throw new Error('Missing sector');
    sector.ceilingHeight = FRAC_UNIT;
    tickCeiling(world, thinker, callbacks);
    expect(sector.ceilingHeight).toBe(0);
    expect(thinker.removed).toBe(false);
    tickCeiling(world, thinker, callbacks);
    expect(thinker.removed).toBe(true);
    expect(sector.specialData).toBe(null);
    expect(world.thinkers).toContain(thinker);
  });

  it('removes a raised ceiling after it passes its original upper destination', () => {
    const world = fixture(), callbacks = hooks();
    doCeiling(world, 7, 'raiseToHighest');
    const thinker = ceiling(world), sector = world.sectors[0];
    if (!sector) throw new Error('Missing sector');
    sector.ceilingHeight = thinker.topHeight;
    tickCeiling(world, thinker, callbacks);
    expect(sector.ceilingHeight).toBe(fixed(256));
    expect(thinker.removed).toBe(true);
    expect(sector.specialData).toBe(null);
  });

  it('slows a normal crusher after obstruction, damages on the four-tic cadence and restores speed at the bottom', () => {
    const world = fixture(), callbacks = hooks();
    doCeiling(world, 7, 'crushAndRaise');
    const thinker = ceiling(world), sector = world.sectors[0];
    if (!sector) throw new Error('Missing sector');
    sector.ceilingHeight = fixed(56);
    tickCeiling(world, thinker, callbacks);
    expect(sector.ceilingHeight).toBe(fixed(55));
    expect(thinker.speed).toBe(FRAC_UNIT / 8);
    expect(callbacks.damageActor).toHaveBeenCalledWith(world.actorsById.get(world.player.actorId), null, null, 10);
    vi.mocked(callbacks.damageActor).mockClear(); world.levelTime = 1;
    tickCeiling(world, thinker, callbacks);
    expect(callbacks.damageActor).not.toHaveBeenCalled();
    clearPlayer(world); sector.ceilingHeight = thinker.bottomHeight;
    tickCeiling(world, thinker, callbacks);
    expect(thinker.direction).toBe(1);
    expect(thinker.speed).toBe(FRAC_UNIT);
    sector.ceilingHeight = thinker.topHeight;
    tickCeiling(world, thinker, callbacks);
    expect(thinker.direction).toBe(-1);
  });

  it('keeps a fast crusher at two units when obstructed and after reversal', () => {
    const world = fixture(), callbacks = hooks();
    doCeiling(world, 7, 'fastCrushAndRaise');
    const thinker = ceiling(world), sector = world.sectors[0];
    if (!sector) throw new Error('Missing sector');
    sector.ceilingHeight = fixed(56);
    tickCeiling(world, thinker, callbacks);
    expect(thinker.speed).toBe(fixed(2));
    clearPlayer(world); sector.ceilingHeight = thinker.bottomHeight;
    tickCeiling(world, thinker, callbacks);
    expect(thinker.direction).toBe(1);
    expect(thinker.speed).toBe(fixed(2));
  });

  it('lowerAndCrush slows but restores a blocked non-crushing plane without damage', () => {
    const world = fixture(), callbacks = hooks();
    doCeiling(world, 7, 'lowerAndCrush');
    const thinker = ceiling(world), sector = world.sectors[0];
    if (!sector) throw new Error('Missing sector');
    sector.ceilingHeight = fixed(56);
    tickCeiling(world, thinker, callbacks);
    expect(sector.ceilingHeight).toBe(fixed(56));
    expect(thinker.speed).toBe(FRAC_UNIT / 8);
    expect(callbacks.damageActor).not.toHaveBeenCalled();
  });

  it('emits movement sound every eight tics, while silent crushers only sound at reversals', () => {
    const world = fixture(), callbacks = hooks(); clearPlayer(world);
    doCeiling(world, 7, 'silentCrushAndRaise');
    const thinker = ceiling(world), sector = world.sectors[0];
    if (!sector) throw new Error('Missing sector');
    tickCeiling(world, thinker, callbacks);
    expect(world.events).toEqual([]);
    sector.ceilingHeight = thinker.bottomHeight;
    tickCeiling(world, thinker, callbacks);
    expect(world.events).toEqual([{ type: 'sectorSound', sound: SfxId.sfx_pstop, sector: 0 }]);
    sector.ceilingHeight = thinker.topHeight;
    tickCeiling(world, thinker, callbacks);
    expect(world.events).toHaveLength(2);
    const normal = fixture(); clearPlayer(normal);
    doCeiling(normal, 7, 'lowerToFloor'); normal.levelTime = 7;
    tickCeiling(normal, ceiling(normal), callbacks);
    expect(normal.events).toEqual([]);
    normal.levelTime = 8; tickCeiling(normal, ceiling(normal), callbacks);
    expect(normal.events).toEqual([{ type: 'sectorSound', sound: SfxId.sfx_stnmov, sector: 0 }]);
  });
});

describe('ceiling stasis and active slots', () => {
  it('stops tagged movement and resumes its saved direction without reporting new activation', () => {
    const world = fixture(), callbacks = hooks();
    doCeiling(world, 7, 'crushAndRaise');
    const thinker = ceiling(world);
    thinker.direction = 1;
    expect(stopCeilings(world, 8)).toBe(false);
    expect(stopCeilings(world, 7)).toBe(true);
    expect(thinker.direction).toBe(0);
    expect(thinker.oldDirection).toBe(1);
    expect(stopCeilings(world, 7)).toBe(false);
    const height = world.sectors[0]?.ceilingHeight;
    tickCeiling(world, thinker, callbacks);
    expect(world.sectors[0]?.ceilingHeight).toBe(height);
    expect(doCeiling(world, 7, 'lowerToFloor')).toBe(false);
    expect(thinker.direction).toBe(0);
    expect(doCeiling(world, 7, 'fastCrushAndRaise')).toBe(false);
    expect(thinker.direction).toBe(1);
    expect(thinker.type).toBe('crushAndRaise');
  });

  it('retains the untracked thirty-first ceiling and cannot stop or remove it', () => {
    const world = fixture(31), callbacks = hooks(); clearPlayer(world);
    expect(doCeiling(world, 7, 'lowerToFloor')).toBe(true);
    const untracked = ceiling(world, 30), sector = world.sectors[30];
    if (!sector) throw new Error('Missing overflow sector');
    expect(untracked.activeSlot).toBe(null);
    stopCeilings(world, 7);
    expect(ceiling(world, 29).direction).toBe(0);
    expect(untracked.direction).toBe(-1);
    sector.ceilingHeight = untracked.bottomHeight;
    tickCeiling(world, untracked, callbacks);
    expect(untracked.removed).toBe(false);
    expect(sector.specialData).toBe(untracked);
  });

  it('reuses the first freed active slot while leaving overflow thinkers untracked', () => {
    const world = fixture(31), callbacks = hooks(); clearPlayer(world);
    doCeiling(world, 7, 'raiseToHighest');
    const first = ceiling(world), sector = world.sectors[0];
    if (!sector) throw new Error('Missing sector');
    sector.ceilingHeight = first.topHeight;
    tickCeiling(world, first, callbacks);
    expect(first.removed).toBe(true);
    expect(doCeiling(world, 7, 'lowerToFloor')).toBe(true);
    expect(ceiling(world).activeSlot).toBe(0);
    expect(ceiling(world)).not.toBe(first);
    expect(ceiling(world, 30).activeSlot).toBe(null);
  });
});
