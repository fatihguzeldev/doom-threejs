import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap, type DoomMap } from '../../src/wad/map';
import { ActorType, MobjFlag, SfxId, actors } from '../../src/simulation/data/actors';
import { ActionId, StateId } from '../../src/simulation/data/states';
import { fixedMul, FRAC_UNIT } from '../../src/simulation/fixed';
import { ANG180 } from '../../src/simulation/angle';
import { createWorld, spawnActor, type World } from '../../src/simulation/world';
import { gameRandom } from '../../src/simulation/random';
import {
  aimLineAttack, explodeMissile, lineAttack, radiusAttack, spawnBlood, spawnMissile,
  spawnPlayerMissile, spawnPuff, useLines, type ShootingHooks,
} from '../../src/simulation/shooting';

const fixed = (n: number) => (n * FRAC_UNIT) | 0;

function fixture(options: {
  readonly walls?: readonly { readonly x: number; readonly special?: number; readonly oneSided?: boolean }[];
  readonly rightFloor?: number;
  readonly rightCeiling?: number;
} = {}): World {
  const walls = options.walls ?? [], count = walls.length;
  const box = { top: 1024, bottom: 0, left: 0, right: 1536 };
  const map: DoomMap = {
    name: 'E1M1',
    vertices: walls.flatMap(wall => [{ x: wall.x, y: 0 }, { x: wall.x, y: 1024 }]),
    lines: walls.map((wall, i) => ({ v1: i * 2, v2: i * 2 + 1, flags: wall.oneSided ? 1 : 4,
      special: wall.special ?? 0, tag: 0, frontSide: 0, backSide: wall.oneSided ? null : 1 })),
    sides: [0, 1].map(sector => ({ sector, textureOffset: 0, rowOffset: 0,
      upperTexture: '-', lowerTexture: '-', middleTexture: '-' })),
    sectors: [0, 1].map(i => ({ floorHeight: i ? options.rightFloor ?? 0 : 0,
      ceilingHeight: i ? options.rightCeiling ?? 128 : 128, floorTexture: 'FLAT', ceilingTexture: 'CEIL',
      lightLevel: 255, special: 0, tag: 0 })),
    segs: [0, 1].flatMap(side => walls.map((_, line) => ({ v1: line * 2, v2: line * 2 + 1,
      angle: 0, line, side: side as 0 | 1, offset: 0 }))),
    subsectors: [{ firstSeg: 0, segCount: count, sector: 0 }, { firstSeg: count, segCount: count, sector: 1 }],
    nodes: [{ x: 256, y: 0, dx: 0, dy: 1, boxes: [box, box], children: [0x8001, 0x8000] }],
    things: [{ x: 64, y: 64, angle: 0, type: 1, flags: 7 }], reject: new Uint8Array(1),
    blockmap: { originX: 0, originY: 0, width: 12, height: 8,
      cells: Array.from({ length: 96 }, () => walls.map((_, i) => i)) },
  };
  return createWorld(map, { skill: 2 });
}

function source(world: World) {
  const actor = world.actorsById.get(world.player.actorId);
  if (!actor) throw new Error('Missing shooter');
  return actor;
}

function hooks(): ShootingHooks {
  return { damageActor: vi.fn(), runActorAction: vi.fn(), shootSpecial: vi.fn(), useSpecial: vi.fn() };
}

describe('hitscan auto-aim', () => {
  it('uses twenty-unit monster projectiles in fast/nightmare worlds without affecting normal worlds', () => {
    const normal = fixture();
    const fast = createWorld(normal.spatial.map, { skill: 2, fastMonsters: true });
    const nightmare = createWorld(normal.spatial.map, { skill: 4 });
    for (const world of [normal, fast, nightmare]) {
      const shooter = source(world);
      const target = spawnActor(world, ActorType.MT_POSSESSED, fixed(512), shooter.y, fixed(32));
      for (const type of [ActorType.MT_TROOPSHOT, ActorType.MT_HEADSHOT, ActorType.MT_BRUISERSHOT]) {
        const shot = spawnMissile(world, shooter, target, type, hooks());
        const speed = world === normal ? actors[type]?.speed : fixed(20);
        expect(speed).toBeDefined();
        expect(shot.momx).toBe(fixedMul(speed ?? 0, 65535));
      }
    }
  });
  it('selects the first shootable target and centers the available vertical slope', () => {
    const world = fixture(), shooter = source(world);
    spawnActor(world, ActorType.MT_CLIP, fixed(96), fixed(64));
    const near = spawnActor(world, ActorType.MT_POSSESSED, fixed(192), fixed(64));
    spawnActor(world, ActorType.MT_POSSESSED, fixed(256), fixed(64));
    const randomIndex = world.random.gameIndex;
    const result = aimLineAttack(world, shooter, 0, fixed(1024));
    expect(result.target).toBe(near);
    expect(result.slope).toBeLessThan(0);
    expect(result.slope).toBeGreaterThan(-fixed(0.1));
    expect(world.random.gameIndex).toBe(randomIndex);
  });

  it('returns zero slope when a wall or closed opening prevents a target', () => {
    const world = fixture({ walls: [{ x: 128, oneSided: true }] }), shooter = source(world);
    spawnActor(world, ActorType.MT_POSSESSED, fixed(192), fixed(64));
    expect(aimLineAttack(world, shooter, 0, fixed(1024))).toEqual({ slope: 0, target: null });
    const closed = fixture({ walls: [{ x: 128 }], rightCeiling: 0 });
    spawnActor(closed, ActorType.MT_POSSESSED, fixed(192), fixed(64));
    expect(aimLineAttack(closed, source(closed), 0, fixed(1024)).target).toBe(null);
  });

  it('narrows auto-aim through a portal and ignores targets outside the view slope', () => {
    const world = fixture({ walls: [{ x: 128 }], rightFloor: 40 }), shooter = source(world);
    const target = spawnActor(world, ActorType.MT_POSSESSED, fixed(192), fixed(64));
    const aim = aimLineAttack(world, shooter, 0, fixed(1024));
    expect(aim.target).toBe(target);
    expect(aim.slope).toBeGreaterThan(0);
    target.z = fixed(256);
    expect(aimLineAttack(world, shooter, 0, fixed(1024)).target).toBe(null);
  });

  it('narrows auto-aim below a lowered portal ceiling', () => {
    const world = fixture({ walls: [{ x: 128 }], rightCeiling: 30 });
    const target = spawnActor(world, ActorType.MT_POSSESSED, fixed(192), fixed(64));
    const aim = aimLineAttack(world, source(world), 0, fixed(1024));
    expect(aim.target).toBe(target);
    expect(aim.slope).toBeLessThan(-fixed(0.1));
  });

  it('does not aim at itself or at corpses with shootable cleared', () => {
    const world = fixture(), shooter = source(world);
    const corpse = spawnActor(world, ActorType.MT_POSSESSED, fixed(96), fixed(64));
    corpse.flags &= ~MobjFlag.MF_SHOOTABLE;
    expect(aimLineAttack(world, shooter, 0, fixed(1024))).toEqual({ slope: 0, target: null });
  });
});

describe('native line attack', () => {
  it('spawns blood ten units before a hit and sends exact damage attribution', () => {
    const world = fixture(), shooter = source(world), callbacks = hooks();
    const target = spawnActor(world, ActorType.MT_POSSESSED, fixed(192), fixed(64));
    world.random.gameIndex = 0;
    expect(lineAttack(world, shooter, 0, fixed(1024), 0, 20, callbacks)).toBe(target);
    expect(callbacks.damageActor).toHaveBeenCalledWith(target, shooter, shooter, 20);
    const blood = world.actors.find(actor => actor.type === ActorType.MT_BLOOD);
    if (!blood) throw new Error('Blood not spawned');
    expect(blood.x).toBeGreaterThan(fixed(181));
    expect(blood.x).toBeLessThan(fixed(183));
    expect(blood.z).toBe(fixed(36) + ((8 - 109) << 10));
    expect(blood.momz).toBe(fixed(2));
    expect(world.random.gameIndex).toBe(4);
  });

  it('still spawns an effect for a zero-damage trace but does not damage', () => {
    const world = fixture(), shooter = source(world), callbacks = hooks();
    const target = spawnActor(world, ActorType.MT_POSSESSED, fixed(192), fixed(64));
    expect(lineAttack(world, shooter, 0, fixed(1024), 0, 0, callbacks)).toBe(target);
    expect(callbacks.damageActor).not.toHaveBeenCalled();
    expect(world.actors.some(actor => actor.type === ActorType.MT_BLOOD && actor.state === StateId.S_BLOOD3)).toBe(true);
  });

  it('makes a puff on NOBLOOD targets and misses actors above the bullet slope', () => {
    const world = fixture(), shooter = source(world), callbacks = hooks();
    const target = spawnActor(world, ActorType.MT_BARREL, fixed(192), fixed(64));
    target.flags |= MobjFlag.MF_NOBLOOD;
    expect(lineAttack(world, shooter, 0, fixed(1024), 0, 10, callbacks)).toBe(target);
    expect(world.actors.some(actor => actor.type === ActorType.MT_PUFF)).toBe(true);
    target.z = fixed(100);
    expect(lineAttack(world, shooter, 0, fixed(1024), 0, 10, callbacks)).toBe(null);
    expect(callbacks.damageActor).toHaveBeenCalledTimes(1);
  });

  it('runs shoot-special before a blocking wall and puffs four units before it', () => {
    const world = fixture({ walls: [{ x: 128, oneSided: true, special: 46 }] });
    const shooter = source(world), callbacks = hooks();
    world.random.gameIndex = 0;
    expect(lineAttack(world, shooter, 0, fixed(1024), 0, 5, callbacks)).toBe(null);
    expect(callbacks.shootSpecial).toHaveBeenCalledWith(0, shooter);
    const puff = world.actors.find(actor => actor.type === ActorType.MT_PUFF);
    if (!puff) throw new Error('Puff not spawned');
    expect(puff.x).toBeGreaterThan(fixed(123));
    expect(puff.x).toBeLessThan(fixed(125));
    expect(puff.momz).toBe(FRAC_UNIT);
    expect(puff.tics).toBe(2);
    expect(world.random.gameIndex).toBe(4);
  });

  it('passes an open portal and stops at raised floors or lowered ceilings', () => {
    const clear = fixture({ walls: [{ x: 128 }] }), callbacks = hooks();
    const target = spawnActor(clear, ActorType.MT_POSSESSED, fixed(192), fixed(64));
    expect(lineAttack(clear, source(clear), 0, fixed(1024), 0, 5, callbacks)).toBe(target);
    const blocked = fixture({ walls: [{ x: 128 }], rightFloor: 40 });
    spawnActor(blocked, ActorType.MT_POSSESSED, fixed(192), fixed(64));
    expect(lineAttack(blocked, source(blocked), 0, fixed(1024), 0, 5, hooks())).toBe(null);
    expect(blocked.actors.some(actor => actor.type === ActorType.MT_PUFF)).toBe(true);
    const lowCeiling = fixture({ walls: [{ x: 128 }], rightCeiling: 32 });
    spawnActor(lowCeiling, ActorType.MT_POSSESSED, fixed(192), fixed(64));
    expect(lineAttack(lowCeiling, source(lowCeiling), 0, fixed(1024), 0, 5, hooks())).toBe(null);
    expect(lowCeiling.actors.some(actor => actor.type === ActorType.MT_PUFF)).toBe(true);
  });

  it('suppresses sky impacts, including a sky portal hack, without consuming RNG', () => {
    const world = fixture({ walls: [{ x: 128, oneSided: true }] }), shooter = source(world);
    const front = world.sectors[0];
    if (!front) throw new Error('Missing sector');
    front.ceilingTexture = 'F_SKY1'; front.ceilingHeight = fixed(32);
    world.random.gameIndex = 0;
    lineAttack(world, shooter, 0, fixed(1024), 0, 5, hooks());
    expect(world.actors.some(actor => actor.type === ActorType.MT_PUFF)).toBe(false);
    expect(world.random.gameIndex).toBe(0);
    const portal = fixture({ walls: [{ x: 128 }], rightFloor: 64 });
    for (const sector of portal.sectors) sector.ceilingTexture = 'F_SKY1';
    portal.random.gameIndex = 0;
    lineAttack(portal, source(portal), 0, fixed(1024), 0, 5, hooks());
    expect(portal.actors.some(actor => actor.type === ActorType.MT_PUFF)).toBe(false);
    expect(portal.random.gameIndex).toBe(0);
  });
});

describe('puff and blood lifecycle', () => {
  it('consumes puff jitter, actor lastlook and tic randomness in source order', () => {
    const world = fixture(); world.random.gameIndex = 0;
    const puff = spawnPuff(world, fixed(128), fixed(64), fixed(36), fixed(1024), hooks());
    expect(puff.z).toBe(fixed(36) - 103424);
    expect(puff.lastLook).toBe(0);
    expect(puff.tics).toBe(2);
    expect(puff.state).toBe(StateId.S_PUFF1);
    expect(world.random.gameIndex).toBe(4);
  });

  it('enters the non-sparking punch puff after tic randomization', () => {
    const world = fixture(); world.random.gameIndex = 0;
    const puff = spawnPuff(world, fixed(128), fixed(64), fixed(36), fixed(64), hooks());
    expect(puff.state).toBe(StateId.S_PUFF3);
    expect(puff.tics).toBe(4);
    expect(world.random.gameIndex).toBe(4);
  });

  it.each([[8, StateId.S_BLOOD3, 8], [9, StateId.S_BLOOD2, 8], [12, StateId.S_BLOOD2, 8], [13, StateId.S_BLOOD1, 6]])
  ('uses the %i damage blood state and resulting tic duration', (damage, state, tics) => {
    const world = fixture(); world.random.gameIndex = 0;
    const blood = spawnBlood(world, fixed(128), fixed(64), fixed(36), damage, hooks());
    expect(blood.state).toBe(state);
    expect(blood.tics).toBe(tics);
    expect(blood.z).toBe(fixed(36) - 103424);
    expect(blood.momz).toBe(fixed(2));
    expect(world.random.gameIndex).toBe(4);
  });
});

describe('missile spawn and explosion', () => {
  it('sets source, native angle, velocity and vertical time-of-flight, then advances half a tic', () => {
    const world = fixture(), shooter = source(world), callbacks = hooks();
    const target = spawnActor(world, ActorType.MT_POSSESSED, fixed(264), fixed(64), fixed(40));
    world.random.gameIndex = 0;
    const missile = spawnMissile(world, shooter, target, ActorType.MT_ROCKET, callbacks);
    expect(missile.target).toBe(shooter.id);
    expect(missile.angle).toBe(0);
    expect(missile.momx).toBe(1310700);
    expect(missile.momy).toBe(500);
    expect(missile.momz).toBe(fixed(4));
    expect(missile.x).toBe(fixed(64) + (1310700 >> 1));
    expect(missile.y).toBe(fixed(64) + 250);
    expect(missile.z).toBe(fixed(34));
    expect(missile.tics).toBe(1);
    expect(world.random.gameIndex).toBe(2);
    expect(world.events).toContainEqual({ type: 'sound', sound: SfxId.sfx_rlaunc, actor: missile.id });
  });

  it('adds fuzzy target angle error in source RNG order', () => {
    const world = fixture(), shooter = source(world);
    const target = spawnActor(world, ActorType.MT_POSSESSED, fixed(264), fixed(64));
    target.flags |= MobjFlag.MF_SHADOW;
    world.random.gameIndex = 0;
    const missile = spawnMissile(world, shooter, target, ActorType.MT_TROOPSHOT, hooks());
    expect(missile.angle).toBe(((109 - 220) << 20) >>> 0);
    expect(world.random.gameIndex).toBe(4);
  });

  it('spawns a horizontal player missile when none of the three auto-aim angles finds a target', () => {
    const world = fixture(), shooter = source(world);
    world.random.gameIndex = 0;
    const missile = spawnPlayerMissile(world, shooter, ActorType.MT_ROCKET, hooks());
    expect(missile.angle).toBe(shooter.angle);
    expect(missile.momz).toBe(0);
    expect(world.random.gameIndex).toBe(2);
  });

  it.each([[96, 1 << 26], [32, -(1 << 26)]])('auto-aims the player missile toward the target at Y=%i', (y, offset) => {
    const world = fixture(), shooter = source(world);
    const target = spawnActor(world, ActorType.MT_POSSESSED, fixed(400), fixed(y));
    expect(aimLineAttack(world, shooter, shooter.angle, fixed(1024)).target).toBe(null);
    const expected = aimLineAttack(world, shooter, (shooter.angle + offset) >>> 0, fixed(1024));
    expect(expected.target).toBe(target);
    const missile = spawnPlayerMissile(world, shooter, ActorType.MT_ROCKET, hooks());
    expect(missile.angle).toBe((shooter.angle + offset) >>> 0);
    expect(missile.momz).toBe(fixedMul(actors[ActorType.MT_ROCKET]?.speed ?? 0, expected.slope));
  });

  it('keeps a NOBLOCKMAP missile outside actor lists when its spawn advance crosses a cell boundary', () => {
    const world = fixture(), shooter = source(world);
    const other = spawnActor(world, ActorType.MT_POSSESSED, fixed(124), fixed(256));
    const target = spawnActor(world, ActorType.MT_POSSESSED, fixed(324), fixed(256));
    const missile = spawnMissile(world, other, target, ActorType.MT_ROCKET, hooks());
    expect(missile.x).toBeGreaterThan(fixed(128));
    expect(missile.flags & MobjFlag.MF_NOBLOCKMAP).not.toBe(0);
    expect(world.actorBlocks.flat()).not.toContain(missile.id);
    expect(world.actorBlocks[2 * 12]).toContain(other.id);
    expect(world.actorBlocks[2 * 12 + 2]).toContain(target.id);
    expect(shooter.removed).toBe(false);
  });

  it('explodes immediately into a wall without triggering crossed specials', () => {
    const world = fixture({ walls: [{ x: 72, oneSided: true, special: 2 }] }), shooter = source(world);
    const target = spawnActor(world, ActorType.MT_POSSESSED, fixed(264), fixed(64)), callbacks = hooks();
    world.random.gameIndex = 0;
    const missile = spawnMissile(world, shooter, target, ActorType.MT_ROCKET, callbacks);
    expect(missile.state).toBe(StateId.S_EXPLODE1);
    expect(missile.flags & MobjFlag.MF_MISSILE).toBe(0);
    expect(missile.momx).toBe(0);
    expect(callbacks.runActorAction).toHaveBeenCalledWith(ActionId.A_Explode, missile);
    expect(callbacks.shootSpecial).not.toHaveBeenCalled();
    expect(callbacks.useSpecial).not.toHaveBeenCalled();
    expect(world.random.gameIndex).toBe(3);
  });

  it('runs the explosion action before tic jitter, flag clearing and sound', () => {
    const world = fixture(), callbacks = hooks();
    const missile = spawnActor(world, ActorType.MT_ROCKET, fixed(256), fixed(64), fixed(32));
    missile.momx = fixed(20); missile.momz = fixed(2);
    world.random.gameIndex = 0;
    vi.mocked(callbacks.runActorAction).mockImplementation((action, actor) => {
      expect(action).toBe(ActionId.A_Explode);
      expect(actor.momx).toBe(0);
      expect(actor.momz).toBe(0);
      expect(actor.flags & MobjFlag.MF_MISSILE).not.toBe(0);
      expect(world.random.gameIndex).toBe(0);
      expect(gameRandom(world.random)).toBe(8);
    });
    explodeMissile(world, missile, callbacks);
    expect(missile.tics).toBe(7);
    expect(world.random.gameIndex).toBe(2);
    expect(missile.flags & MobjFlag.MF_MISSILE).toBe(0);
    expect(world.events.at(-1)).toEqual({ type: 'sound', sound: SfxId.sfx_barexp, actor: missile.id });
  });

  it('keeps explosion RNG consumption even when death state removes the actor', () => {
    const world = fixture(), puff = spawnActor(world, ActorType.MT_PUFF, fixed(128), fixed(64));
    puff.flags |= MobjFlag.MF_MISSILE;
    world.random.gameIndex = 1;
    explodeMissile(world, puff, hooks());
    expect(puff.removed).toBe(true);
    expect(puff.state).toBe(StateId.S_NULL);
    expect(world.activeActorIds.has(puff.id)).toBe(false);
    expect(world.random.gameIndex).toBe(2);
  });
});

describe('radius damage', () => {
  it('uses radius-adjusted Chebyshev distance and source attribution without vertical attenuation', () => {
    const world = fixture(), shooter = source(world), callbacks = hooks();
    const spot = spawnActor(world, ActorType.MT_ROCKET, fixed(512), fixed(512), fixed(32));
    const target = spawnActor(world, ActorType.MT_POSSESSED, fixed(576), fixed(552), fixed(300));
    radiusAttack(world, spot, shooter, 128, callbacks);
    expect(callbacks.damageActor).toHaveBeenCalledWith(target, spot, shooter, 84);
  });

  it('clamps nearby radius distance to zero and excludes the exact damage boundary', () => {
    const world = fixture(), callbacks = hooks();
    const spot = spawnActor(world, ActorType.MT_ROCKET, fixed(512), fixed(512));
    const near = spawnActor(world, ActorType.MT_POSSESSED, fixed(520), fixed(512));
    const far = spawnActor(world, ActorType.MT_POSSESSED, fixed(660), fixed(512));
    radiusAttack(world, spot, null, 128, callbacks);
    expect(callbacks.damageActor).toHaveBeenCalledWith(near, spot, null, 128);
    expect(vi.mocked(callbacks.damageActor).mock.calls.some(call => call[0] === far)).toBe(false);
  });

  it('exempts cyberdemons and spider bosses and requires BSP sight', () => {
    const world = fixture({ walls: [{ x: 576, oneSided: true }] }), callbacks = hooks();
    const spot = spawnActor(world, ActorType.MT_ROCKET, fixed(512), fixed(512));
    const cyber = spawnActor(world, ActorType.MT_CYBORG, fixed(544), fixed(512));
    const spider = spawnActor(world, ActorType.MT_SPIDER, fixed(544), fixed(544));
    const occluded = spawnActor(world, ActorType.MT_POSSESSED, fixed(608), fixed(512));
    radiusAttack(world, spot, source(world), 128, callbacks);
    const targets = vi.mocked(callbacks.damageActor).mock.calls.map(call => call[0]);
    expect(targets).not.toContain(cyber);
    expect(targets).not.toContain(spider);
    expect(targets).not.toContain(occluded);
  });

  it('preserves the wrapped MAXRADIUS scan extent from original p_map.c', () => {
    const world = fixture(), callbacks = hooks();
    const spot = spawnActor(world, ActorType.MT_ROCKET, fixed(63), fixed(512));
    const outsideCell = spawnActor(world, ActorType.MT_POSSESSED, fixed(128), fixed(512));
    radiusAttack(world, spot, null, 64, callbacks);
    expect(vi.mocked(callbacks.damageActor).mock.calls.some(call => call[0] === outsideCell)).toBe(false);
  });

  it('traverses row-major blocks and actor heads before later actors in a block', () => {
    const world = fixture(), callbacks = hooks();
    const spot = spawnActor(world, ActorType.MT_ROCKET, fixed(512), fixed(512));
    const first = spawnActor(world, ActorType.MT_POSSESSED, fixed(384), fixed(384));
    const head = spawnActor(world, ActorType.MT_POSSESSED, fixed(384), fixed(384));
    const north = spawnActor(world, ActorType.MT_POSSESSED, fixed(512), fixed(384));
    const west = spawnActor(world, ActorType.MT_POSSESSED, fixed(384), fixed(512));
    radiusAttack(world, spot, null, 200, callbacks);
    expect(vi.mocked(callbacks.damageActor).mock.calls.map(call => call[0])).toEqual([head, first, north, west]);
  });
});

describe('using nearby lines', () => {
  it('uses the first special within 64 units, including its back side', () => {
    const world = fixture({ walls: [{ x: 96, special: 1 }, { x: 112, special: 2 }] });
    const actor = source(world), callbacks = hooks();
    useLines(world, actor, callbacks);
    expect(callbacks.useSpecial).toHaveBeenCalledExactlyOnceWith(0, 1, actor);
  });

  it('stops at a non-special closed opening and emits the no-way sound', () => {
    const world = fixture({ walls: [{ x: 80, oneSided: true }, { x: 96, special: 1 }] });
    const actor = source(world), callbacks = hooks();
    useLines(world, actor, callbacks);
    expect(callbacks.useSpecial).not.toHaveBeenCalled();
    expect(world.events.at(-1)).toEqual({ type: 'sound', sound: SfxId.sfx_noway, actor: actor.id });
  });

  it('passes a one-unit non-special opening but does not use an out-of-range line', () => {
    const world = fixture({ walls: [{ x: 80 }, { x: 96, special: 1 }], rightCeiling: 1 });
    const callbacks = hooks();
    useLines(world, source(world), callbacks);
    expect(callbacks.useSpecial).toHaveBeenCalledTimes(1);
    const distant = fixture({ walls: [{ x: 129, special: 1 }] });
    const farCallbacks = hooks();
    useLines(distant, source(distant), farCallbacks);
    expect(farCallbacks.useSpecial).not.toHaveBeenCalled();
  });

  it('uses the actor angle for the line trace', () => {
    const world = fixture({ walls: [{ x: 96, special: 1 }] });
    const actor = source(world), callbacks = hooks();
    actor.angle = ANG180;
    useLines(world, actor, callbacks);
    expect(callbacks.useSpecial).not.toHaveBeenCalled();
  });
});

describe('original shareware shooting integration', () => {
  const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('aims, shoots and uses original E1M%i geometry', mapNumber => {
    const world = createWorld(decodeMap(wad, `E1M${mapNumber}`), { skill: 2 });
    const shooter = source(world), callbacks = hooks();
    const aim = aimLineAttack(world, shooter, shooter.angle, fixed(2048));
    lineAttack(world, shooter, shooter.angle, fixed(2048), aim.slope, 5, callbacks);
    useLines(world, shooter, callbacks);
    expect(aim.slope).toBeGreaterThanOrEqual(-fixed(0.625));
    expect(aim.slope).toBeLessThanOrEqual(fixed(0.625));
  });
});
