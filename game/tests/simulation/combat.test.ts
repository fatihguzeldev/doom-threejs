import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { damageActor, killActor, type CombatHooks } from '../../src/simulation/combat';
import { createWorld, spawnActor, type Skill, type World } from '../../src/simulation/world';
import { ActorType, MobjFlag } from '../../src/simulation/data/actors';
import { ActionId, StateId } from '../../src/simulation/data/states';
import { WeaponType } from '../../src/simulation/data/weapons';
import { CheatFlag, PowerType } from '../../src/simulation/player';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { tickActorState, type Actor } from '../../src/simulation/actors';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');

function fixture(skill: Skill = 2): World {
  return createWorld(map, { skill, noMonsters: true });
}

function avatar(world: World): Actor {
  const actor = world.actorsById.get(world.player.actorId);
  if (!actor) throw new Error('Player missing');
  return actor;
}

function monster(world: World, type: ActorType = ActorType.MT_POSSESSED): Actor {
  const player = avatar(world);
  return spawnActor(world, type, player.x + 64 * FRAC_UNIT, player.y, player.z);
}

function hooks(): CombatHooks & { calls: { actions: [ActionId, StateId, number][]; drops: number; automapStops: number } } {
  const calls = { actions: [] as [ActionId, StateId, number][], drops: 0, automapStops: 0 };
  return {
    calls,
    runActorAction: (action, actor) => { calls.actions.push([action, actor.state, actor.id]); },
    dropWeapon: () => { calls.drops++; },
    stopAutomap: () => { calls.automapStops++; },
  };
}

describe('damage eligibility and momentum', () => {
  it.each([0, -1])('leaves an already dead target at health %i without consuming random values', health => {
    const world = fixture(), target = monster(world), callback = hooks();
    target.health = health;
    world.random.gameIndex = 0;
    damageActor(world, target, avatar(world), avatar(world), 10, callback);
    expect(target.health).toBe(health);
    expect(target.momx).toBe(0);
    expect(world.random.gameIndex).toBe(0);
    expect(callback.calls.actions).toEqual([]);
  });

  it('ignores non-shootable targets', () => {
    const world = fixture(), target = monster(world), callback = hooks();
    target.flags &= ~MobjFlag.MF_SHOOTABLE;
    world.random.gameIndex = 0;
    damageActor(world, target, avatar(world), avatar(world), 10, callback);
    expect(target.health).toBe(20);
    expect(target.momx).toBe(0);
    expect(world.random.gameIndex).toBe(0);
  });

  it('uses original fixed-point angle tables and mass-based thrust', () => {
    const world = fixture(), target = monster(world);
    world.random.gameIndex = 0;
    damageActor(world, target, avatar(world), avatar(world), 8, hooks());
    expect(target.health).toBe(12);
    expect(target.momx).toBe(65535);
    expect(target.momy).toBe(25);
  });

  it.each([CheatFlag.CF_GODMODE, 0])('applies thrust before god or invulnerability damage rejection (cheat %i)', cheat => {
    const world = fixture(), target = avatar(world), inflictor = monster(world);
    inflictor.x = target.x - 64 * FRAC_UNIT;
    world.player.cheats = cheat;
    if (cheat === 0) world.player.powers[PowerType.pw_invulnerability] = 1050;
    world.random.gameIndex = 0;
    damageActor(world, target, inflictor, inflictor, 8, hooks());
    expect(target.health).toBe(100);
    expect(world.player.health).toBe(100);
    expect(target.momx).toBe(65535);
    expect(target.momy).toBe(25);
    expect(world.player.damageCount).toBe(0);
    expect(world.random.gameIndex).toBe(0);
  });

  it('does not add thrust for chainsaw attacks or no-clip targets', () => {
    const world = fixture(), source = avatar(world), target = monster(world);
    world.player.readyWeapon = WeaponType.wp_chainsaw;
    damageActor(world, target, source, source, 1, hooks());
    expect(target.momx).toBe(0);
    expect(target.momy).toBe(0);
    world.player.readyWeapon = WeaponType.wp_pistol;
    target.flags |= MobjFlag.MF_NOCLIP;
    damageActor(world, target, source, source, 1, hooks());
    expect(target.momx).toBe(0);
    expect(target.momy).toBe(0);
  });

  it('sometimes reverses and quadruples thrust for a victim dying high above its inflictor', () => {
    const world = fixture(), target = monster(world), source = avatar(world);
    target.z = source.z + 80 * FRAC_UNIT;
    target.health = 5;
    world.random.gameIndex = 1; // Next value 109 is odd; death draw is 220.
    damageActor(world, target, source, source, 10, hooks());
    expect(target.momx).toBe(-327675);
    expect(target.momy).toBe(-125);
    expect(target.health).toBe(-5);
    expect(world.random.gameIndex).toBe(4); // Fall, death timing, then dropped clip spawn.
  });

  it('cancels a charging lost soul momentum and consumes pain RNG before the skull-flight check', () => {
    const world = fixture(), target = monster(world, ActorType.MT_SKULL), callback = hooks();
    target.flags |= MobjFlag.MF_SKULLFLY;
    target.momx = target.momy = target.momz = FRAC_UNIT;
    world.random.gameIndex = 0;
    damageActor(world, target, null, null, 1, callback);
    expect([target.momx, target.momy, target.momz]).toEqual([0, 0, 0]);
    expect(target.flags & MobjFlag.MF_SKULLFLY).toBe(MobjFlag.MF_SKULLFLY);
    expect(target.flags & MobjFlag.MF_JUSTHIT).toBe(0);
    expect(world.random.gameIndex).toBe(1);
    expect(callback.calls.actions).toEqual([]);
  });
});

describe('player damage', () => {
  it('halves baby-skill player damage with integer rounding but does not halve monster damage', () => {
    const world = fixture(0), player = avatar(world), target = monster(world);
    damageActor(world, player, null, null, 5, hooks());
    damageActor(world, target, null, null, 5, hooks());
    expect(player.health).toBe(98);
    expect(world.player.health).toBe(98);
    expect(target.health).toBe(15);
  });

  it.each([[1, 10, 80, 90], [2, 15, 85, 85]] as const)
    ('absorbs original armor type %i share', (armorType, saved, health, armorPoints) => {
      const world = fixture(), player = avatar(world);
      world.player.armorType = armorType;
      world.player.armorPoints = 100;
      damageActor(world, player, null, null, 30, hooks());
      expect(world.player.health).toBe(health);
      expect(player.health).toBe(health);
      expect(world.player.armorPoints).toBe(armorPoints);
      expect(world.player.damageCount).toBe(30 - saved);
      expect(world.player.attacker).toBeNull();
    });

  it('uses remaining armor and clears its type when protection is exhausted', () => {
    const world = fixture(), player = avatar(world);
    world.player.armorType = 1;
    world.player.armorPoints = 4;
    damageActor(world, player, null, null, 30, hooks());
    expect(world.player).toMatchObject({ armorType: 0, armorPoints: 0, health: 74, damageCount: 26 });
    expect(player.health).toBe(74);
  });

  it('prevents lethal damage in sector special 11 before armor and immunity handling', () => {
    const world = fixture(), player = avatar(world);
    const sector = world.sectors[player.sector];
    if (!sector) throw new Error('Sector missing');
    sector.special = 11;
    world.player.health = player.health = 10;
    damageActor(world, player, null, null, 10000, hooks());
    expect(world.player.health).toBe(1);
    expect(player.health).toBe(1);
    expect(world.player.state).toBe('alive');
  });

  it('bypasses god and invulnerability at damage 1000 and caps the player damage flash', () => {
    const world = fixture(), player = avatar(world), callback = hooks();
    world.player.cheats = CheatFlag.CF_GODMODE;
    world.player.powers[PowerType.pw_invulnerability] = 1050;
    world.random.gameIndex = 0;
    damageActor(world, player, null, null, 1000, callback);
    expect(player.health).toBe(-900);
    expect(world.player).toMatchObject({ health: 0, damageCount: 100, state: 'dead', attacker: null });
    expect(player.state).toBe(StateId.S_PLAY_XDIE1);
    expect(player.flags & MobjFlag.MF_SOLID).toBe(0);
    expect(callback.calls.drops).toBe(1);
    expect(callback.calls.automapStops).toBe(1);
    expect(world.random.gameIndex).toBe(1);
  });

  it('records the source ID as attacker after armor and preserves the referenced actor record', () => {
    const world = fixture(), player = avatar(world), source = monster(world);
    damageActor(world, player, null, source, 5, hooks());
    expect(world.player.attacker).toBe(source.id);
    expect(world.actorsById.get(source.id)).toBe(source);
  });
});

describe('pain and retaliation', () => {
  it('enters the first pain frame, marks just-hit and runs its action at the following frame', () => {
    const world = fixture(), target = monster(world), callback = hooks();
    target.reactionTime = 20;
    world.random.gameIndex = 0;
    damageActor(world, target, null, null, 1, callback);
    expect(target.state).toBe(StateId.S_POSS_PAIN);
    expect(target.flags & MobjFlag.MF_JUSTHIT).toBe(MobjFlag.MF_JUSTHIT);
    expect(target.reactionTime).toBe(0);
    expect(callback.calls.actions).toEqual([]);
    for (let tic = 0; tic < 3; tic++) tickActorState(target, callback.runActorAction);
    expect(callback.calls.actions).toEqual([[ActionId.A_Pain, StateId.S_POSS_PAIN2, target.id]]);
    expect(world.random.gameIndex).toBe(1);
  });

  it('consumes the original pain draw even with painchance zero and damage zero', () => {
    const world = fixture(), target = monster(world, ActorType.MT_BARREL), callback = hooks();
    target.reactionTime = 9;
    world.random.gameIndex = 0;
    damageActor(world, target, null, null, 0, callback);
    expect(target.health).toBe(20);
    expect(target.reactionTime).toBe(0);
    expect(world.random.gameIndex).toBe(1);
    expect(callback.calls.actions).toEqual([]);
  });

  it('retargets an idle uncommitted monster and enters its see state when pain did not occur', () => {
    const world = fixture(), target = monster(world), source = avatar(world), callback = hooks();
    world.random.gameIndex = 2; // Next value 220 exceeds possessed painchance 200.
    damageActor(world, target, null, source, 1, callback);
    expect(target.target).toBe(source.id);
    expect(target.threshold).toBe(100);
    expect(target.state).toBe(StateId.S_POSS_RUN1);
    expect(callback.calls.actions).toEqual([[ActionId.A_Chase, StateId.S_POSS_RUN1, target.id]]);
  });

  it('keeps an existing committed target, except for the original arch-vile exception', () => {
    const world = fixture(), source = avatar(world);
    const possessed = monster(world), vile = monster(world, ActorType.MT_VILE);
    for (const target of [possessed, vile]) {
      target.threshold = 50;
      target.target = possessed.id;
      world.random.gameIndex = 2;
      damageActor(world, target, null, source, 1, hooks());
    }
    expect(possessed.target).toBe(possessed.id);
    expect(possessed.threshold).toBe(50);
    expect(vile.target).toBe(source.id);
    expect(vile.threshold).toBe(100);
  });

  it('does not select the source when it is self or an arch-vile', () => {
    const world = fixture(), target = monster(world), vile = monster(world, ActorType.MT_VILE);
    world.random.gameIndex = 2;
    damageActor(world, target, null, target, 1, hooks());
    expect(target.target).toBeNull();
    world.random.gameIndex = 2;
    damageActor(world, target, null, vile, 1, hooks());
    expect(target.target).toBeNull();
    expect(target.threshold).toBe(0);
  });
});

describe('death and dropped items', () => {
  it('keeps the corpse solid until its fall action, quarters height and clears living flags', () => {
    const world = fixture(), target = monster(world, ActorType.MT_HEAD);
    target.flags |= MobjFlag.MF_SKULLFLY;
    target.health = 0;
    world.random.gameIndex = 0;
    killActor(world, avatar(world), target, hooks());
    expect(target.height).toBe(14 * FRAC_UNIT);
    expect(target.flags & (MobjFlag.MF_SHOOTABLE | MobjFlag.MF_FLOAT | MobjFlag.MF_SKULLFLY | MobjFlag.MF_NOGRAVITY)).toBe(0);
    expect(target.flags & MobjFlag.MF_SOLID).toBe(MobjFlag.MF_SOLID);
    expect(target.flags & (MobjFlag.MF_CORPSE | MobjFlag.MF_DROPOFF)).toBe(MobjFlag.MF_CORPSE | MobjFlag.MF_DROPOFF);
  });

  it('preserves the lost soul no-gravity flag on death', () => {
    const world = fixture(), target = monster(world, ActorType.MT_SKULL);
    target.health = 0;
    killActor(world, null, target, hooks());
    expect(target.flags & MobjFlag.MF_NOGRAVITY).toBe(MobjFlag.MF_NOGRAVITY);
    expect(target.flags & MobjFlag.MF_FLOAT).toBe(0);
    expect(target.height).toBe(14 * FRAC_UNIT);
  });

  it.each([[null, 1], [ActorType.MT_TROOP, 1], [ActorType.MT_PLAYER, 1]] as const)
    ('attributes all single-player counted deaths even with source %s', (sourceType, count) => {
      const world = fixture(), target = monster(world, ActorType.MT_TROOP);
      const source = sourceType === null ? null : sourceType === ActorType.MT_PLAYER
        ? avatar(world) : monster(world, sourceType);
      target.health = 0;
      killActor(world, source, target, hooks());
      expect(world.player.killCount).toBe(count);
    });

  it('does not count barrels or scenery as monster kills', () => {
    const world = fixture(), target = monster(world, ActorType.MT_BARREL);
    target.health = 0;
    killActor(world, avatar(world), target, hooks());
    expect(world.player.killCount).toBe(0);
  });

  it.each([[-20, StateId.S_POSS_DIE1], [-21, StateId.S_POSS_XDIE1]] as const)
    ('uses the strict gib boundary at health %i', (health, state) => {
      const world = fixture(), target = monster(world);
      target.health = health;
      world.random.gameIndex = 0;
      killActor(world, null, target, hooks());
      expect(target.state).toBe(state);
      expect(target.tics).toBe(5);
    });

  it('subtracts the original 0..3 random death timing and consumes a separate spawn draw for drops', () => {
    const world = fixture(), target = monster(world);
    target.health = 0;
    world.random.gameIndex = 7; // Next value 107 => three fewer death tics.
    const before = world.actors.length;
    killActor(world, null, target, hooks());
    expect(target.tics).toBe(2);
    expect(world.actors.length).toBe(before + 1);
    expect(world.random.gameIndex).toBe(9);
  });

  it.each([[ActorType.MT_POSSESSED, ActorType.MT_CLIP], [ActorType.MT_SHOTGUY, ActorType.MT_SHOTGUN],
    [ActorType.MT_CHAINGUY, ActorType.MT_CHAINGUN], [ActorType.MT_WOLFSS, ActorType.MT_CLIP]] as const)
    ('drops the original item for actor type %i', (type, dropType) => {
      const world = fixture(), target = monster(world, type);
      target.health = 0;
      target.z += 10 * FRAC_UNIT;
      const before = world.nextActorId;
      killActor(world, null, target, hooks());
      const drop = world.actorsById.get(before);
      expect(drop).toMatchObject({ type: dropType, x: target.x, y: target.y });
      expect(drop?.z).toBe(drop?.floorZ);
      expect((drop?.flags ?? 0) & MobjFlag.MF_DROPPED).toBe(MobjFlag.MF_DROPPED);
      expect(world.activeActorIds.has(before)).toBe(true);
    });

  it('enters the death state after player presentation hooks see the dead player and cleared solid flag', () => {
    const world = fixture(), player = avatar(world);
    const order: string[] = [];
    player.health = 0;
    killActor(world, null, player, {
      dropWeapon: () => {
        expect(world.player.state).toBe('dead');
        expect(player.flags & MobjFlag.MF_SOLID).toBe(0);
        order.push('drop');
      },
      stopAutomap: () => { order.push('map'); },
      runActorAction: () => { order.push('state'); },
    });
    expect(order).toEqual(['drop', 'map']); // S_PLAY_DIE1 has no entry action.
    expect(player.state).toBe(StateId.S_PLAY_DIE1);
  });

  it('unlinks a null death-state actor immediately and still draws and clamps its death timer', () => {
    const world = fixture(), target = monster(world, ActorType.MT_FIRE);
    target.health = 0;
    world.random.gameIndex = 7;
    killActor(world, null, target, hooks());
    expect(target).toMatchObject({ state: StateId.S_NULL, removed: true, tics: 1 });
    expect(world.activeActorIds.has(target.id)).toBe(false);
    expect(world.actorsById.get(target.id)).toBe(target);
    expect(world.actorBlocks.flat()).not.toContain(target.id);
    expect(world.random.gameIndex).toBe(8);
    expect(world.events).toContainEqual({ type: 'stopSound', actor: target.id });
  });

});
