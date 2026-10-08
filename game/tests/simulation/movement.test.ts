import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import type { DoomMap, MapSector } from '../../src/wad/map';
import { ActorType, MobjFlag, SfxId, actors } from '../../src/simulation/data/actors';
import { StateId } from '../../src/simulation/data/states';
import { fixedMul, FRAC_UNIT } from '../../src/simulation/fixed';
import { CheatFlag } from '../../src/simulation/player';
import { createWorld, removeActor, spawnActor, type World } from '../../src/simulation/world';
import {
  checkPosition, linkActor, moveXY, moveZ, slideMove, tryMove, unlinkActor,
  type MovementHooks,
} from '../../src/simulation/movement';

const fixed = (n: number) => (n * FRAC_UNIT) | 0;
const sector = (floorHeight = 0, ceilingHeight = 128): MapSector => ({
  floorHeight, ceilingHeight, floorTexture: 'FLAT', ceilingTexture: 'CEIL',
  lightLevel: 255, special: 0, tag: 0,
});

function fixture(options: {
  readonly wall?: boolean;
  readonly rightFloor?: number;
  readonly rightCeiling?: number;
  readonly flags?: number;
  readonly specials?: readonly number[];
  readonly points?: readonly (readonly [number, number, number, number])[];
} = {}): World {
  const points = options.points ?? [[0, 128, 0, -128]];
  const lines = points.map((_, i) => ({
    v1: i * 2, v2: i * 2 + 1, flags: options.flags ?? (options.wall ? 1 : 4),
    special: options.specials?.[i] ?? 0, tag: 0, frontSide: 0,
    backSide: options.wall ? null : 1,
  }));
  const box = { top: 256, bottom: -256, left: -256, right: 256 };
  const map: DoomMap = {
    name: 'E1M1',
    vertices: points.flatMap(([x1, y1, x2, y2]) => [{ x: x1, y: y1 }, { x: x2, y: y2 }]),
    lines, sectors: [sector(), sector(options.rightFloor, options.rightCeiling)],
    sides: [0, 1].map(s => ({ sector: s, textureOffset: 0, rowOffset: 0,
      upperTexture: '-', lowerTexture: '-', middleTexture: '-' })),
    segs: [], subsectors: [0, 1].map(s => ({ firstSeg: 0, segCount: 0, sector: s })),
    nodes: [{ x: 0, y: 0, dx: 0, dy: 1, boxes: [box, box], children: [0x8001, 0x8000] }],
    things: [{ x: -40, y: 0, angle: 0, type: 1, flags: 7 }], reject: new Uint8Array(1),
    blockmap: { originX: -256, originY: -256, width: 4, height: 4,
      cells: Array.from({ length: 16 }, () => lines.map((_, i) => i)) },
  };
  return createWorld(map, { skill: 2 });
}

function player(world: World) {
  const actor = world.actorsById.get(world.player.actorId);
  if (!actor) throw new Error('Missing fixture player');
  return actor;
}

function hooks(): MovementHooks {
  return { touchPickup: vi.fn(), damageActor: vi.fn(), explodeMissile: vi.fn(),
    crossSpecial: vi.fn(), runActorAction: vi.fn() };
}

describe('position and opening checks', () => {
  it('blocks a one-sided wall only when the destination box crosses it', () => {
    const world = fixture({ wall: true }), actor = player(world), callbacks = hooks();
    expect(checkPosition(world, actor, fixed(-16), 0, callbacks).fits).toBe(true);
    const blocked = checkPosition(world, actor, fixed(-15), 0, callbacks);
    expect(blocked.fits).toBe(false);
    expect(blocked.blockingLine).toBe(0);
    expect(actor.x).toBe(fixed(-40));
  });

  it.each([[24, true], [25, false]])('retains the %i unit step boundary', (height, fits) => {
    const world = fixture({ rightFloor: height }), actor = player(world);
    const result = tryMove(world, actor, fixed(-8), 0, hooks());
    expect(result.fits).toBe(fits);
    expect(result.floorZ).toBe(fixed(height));
    expect(result.floatOk).toBe(true);
    expect(actor.x).toBe(fixed(fits ? -8 : -40));
  });

  it.each([[56, true], [55, false]])('requires %i units of vertical clearance', (height, fits) => {
    const world = fixture({ rightCeiling: height }), actor = player(world);
    const result = tryMove(world, actor, fixed(-8), 0, hooks());
    expect(result.fits).toBe(fits);
    expect(result.ceilingLine).toBe(0);
    expect(result.floatOk).toBe(fits);
  });

  it('checks current Z as well as total opening height, except during teleport', () => {
    const world = fixture({ rightCeiling: 64 }), actor = player(world);
    actor.z = fixed(16);
    expect(tryMove(world, actor, fixed(-8), 0, hooks()).fits).toBe(false);
    actor.flags |= MobjFlag.MF_TELEPORT;
    expect(tryMove(world, actor, fixed(-8), 0, hooks()).fits).toBe(true);
  });

  it('keeps ordinary monsters from standing over a 25 unit dropoff', () => {
    const world = fixture({ rightFloor: -25 }), actor = player(world);
    actor.flags &= ~MobjFlag.MF_DROPOFF;
    expect(tryMove(world, actor, fixed(-8), 0, hooks()).fits).toBe(false);
    actor.flags |= MobjFlag.MF_FLOAT;
    expect(tryMove(world, actor, fixed(-8), 0, hooks()).fits).toBe(true);
  });

  it('uses mutable runtime sector heights for closed and reopened doors', () => {
    const world = fixture(), actor = player(world), right = world.sectors[1];
    if (!right) throw new Error('Missing door sector');
    right.ceilingHeight = 0;
    expect(tryMove(world, actor, fixed(-8), 0, hooks()).fits).toBe(false);
    right.ceilingHeight = fixed(128);
    expect(tryMove(world, actor, fixed(-8), 0, hooks()).fits).toBe(true);
  });

  it('lets missiles ignore blocking flags while monsters obey block-monsters', () => {
    const world = fixture({ flags: 7 }), actor = player(world);
    expect(checkPosition(world, actor, fixed(-8), 0, hooks()).fits).toBe(false);
    actor.flags |= MobjFlag.MF_MISSILE;
    expect(checkPosition(world, actor, fixed(-8), 0, hooks()).fits).toBe(true);
    world.lineFlags[0] = 6;
    actor.flags &= ~MobjFlag.MF_MISSILE;
    expect(checkPosition(world, actor, fixed(-8), 0, hooks()).fits).toBe(true);
    actor.player = null;
    expect(checkPosition(world, actor, fixed(-8), 0, hooks()).fits).toBe(false);
  });

  it('processes pickups before finding a blocking wall, preserving touch side effects', () => {
    const world = fixture({ wall: true }), actor = player(world), callbacks = hooks();
    const pickup = spawnActor(world, ActorType.MT_CLIP, fixed(-8), 0);
    expect(checkPosition(world, actor, fixed(-8), 0, callbacks).fits).toBe(false);
    expect(callbacks.touchPickup).toHaveBeenCalledWith(pickup, actor);
    actor.flags |= MobjFlag.MF_NOCLIP;
    vi.mocked(callbacks.touchPickup).mockClear();
    expect(tryMove(world, actor, fixed(8), 0, callbacks).fits).toBe(true);
    expect(callbacks.touchPickup).not.toHaveBeenCalled();
  });

  it('rejects solid actors by XY square overlap even at different heights', () => {
    const world = fixture(), actor = player(world);
    const barrel = spawnActor(world, ActorType.MT_BARREL, fixed(-8), 0, fixed(100));
    expect(checkPosition(world, actor, fixed(-8), 0, hooks()).fits).toBe(false);
    const boundary = (barrel.x - barrel.radius - actor.radius) | 0;
    expect(checkPosition(world, actor, boundary, 0, hooks()).fits).toBe(true);
  });

  it('crosses successful special lines in reverse blockmap encounter order', () => {
    const world = fixture({ specials: [2, 3], points: [[0, 128, 0, -128], [4, 128, 4, -128]] });
    const actor = player(world), callbacks = hooks();
    expect(tryMove(world, actor, fixed(8), 0, callbacks).fits).toBe(true);
    expect(vi.mocked(callbacks.crossSpecial).mock.calls.map(call => call.slice(0, 2))).toEqual([[1, 0], [0, 0]]);
    expect(actor.sector).toBe(1);
  });

  it('does not trigger a special until a fitting move actually crosses its side', () => {
    const world = fixture({ specials: [2], rightFloor: 25 });
    const actor = player(world), callbacks = hooks();
    const result = tryMove(world, actor, fixed(8), 0, callbacks);
    expect(result.specialLines).toEqual([0]);
    expect(result.fits).toBe(false);
    expect(callbacks.crossSpecial).not.toHaveBeenCalled();
    actor.flags |= MobjFlag.MF_TELEPORT;
    expect(tryMove(world, actor, fixed(8), 0, callbacks).fits).toBe(true);
    expect(callbacks.crossSpecial).not.toHaveBeenCalled();
  });
});

describe('blockmap actor membership', () => {
  it('retains Doom 1 mode and level metadata with the initial on-ground global', () => {
    const world = fixture();
    expect(world.mode).toBe('registered');
    expect(world.episode).toBe(1);
    expect(world.mapNumber).toBe(1);
    expect(world.onGround).toBe(false);
    expect(createWorld(world.spatial.map, { skill: 2, mode: 'shareware' }).mode).toBe('shareware');
    expect(() => createWorld({ ...world.spatial.map, name: 'MAP01' }, { skill: 2 })).toThrow(/Doom 1/);
  });

  it('spawns at list head and relinks successful same-cell moves to the head', () => {
    const world = fixture(), actor = player(world);
    const other = spawnActor(world, ActorType.MT_CLIP, fixed(-80), 0);
    const cell = world.actorBlocks.find(list => list.includes(actor.id));
    expect(cell).toEqual([other.id, actor.id]);
    expect(tryMove(world, actor, fixed(-39), 0, hooks()).fits).toBe(true);
    expect(cell).toEqual([actor.id, other.id]);
    unlinkActor(world, actor);
    expect(cell).toEqual([other.id]);
    actor.x = fixed(140);
    linkActor(world, actor);
    expect(world.actorBlocks.some(list => list.includes(actor.id))).toBe(true);
    expect(cell).toEqual([other.id]);
  });

  it('skips NOBLOCKMAP actors and removes active membership immediately exactly once', () => {
    const world = fixture(), actor = player(world);
    const puff = spawnActor(world, ActorType.MT_PUFF, actor.x, actor.y);
    expect(world.actorBlocks.flat()).not.toContain(puff.id);
    const state = actor.state;
    removeActor(world, actor);
    removeActor(world, actor);
    expect(actor.removed).toBe(true);
    expect(actor.state).toBe(state);
    expect(world.actorBlocks.flat()).not.toContain(actor.id);
    expect(world.activeActorIds.has(actor.id)).toBe(false);
    expect(world.actors).toContain(actor);
    expect(world.thinkers).toContainEqual({ kind: 'actor', id: actor.id });
    expect(world.events.filter(e => e.type === 'stopSound' && e.actor === actor.id)).toHaveLength(1);
  });

  it('damages the newest blocking actor first during a skull charge', () => {
    const world = fixture(), actor = player(world), callbacks = hooks();
    const first = spawnActor(world, ActorType.MT_BARREL, fixed(-8), 0);
    const last = spawnActor(world, ActorType.MT_BARREL, fixed(-8), 0);
    actor.type = ActorType.MT_SKULL;
    actor.flags |= MobjFlag.MF_SKULLFLY;
    actor.momx = fixed(10);
    expect(checkPosition(world, actor, fixed(-8), 0, callbacks).fits).toBe(false);
    expect(callbacks.damageActor).toHaveBeenCalledWith(last, actor, actor, expect.any(Number));
    expect(callbacks.damageActor).not.toHaveBeenCalledWith(first, actor, actor, expect.any(Number));
    expect(actor.flags & MobjFlag.MF_SKULLFLY).toBe(0);
    expect(actor.momx).toBe(0);
    expect(actor.state).toBe(actors[ActorType.MT_SKULL]?.spawnstate);
  });

  it('continues through consecutive pickups that unlink themselves during contact', () => {
    const world = fixture(), actor = player(world), callbacks = hooks();
    const first = spawnActor(world, ActorType.MT_CLIP, fixed(-8), 0);
    const second = spawnActor(world, ActorType.MT_CLIP, fixed(-8), 0);
    vi.mocked(callbacks.touchPickup).mockImplementation(thing => removeActor(world, thing));
    expect(checkPosition(world, actor, fixed(-8), 0, callbacks).fits).toBe(true);
    expect(vi.mocked(callbacks.touchPickup).mock.calls.map(call => call[0].id)).toEqual([second.id, first.id]);
    expect(world.actorBlocks.flat()).toEqual([actor.id]);
  });
});

describe('missile movement', () => {
  it('passes its shooter but explodes on same-species actors without damaging them', () => {
    const world = fixture(), source = player(world), callbacks = hooks();
    source.type = ActorType.MT_TROOP;
    const missile = spawnActor(world, ActorType.MT_TROOPSHOT, source.x, 0, fixed(20));
    missile.target = source.id;
    expect(checkPosition(world, missile, source.x, 0, callbacks).fits).toBe(true);
    spawnActor(world, ActorType.MT_TROOP, fixed(-8), 0);
    expect(checkPosition(world, missile, fixed(-8), 0, callbacks).fits).toBe(false);
    expect(callbacks.damageActor).not.toHaveBeenCalled();
    missile.momx = fixed(30);
    moveXY(world, missile, callbacks);
    expect(callbacks.explodeMissile).toHaveBeenCalledWith(missile);
  });

  it('applies original random damage on vertical edge contact but passes above it', () => {
    const world = fixture(), callbacks = hooks();
    const target = spawnActor(world, ActorType.MT_BARREL, fixed(64), 0);
    const missile = spawnActor(world, ActorType.MT_ROCKET, fixed(32), 0, target.height);
    missile.target = world.player.actorId;
    world.random.gameIndex = 0;
    expect(checkPosition(world, missile, fixed(64), 0, callbacks).fits).toBe(false);
    expect(callbacks.damageActor).toHaveBeenCalledWith(target, missile, player(world), 20);
    vi.mocked(callbacks.damageActor).mockClear();
    missile.z++;
    expect(checkPosition(world, missile, fixed(64), 0, callbacks).fits).toBe(true);
    expect(callbacks.damageActor).not.toHaveBeenCalled();
  });

  it('treats barons and knights as one missile species and still damages a player', () => {
    const world = fixture(), callbacks = hooks(), target = player(world);
    const baron = spawnActor(world, ActorType.MT_BRUISER, fixed(-120), 0);
    const knight = spawnActor(world, ActorType.MT_KNIGHT, fixed(64), 0);
    const missile = spawnActor(world, ActorType.MT_BRUISERSHOT, fixed(32), 0, fixed(20));
    missile.target = baron.id;
    expect(checkPosition(world, missile, knight.x, knight.y, callbacks).fits).toBe(false);
    expect(callbacks.damageActor).not.toHaveBeenCalled();
    expect(checkPosition(world, missile, target.x, target.y, callbacks).fits).toBe(false);
    expect(callbacks.damageActor).toHaveBeenCalledWith(target, missile, baron, expect.any(Number));
  });

  it('removes a missile against a sky ceiling without playing its explosion', () => {
    const world = fixture({ rightCeiling: 40 }), callbacks = hooks();
    const right = world.sectors[1];
    if (!right) throw new Error('Missing sector');
    right.ceilingTexture = 'F_SKY1';
    const missile = spawnActor(world, ActorType.MT_ROCKET, fixed(-20), 0, fixed(40));
    missile.momx = fixed(20);
    moveXY(world, missile, callbacks);
    expect(missile.removed).toBe(true);
    expect(callbacks.explodeMissile).not.toHaveBeenCalled();
  });
});

describe('XY movement and sliding', () => {
  it('slides along a vertical wall using the three leading corner traces', () => {
    const world = fixture({ wall: true }), actor = player(world);
    actor.momx = fixed(30); actor.momy = fixed(10);
    slideMove(world, actor, hooks());
    expect(actor.x).toBeLessThan(fixed(-16));
    expect(actor.x).toBeGreaterThan(fixed(-18));
    expect(actor.y).toBeGreaterThan(fixed(9));
    expect(actor.momx).toBe(0);
    expect(actor.momy).toBeGreaterThan(0);
  });

  it('clamps momentum and applies original fixed friction on the floor', () => {
    const world = fixture(), actor = player(world);
    actor.momx = fixed(-40);
    moveXY(world, actor, hooks());
    expect(actor.x).toBe(fixed(-70));
    expect(actor.momx).toBe(fixedMul(fixed(-30), 0xe800));
    actor.z = fixed(8); actor.momx = fixed(-1);
    moveXY(world, actor, hooks());
    expect(actor.momx).toBe(fixed(-1));
  });

  it('keeps corpses sliding over a ledge until momentum is sufficiently small', () => {
    const world = fixture(), actor = player(world);
    actor.player = null;
    actor.flags |= MobjFlag.MF_CORPSE;
    actor.floorZ = fixed(24); actor.z = fixed(24); actor.momx = fixed(-1);
    // This contacted ledge is retained by the successful destination check.
    const right = world.sectors[1];
    if (!right) throw new Error('Missing ledge');
    right.floorHeight = fixed(24);
    unlinkActor(world, actor); actor.x = fixed(-8); linkActor(world, actor);
    moveXY(world, actor, hooks());
    expect(actor.momx).toBe(fixed(-1));
    actor.momx = FRAC_UNIT / 8;
    moveXY(world, actor, hooks());
    expect(actor.momx).toBe(fixedMul(FRAC_UNIT / 8, 0xe800));
  });

  it('resets a stalled skull charge even without XY movement', () => {
    const world = fixture(), actor = spawnActor(world, ActorType.MT_SKULL, fixed(-100), 0);
    actor.flags |= MobjFlag.MF_SKULLFLY;
    actor.momz = fixed(8);
    moveXY(world, actor, hooks());
    expect(actor.flags & MobjFlag.MF_SKULLFLY).toBe(0);
    expect(actor.momz).toBe(0);
    expect(actor.state).toBe(actors[ActorType.MT_SKULL]?.spawnstate);
  });

  it('stops small momentum and restores idle player state unless input is held', () => {
    const world = fixture(), actor = player(world);
    actor.state = StateId.S_PLAY_RUN1; actor.momx = 0x800;
    moveXY(world, actor, hooks());
    expect(actor.momx).toBe(0);
    expect(actor.state).toBe(StateId.S_PLAY);
    actor.momx = 0x800;
    moveXY(world, actor, hooks(), { forwardMove: 1, sideMove: 0 });
    expect(actor.momx).toBe(fixedMul(0x800, 0xe800));
    world.player.cheats |= CheatFlag.CF_NOMOMENTUM;
    actor.momx = fixed(1);
    moveXY(world, actor, hooks());
    expect(actor.momx).toBe(0);
  });
});

describe('Z movement', () => {
  it('starts gravity at two units, then accelerates by one per tic', () => {
    const world = fixture(), actor = player(world);
    actor.z = fixed(40);
    moveZ(world, actor, hooks());
    expect(actor.z).toBe(fixed(40)); expect(actor.momz).toBe(fixed(-2));
    moveZ(world, actor, hooks());
    expect(actor.z).toBe(fixed(38)); expect(actor.momz).toBe(fixed(-3));
  });

  it('adjusts player view for a step and squats with sound after a hard landing', () => {
    const world = fixture(), actor = player(world);
    actor.floorZ = fixed(24);
    moveZ(world, actor, hooks());
    expect(actor.z).toBe(fixed(24));
    expect(world.player.viewHeight).toBe(fixed(17));
    expect(world.player.deltaViewHeight).toBe(fixed(3));
    actor.floorZ = 0; actor.z = fixed(8); actor.momz = fixed(-10);
    moveZ(world, actor, hooks());
    expect(actor.z).toBe(0); expect(actor.momz).toBe(0);
    expect(world.player.deltaViewHeight).toBe(fixed(-10) >> 3);
    expect(world.events).toContainEqual({ type: 'sound', sound: SfxId.sfx_oof, actor: actor.id });
  });

  it('retains the original lost soul floor bounce and ceiling momentum bug', () => {
    const world = fixture(), skull = spawnActor(world, ActorType.MT_SKULL, fixed(-100), 0, fixed(4));
    skull.flags |= MobjFlag.MF_SKULLFLY;
    skull.momz = fixed(-8);
    moveZ(world, skull, hooks());
    expect(skull.z).toBe(0); expect(skull.momz).toBe(fixed(8));
    skull.z = skull.ceilingZ - skull.height; skull.momz = fixed(8);
    moveZ(world, skull, hooks());
    expect(skull.z).toBe(skull.ceilingZ - skull.height);
    expect(skull.momz).toBe(0);
  });

  it('floats toward a nearby target and explodes missiles on the floor', () => {
    const world = fixture(), callbacks = hooks();
    const head = spawnActor(world, ActorType.MT_HEAD, fixed(-60), 0, fixed(40));
    head.target = world.player.actorId;
    moveZ(world, head, callbacks);
    expect(head.z).toBe(fixed(36));
    const missile = spawnActor(world, ActorType.MT_ROCKET, fixed(-100), 0, fixed(1));
    missile.momz = fixed(-2);
    moveZ(world, missile, callbacks);
    expect(callbacks.explodeMissile).toHaveBeenCalledWith(missile);
  });
});

describe('original shareware geometry integration', () => {
  const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('checks and relinks the original E1M%i start', mapNumber => {
    const world = createWorld(decodeMap(wad, `E1M${mapNumber}`), { skill: 2, mode: 'shareware' });
    const actor = player(world);
    const result = tryMove(world, actor, actor.x, actor.y, hooks());
    expect(result.fits).toBe(true);
    expect(result.ceilingZ - result.floorZ).toBeGreaterThanOrEqual(actor.height);
    const list = world.actorBlocks.find(block => block.includes(actor.id));
    expect(list?.[0]).toBe(actor.id);
    expect(world.actorBlocks.flat().filter(id => id === actor.id)).toHaveLength(1);
  });
});
