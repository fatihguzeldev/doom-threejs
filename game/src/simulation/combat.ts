// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native singleplayer P_DamageMobj/P_KillMobj from p_inter.c. See ../../LICENSE.
import { setActorState, type Actor } from './actors';
import { ANG180, fineCos, fineSin, pointToAngle } from './angle';
import { ActorType, MobjFlag, actors } from './data/actors';
import { StateId, type ActionId } from './data/states';
import { WeaponType } from './data/weapons';
import { fixedMul, FRAC_UNIT } from './fixed';
import { CheatFlag, PowerType } from './player';
import { gameRandom } from './random';
import { removeActor, spawnActor, type World } from './world';

export interface CombatHooks {
  readonly runActorAction: (action: ActionId, actor: Actor) => void;
  readonly dropWeapon: () => void;
  readonly stopAutomap: () => void;
}

function enterState(world: World, actor: Actor, state: StateId, hooks: CombatHooks): void {
  setActorState(actor, state, hooks.runActorAction);
  if (actor.removed) removeActor(world, actor);
}

export function killActor(world: World, source: Actor | null, target: Actor, hooks: CombatHooks): void {
  const info = actors[target.type];
  if (info === undefined) throw new RangeError(`Unknown killed actor type ${target.type}`);
  target.flags &= ~(MobjFlag.MF_SHOOTABLE | MobjFlag.MF_FLOAT | MobjFlag.MF_SKULLFLY);
  if (target.type !== ActorType.MT_SKULL) target.flags &= ~MobjFlag.MF_NOGRAVITY;
  target.flags |= MobjFlag.MF_CORPSE | MobjFlag.MF_DROPOFF;
  target.height >>= 2;

  if (source !== null && source.player !== null) {
    if ((target.flags & MobjFlag.MF_COUNTKILL) !== 0) world.player.killCount++;
  } else if ((target.flags & MobjFlag.MF_COUNTKILL) !== 0) {
    // Single-player also counts environmental deaths and monster infighting.
    world.player.killCount++;
  }

  if (target.player !== null) {
    target.flags &= ~MobjFlag.MF_SOLID;
    world.player.state = 'dead';
    hooks.dropWeapon();
    hooks.stopAutomap();
  }

  if (target.health < -info.spawnhealth && info.xdeathstate !== StateId.S_NULL) {
    enterState(world, target, info.xdeathstate, hooks);
  } else {
    enterState(world, target, info.deathstate, hooks);
  }
  target.tics -= gameRandom(world.random) & 3;
  if (target.tics < 1) target.tics = 1;

  let item: ActorType;
  switch (target.type) {
    case ActorType.MT_WOLFSS:
    case ActorType.MT_POSSESSED:
      item = ActorType.MT_CLIP;
      break;
    case ActorType.MT_SHOTGUY:
      item = ActorType.MT_SHOTGUN;
      break;
    case ActorType.MT_CHAINGUY:
      item = ActorType.MT_CHAINGUN;
      break;
    default:
      return;
  }
  const dropped = spawnActor(world, item, target.x, target.y, 'floor');
  dropped.flags |= MobjFlag.MF_DROPPED;
}

export function damageActor(
  world: World,
  target: Actor,
  inflictor: Actor | null,
  source: Actor | null,
  damage: number,
  hooks: CombatHooks,
): void {
  if ((target.flags & MobjFlag.MF_SHOOTABLE) === 0 || target.health <= 0) return;
  const info = actors[target.type];
  if (info === undefined) throw new RangeError(`Unknown damaged actor type ${target.type}`);
  if ((target.flags & MobjFlag.MF_SKULLFLY) !== 0) target.momx = target.momy = target.momz = 0;
  const player = target.player === null ? null : world.player;
  if (player !== null && world.skill === 0) damage >>= 1;

  if (inflictor !== null && (target.flags & MobjFlag.MF_NOCLIP) === 0
    && (source === null || source.player === null || world.player.readyWeapon !== WeaponType.wp_chainsaw)) {
    let angle = pointToAngle(inflictor.x, inflictor.y, target.x, target.y);
    // Each original C multiply is a signed 32-bit operation before division.
    const numerator = Math.imul(Math.imul(damage, FRAC_UNIT >> 3), 100);
    let thrust = Math.trunc(numerator / info.mass) | 0;
    if (damage < 40 && damage > target.health
      && ((target.z - inflictor.z) | 0) > 64 * FRAC_UNIT && (gameRandom(world.random) & 1) !== 0) {
      angle = (angle + ANG180) >>> 0;
      thrust = Math.imul(thrust, 4);
    }
    target.momx = (target.momx + fixedMul(thrust, fineCos(angle))) | 0;
    target.momy = (target.momy + fixedMul(thrust, fineSin(angle))) | 0;
  }

  if (player !== null) {
    const sector = world.sectors[target.sector];
    if (sector === undefined) throw new RangeError(`Unknown player sector ${target.sector}`);
    if (sector.special === 11 && damage >= target.health) damage = target.health - 1;
    if (damage < 1000 && ((player.cheats & CheatFlag.CF_GODMODE) !== 0
      || player.powers[PowerType.pw_invulnerability])) return;
    if (player.armorType !== 0) {
      let saved = Math.trunc(damage / (player.armorType === 1 ? 3 : 2));
      if (player.armorPoints <= saved) {
        saved = player.armorPoints;
        player.armorType = 0;
      }
      player.armorPoints -= saved;
      damage -= saved;
    }
    player.health = Math.max(0, (player.health - damage) | 0);
    player.attacker = source?.id ?? null;
    player.damageCount = Math.min((player.damageCount + damage) | 0, 100);
  }

  target.health = (target.health - damage) | 0;
  if (target.health <= 0) {
    killActor(world, source, target, hooks);
    return;
  }
  // Draw first, even when painchance is zero or skull-flight suppresses pain.
  if (gameRandom(world.random) < info.painchance && (target.flags & MobjFlag.MF_SKULLFLY) === 0) {
    target.flags |= MobjFlag.MF_JUSTHIT;
    enterState(world, target, info.painstate, hooks);
  }
  target.reactionTime = 0;
  if ((target.threshold === 0 || target.type === ActorType.MT_VILE)
    && source !== null && source !== target && source.type !== ActorType.MT_VILE) {
    target.target = source.id;
    target.threshold = 100;
    if (target.state === info.spawnstate && info.seestate !== StateId.S_NULL) {
      enterState(world, target, info.seestate, hooks);
    }
  }
}
