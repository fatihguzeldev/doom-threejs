import { describe, expect, it, vi } from 'vitest';
import type { DoomMap } from '../../src/wad/map';
import { SfxId } from '../../src/simulation/data/actors';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { doPlatform, stopPlatforms, tickPlatform } from '../../src/simulation/specials/platforms';
import type { PlatformThinker } from '../../src/simulation/specials/types';
import type { PlaneHooks } from '../../src/simulation/specials/planes';
import { createWorld, removeActor, type World } from '../../src/simulation/world';

const fixed = (n: number) => (n * FRAC_UNIT) | 0;

function fixture(count = 1): World {
  const box = { top: 256, bottom: 0, left: 0, right: (count + 1) * 128 };
  const connections = Array.from({ length: count }, (_, i) => [i, count] as const);
  connections.push([count, 0]);
  const map: DoomMap = {
    name: 'E1M1',
    vertices: connections.flatMap((_, i) => [{ x: (i + 1) * 128, y: 0 }, { x: (i + 1) * 128, y: 256 }]),
    lines: connections.map((_, i) => ({ v1: i * 2, v2: i * 2 + 1, flags: 4,
      special: 0, tag: 7, frontSide: i * 2, backSide: i * 2 + 1 })),
    sides: connections.flatMap(pair => pair.map(sector => ({ sector, textureOffset: 0,
      rowOffset: 0, upperTexture: '-', lowerTexture: '-', middleTexture: '-' }))),
    sectors: Array.from({ length: count + 1 }, (_, i) => ({ floorHeight: i === count ? -16 : 0, ceilingHeight: 128,
      floorTexture: i === count ? 'MODEL' : 'FLAT', ceilingTexture: 'CEIL', lightLevel: 255,
      special: i === count ? 0 : 5, tag: i === count ? 0 : 7 })),
    segs: [], subsectors: [{ firstSeg: 0, segCount: 0, sector: 0 }, { firstSeg: 0, segCount: 0, sector: count }],
    nodes: [{ x: 128, y: 0, dx: 0, dy: 1, boxes: [box, box], children: [0x8001, 0x8000] }],
    things: [{ x: 64, y: 64, angle: 0, type: 1, flags: 7 }], reject: new Uint8Array(Math.ceil((count + 1) ** 2 / 8)),
    blockmap: { originX: 0, originY: 0, width: count + 3, height: 3,
      cells: Array.from({ length: (count + 3) * 3 }, () => connections.map((_, i) => i)) },
  };
  return createWorld(map, { skill: 2 });
}

function hooks(): PlaneHooks {
  return { damageActor: vi.fn(), movement: { touchPickup: vi.fn(), damageActor: vi.fn(),
    explodeMissile: vi.fn(), crossSpecial: vi.fn(), runActorAction: vi.fn() } };
}

function platform(world: World, index = 0): PlatformThinker {
  const thinker = world.sectors[index]?.specialData;
  if (thinker?.kind !== 'platform') throw new Error('Missing platform thinker');
  return thinker;
}

function clearPlayer(world: World): void {
  const player = world.actorsById.get(world.player.actorId);
  if (!player) throw new Error('Missing player');
  removeActor(world, player);
  world.events.length = 0;
}

describe('native platform creation', () => {
  it.each([['downWaitUpStay', 4], ['blazeDownWaitUpStay', 8]] as const)
  ('configures %s to lower, wait three seconds and return', (type, speed) => {
    const world = fixture();
    expect(doPlatform(world, 7, type, 0, 0)).toBe(true);
    const thinker = platform(world);
    expect(thinker.low).toBe(fixed(-16));
    expect(thinker.high).toBe(0);
    expect(thinker.wait).toBe(105);
    expect(thinker.status).toBe('down');
    expect(thinker.speed).toBe(fixed(speed));
    expect(thinker.activeSlot).toBe(0);
    expect(world.events.at(-1)).toEqual({ type: 'sectorSound', sound: SfxId.sfx_pstart, sector: 0 });
  });

  it('raises and changes texture without clearing the existing damaging special', () => {
    const world = fixture();
    doPlatform(world, 7, 'raiseAndChange', 24, 1);
    expect(platform(world).high).toBe(fixed(24));
    expect(platform(world).speed).toBe(FRAC_UNIT / 2);
    expect(platform(world).wait).toBe(0);
    expect(world.sectors[0]?.floorTexture).toBe('MODEL');
    expect(world.sectors[0]?.special).toBe(5);
  });

  it('raises to the next higher floor, copies the model texture and clears damage', () => {
    const world = fixture(), neighbor = world.sectors[1];
    if (!neighbor) throw new Error('Missing neighbor');
    neighbor.floorHeight = fixed(48);
    doPlatform(world, 7, 'raiseToNearestAndChange', 0, 1);
    expect(platform(world).high).toBe(fixed(48));
    expect(world.sectors[0]?.floorTexture).toBe('MODEL');
    expect(world.sectors[0]?.special).toBe(0);
  });

  it('uses original random parity for a perpetual platform and clamps its endpoints to the current floor', () => {
    const world = fixture(); world.random.gameIndex = 0;
    doPlatform(world, 7, 'perpetualRaise', 0, 0);
    expect(platform(world).status).toBe('up');
    expect(platform(world).low).toBe(fixed(-16));
    expect(platform(world).high).toBe(0);
    expect(world.random.gameIndex).toBe(1);
    const second = fixture(); second.random.gameIndex = 1;
    doPlatform(second, 7, 'perpetualRaise', 0, 0);
    expect(platform(second).status).toBe('down');
  });

  it('ignores untagged and busy sectors', () => {
    const world = fixture();
    expect(doPlatform(world, 99, 'downWaitUpStay', 0, 0)).toBe(false);
    expect(doPlatform(world, 7, 'downWaitUpStay', 0, 0)).toBe(true);
    const current = platform(world);
    expect(doPlatform(world, 7, 'raiseAndChange', 24, 1)).toBe(false);
    expect(platform(world)).toBe(current);
  });
});

describe('native platform movement', () => {
  it('lowers at four units, waits exactly 105 tics and removes itself after returning', () => {
    const world = fixture(), callbacks = hooks();
    doPlatform(world, 7, 'downWaitUpStay', 0, 0);
    const thinker = platform(world);
    for (let i = 0; i < 4; i++) tickPlatform(world, thinker, callbacks);
    expect(world.sectors[0]?.floorHeight).toBe(fixed(-16));
    expect(thinker.status).toBe('down');
    tickPlatform(world, thinker, callbacks);
    expect(thinker.status).toBe('waiting');
    expect(thinker.count).toBe(105);
    for (let i = 0; i < 104; i++) tickPlatform(world, thinker, callbacks);
    expect(thinker.status).toBe('waiting');
    expect(thinker.count).toBe(1);
    tickPlatform(world, thinker, callbacks);
    expect(thinker.status).toBe('up');
    for (let i = 0; i < 5; i++) tickPlatform(world, thinker, callbacks);
    expect(world.sectors[0]?.floorHeight).toBe(0);
    expect(thinker.removed).toBe(true);
    expect(world.sectors[0]?.specialData).toBe(null);
    expect(world.events.filter(event => event.type === 'sectorSound').map(event => event.sound)).toEqual([
      SfxId.sfx_pstart, SfxId.sfx_pstop, SfxId.sfx_pstart, SfxId.sfx_pstop,
    ]);
  });

  it('reverses a blocked non-crushing rise immediately and retains its wait counter', () => {
    const world = fixture(), callbacks = hooks(), sector = world.sectors[0];
    if (!sector) throw new Error('Missing sector');
    sector.ceilingHeight = fixed(56);
    doPlatform(world, 7, 'raiseAndChange', 24, 1);
    const thinker = platform(world);
    thinker.wait = 105;
    tickPlatform(world, thinker, callbacks);
    expect(sector.floorHeight).toBe(0);
    expect(thinker.status).toBe('down');
    expect(thinker.count).toBe(105);
    expect(callbacks.damageActor).not.toHaveBeenCalled();
    expect(world.events.at(-1)).toEqual({ type: 'sectorSound', sound: SfxId.sfx_pstart, sector: 0 });
  });

  it('keeps a perpetual platform after reaching its high point and next reverses toward low', () => {
    const world = fixture(), callbacks = hooks(); clearPlayer(world);
    world.random.gameIndex = 0;
    doPlatform(world, 7, 'perpetualRaise', 0, 0);
    const thinker = platform(world);
    tickPlatform(world, thinker, callbacks);
    expect(thinker.status).toBe('waiting');
    expect(thinker.removed).toBe(false);
    thinker.count = 1;
    tickPlatform(world, thinker, callbacks);
    expect(thinker.status).toBe('down');
  });

  it('emits raising texture movement sound on the eight-tic cadence and removes at its height', () => {
    const world = fixture(), callbacks = hooks(); clearPlayer(world);
    doPlatform(world, 7, 'raiseAndChange', 1, 1);
    const thinker = platform(world);
    world.events.length = 0; world.levelTime = 7;
    tickPlatform(world, thinker, callbacks);
    expect(world.events).toEqual([]);
    world.levelTime = 8;
    tickPlatform(world, thinker, callbacks);
    expect(world.events.at(-1)).toEqual({ type: 'sectorSound', sound: SfxId.sfx_stnmov, sector: 0 });
    tickPlatform(world, thinker, callbacks);
    expect(thinker.removed).toBe(true);
    expect(world.events.at(-1)).toEqual({ type: 'sectorSound', sound: SfxId.sfx_pstop, sector: 0 });
  });

  it('keeps a zero waiting counter waiting after the native pre-decrement', () => {
    const world = fixture(), callbacks = hooks(); clearPlayer(world);
    doPlatform(world, 7, 'perpetualRaise', 0, 0);
    const thinker = platform(world);
    thinker.status = 'waiting'; thinker.count = 0;
    tickPlatform(world, thinker, callbacks);
    expect(thinker.status).toBe('waiting');
    expect(thinker.count).toBe(-1);
  });
});

describe('platform stasis and capacity', () => {
  it('saves and restores a waiting platform without consuming another random byte', () => {
    const world = fixture(), callbacks = hooks();
    doPlatform(world, 7, 'perpetualRaise', 0, 0);
    const thinker = platform(world);
    thinker.status = 'waiting'; thinker.count = 20;
    expect(stopPlatforms(world, 7)).toBeUndefined();
    expect(thinker.status).toBe('stasis');
    expect(thinker.oldStatus).toBe('waiting');
    tickPlatform(world, thinker, callbacks);
    expect(thinker.count).toBe(20);
    const random = world.random.gameIndex;
    expect(doPlatform(world, 7, 'downWaitUpStay', 0, 0)).toBe(false);
    expect(thinker.status).toBe('stasis');
    expect(doPlatform(world, 7, 'perpetualRaise', 0, 0)).toBe(false);
    expect(thinker.status).toBe('waiting');
    expect(world.random.gameIndex).toBe(random);
  });

  it('throws at platform thirty-one after the thinker and sector association are installed', () => {
    const world = fixture(31);
    expect(() => doPlatform(world, 7, 'downWaitUpStay', 0, 0)).toThrow(/no more plat/i);
    expect(platform(world, 29).activeSlot).toBe(29);
    expect(platform(world, 30).activeSlot).toBe(null);
    expect(world.thinkers.filter(thinker => thinker.kind === 'platform')).toHaveLength(31);
  });

  it('reuses a freed slot for newly activated platforms', () => {
    const world = fixture(30), callbacks = hooks(); clearPlayer(world);
    doPlatform(world, 7, 'raiseAndChange', 0, 30);
    const first = platform(world);
    tickPlatform(world, first, callbacks);
    expect(first.removed).toBe(true);
    expect(doPlatform(world, 7, 'downWaitUpStay', 0, 0)).toBe(true);
    expect(platform(world).activeSlot).toBe(0);
    expect(platform(world, 29).activeSlot).toBe(29);
  });
});
