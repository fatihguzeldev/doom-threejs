// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native attacks and effects from p_map.c and p_mobj.c. See ../../LICENSE.
import { setActorState, type Actor } from './actors';
import { fineCos, fineSin, pointToAngle } from './angle';
import { ActorType, MobjFlag, SfxId, actors } from './data/actors';
import { StateId, type ActionId } from './data/states';
import { fixedDiv, fixedMul, FRAC_BITS, FRAC_UNIT } from './fixed';
import { tryMove, type MovementHooks } from './movement';
import { gameRandom } from './random';
import { makeTrace, pointOnLineSide, type FixedLine } from './spatial';
import { checkSight, tracePath } from './trace';
import { linkActorBlock, removeActor, spawnActor, unlinkActorBlock, type World } from './world';

export interface AimResult {
  readonly slope: number;
  readonly target: Actor | null;
}

export interface ShootingHooks {
  readonly damageActor: (target: Actor, inflictor: Actor | null, source: Actor | null, damage: number) => void;
  readonly runActorAction: (action: ActionId, actor: Actor) => void;
  readonly shootSpecial: (line: number, actor: Actor) => void;
  readonly useSpecial: (line: number, side: 0 | 1, actor: Actor) => void;
}

const MELEE_RANGE = 64 * FRAC_UNIT;
const AUTO_AIM_RANGE = 16 * 64 * FRAC_UNIT;
const MAX_RADIUS = 32 * FRAC_UNIT;
const BLOCK_SHIFT = FRAC_BITS + 7;

function element<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`Invalid shooting reference ${index}`);
  return value;
}

function lineOpening(world: World, line: FixedLine) {
  const front = element(world.sectors, line.frontSector);
  const back = line.backSector === null ? null : element(world.sectors, line.backSector);
  const top = back === null ? 0 : Math.min(front.ceilingHeight, back.ceilingHeight);
  const bottom = back === null ? 0 : Math.max(front.floorHeight, back.floorHeight);
  return { front, back, top, bottom, range: (top - bottom) | 0 };
}

function attackEnd(source: Actor, angle: number, distance: number): readonly [number, number] {
  // P_AimLineAttack/P_LineAttack truncate distance before multiplying the table.
  return [(source.x + Math.imul(distance >> FRAC_BITS, fineCos(angle))) | 0,
    (source.y + Math.imul(distance >> FRAC_BITS, fineSin(angle))) | 0];
}

export function aimLineAttack(world: World, source: Actor, angle: number, distance: number): AimResult {
  const [x2, y2] = attackEnd(source, angle, distance);
  const shootZ = (source.z + (source.height >> 1) + 8 * FRAC_UNIT) | 0;
  let topSlope = 100 * FRAC_UNIT / 160, bottomSlope = -topSlope;
  for (const intercept of tracePath(world, source.x, source.y, x2, y2)) {
    const range = fixedMul(distance, intercept.fraction);
    if (intercept.kind === 'line') {
      const line = element(world.spatial.lines, intercept.line), gap = lineOpening(world, line);
      if (((world.lineFlags[intercept.line] ?? line.flags) & 4) === 0 || gap.back === null || gap.bottom >= gap.top) break;
      if (gap.front.floorHeight !== gap.back.floorHeight) {
        bottomSlope = Math.max(bottomSlope, fixedDiv((gap.bottom - shootZ) | 0, range));
      }
      if (gap.front.ceilingHeight !== gap.back.ceilingHeight) {
        topSlope = Math.min(topSlope, fixedDiv((gap.top - shootZ) | 0, range));
      }
      if (topSlope <= bottomSlope) break;
      continue;
    }
    const target = intercept.actor;
    if (target === source || (target.flags & MobjFlag.MF_SHOOTABLE) === 0) continue;
    const targetTop = fixedDiv((target.z + target.height - shootZ) | 0, range);
    const targetBottom = fixedDiv((target.z - shootZ) | 0, range);
    if (targetTop < bottomSlope || targetBottom > topSlope) continue;
    const slope = Math.trunc(((Math.min(targetTop, topSlope) + Math.max(targetBottom, bottomSlope)) | 0) / 2);
    return { slope, target };
  }
  return { slope: 0, target: null };
}

export function spawnPuff(
  world: World, x: number, y: number, z: number, attackRange: number, hooks: ShootingHooks,
): Actor {
  z = (z + ((gameRandom(world.random) - gameRandom(world.random)) << 10)) | 0;
  const puff = spawnActor(world, ActorType.MT_PUFF, x, y, z);
  puff.momz = FRAC_UNIT;
  puff.tics = Math.max(1, puff.tics - (gameRandom(world.random) & 3));
  if (attackRange === MELEE_RANGE) setActorState(puff, StateId.S_PUFF3, hooks.runActorAction);
  return puff;
}

export function spawnBlood(world: World, x: number, y: number, z: number, damage: number, hooks: ShootingHooks): Actor {
  z = (z + ((gameRandom(world.random) - gameRandom(world.random)) << 10)) | 0;
  const blood = spawnActor(world, ActorType.MT_BLOOD, x, y, z);
  blood.momz = 2 * FRAC_UNIT;
  blood.tics = Math.max(1, blood.tics - (gameRandom(world.random) & 3));
  if (damage <= 12 && damage >= 9) setActorState(blood, StateId.S_BLOOD2, hooks.runActorAction);
  else if (damage < 9) setActorState(blood, StateId.S_BLOOD3, hooks.runActorAction);
  return blood;
}

export function lineAttack(
  world: World, source: Actor, angle: number, distance: number, aimSlope: number, damage: number, hooks: ShootingHooks,
): Actor | null {
  const [x2, y2] = attackEnd(source, angle, distance);
  const trace = makeTrace(world.spatial, source.x, source.y, x2, y2);
  const shootZ = (source.z + (source.height >> 1) + 8 * FRAC_UNIT) | 0;
  const impact = (fraction: number): readonly [number, number, number] => [
    (trace.x + fixedMul(trace.dx, fraction)) | 0,
    (trace.y + fixedMul(trace.dy, fraction)) | 0,
    (shootZ + fixedMul(aimSlope, fixedMul(fraction, distance))) | 0,
  ];
  for (const intercept of tracePath(world, source.x, source.y, x2, y2)) {
    const range = fixedMul(distance, intercept.fraction);
    if (intercept.kind === 'line') {
      const index = intercept.line, line = element(world.spatial.lines, index);
      if ((world.lineSpecials[index] ?? line.special) !== 0) hooks.shootSpecial(index, source);
      const gap = lineOpening(world, line);
      let hit = ((world.lineFlags[index] ?? line.flags) & 4) === 0 || gap.back === null;
      if (gap.back !== null) {
        if (gap.front.floorHeight !== gap.back.floorHeight && fixedDiv((gap.bottom - shootZ) | 0, range) > aimSlope) hit = true;
        if (gap.front.ceilingHeight !== gap.back.ceilingHeight && fixedDiv((gap.top - shootZ) | 0, range) < aimSlope) hit = true;
      }
      if (!hit) continue;
      const [x, y, z] = impact((intercept.fraction - fixedDiv(4 * FRAC_UNIT, distance)) | 0);
      if (gap.front.ceilingTexture === 'F_SKY1' &&
        (z > gap.front.ceilingHeight || gap.back?.ceilingTexture === 'F_SKY1')) return null;
      spawnPuff(world, x, y, z, distance, hooks);
      return null;
    }
    const target = intercept.actor;
    if (target === source || (target.flags & MobjFlag.MF_SHOOTABLE) === 0) continue;
    if (fixedDiv((target.z + target.height - shootZ) | 0, range) < aimSlope ||
      fixedDiv((target.z - shootZ) | 0, range) > aimSlope) continue;
    const [x, y, z] = impact((intercept.fraction - fixedDiv(10 * FRAC_UNIT, distance)) | 0);
    if ((target.flags & MobjFlag.MF_NOBLOOD) !== 0) spawnPuff(world, x, y, z, distance, hooks);
    else spawnBlood(world, x, y, z, damage, hooks);
    if (damage !== 0) hooks.damageActor(target, source, source, damage);
    return target;
  }
  return null;
}

export function explodeMissile(world: World, actor: Actor, hooks: ShootingHooks): void {
  actor.momx = actor.momy = actor.momz = 0;
  const info = element(actors, actor.type);
  setActorState(actor, info.deathstate, hooks.runActorAction);
  if (actor.removed) removeActor(world, actor);
  // The original consumes this random byte even after S_NULL removed the actor.
  actor.tics = Math.max(1, actor.tics - (gameRandom(world.random) & 3));
  actor.flags &= ~MobjFlag.MF_MISSILE;
  if (info.deathsound !== SfxId.sfx_None) world.events.push({ type: 'sound', sound: info.deathsound, actor: actor.id });
}

function checkMissileSpawn(world: World, actor: Actor, hooks: ShootingHooks): void {
  actor.tics = Math.max(1, actor.tics - (gameRandom(world.random) & 3));
  // Keep the ID block cache coherent around C's direct advance. Vanilla missile
  // types have NOBLOCKMAP, so these links normally perform no operation.
  unlinkActorBlock(world, actor);
  actor.x = (actor.x + (actor.momx >> 1)) | 0;
  actor.y = (actor.y + (actor.momy >> 1)) | 0;
  actor.z = (actor.z + (actor.momz >> 1)) | 0;
  linkActorBlock(world, actor);
  const movement: MovementHooks = {
    damageActor: hooks.damageActor, runActorAction: hooks.runActorAction,
    explodeMissile: missile => explodeMissile(world, missile, hooks),
    // Spawned missiles do not carry PICKUP. P_CheckMissileSpawn preadvances to
    // the same XY passed to TryMove, so its special-line side never changes.
    touchPickup: () => {}, crossSpecial: () => {},
  };
  if (!tryMove(world, actor, actor.x, actor.y, movement).fits) explodeMissile(world, actor, hooks);
}

export function spawnMissile(world: World, source: Actor, destination: Actor, type: ActorType, hooks: ShootingHooks): Actor {
  const missile = spawnActor(world, type, source.x, source.y, (source.z + 32 * FRAC_UNIT) | 0);
  const info = element(actors, type);
  if (info.seesound !== SfxId.sfx_None) world.events.push({ type: 'sound', sound: info.seesound, actor: missile.id });
  missile.target = source.id;
  let angle = pointToAngle(source.x, source.y, destination.x, destination.y);
  if ((destination.flags & MobjFlag.MF_SHADOW) !== 0) angle = (angle + ((gameRandom(world.random) - gameRandom(world.random)) << 20)) >>> 0;
  missile.angle = angle;
  missile.momx = fixedMul(info.speed, fineCos(angle));
  missile.momy = fixedMul(info.speed, fineSin(angle));
  const dx = Math.abs((destination.x - source.x) | 0), dy = Math.abs((destination.y - source.y) | 0);
  const distance = (dx + dy - (Math.min(dx, dy) >> 1)) | 0;
  const travelTics = Math.max(1, Math.trunc(distance / info.speed));
  missile.momz = Math.trunc(((destination.z - source.z) | 0) / travelTics) | 0;
  checkMissileSpawn(world, missile, hooks);
  return missile;
}

export function spawnPlayerMissile(world: World, source: Actor, type: ActorType, hooks: ShootingHooks): Actor {
  let angle = source.angle, aim = aimLineAttack(world, source, angle, AUTO_AIM_RANGE);
  if (aim.target === null) {
    angle = (angle + (1 << 26)) >>> 0;
    aim = aimLineAttack(world, source, angle, AUTO_AIM_RANGE);
    if (aim.target === null) {
      angle = (angle - (2 << 26)) >>> 0;
      aim = aimLineAttack(world, source, angle, AUTO_AIM_RANGE);
    }
    if (aim.target === null) { angle = source.angle; aim = { slope: 0, target: null }; }
  }
  const missile = spawnActor(world, type, source.x, source.y, (source.z + 32 * FRAC_UNIT) | 0);
  const info = element(actors, type);
  if (info.seesound !== SfxId.sfx_None) world.events.push({ type: 'sound', sound: info.seesound, actor: missile.id });
  missile.target = source.id; missile.angle = angle;
  missile.momx = fixedMul(info.speed, fineCos(angle));
  missile.momy = fixedMul(info.speed, fineSin(angle));
  missile.momz = fixedMul(info.speed, aim.slope);
  checkMissileSpawn(world, missile, hooks);
  return missile;
}

export function radiusAttack(world: World, spot: Actor, source: Actor | null, damage: number, hooks: ShootingHooks): void {
  // Preserve p_map.c's 32-bit expression: MAXRADIUS is already fixed-point and
  // its contribution wraps out when the sum is shifted by FRACBITS again.
  const extent = (damage + MAX_RADIUS) << FRAC_BITS;
  const spatial = world.spatial, { width, height } = spatial.map.blockmap;
  const left = Math.max(0, ((spot.x - extent - spatial.blockOriginX) | 0) >> BLOCK_SHIFT);
  const right = Math.min(width - 1, ((spot.x + extent - spatial.blockOriginX) | 0) >> BLOCK_SHIFT);
  const bottom = Math.max(0, ((spot.y - extent - spatial.blockOriginY) | 0) >> BLOCK_SHIFT);
  const top = Math.min(height - 1, ((spot.y + extent - spatial.blockOriginY) | 0) >> BLOCK_SHIFT);
  // Radius damage traverses rows first; collision movement traverses columns.
  for (let y = bottom; y <= top; y++) {
    for (let x = left; x <= right; x++) {
      for (const id of [...element(world.actorBlocks, y * width + x)]) {
        const target = world.actorsById.get(id);
        if (!target || target.removed || (target.flags & MobjFlag.MF_SHOOTABLE) === 0 ||
          target.type === ActorType.MT_CYBORG || target.type === ActorType.MT_SPIDER) continue;
        const dx = Math.abs((target.x - spot.x) | 0), dy = Math.abs((target.y - spot.y) | 0);
        const distance = Math.max(0, ((Math.max(dx, dy) - target.radius) | 0) >> FRAC_BITS);
        if (distance < damage && checkSight(world, target, spot)) hooks.damageActor(target, spot, source, damage - distance);
      }
    }
  }
}

export function useLines(world: World, actor: Actor, hooks: ShootingHooks): void {
  const [x2, y2] = attackEnd(actor, actor.angle, MELEE_RANGE);
  for (const hit of tracePath(world, actor.x, actor.y, x2, y2, { actors: false })) {
    if (hit.kind !== 'line') continue;
    const line = element(world.spatial.lines, hit.line);
    if ((world.lineSpecials[hit.line] ?? line.special) === 0) {
      if (lineOpening(world, line).range <= 0) {
        world.events.push({ type: 'sound', sound: SfxId.sfx_noway, actor: actor.id });
        return;
      }
      continue;
    }
    hooks.useSpecial(hit.line, pointOnLineSide(actor.x, actor.y, line), actor);
    return;
  }
}
