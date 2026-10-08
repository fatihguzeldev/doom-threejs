import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap, type DoomMap } from '../../src/wad/map';
import { createEnemies, Direction, type BossDeathEffect, type EnemyHooks, type EnemySystem } from '../../src/simulation/enemy';
import { createWorld, removeActor, spawnActor, type Skill, type World } from '../../src/simulation/world';
import { ActorType, MobjFlag, SfxId } from '../../src/simulation/data/actors';
import { ActionId, StateId } from '../../src/simulation/data/states';
import { ANG45, ANG90, ANG180 } from '../../src/simulation/angle';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { tickActorState, type Actor } from '../../src/simulation/actors';
import type { MovementResult } from '../../src/simulation/movement';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');
const fits: MovementResult = { fits: true, floatOk: false, floorZ: 0, ceilingZ: 128 * FRAC_UNIT,
  dropoffZ: 0, blockingLine: null, ceilingLine: null, specialLines: [] };

function fixture(skill: Skill = 2): World { return createWorld(map, { skill, noMonsters: true }); }
function avatar(world: World): Actor {
  const actor = world.actorsById.get(world.player.actorId);
  if (!actor) throw new Error('Player missing');
  return actor;
}
function enemy(world: World, type: ActorType = ActorType.MT_POSSESSED): Actor {
  const player = avatar(world);
  const actor = spawnActor(world, type, player.x - 128 * FRAC_UNIT, player.y, player.z);
  actor.lastLook = 0;
  actor.angle = 0;
  return actor;
}
function hooks(world: World, overrides: Partial<EnemyHooks> = {}): EnemyHooks {
  return {
    tryMove: (actor, x, y) => { actor.x = x; actor.y = y; return fits; },
    checkSight: () => true,
    aimLineAttack: () => ({ slope: 0, target: null }),
    lineAttack: () => null,
    spawnMissile: (source, _target, type) => spawnActor(world, type, source.x, source.y, source.z),
    damageActor: () => {}, radiusAttack: () => {}, runActorAction: () => {},
    useSpecial: () => false, bossDeath: () => {},
    ...overrides,
  };
}

function soundMap(): DoomMap {
  const sector = { floorHeight: 0, ceilingHeight: 128, floorTexture: 'FLOOR0_1',
    ceilingTexture: 'CEIL1_1', lightLevel: 160, special: 0, tag: 0 };
  const connections = [[0, 1, 68], [1, 2, 68], [0, 3, 4], [3, 1, 4], [3, 4, 4]] as const;
  return {
    name: 'E1M1', vertices: [{ x: 0, y: 0 }, { x: 128, y: 0 }],
    sectors: Array.from({ length: 5 }, (_, index) => ({ ...sector, floorHeight: index === 4 ? 128 : 0 })),
    sides: connections.flatMap(([front, back]) => [front, back].map(sectorIndex => ({
      sector: sectorIndex, textureOffset: 0, rowOffset: 0,
      upperTexture: '-', lowerTexture: '-', middleTexture: '-',
    }))),
    lines: connections.map(([, , flags], index) => ({ v1: 0, v2: 1, flags, special: 0,
      tag: 0, frontSide: index * 2, backSide: index * 2 + 1 })),
    segs: [{ v1: 0, v2: 1, angle: 0, line: 0, side: 0, offset: 0 }],
    subsectors: [{ firstSeg: 0, segCount: 1, sector: 0 }], nodes: [],
    things: [{ x: 0, y: 0, angle: 0, type: 1, flags: 7 }],
    blockmap: { originX: -64, originY: -64, width: 1, height: 1, cells: [[0, 1, 2, 3, 4]] },
    reject: new Uint8Array(4),
  };
}

describe('noise flood', () => {
  it('refloods a sector through a less-blocked path and stops at closed openings', () => {
    const world = createWorld(soundMap(), { skill: 2 }), actor = avatar(world);
    const system = createEnemies(world, hooks(world));
    world.random.gameIndex = 0;
    system.noiseAlert(actor, actor);
    expect(world.sectors.map(sector => sector.soundTarget)).toEqual([actor.id, actor.id, actor.id, actor.id, null]);
    expect(world.sectors.map(sector => sector.soundTraversed)).toEqual([1, 1, 2, 1, 0]);
    expect(world.random.gameIndex).toBe(0);
    const other = enemy(world);
    system.noiseAlert(other, actor);
    expect(world.sectors[0]?.soundTarget).toBe(other.id);
    expect(world.sectors[0]?.soundValidCount).toBe(2);
  });

  it('does not cross two sound-blocking lines when no alternative opening remains', () => {
    const world = createWorld(soundMap(), { skill: 2 }), actor = avatar(world);
    world.lineFlags[2] = 68;
    world.lineFlags[3] = 68;
    createEnemies(world, hooks(world)).noiseAlert(actor, actor);
    expect(world.sectors[1]?.soundTarget).toBe(actor.id);
    expect(world.sectors[2]?.soundTarget).toBeNull();
    expect(world.sectors[3]?.soundTarget).toBe(actor.id);
  });
});

describe('Doom I attack actions', () => {
  it('dispatches the nested nightmare wake/chase/attack states with their original immediate actions', () => {
    const world = fixture(4), actor = enemy(world), target = avatar(world);
    world.random.gameIndex = 0;
    const shots: number[] = [];
    const system: EnemySystem = createEnemies(world, hooks(world, {
      runActorAction: (action, current) => system.runAction(action, current),
      lineAttack: (_source, _angle, _range, _slope, damage) => { shots.push(damage); return target; },
    }));
    system.runAction(ActionId.A_Look, actor);
    expect(actor).toMatchObject({ state: StateId.S_POSS_ATK1, tics: 10, target: target.id });
    expect(actor.flags & MobjFlag.MF_JUSTATTACKED).toBe(MobjFlag.MF_JUSTATTACKED);
    expect(world.random.gameIndex).toBe(2); // Alert, then missile range decision.
    for (let tic = 0; tic < 10; tic++) tickActorState(actor, system.runAction);
    expect(actor).toMatchObject({ state: StateId.S_POSS_ATK2, tics: 8 });
    expect(shots).toEqual([6]); // P_Random's 220, 222 spread and 241 damage.
    expect(world.random.gameIndex).toBe(5);
  });

  it('aims before pistol sound, then consumes spread draws before damage', () => {
    const world = fixture(), actor = enemy(world), target = avatar(world);
    actor.target = target.id;
    world.random.gameIndex = 0;
    const shots: number[][] = [];
    const system = createEnemies(world, hooks(world, {
      aimLineAttack: (source, angle, range) => {
        expect(source).toBe(actor); expect(angle).toBe(0); expect(range).toBe(2048 * FRAC_UNIT);
        expect(world.events).toEqual([]); return { slope: 1234, target };
      },
      lineAttack: (source, angle, range, slope, damage) => {
        expect(source).toBe(actor); shots.push([angle, range, slope, damage]); return target;
      },
    }));
    system.runAction(ActionId.A_PosAttack, actor);
    expect(shots).toEqual([[((8 - 109) << 20) >>> 0, 2048 * FRAC_UNIT, 1234, 3]]);
    expect(world.events).toEqual([{ type: 'sound', sound: SfxId.sfx_pistol, actor: actor.id }]);
    expect(world.random.gameIndex).toBe(3);
  });

  it('uses one shared shotgun aim and three separately randomized pellets', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_SHOTGUY), target = avatar(world);
    actor.target = target.id;
    world.random.gameIndex = 0;
    const shots: number[][] = [];
    let aimCount = 0;
    createEnemies(world, hooks(world, {
      aimLineAttack: () => {
        aimCount++; expect(world.events).toEqual([{ type: 'sound', sound: SfxId.sfx_shotgn, actor: actor.id }]);
        return { slope: -567, target };
      },
      lineAttack: (_source, angle, _range, slope, damage) => { shots.push([angle, slope, damage]); return target; },
    })).runAction(ActionId.A_SPosAttack, actor);
    expect(aimCount).toBe(1);
    expect(shots).toEqual([
      [((8 - 109) << 20) >>> 0, -567, 3],
      [((222 - 241) << 20) >>> 0, -567, 15],
      [((107 - 75) << 20) >>> 0, -567, 12],
    ]);
    expect(world.random.gameIndex).toBe(9);
  });

  it('consumes target invisibility draws before pistol spread and damage', () => {
    const world = fixture(), actor = enemy(world), target = avatar(world);
    actor.target = target.id; target.flags |= MobjFlag.MF_SHADOW;
    world.random.gameIndex = 0;
    let shot: number[] = [];
    createEnemies(world, hooks(world, {
      lineAttack: (_source, angle, _range, _slope, damage) => { shot = [angle, damage]; return target; },
    })).runAction(ActionId.A_PosAttack, actor);
    expect(shot).toEqual([(((8 - 109) << 21) + ((220 - 222) << 20)) >>> 0, 6]);
    expect(world.random.gameIndex).toBe(5);
  });

  it.each([
    [ActionId.A_TroopAttack, ActorType.MT_TROOP, 3, SfxId.sfx_claw],
    [ActionId.A_SargAttack, ActorType.MT_SERGEANT, 36, SfxId.sfx_None],
    [ActionId.A_HeadAttack, ActorType.MT_HEAD, 30, SfxId.sfx_None],
    [ActionId.A_BruisAttack, ActorType.MT_BRUISER, 10, SfxId.sfx_claw],
  ] as const)('preserves melee damage and sound for %s', (action, type, damage, attackSound) => {
    const world = fixture(), actor = enemy(world, type), target = avatar(world);
    actor.target = target.id; actor.x = target.x - 40 * FRAC_UNIT;
    world.random.gameIndex = 0;
    const hits: number[] = [];
    createEnemies(world, hooks(world, {
      damageActor: (victim, inflictor, source, amount) => {
        expect(victim).toBe(target); expect(inflictor).toBe(actor); expect(source).toBe(actor); hits.push(amount);
      },
      spawnMissile: () => { throw new Error('Melee must not launch a missile'); },
    })).runAction(action, actor);
    expect(hits).toEqual([damage]);
    expect(world.events).toEqual(attackSound === SfxId.sfx_None ? [] : [{ type: 'sound', sound: attackSound, actor: actor.id }]);
    expect(world.random.gameIndex).toBe(1);
  });

  it.each([
    [ActionId.A_TroopAttack, ActorType.MT_TROOP, ActorType.MT_TROOPSHOT],
    [ActionId.A_HeadAttack, ActorType.MT_HEAD, ActorType.MT_HEADSHOT],
    [ActionId.A_BruisAttack, ActorType.MT_BRUISER, ActorType.MT_BRUISERSHOT],
    [ActionId.A_CyberAttack, ActorType.MT_CYBORG, ActorType.MT_ROCKET],
  ] as const)('launches the original projectile for %s', (action, type, projectile) => {
    const world = fixture(), actor = enemy(world, type), target = avatar(world);
    actor.target = target.id;
    const spawned: ActorType[] = [];
    world.random.gameIndex = 0;
    createEnemies(world, hooks(world, {
      spawnMissile: (source, victim, missile) => {
        expect(source).toBe(actor); expect(victim).toBe(target); spawned.push(missile); return actor;
      },
      damageActor: () => { throw new Error('Distant attack must not damage directly'); },
    })).runAction(action, actor);
    expect(spawned).toEqual([projectile]);
    expect(world.random.gameIndex).toBe(0);
  });

  it('keeps the baron action angle and skips an out-of-range demon attack', () => {
    const world = fixture(), baron = enemy(world, ActorType.MT_BRUISER), target = avatar(world);
    baron.target = target.id; baron.angle = ANG180;
    target.flags |= MobjFlag.MF_SHADOW;
    world.random.gameIndex = 0;
    createEnemies(world, hooks(world, { spawnMissile: () => baron })).runAction(ActionId.A_BruisAttack, baron);
    expect(baron.angle).toBe(ANG180); expect(world.random.gameIndex).toBe(0);
    const demon = enemy(world, ActorType.MT_SERGEANT);
    demon.target = target.id; target.flags &= ~MobjFlag.MF_SHADOW;
    createEnemies(world, hooks(world, {
      damageActor: () => { throw new Error('Demon is out of range'); },
    })).runAction(ActionId.A_SargAttack, demon);
    expect(world.random.gameIndex).toBe(1); // The demon spawn's last-look draw only.
  });

  it('launches a lost soul at fixed speed and aims vertical momentum over integer travel ticks', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_SKULL), target = avatar(world);
    actor.target = target.id; actor.x = target.x - 100 * FRAC_UNIT; actor.z = target.z + 3 * FRAC_UNIT;
    world.random.gameIndex = 0;
    createEnemies(world, hooks(world)).runAction(ActionId.A_SkullAttack, actor);
    expect(actor.flags & MobjFlag.MF_SKULLFLY).toBe(MobjFlag.MF_SKULLFLY);
    expect(actor.momx).toBe(20 * 65535); expect(actor.momy).toBe(20 * 25);
    expect(actor.momz).toBe(5 * FRAC_UNIT); // (Player center 28 - soul 3) / five tics.
    expect(world.events).toEqual([{ type: 'sound', sound: SfxId.sfx_sklatk, actor: actor.id }]);
    expect(world.random.gameIndex).toBe(0);
  });

  it('clamps lost-soul travel time to one for a close target', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_SKULL), target = avatar(world);
    actor.target = target.id; actor.x = target.x - 1;
    createEnemies(world, hooks(world)).runAction(ActionId.A_SkullAttack, actor);
    expect(actor.momz).toBe(28 * FRAC_UNIT);
  });

  it('gives spider refire its early random continuation before testing a dead target', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_SPIDER), target = avatar(world);
    actor.target = target.id; target.health = 0; actor.state = StateId.S_SPID_ATK4;
    world.random.gameIndex = 0;
    const system = createEnemies(world, hooks(world, { checkSight: () => { throw new Error('Dead target has no sight test'); } }));
    system.runAction(ActionId.A_SpidRefire, actor);
    expect(actor.state).toBe(StateId.S_SPID_ATK4); expect(world.random.gameIndex).toBe(1);
    system.runAction(ActionId.A_SpidRefire, actor);
    expect(actor.state).toBe(StateId.S_SPID_RUN1); expect(world.random.gameIndex).toBe(2);
  });

  it('returns spider refire to chase when sight is lost and permits a visible living target', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_SPIDER);
    actor.target = world.player.actorId; actor.state = StateId.S_SPID_ATK4;
    world.random.gameIndex = 1;
    createEnemies(world, hooks(world)).runAction(ActionId.A_SpidRefire, actor);
    expect(actor.state).toBe(StateId.S_SPID_ATK4);
    createEnemies(world, hooks(world, { checkSight: () => false })).runAction(ActionId.A_SpidRefire, actor);
    expect(actor.state).toBe(StateId.S_SPID_RUN1);
  });

  it.each([ActionId.A_PosAttack, ActionId.A_SPosAttack, ActionId.A_TroopAttack, ActionId.A_SargAttack,
    ActionId.A_HeadAttack, ActionId.A_BruisAttack, ActionId.A_CyberAttack, ActionId.A_SkullAttack])
  ('does not consume RNG or create effects without a target for %s', action => {
    const world = fixture(), actor = enemy(world);
    world.random.gameIndex = 0;
    createEnemies(world, hooks(world)).runAction(action, actor);
    expect(world.events).toEqual([]); expect(world.random.gameIndex).toBe(0);
  });

  it('rejects a Doom II action explicitly', () => {
    const world = fixture(), actor = enemy(world);
    expect(() => createEnemies(world, hooks(world)).runAction(ActionId.A_VileAttack, actor)).toThrow(/Unsupported.*A_VileAttack.*Doom I/);
  });
});

describe('actor death and effects', () => {
  it.each([
    [ActorType.MT_POSSESSED, SfxId.sfx_podth3, 1, false],
    [ActorType.MT_TROOP, SfxId.sfx_bgdth1, 1, false],
    [ActorType.MT_CYBORG, SfxId.sfx_cybdth, 0, true],
    [ActorType.MT_SPIDER, SfxId.sfx_spidth, 0, true],
  ] as const)('uses the original death sound origin and random selection for type %i', (type, deathSound, draws, global) => {
    const world = fixture(), actor = enemy(world, type);
    world.random.gameIndex = 0;
    createEnemies(world, hooks(world)).runAction(ActionId.A_Scream, actor);
    expect(world.events).toEqual([{ type: 'sound', sound: deathSound, actor: global ? null : actor.id }]);
    expect(world.random.gameIndex).toBe(draws);
  });

  it('does not play an absent pain/death sound or consume random values', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_EXTRABFG);
    world.random.gameIndex = 0;
    const system = createEnemies(world, hooks(world));
    system.runAction(ActionId.A_Pain, actor); system.runAction(ActionId.A_Scream, actor);
    expect(world.events).toEqual([]); expect(world.random.gameIndex).toBe(0);
  });

  it('plays pain, gib and Doom I player death sounds and clears only solidity on fall', () => {
    const world = fixture(), actor = avatar(world);
    actor.health = -100; actor.flags |= MobjFlag.MF_CORPSE;
    const beforeFlags = actor.flags, system = createEnemies(world, hooks(world));
    system.runAction(ActionId.A_Pain, actor); system.runAction(ActionId.A_XScream, actor);
    system.runAction(ActionId.A_PlayerScream, actor); system.runAction(ActionId.A_Fall, actor);
    expect(world.events).toEqual([SfxId.sfx_plpain, SfxId.sfx_slop, SfxId.sfx_pldeth]
      .map(sound => ({ type: 'sound', sound, actor: actor.id })));
    expect(actor.flags).toBe(beforeFlags & ~MobjFlag.MF_SOLID);
  });

  it.each([[ActionId.A_Hoof, SfxId.sfx_hoof], [ActionId.A_Metal, SfxId.sfx_metal]] as const)
  ('plays step sound before calling chase for %s', (action, footstep) => {
    const world = fixture(), actor = enemy(world, ActorType.MT_CYBORG);
    actor.reactionTime = 2; world.player.health = 0;
    createEnemies(world, hooks(world)).runAction(action, actor);
    expect(actor.reactionTime).toBe(1);
    expect(world.events).toEqual([{ type: 'sound', sound: footstep, actor: actor.id }]);
    expect(actor.state).toBe(StateId.S_CYBER_STND);
  });

  it('attributes explosion radius damage to the retained originator even after unlinking', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_ROCKET), owner = avatar(world);
    actor.target = owner.id; removeActor(world, owner);
    let called = false;
    createEnemies(world, hooks(world, { radiusAttack: (spot, source, damage) => {
      called = true; expect(spot).toBe(actor); expect(source).toBe(owner); expect(damage).toBe(128);
    } })).runAction(ActionId.A_Explode, actor);
    expect(called).toBe(true);
  });

  it('scans forty BFG angles from the retained shooter without random draws for empty rays', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_BFG), owner = avatar(world);
    actor.target = owner.id; actor.angle = ANG90; removeActor(world, owner);
    const aimed: number[] = [];
    world.random.gameIndex = 0;
    createEnemies(world, hooks(world, { aimLineAttack: (source, angle, range) => {
      expect(source).toBe(owner); expect(range).toBe(1024 * FRAC_UNIT); aimed.push(angle);
      return { slope: 0, target: null };
    } })).runAction(ActionId.A_BFGSpray, actor);
    expect(aimed).toHaveLength(40);
    expect(aimed[0]).toBe(ANG45); expect(aimed[39]).toBe(ANG45 + Math.trunc(ANG90 / 40) * 39);
    expect(world.random.gameIndex).toBe(0);
  });

  it('spawns the BFG effect before fifteen damage draws and uses the shooter for both damage identities', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_BFG), owner = avatar(world), target = enemy(world, ActorType.MT_TROOP);
    actor.target = owner.id; target.z = 11 * FRAC_UNIT;
    let rays = 0, hitCount = 0;
    world.random.gameIndex = 0;
    createEnemies(world, hooks(world, {
      aimLineAttack: () => ({ slope: 0, target: rays++ === 0 ? target : null }),
      damageActor: (victim, inflictor, source, damage) => {
        hitCount++; expect(victim).toBe(target); expect(inflictor).toBe(owner); expect(source).toBe(owner);
        expect(damage).toBe(64); expect(world.random.gameIndex).toBe(16);
        const effects = world.actors.filter(effect => effect.type === ActorType.MT_EXTRABFG);
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({ x: target.x, y: target.y, z: target.z + (target.height >> 2), lastLook: 0 });
      },
    })).runAction(ActionId.A_BFGSpray, actor);
    expect(hitCount).toBe(1); expect(rays).toBe(40); expect(world.random.gameIndex).toBe(16);
  });

  it('rejects a malformed BFG effect without an originator', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_BFG);
    expect(() => createEnemies(world, hooks(world)).runAction(ActionId.A_BFGSpray, actor)).toThrow(/originator/);
  });
});

describe('Doom I boss death policy', () => {
  it.each([
    ['E1M8', ActorType.MT_BRUISER, { kind: 'lowerFloorToLowest', tag: 666 }],
    ['E2M8', ActorType.MT_CYBORG, { kind: 'exit' }],
    ['E3M8', ActorType.MT_SPIDER, { kind: 'exit' }],
    ['E4M6', ActorType.MT_CYBORG, { kind: 'blazeOpen', tag: 666 }],
    ['E4M8', ActorType.MT_SPIDER, { kind: 'lowerFloorToLowest', tag: 666 }],
  ] as const)('triggers the native effect for the final boss in %s', (name, type, effect) => {
    const world = createWorld({ ...map, name }, { skill: 2, mode: 'retail', noMonsters: true }), actor = enemy(world, type);
    actor.health = 0;
    const effects: BossDeathEffect[] = [];
    createEnemies(world, hooks(world, { bossDeath: effect => effects.push(effect) })).runAction(ActionId.A_BossDeath, actor);
    expect(effects).toEqual([effect]);
  });

  it.each([
    ['E1M7', ActorType.MT_BRUISER], ['E1M8', ActorType.MT_CYBORG], ['E2M8', ActorType.MT_BRUISER],
    ['E3M8', ActorType.MT_CYBORG], ['E4M7', ActorType.MT_SPIDER], ['E4M6', ActorType.MT_SPIDER],
  ] as const)('rejects a boss outside its source level/type rule in %s', (name, type) => {
    const world = createWorld({ ...map, name }, { skill: 2, mode: 'retail', noMonsters: true }), actor = enemy(world, type);
    actor.health = 0;
    createEnemies(world, hooks(world, { bossDeath: () => { throw new Error('Must not trigger'); } })).runAction(ActionId.A_BossDeath, actor);
  });

  it('waits for every boss, ignores unlinked living records, and requires a surviving player', () => {
    const world = createWorld({ ...map, name: 'E1M8' }, { skill: 2, noMonsters: true }), actor = enemy(world, ActorType.MT_BRUISER);
    actor.health = 0;
    const other = enemy(world, ActorType.MT_BRUISER), effects: BossDeathEffect[] = [];
    const system = createEnemies(world, hooks(world, { bossDeath: effect => effects.push(effect) }));
    system.runAction(ActionId.A_BossDeath, actor); expect(effects).toEqual([]);
    removeActor(world, other); world.player.health = 0;
    system.runAction(ActionId.A_BossDeath, actor); expect(effects).toEqual([]);
    world.player.health = 1;
    system.runAction(ActionId.A_BossDeath, actor);
    expect(effects).toEqual([{ kind: 'lowerFloorToLowest', tag: 666 }]);
  });
});

describe('player search and wakeup', () => {
  it('retains the original four-slot last-look stop condition even in single-player', () => {
    const world = fixture(), actor = enemy(world), system = createEnemies(world, hooks(world));
    actor.lastLook = 1;
    world.random.gameIndex = 0;
    expect(system.lookForPlayers(actor, false)).toBe(false);
    expect(actor.lastLook).toBe(0);
    expect(actor.target).toBeNull();
    expect(system.lookForPlayers(actor, false)).toBe(true);
    expect(actor.target).toBe(world.player.actorId);
    expect(world.random.gameIndex).toBe(0);
  });

  it('checks an unseen active player only twice before completing the original search', () => {
    const world = fixture(), actor = enemy(world);
    let checks = 0;
    const system = createEnemies(world, hooks(world, { checkSight: () => { checks++; return false; } }));
    expect(system.lookForPlayers(actor, true)).toBe(false);
    expect(checks).toBe(2);
    expect(actor.lastLook).toBe(0);
  });

  it('ignores dead players and excludes removed player records from active targeting', () => {
    const world = fixture(), actor = enemy(world), system = createEnemies(world, hooks(world));
    world.player.health = 0;
    expect(system.lookForPlayers(actor, true)).toBe(false);
    world.player.health = 100;
    const player = avatar(world);
    removeActor(world, player);
    expect(world.actorsById.get(player.id)).toBe(player);
    expect(system.lookForPlayers(actor, true)).toBe(false);
  });

  it('requires a forward view unless the player is within the inclusive melee distance', () => {
    const world = fixture(), actor = enemy(world), player = avatar(world);
    const system = createEnemies(world, hooks(world));
    actor.angle = ANG180;
    expect(system.lookForPlayers(actor, false)).toBe(false);
    actor.x = player.x - 64 * FRAC_UNIT;
    expect(system.lookForPlayers(actor, false)).toBe(true);
    actor.x = player.x - 128 * FRAC_UNIT;
    actor.target = null;
    expect(system.lookForPlayers(actor, true)).toBe(true);
  });

  it('wakes a hearing monster without sight and randomizes its original alert sound', () => {
    const world = fixture(), actor = enemy(world), player = avatar(world);
    const sector = world.sectors[actor.sector];
    if (!sector) throw new Error('Sector missing');
    sector.soundTarget = player.id;
    actor.threshold = 100;
    world.random.gameIndex = 0;
    createEnemies(world, hooks(world, { checkSight: () => false })).runAction(ActionId.A_Look, actor);
    expect(actor.target).toBe(player.id);
    expect(actor.threshold).toBe(0);
    expect(actor.state).toBe(StateId.S_POSS_RUN1);
    expect(world.events).toContainEqual({ type: 'sound', sound: SfxId.sfx_posit3, actor: actor.id });
    expect(world.random.gameIndex).toBe(1);
  });

  it('requires sight for an ambush monster hearing the same alert', () => {
    const world = fixture(), actor = enemy(world), player = avatar(world);
    const sector = world.sectors[actor.sector];
    if (!sector) throw new Error('Sector missing');
    sector.soundTarget = player.id;
    actor.flags |= MobjFlag.MF_AMBUSH;
    createEnemies(world, hooks(world, { checkSight: () => false })).runAction(ActionId.A_Look, actor);
    expect(actor.state).toBe(StateId.S_POSS_STND);
    expect(world.events).toEqual([]);
  });

  it('uses a global full-volume sound when a boss wakes', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_CYBORG);
    createEnemies(world, hooks(world)).runAction(ActionId.A_Look, actor);
    expect(world.events).toContainEqual({ type: 'sound', sound: SfxId.sfx_cybsit, actor: null });
  });
});

describe('range checks, movement and chase', () => {
  it('uses target definition radius and strict melee cutoff, with sight required', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_TROOP), target = avatar(world);
    actor.target = target.id;
    const system = createEnemies(world, hooks(world));
    actor.x = target.x - 59 * FRAC_UNIT;
    expect(system.checkMeleeRange(actor)).toBe(true);
    actor.x = target.x - 60 * FRAC_UNIT;
    expect(system.checkMeleeRange(actor)).toBe(false);
    actor.x = target.x - 1;
    expect(createEnemies(world, hooks(world, { checkSight: () => false })).checkMeleeRange(actor)).toBe(false);
  });

  it('lets just-hit bypass reaction and probability only after passing sight', () => {
    const world = fixture(), actor = enemy(world);
    actor.target = world.player.actorId;
    actor.flags |= MobjFlag.MF_JUSTHIT;
    actor.reactionTime = 100;
    world.random.gameIndex = 0;
    expect(createEnemies(world, hooks(world, { checkSight: () => false })).checkMissileRange(actor)).toBe(false);
    expect(actor.flags & MobjFlag.MF_JUSTHIT).toBe(MobjFlag.MF_JUSTHIT);
    expect(createEnemies(world, hooks(world)).checkMissileRange(actor)).toBe(true);
    expect(actor.flags & MobjFlag.MF_JUSTHIT).toBe(0);
    expect(world.random.gameIndex).toBe(0);
  });

  it('waits for reaction time and applies the original missile distance probability', () => {
    const world = fixture(), actor = enemy(world), player = avatar(world);
    actor.target = player.id;
    const system = createEnemies(world, hooks(world));
    world.random.gameIndex = 0;
    expect(system.checkMissileRange(actor)).toBe(false);
    actor.reactionTime = 0;
    actor.x = player.x - 1000 * FRAC_UNIT;
    expect(system.checkMissileRange(actor)).toBe(false); // 8 < capped distance 200.
    world.random.gameIndex = 2;
    expect(system.checkMissileRange(actor)).toBe(true); // 220 >= 200.
  });

  it('uses the cyberdemon probability cap while preserving its one random decision', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_CYBORG), player = avatar(world);
    actor.target = player.id; actor.reactionTime = 0; actor.x = player.x - 1000 * FRAC_UNIT;
    const system = createEnemies(world, hooks(world));
    world.random.gameIndex = 5; // Next original random byte is 149, below cyber cap 160.
    expect(system.checkMissileRange(actor)).toBe(false);
    world.random.gameIndex = 4; // 241 exceeds the cyber cap.
    expect(system.checkMissileRange(actor)).toBe(true);
    expect(world.random.gameIndex).toBe(5);
  });

  it('uses exact diagonal movement constants and assigns walk count after a successful walk', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_TROOP);
    actor.moveDir = Direction.DI_NORTHEAST;
    const before = { x: actor.x, y: actor.y };
    world.random.gameIndex = 1;
    expect(createEnemies(world, hooks(world)).tryWalk(actor)).toBe(true);
    expect(actor.x - before.x).toBe(8 * 47000);
    expect(actor.y - before.y).toBe(8 * 47000);
    expect(actor.moveCount).toBe(13); // 109 & 15.
    expect(world.random.gameIndex).toBe(2);
  });

  it('floats toward a blocked opening or uses encountered specials in reverse order', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_HEAD);
    actor.moveDir = Direction.DI_EAST;
    const floated = createEnemies(world, hooks(world, {
      tryMove: () => ({ ...fits, fits: false, floatOk: true, floorZ: actor.z + 20 * FRAC_UNIT }),
    }));
    const oldZ = actor.z;
    expect(floated.move(actor)).toBe(true);
    expect(actor.z).toBe(oldZ + 4 * FRAC_UNIT);
    expect(actor.flags & MobjFlag.MF_INFLOAT).toBe(MobjFlag.MF_INFLOAT);
    actor.flags &= ~MobjFlag.MF_FLOAT;
    const used: number[] = [];
    const doors = createEnemies(world, hooks(world, {
      tryMove: () => ({ ...fits, fits: false, specialLines: [2, 3] }),
      useSpecial: (line, side, user) => { expect(side).toBe(0); expect(user).toBe(actor); used.push(line); return line === 2; },
    }));
    expect(doors.move(actor)).toBe(true);
    expect(used).toEqual([3, 2]);
    expect(actor.moveDir).toBe(Direction.DI_NODIR);
  });

  it('floats down when above an opening and clears in-float on success without snapping a floater', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_HEAD);
    actor.moveDir = Direction.DI_EAST; actor.z = 20 * FRAC_UNIT;
    createEnemies(world, hooks(world, { tryMove: () => ({ ...fits, fits: false, floatOk: true }) })).move(actor);
    expect(actor.z).toBe(16 * FRAC_UNIT);
    createEnemies(world, hooks(world)).move(actor);
    expect(actor.flags & MobjFlag.MF_INFLOAT).toBe(0); expect(actor.z).toBe(16 * FRAC_UNIT);
    actor.flags &= ~MobjFlag.MF_FLOAT; actor.floorZ = 12 * FRAC_UNIT;
    createEnemies(world, hooks(world)).move(actor);
    expect(actor.z).toBe(actor.floorZ);
  });

  it('rejects no direction without a movement call and invalid directions as the source error', () => {
    const world = fixture(), actor = enemy(world), system = createEnemies(world, hooks(world, {
      tryMove: () => { throw new Error('must not move'); },
    }));
    actor.moveDir = Direction.DI_NODIR;
    expect(system.move(actor)).toBe(false);
    actor.moveDir = -1;
    expect(() => system.move(actor)).toThrow(/movedir/i);
  });

  it('takes an available direct diagonal before drawing axis-search random values', () => {
    const world = fixture(), actor = enemy(world), player = avatar(world);
    actor.target = player.id;
    actor.y = player.y - 100 * FRAC_UNIT;
    actor.moveDir = Direction.DI_NODIR;
    world.random.gameIndex = 0;
    createEnemies(world, hooks(world)).newChaseDir(actor);
    expect(actor.moveDir).toBe(Direction.DI_NORTHEAST);
    expect(actor.moveCount).toBe(8);
    expect(world.random.gameIndex).toBe(1);
  });

  it('searches fallback directions and tries turnaround last when every path is blocked', () => {
    const world = fixture(), actor = enemy(world), player = avatar(world);
    actor.target = player.id;
    actor.moveDir = Direction.DI_WEST;
    const attempts: number[] = [];
    world.random.gameIndex = 0;
    createEnemies(world, hooks(world, {
      tryMove: () => { attempts.push(actor.moveDir); return { ...fits, fits: false }; },
    })).newChaseDir(actor);
    expect(actor.moveDir).toBe(Direction.DI_NODIR);
    expect(attempts).toEqual([4, 1, 2, 3, 4, 5, 6, 7, 0]);
    expect(world.random.gameIndex).toBe(2);
  });

  it('turns by 45 degrees using signed wraparound, clears dead-target threshold, and reacquires before attacking', () => {
    const world = fixture(), actor = enemy(world);
    actor.moveDir = Direction.DI_WEST;
    actor.threshold = 10;
    actor.reactionTime = 2;
    createEnemies(world, hooks(world)).runAction(ActionId.A_Chase, actor);
    expect(actor.angle).toBe(ANG45);
    expect(actor.threshold).toBe(0);
    expect(actor.reactionTime).toBe(1);
    expect(actor.target).toBe(world.player.actorId);
    expect(actor.state).toBe(StateId.S_POSS_STND);
  });

  it('takes an in-range melee attack before considering missile fire or movement', () => {
    const world = fixture(), actor = enemy(world, ActorType.MT_TROOP), player = avatar(world);
    actor.target = player.id;
    actor.x = player.x - 40 * FRAC_UNIT;
    createEnemies(world, hooks(world, { tryMove: () => { throw new Error('must attack before walking'); } }))
      .runAction(ActionId.A_Chase, actor);
    expect(actor.state).toBe(StateId.S_TROO_ATK1);
  });

  it.each([2, 4] as const)('applies the original missile movement-count gate on skill %i', skill => {
    const world = fixture(skill), actor = enemy(world);
    actor.target = world.player.actorId;
    actor.reactionTime = 0;
    actor.moveCount = 2;
    world.random.gameIndex = 0;
    createEnemies(world, hooks(world)).runAction(ActionId.A_Chase, actor);
    expect(actor.state).toBe(skill === 4 ? StateId.S_POSS_ATK1 : StateId.S_POSS_STND);
    expect(actor.flags & MobjFlag.MF_JUSTATTACKED).toBe(skill === 4 ? MobjFlag.MF_JUSTATTACKED : 0);
  });

  it('does not attack twice in succession and permits fast-monster missile decisions', () => {
    const world = fixture(), actor = enemy(world);
    actor.target = world.player.actorId;
    actor.flags |= MobjFlag.MF_JUSTATTACKED;
    world.random.gameIndex = 0;
    const system = createEnemies(world, hooks(world), true);
    system.runAction(ActionId.A_Chase, actor);
    expect(actor.flags & MobjFlag.MF_JUSTATTACKED).toBe(0);
    expect(world.random.gameIndex).toBe(0);
    actor.reactionTime = 0;
    actor.moveCount = 10;
    system.runAction(ActionId.A_Chase, actor);
    expect(actor.state).toBe(StateId.S_POSS_ATK1);
  });

  it('faces a target, clears ambush and draws twice for its shadow angle perturbation', () => {
    const world = fixture(), actor = enemy(world), player = avatar(world);
    actor.target = player.id;
    actor.flags |= MobjFlag.MF_AMBUSH;
    player.flags |= MobjFlag.MF_SHADOW;
    world.random.gameIndex = 0;
    createEnemies(world, hooks(world)).faceTarget(actor);
    expect(actor.angle).toBe(((8 - 109) << 21) >>> 0);
    expect(actor.flags & MobjFlag.MF_AMBUSH).toBe(0);
    expect(world.random.gameIndex).toBe(2);
  });
});
