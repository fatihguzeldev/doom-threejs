// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native Doom I enemy thinking and actor actions from p_enemy.c. See ../../LICENSE.
import { setActorState, type Actor } from './actors';
import { ANG45, ANG90, ANG270, fineCos, fineSin, pointToAngle } from './angle';
import { ActorType, MobjFlag, SfxId, actors } from './data/actors';
import { ActionId, StateId } from './data/states';
import { FRAC_UNIT, fixedMul } from './fixed';
import type { MovementResult } from './movement';
import { gameRandom } from './random';
import { removeActor, spawnActor, type World } from './world';

export enum Direction {
  DI_EAST = 0, DI_NORTHEAST = 1, DI_NORTH = 2, DI_NORTHWEST = 3,
  DI_WEST = 4, DI_SOUTHWEST = 5, DI_SOUTH = 6, DI_SOUTHEAST = 7,
  DI_NODIR = 8, NUMDIRS = 9,
}

export type BossDeathEffect =
  | { readonly kind: 'lowerFloorToLowest'; readonly tag: 666 }
  | { readonly kind: 'blazeOpen'; readonly tag: 666 }
  | { readonly kind: 'exit' };

export interface EnemyHooks {
  readonly tryMove: (actor: Actor, x: number, y: number) => MovementResult;
  readonly checkSight: (actor: Actor, target: Actor) => boolean;
  readonly aimLineAttack: (actor: Actor, angle: number, range: number) => { readonly slope: number; readonly target: Actor | null };
  readonly lineAttack: (actor: Actor, angle: number, range: number, slope: number, damage: number) => Actor | null;
  readonly spawnMissile: (source: Actor, target: Actor, type: ActorType) => Actor;
  readonly damageActor: (target: Actor, inflictor: Actor | null, source: Actor | null, damage: number) => void;
  readonly radiusAttack: (spot: Actor, source: Actor | null, damage: number) => void;
  readonly runActorAction: (action: ActionId, actor: Actor) => void;
  readonly useSpecial: (line: number, side: 0 | 1, actor: Actor) => boolean;
  readonly bossDeath: (effect: BossDeathEffect) => void;
}

export interface EnemySystem {
  noiseAlert(target: Actor, emitter: Actor): void;
  lookForPlayers(actor: Actor, allAround: boolean): boolean;
  checkMeleeRange(actor: Actor): boolean;
  checkMissileRange(actor: Actor): boolean;
  move(actor: Actor): boolean;
  tryWalk(actor: Actor): boolean;
  newChaseDir(actor: Actor): void;
  faceTarget(actor: Actor): void;
  runAction(action: ActionId, actor: Actor): void;
}

interface EnemyContext {
  readonly world: World;
  readonly hooks: EnemyHooks;
  readonly fastMonsters: boolean;
  soundValidCount: number;
}

const MELEE_RANGE = 64 * FRAC_UNIT;
const MISSILE_RANGE = 32 * 64 * FRAC_UNIT;
const FLOAT_SPEED = 4 * FRAC_UNIT;
const xSpeed = [FRAC_UNIT, 47000, 0, -47000, -FRAC_UNIT, -47000, 0, 47000];
const ySpeed = [0, 47000, FRAC_UNIT, 47000, 0, -47000, -FRAC_UNIT, -47000];
const opposite = [4, 5, 6, 7, 0, 1, 2, 3, 8];
const diagonals = [3, 1, 5, 7];

function element<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Invalid enemy reference ${index}`);
  return value;
}
function targetOf(context: EnemyContext, actor: Actor): Actor | null {
  const target = actor.target === null ? null : context.world.actorsById.get(actor.target) ?? null;
  return target?.removed ? null : target;
}
function approximateDistance(dx: number, dy: number): number {
  dx = Math.abs(dx); dy = Math.abs(dy);
  return (dx + dy - (Math.min(dx, dy) >> 1)) | 0;
}
function enterState(context: EnemyContext, actor: Actor, state: StateId): void {
  setActorState(actor, state, context.hooks.runActorAction);
  if (actor.removed) removeActor(context.world, actor);
}
function sound(context: EnemyContext, soundId: SfxId, actor: Actor | null): void {
  context.world.events.push({ type: 'sound', sound: soundId, actor: actor?.id ?? null });
}

function noiseAlert(context: EnemyContext, target: Actor, emitter: Actor): void {
  const world = context.world;
  context.soundValidCount = (context.soundValidCount + 1) | 0;
  const pending = [{ sector: emitter.sector, blocks: 0 }];
  while (pending.length !== 0) {
    const entry = pending.pop();
    if (!entry) break;
    const sector = element(world.sectors, entry.sector);
    if (sector.soundValidCount === context.soundValidCount && sector.soundTraversed <= entry.blocks + 1) continue;
    sector.soundValidCount = context.soundValidCount;
    sector.soundTraversed = entry.blocks + 1;
    sector.soundTarget = target.id;
    // Reverse pushes retain P_RecursiveSound's grouped line traversal order.
    for (let index = sector.lines.length - 1; index >= 0; index--) {
      const lineIndex = element(sector.lines, index);
      const line = element(world.spatial.lines, lineIndex);
      const flags = element(world.lineFlags, lineIndex);
      if ((flags & 4) === 0 || line.backSector === null) continue;
      const front = element(world.sectors, line.frontSector), back = element(world.sectors, line.backSector);
      if (Math.min(front.ceilingHeight, back.ceilingHeight) - Math.max(front.floorHeight, back.floorHeight) <= 0) continue;
      if ((flags & 64) !== 0 && entry.blocks !== 0) continue;
      pending.push({ sector: line.frontSector === entry.sector ? line.backSector : line.frontSector,
        blocks: (flags & 64) !== 0 ? 1 : entry.blocks });
    }
  }
}

function lookForPlayers(context: EnemyContext, actor: Actor, allAround: boolean): boolean {
  const world = context.world;
  let count = 0;
  const stop = (actor.lastLook - 1) & 3;
  for (;; actor.lastLook = (actor.lastLook + 1) & 3) {
    if (actor.lastLook !== 0) continue; // Player zero is the only active single-player slot.
    if (count++ === 2 || actor.lastLook === stop) return false;
    if (world.player.health <= 0) continue;
    const player = world.actorsById.get(world.player.actorId);
    if (!player || player.removed || !context.hooks.checkSight(actor, player)) continue;
    if (!allAround) {
      const angle = (pointToAngle(actor.x, actor.y, player.x, player.y) - actor.angle) >>> 0;
      if (angle > ANG90 && angle < ANG270
        && approximateDistance((player.x - actor.x) | 0, (player.y - actor.y) | 0) > MELEE_RANGE) continue;
    }
    actor.target = player.id;
    return true;
  }
}

function checkMeleeRange(context: EnemyContext, actor: Actor): boolean {
  const target = targetOf(context, actor);
  if (!target) return false;
  const distance = approximateDistance((target.x - actor.x) | 0, (target.y - actor.y) | 0);
  if (distance >= MELEE_RANGE - 20 * FRAC_UNIT + element(actors, target.type).radius) return false;
  return context.hooks.checkSight(actor, target);
}

function checkMissileRange(context: EnemyContext, actor: Actor): boolean {
  const target = targetOf(context, actor);
  if (!target || !context.hooks.checkSight(actor, target)) return false;
  if ((actor.flags & MobjFlag.MF_JUSTHIT) !== 0) {
    actor.flags &= ~MobjFlag.MF_JUSTHIT;
    return true;
  }
  if (actor.reactionTime !== 0) return false;
  let distance = (approximateDistance((actor.x - target.x) | 0, (actor.y - target.y) | 0) - 64 * FRAC_UNIT) | 0;
  if (element(actors, actor.type).meleestate === StateId.S_NULL) distance = (distance - 128 * FRAC_UNIT) | 0;
  distance >>= 16;
  if (actor.type === ActorType.MT_VILE && distance > 14 * 64) return false;
  if (actor.type === ActorType.MT_UNDEAD) {
    if (distance < 196) return false;
    distance >>= 1;
  }
  if (actor.type === ActorType.MT_CYBORG || actor.type === ActorType.MT_SPIDER || actor.type === ActorType.MT_SKULL) distance >>= 1;
  if (distance > 200) distance = 200;
  if (actor.type === ActorType.MT_CYBORG && distance > 160) distance = 160;
  return gameRandom(context.world.random) >= distance;
}

function move(context: EnemyContext, actor: Actor): boolean {
  if (actor.moveDir === Direction.DI_NODIR) return false;
  if ((actor.moveDir >>> 0) >= 8) throw new Error('Weird actor->movedir!');
  const speed = element(actors, actor.type).speed;
  const result = context.hooks.tryMove(actor,
    (actor.x + Math.imul(speed, element(xSpeed, actor.moveDir))) | 0,
    (actor.y + Math.imul(speed, element(ySpeed, actor.moveDir))) | 0);
  if (!result.fits) {
    if ((actor.flags & MobjFlag.MF_FLOAT) !== 0 && result.floatOk) {
      actor.z = (actor.z + (actor.z < result.floorZ ? FLOAT_SPEED : -FLOAT_SPEED)) | 0;
      actor.flags |= MobjFlag.MF_INFLOAT;
      return true;
    }
    if (result.specialLines.length === 0) return false;
    actor.moveDir = Direction.DI_NODIR;
    let good = false;
    for (let index = result.specialLines.length - 1; index >= 0; index--) {
      if (context.hooks.useSpecial(element(result.specialLines, index), 0, actor)) good = true;
    }
    return good;
  }
  actor.flags &= ~MobjFlag.MF_INFLOAT;
  if ((actor.flags & MobjFlag.MF_FLOAT) === 0) actor.z = actor.floorZ;
  return true;
}

function tryWalk(context: EnemyContext, actor: Actor): boolean {
  if (!move(context, actor)) return false;
  actor.moveCount = gameRandom(context.world.random) & 15;
  return true;
}

function newChaseDir(context: EnemyContext, actor: Actor): void {
  const target = targetOf(context, actor);
  if (!target) throw new Error('P_NewChaseDir: called with no target');
  const oldDir = actor.moveDir, turnaround = element(opposite, oldDir);
  const dx = (target.x - actor.x) | 0, dy = (target.y - actor.y) | 0;
  let first = dx > 10 * FRAC_UNIT ? Direction.DI_EAST : dx < -10 * FRAC_UNIT ? Direction.DI_WEST : Direction.DI_NODIR;
  let second = dy < -10 * FRAC_UNIT ? Direction.DI_SOUTH : dy > 10 * FRAC_UNIT ? Direction.DI_NORTH : Direction.DI_NODIR;
  if (first !== Direction.DI_NODIR && second !== Direction.DI_NODIR) {
    actor.moveDir = element(diagonals, (dy < 0 ? 2 : 0) + (dx > 0 ? 1 : 0));
    if (actor.moveDir !== turnaround && tryWalk(context, actor)) return;
  }
  if (gameRandom(context.world.random) > 200 || Math.abs(dy) > Math.abs(dx)) [first, second] = [second, first];
  if (first === turnaround) first = Direction.DI_NODIR;
  if (second === turnaround) second = Direction.DI_NODIR;
  for (const direction of [first, second]) {
    if (direction === Direction.DI_NODIR) continue;
    actor.moveDir = direction;
    if (tryWalk(context, actor)) return;
  }
  if (oldDir !== Direction.DI_NODIR) {
    actor.moveDir = oldDir;
    if (tryWalk(context, actor)) return;
  }
  const ascending = (gameRandom(context.world.random) & 1) !== 0;
  for (let direction = ascending ? 0 : 7; ascending ? direction <= 7 : direction >= 0; direction += ascending ? 1 : -1) {
    if (direction === turnaround) continue;
    actor.moveDir = direction;
    if (tryWalk(context, actor)) return;
  }
  if (turnaround !== Direction.DI_NODIR) {
    actor.moveDir = turnaround;
    if (tryWalk(context, actor)) return;
  }
  actor.moveDir = Direction.DI_NODIR;
}

function look(context: EnemyContext, actor: Actor): void {
  actor.threshold = 0;
  const targetId = element(context.world.sectors, actor.sector).soundTarget;
  const target = targetId === null ? null : context.world.actorsById.get(targetId) ?? null;
  let seen = false;
  if (target && !target.removed && (target.flags & MobjFlag.MF_SHOOTABLE) !== 0) {
    actor.target = target.id;
    seen = (actor.flags & MobjFlag.MF_AMBUSH) === 0 || context.hooks.checkSight(actor, target);
  }
  if (!seen && !lookForPlayers(context, actor, false)) return;
  const info = element(actors, actor.type);
  if (info.seesound !== SfxId.sfx_None) {
    let alert = info.seesound;
    switch (alert) {
      case SfxId.sfx_posit1: case SfxId.sfx_posit2: case SfxId.sfx_posit3:
        alert = SfxId.sfx_posit1 + gameRandom(context.world.random) % 3;
        break;
      case SfxId.sfx_bgsit1: case SfxId.sfx_bgsit2:
        alert = SfxId.sfx_bgsit1 + gameRandom(context.world.random) % 2;
        break;
    }
    sound(context, alert, actor.type === ActorType.MT_SPIDER || actor.type === ActorType.MT_CYBORG ? null : actor);
  }
  enterState(context, actor, info.seestate);
}

function chase(context: EnemyContext, actor: Actor): void {
  const info = element(actors, actor.type);
  const target = targetOf(context, actor);
  if (actor.reactionTime !== 0) actor.reactionTime--;
  if (actor.threshold !== 0) {
    if (!target || target.health <= 0) actor.threshold = 0;
    else actor.threshold--;
  }
  if (actor.moveDir < 8) {
    actor.angle = (actor.angle & (7 << 29)) >>> 0;
    const delta = (actor.angle - (actor.moveDir << 29)) | 0;
    if (delta > 0) actor.angle = (actor.angle - ANG45) >>> 0;
    else if (delta < 0) actor.angle = (actor.angle + ANG45) >>> 0;
  }
  if (!target || (target.flags & MobjFlag.MF_SHOOTABLE) === 0) {
    if (lookForPlayers(context, actor, true)) return;
    enterState(context, actor, info.spawnstate);
    return;
  }
  if ((actor.flags & MobjFlag.MF_JUSTATTACKED) !== 0) {
    actor.flags &= ~MobjFlag.MF_JUSTATTACKED;
    if (context.world.skill !== 4 && !context.fastMonsters) newChaseDir(context, actor);
    return;
  }
  if (info.meleestate !== StateId.S_NULL && checkMeleeRange(context, actor)) {
    if (info.attacksound !== SfxId.sfx_None) sound(context, info.attacksound, actor);
    enterState(context, actor, info.meleestate);
    return;
  }
  if (info.missilestate !== StateId.S_NULL
    && !(context.world.skill < 4 && !context.fastMonsters && actor.moveCount !== 0)
    && checkMissileRange(context, actor)) {
    enterState(context, actor, info.missilestate);
    actor.flags |= MobjFlag.MF_JUSTATTACKED;
    return;
  }
  // The netgame-only target search from the original does not run in single-player.
  actor.moveCount--;
  if (actor.moveCount < 0 || !move(context, actor)) newChaseDir(context, actor);
  if (info.activesound !== SfxId.sfx_None && gameRandom(context.world.random) < 3) sound(context, info.activesound, actor);
}

function faceTarget(context: EnemyContext, actor: Actor): void {
  const target = targetOf(context, actor);
  if (!target) return;
  actor.flags &= ~MobjFlag.MF_AMBUSH;
  actor.angle = pointToAngle(actor.x, actor.y, target.x, target.y);
  if ((target.flags & MobjFlag.MF_SHADOW) !== 0) {
    actor.angle = (actor.angle + ((gameRandom(context.world.random) - gameRandom(context.world.random)) << 21)) >>> 0;
  }
}

function posAttack(context: EnemyContext, actor: Actor): void {
  if (!targetOf(context, actor)) return;
  faceTarget(context, actor);
  let angle = actor.angle;
  const { slope } = context.hooks.aimLineAttack(actor, angle, MISSILE_RANGE);
  sound(context, SfxId.sfx_pistol, actor);
  angle = (angle + ((gameRandom(context.world.random) - gameRandom(context.world.random)) << 20)) >>> 0;
  const damage = (gameRandom(context.world.random) % 5 + 1) * 3;
  context.hooks.lineAttack(actor, angle, MISSILE_RANGE, slope, damage);
}

function sPosAttack(context: EnemyContext, actor: Actor): void {
  if (!targetOf(context, actor)) return;
  sound(context, SfxId.sfx_shotgn, actor);
  faceTarget(context, actor);
  const baseAngle = actor.angle;
  const { slope } = context.hooks.aimLineAttack(actor, baseAngle, MISSILE_RANGE);
  for (let index = 0; index < 3; index++) {
    const angle = (baseAngle + ((gameRandom(context.world.random) - gameRandom(context.world.random)) << 20)) >>> 0;
    const damage = (gameRandom(context.world.random) % 5 + 1) * 3;
    context.hooks.lineAttack(actor, angle, MISSILE_RANGE, slope, damage);
  }
}

function spidRefire(context: EnemyContext, actor: Actor): void {
  faceTarget(context, actor);
  if (gameRandom(context.world.random) < 10) return;
  const target = targetOf(context, actor);
  if (!target || target.health <= 0 || !context.hooks.checkSight(actor, target)) {
    enterState(context, actor, element(actors, actor.type).seestate);
  }
}

function troopAttack(context: EnemyContext, actor: Actor): void {
  const target = targetOf(context, actor);
  if (!target) return;
  faceTarget(context, actor);
  if (checkMeleeRange(context, actor)) {
    sound(context, SfxId.sfx_claw, actor);
    context.hooks.damageActor(target, actor, actor, (gameRandom(context.world.random) % 8 + 1) * 3);
  } else context.hooks.spawnMissile(actor, target, ActorType.MT_TROOPSHOT);
}

function sargAttack(context: EnemyContext, actor: Actor): void {
  const target = targetOf(context, actor);
  if (!target) return;
  faceTarget(context, actor);
  if (checkMeleeRange(context, actor)) {
    context.hooks.damageActor(target, actor, actor, (gameRandom(context.world.random) % 10 + 1) * 4);
  }
}

function headAttack(context: EnemyContext, actor: Actor): void {
  const target = targetOf(context, actor);
  if (!target) return;
  faceTarget(context, actor);
  if (checkMeleeRange(context, actor)) {
    context.hooks.damageActor(target, actor, actor, (gameRandom(context.world.random) % 6 + 1) * 10);
  } else context.hooks.spawnMissile(actor, target, ActorType.MT_HEADSHOT);
}

function cyberAttack(context: EnemyContext, actor: Actor): void {
  const target = targetOf(context, actor);
  if (!target) return;
  faceTarget(context, actor);
  context.hooks.spawnMissile(actor, target, ActorType.MT_ROCKET);
}

function bruisAttack(context: EnemyContext, actor: Actor): void {
  const target = targetOf(context, actor);
  if (!target) return;
  // The preceding baron states face the target; A_BruisAttack itself does not.
  if (checkMeleeRange(context, actor)) {
    sound(context, SfxId.sfx_claw, actor);
    context.hooks.damageActor(target, actor, actor, (gameRandom(context.world.random) % 8 + 1) * 10);
  } else context.hooks.spawnMissile(actor, target, ActorType.MT_BRUISERSHOT);
}

function skullAttack(context: EnemyContext, actor: Actor): void {
  const target = targetOf(context, actor);
  if (!target) return;
  actor.flags |= MobjFlag.MF_SKULLFLY;
  sound(context, element(actors, actor.type).attacksound, actor);
  faceTarget(context, actor);
  const speed = 20 * FRAC_UNIT;
  actor.momx = fixedMul(speed, fineCos(actor.angle));
  actor.momy = fixedMul(speed, fineSin(actor.angle));
  const travelTics = Math.max(1, Math.trunc(approximateDistance((target.x - actor.x) | 0, (target.y - actor.y) | 0) / speed));
  actor.momz = Math.trunc(((target.z + (target.height >> 1) - actor.z) | 0) / travelTics) | 0;
}

function scream(context: EnemyContext, actor: Actor): void {
  let deathSound = element(actors, actor.type).deathsound;
  switch (deathSound) {
    case SfxId.sfx_None: return;
    case SfxId.sfx_podth1: case SfxId.sfx_podth2: case SfxId.sfx_podth3:
      deathSound = SfxId.sfx_podth1 + gameRandom(context.world.random) % 3;
      break;
    case SfxId.sfx_bgdth1: case SfxId.sfx_bgdth2:
      deathSound = SfxId.sfx_bgdth1 + gameRandom(context.world.random) % 2;
      break;
  }
  sound(context, deathSound, actor.type === ActorType.MT_SPIDER || actor.type === ActorType.MT_CYBORG ? null : actor);
}

function bossDeath(context: EnemyContext, actor: Actor): void {
  const world = context.world;
  switch (world.episode) {
    case 1: if (world.mapNumber !== 8 || actor.type !== ActorType.MT_BRUISER) return; break;
    case 2: if (world.mapNumber !== 8 || actor.type !== ActorType.MT_CYBORG) return; break;
    case 3: if (world.mapNumber !== 8 || actor.type !== ActorType.MT_SPIDER) return; break;
    case 4:
      if (world.mapNumber === 6) {
        if (actor.type !== ActorType.MT_CYBORG) return;
      } else if (world.mapNumber === 8) {
        if (actor.type !== ActorType.MT_SPIDER) return;
      } else return;
      break;
    default: if (world.mapNumber !== 8) return;
  }
  if (world.player.health <= 0) return;
  for (const other of world.actors) {
    if (other !== actor && world.activeActorIds.has(other.id) && !other.removed
      && other.type === actor.type && other.health > 0) return;
  }
  if (world.episode === 1 || world.episode === 4 && world.mapNumber === 8) {
    context.hooks.bossDeath({ kind: 'lowerFloorToLowest', tag: 666 });
  } else if (world.episode === 4 && world.mapNumber === 6) {
    context.hooks.bossDeath({ kind: 'blazeOpen', tag: 666 });
  } else context.hooks.bossDeath({ kind: 'exit' });
}

function bfgSpray(context: EnemyContext, actor: Actor): void {
  // Projectile ownership survives unlinking, like vanilla's originator pointer.
  const owner = actor.target === null ? undefined : context.world.actorsById.get(actor.target);
  if (!owner) throw new Error('BFG spray has no originator');
  for (let index = 0; index < 40; index++) {
    const angle = (actor.angle - ANG90 / 2 + Math.trunc(ANG90 / 40) * index) >>> 0;
    const { target } = context.hooks.aimLineAttack(owner, angle, 16 * 64 * FRAC_UNIT);
    if (!target) continue;
    spawnActor(context.world, ActorType.MT_EXTRABFG, target.x, target.y, (target.z + (target.height >> 2)) | 0);
    let damage = 0;
    for (let draw = 0; draw < 15; draw++) damage += (gameRandom(context.world.random) & 7) + 1;
    context.hooks.damageActor(target, owner, owner, damage);
  }
}

function runAction(context: EnemyContext, action: ActionId, actor: Actor): void {
  switch (action) {
    case ActionId.None: return;
    case ActionId.A_Look: look(context, actor); return;
    case ActionId.A_Chase: chase(context, actor); return;
    case ActionId.A_FaceTarget: faceTarget(context, actor); return;
    case ActionId.A_PosAttack: posAttack(context, actor); return;
    case ActionId.A_SPosAttack: sPosAttack(context, actor); return;
    case ActionId.A_SpidRefire: spidRefire(context, actor); return;
    case ActionId.A_TroopAttack: troopAttack(context, actor); return;
    case ActionId.A_SargAttack: sargAttack(context, actor); return;
    case ActionId.A_HeadAttack: headAttack(context, actor); return;
    case ActionId.A_CyberAttack: cyberAttack(context, actor); return;
    case ActionId.A_BruisAttack: bruisAttack(context, actor); return;
    case ActionId.A_SkullAttack: skullAttack(context, actor); return;
    case ActionId.A_Scream: scream(context, actor); return;
    case ActionId.A_XScream: sound(context, SfxId.sfx_slop, actor); return;
    case ActionId.A_PlayerScream: sound(context, SfxId.sfx_pldeth, actor); return;
    case ActionId.A_Pain: {
      const painSound = element(actors, actor.type).painsound;
      if (painSound !== SfxId.sfx_None) sound(context, painSound, actor);
      return;
    }
    case ActionId.A_Fall: actor.flags &= ~MobjFlag.MF_SOLID; return;
    case ActionId.A_Explode: {
      const owner = actor.target === null ? null : context.world.actorsById.get(actor.target) ?? null;
      context.hooks.radiusAttack(actor, owner, 128); return;
    }
    case ActionId.A_BFGSpray: bfgSpray(context, actor); return;
    case ActionId.A_BossDeath: bossDeath(context, actor); return;
    case ActionId.A_Hoof: sound(context, SfxId.sfx_hoof, actor); chase(context, actor); return;
    case ActionId.A_Metal: sound(context, SfxId.sfx_metal, actor); chase(context, actor); return;
    default: throw new Error(`Unsupported actor action ${ActionId[action]} in Doom I`);
  }
}

export function createEnemies(world: World, hooks: EnemyHooks, fastMonsters = false): EnemySystem {
  const context: EnemyContext = { world, hooks, fastMonsters,
    soundValidCount: world.sectors.reduce((stamp, sector) => Math.max(stamp, sector.soundValidCount), 0) };
  return {
    noiseAlert: (target, emitter) => noiseAlert(context, target, emitter),
    lookForPlayers: (actor, allAround) => lookForPlayers(context, actor, allAround),
    checkMeleeRange: actor => checkMeleeRange(context, actor),
    checkMissileRange: actor => checkMissileRange(context, actor),
    move: actor => move(context, actor),
    tryWalk: actor => tryWalk(context, actor),
    newChaseDir: actor => newChaseDir(context, actor),
    faceTarget: actor => faceTarget(context, actor),
    runAction: (action, actor) => runAction(context, action, actor),
  };
}
