// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native movement port of p_map.c and p_mobj.c. See ../../LICENSE.
import type { BBox } from '../wad/map';
import { setActorState, type Actor } from './actors';
import { ANG180, fineCos, fineSin, pointToAngle } from './angle';
import { ActorType, MobjFlag, SfxId, actors } from './data/actors';
import { StateId, type ActionId } from './data/states';
import { fixedMul, FRAC_BITS, FRAC_UNIT } from './fixed';
import { CheatFlag } from './player';
import { gameRandom } from './random';
import { boxOnLineSide, findSubsector, pointOnLineSide, traceLines, type FixedLine } from './spatial';
import { linkActorBlock, removeActor, unlinkActorBlock, type World } from './world';

export interface MovementHooks {
  readonly touchPickup: (thing: Actor, toucher: Actor) => void;
  readonly damageActor: (target: Actor, inflictor: Actor, source: Actor | null, damage: number) => void;
  readonly explodeMissile: (actor: Actor) => void;
  readonly crossSpecial: (line: number, side: 0 | 1, actor: Actor) => void;
  readonly runActorAction: (action: ActionId, actor: Actor) => void;
}

export interface MovementResult {
  readonly fits: boolean;
  readonly floatOk: boolean;
  readonly floorZ: number;
  readonly ceilingZ: number;
  readonly dropoffZ: number;
  readonly blockingLine: number | null;
  readonly ceilingLine: number | null;
  readonly specialLines: readonly number[];
}

export interface MovementInput {
  readonly forwardMove: number;
  readonly sideMove: number;
}

const MAX_RADIUS = 32 * FRAC_UNIT;
const MAX_MOVE = 30 * FRAC_UNIT;
const MAX_STEP = 24 * FRAC_UNIT;
const BLOCK_SHIFT = FRAC_BITS + 7;
const STOP_SPEED = 0x1000;
const FRICTION = 0xe800;

function element<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`Invalid movement reference ${index}`);
  return value;
}

function approximateDistance(dx: number, dy: number): number {
  dx = Math.abs(dx); dy = Math.abs(dy);
  return (dx + dy - (Math.min(dx, dy) >> 1)) | 0;
}

function opening(world: World, line: FixedLine) {
  const front = element(world.sectors, line.frontSector);
  const back = line.backSector === null ? null : element(world.sectors, line.backSector);
  if (back === null) return { top: 0, bottom: 0, lowFloor: 0, range: 0 };
  const top = Math.min(front.ceilingHeight, back.ceilingHeight);
  const bottom = Math.max(front.floorHeight, back.floorHeight);
  return { top, bottom, lowFloor: Math.min(front.floorHeight, back.floorHeight), range: (top - bottom) | 0 };
}

export function unlinkActor(world: World, actor: Actor): void {
  unlinkActorBlock(world, actor);
}

export function linkActor(world: World, actor: Actor): void {
  actor.subsector = findSubsector(world.spatial, actor.x, actor.y);
  actor.sector = element(world.spatial.map.subsectors, actor.subsector).sector;
  linkActorBlock(world, actor);
}

function checkThing(
  world: World, actor: Actor, thing: Actor, x: number, y: number,
  originalFlags: number, hooks: MovementHooks,
): boolean {
  if ((thing.flags & (MobjFlag.MF_SOLID | MobjFlag.MF_SPECIAL | MobjFlag.MF_SHOOTABLE)) === 0) return true;
  const distance = (thing.radius + actor.radius) | 0;
  if (Math.abs((thing.x - x) | 0) >= distance || Math.abs((thing.y - y) | 0) >= distance || thing === actor) return true;
  const info = element(actors, actor.type);
  if ((actor.flags & MobjFlag.MF_SKULLFLY) !== 0) {
    const damage = (gameRandom(world.random) % 8 + 1) * info.damage;
    hooks.damageActor(thing, actor, actor, damage);
    actor.flags &= ~MobjFlag.MF_SKULLFLY;
    actor.momx = actor.momy = actor.momz = 0;
    setActorState(actor, info.spawnstate, hooks.runActorAction);
    return false;
  }
  if ((actor.flags & MobjFlag.MF_MISSILE) !== 0) {
    if (actor.z > ((thing.z + thing.height) | 0) || ((actor.z + actor.height) | 0) < thing.z) return true;
    const source = actor.target === null ? null : world.actorsById.get(actor.target) ?? null;
    if (source && (source.type === thing.type ||
      (source.type === ActorType.MT_KNIGHT && thing.type === ActorType.MT_BRUISER) ||
      (source.type === ActorType.MT_BRUISER && thing.type === ActorType.MT_KNIGHT))) {
      if (thing === source) return true;
      if (thing.type !== ActorType.MT_PLAYER) return false;
    }
    if ((thing.flags & MobjFlag.MF_SHOOTABLE) === 0) return (thing.flags & MobjFlag.MF_SOLID) === 0;
    hooks.damageActor(thing, actor, source, (gameRandom(world.random) % 8 + 1) * info.damage);
    return false;
  }
  if ((thing.flags & MobjFlag.MF_SPECIAL) !== 0) {
    const solid = (thing.flags & MobjFlag.MF_SOLID) !== 0;
    if ((originalFlags & MobjFlag.MF_PICKUP) !== 0) hooks.touchPickup(thing, actor);
    return !solid;
  }
  return (thing.flags & MobjFlag.MF_SOLID) === 0;
}

export function checkPosition(world: World, actor: Actor, x: number, y: number, hooks: MovementHooks): MovementResult {
  const originalFlags = actor.flags;
  const box: BBox = {
    left: (x - actor.radius) | 0, right: (x + actor.radius) | 0,
    bottom: (y - actor.radius) | 0, top: (y + actor.radius) | 0,
  };
  const subsector = findSubsector(world.spatial, x, y);
  const sector = element(world.sectors, element(world.spatial.map.subsectors, subsector).sector);
  let floorZ = sector.floorHeight, ceilingZ = sector.ceilingHeight, dropoffZ = floorZ;
  let blockingLine: number | null = null, ceilingLine: number | null = null;
  const specialLines: number[] = [];
  const result = (fits: boolean): MovementResult => ({
    fits, floatOk: false, floorZ, ceilingZ, dropoffZ, blockingLine, ceilingLine, specialLines,
  });
  if ((originalFlags & MobjFlag.MF_NOCLIP) !== 0) return result(true);
  const spatial = world.spatial, { width, height, cells } = spatial.map.blockmap;
  const blockX = (coordinate: number) => ((coordinate - spatial.blockOriginX) | 0) >> BLOCK_SHIFT;
  const blockY = (coordinate: number) => ((coordinate - spatial.blockOriginY) | 0) >> BLOCK_SHIFT;
  const left = Math.max(0, blockX((box.left - MAX_RADIUS) | 0));
  const right = Math.min(width - 1, blockX((box.right + MAX_RADIUS) | 0));
  const bottom = Math.max(0, blockY((box.bottom - MAX_RADIUS) | 0));
  const top = Math.min(height - 1, blockY((box.top + MAX_RADIUS) | 0));
  for (let bx = left; bx <= right; bx++) {
    for (let by = bottom; by <= top; by++) {
      // Removing the current pickup does not invalidate its original successor.
      for (const id of [...element(world.actorBlocks, by * width + bx)]) {
        const thing = world.actorsById.get(id);
        if (thing && !thing.removed && !checkThing(world, actor, thing, x, y, originalFlags, hooks)) return result(false);
      }
    }
  }
  const visited = new Set<number>();
  const checkLine = (index: number): boolean => {
    if (visited.has(index)) return true;
    visited.add(index);
    const line = element(spatial.lines, index);
    if (box.right <= line.bbox.left || box.left >= line.bbox.right ||
      box.top <= line.bbox.bottom || box.bottom >= line.bbox.top || boxOnLineSide(box, line) !== -1) return true;
    const flags = world.lineFlags[index] ?? line.flags;
    if (line.backSector === null || ((actor.flags & MobjFlag.MF_MISSILE) === 0 &&
      ((flags & 1) !== 0 || (actor.player === null && (flags & 2) !== 0)))) {
      blockingLine = index;
      return false;
    }
    const gap = opening(world, line);
    if (gap.top < ceilingZ) { ceilingZ = gap.top; ceilingLine = index; }
    if (gap.bottom > floorZ) floorZ = gap.bottom;
    if (gap.lowFloor < dropoffZ) dropoffZ = gap.lowFloor;
    if ((world.lineSpecials[index] ?? line.special) !== 0) specialLines.push(index);
    return true;
  };
  for (let bx = Math.max(0, blockX(box.left)); bx <= Math.min(width - 1, blockX(box.right)); bx++) {
    for (let by = Math.max(0, blockY(box.bottom)); by <= Math.min(height - 1, blockY(box.top)); by++) {
      // Original P_BlockLinesIterator visits the BLOCKMAP dummy zero as line 0.
      if (spatial.lines.length !== 0 && !checkLine(0)) return result(false);
      for (const index of element(cells, by * width + bx)) if (!checkLine(index)) return result(false);
    }
  }
  return result(true);
}

export function tryMove(world: World, actor: Actor, x: number, y: number, hooks: MovementHooks): MovementResult {
  let result = checkPosition(world, actor, x, y, hooks);
  if (!result.fits) return result;
  if ((actor.flags & MobjFlag.MF_NOCLIP) === 0) {
    if (((result.ceilingZ - result.floorZ) | 0) < actor.height) return { ...result, fits: false };
    result = { ...result, floatOk: true };
    if (((actor.flags & MobjFlag.MF_TELEPORT) === 0 &&
      (((result.ceilingZ - actor.z) | 0) < actor.height || ((result.floorZ - actor.z) | 0) > MAX_STEP)) ||
      ((actor.flags & (MobjFlag.MF_DROPOFF | MobjFlag.MF_FLOAT)) === 0 &&
      ((result.floorZ - result.dropoffZ) | 0) > MAX_STEP)) return { ...result, fits: false };
  }
  const oldX = actor.x, oldY = actor.y;
  unlinkActor(world, actor);
  actor.x = x; actor.y = y;
  actor.floorZ = result.floorZ; actor.ceilingZ = result.ceilingZ;
  linkActor(world, actor);
  if ((actor.flags & (MobjFlag.MF_TELEPORT | MobjFlag.MF_NOCLIP)) === 0) {
    for (let i = result.specialLines.length - 1; i >= 0; i--) {
      const index = element(result.specialLines, i), line = element(world.spatial.lines, index);
      const oldSide = pointOnLineSide(oldX, oldY, line);
      if (pointOnLineSide(actor.x, actor.y, line) !== oldSide && (world.lineSpecials[index] ?? line.special) !== 0) {
        hooks.crossSpecial(index, oldSide, actor);
      }
    }
  }
  return result;
}

function slideAlongLine(actor: Actor, line: FixedLine, x: number, y: number): readonly [number, number] {
  if (line.dy === 0) return [x, 0];
  if (line.dx === 0) return [0, y];
  let lineAngle = pointToAngle(0, 0, line.dx, line.dy);
  if (pointOnLineSide(actor.x, actor.y, line) === 1) lineAngle = (lineAngle + ANG180) >>> 0;
  let delta = (pointToAngle(0, 0, x, y) - lineAngle) >>> 0;
  if (delta > ANG180) delta = (delta + ANG180) >>> 0;
  const length = fixedMul(approximateDistance(x, y), fineCos(delta));
  return [fixedMul(length, fineCos(lineAngle)), fixedMul(length, fineSin(lineAngle))];
}

export function slideMove(world: World, actor: Actor, hooks: MovementHooks): void {
  const stairStep = (): void => {
    if (!tryMove(world, actor, actor.x, (actor.y + actor.momy) | 0, hooks).fits) {
      tryMove(world, actor, (actor.x + actor.momx) | 0, actor.y, hooks);
    }
  };
  for (let hitCount = 1; hitCount < 3; hitCount++) {
    const leadX = (actor.x + (actor.momx > 0 ? actor.radius : -actor.radius)) | 0;
    const trailX = (actor.x + (actor.momx > 0 ? -actor.radius : actor.radius)) | 0;
    const leadY = (actor.y + (actor.momy > 0 ? actor.radius : -actor.radius)) | 0;
    const trailY = (actor.y + (actor.momy > 0 ? -actor.radius : actor.radius)) | 0;
    let bestFraction = FRAC_UNIT + 1, bestLine: FixedLine | null = null;
    const starts = [[leadX, leadY], [trailX, leadY], [leadX, trailY]] as const;
    for (const [x, y] of starts) {
      for (const intercept of traceLines(world.spatial, x, y, (x + actor.momx) | 0, (y + actor.momy) | 0)) {
        const line = element(world.spatial.lines, intercept.line);
        const flags = world.lineFlags[intercept.line] ?? line.flags;
        if ((flags & 4) === 0) {
          if (pointOnLineSide(actor.x, actor.y, line) === 1) continue;
        } else {
          const gap = opening(world, line);
          if (gap.range >= actor.height && ((gap.top - actor.z) | 0) >= actor.height &&
            ((gap.bottom - actor.z) | 0) <= MAX_STEP) continue;
        }
        if (intercept.fraction < bestFraction) { bestFraction = intercept.fraction; bestLine = line; }
        break;
      }
    }
    if (bestLine === null) { stairStep(); return; }
    const advance = (bestFraction - 0x800) | 0;
    if (advance > 0 && !tryMove(world, actor,
      (actor.x + fixedMul(actor.momx, advance)) | 0,
      (actor.y + fixedMul(actor.momy, advance)) | 0, hooks).fits) { stairStep(); return; }
    const remaining = Math.min(FRAC_UNIT, (FRAC_UNIT - bestFraction) | 0);
    if (remaining <= 0) return;
    [actor.momx, actor.momy] = slideAlongLine(actor, bestLine,
      fixedMul(actor.momx, remaining), fixedMul(actor.momy, remaining));
    if (tryMove(world, actor, (actor.x + actor.momx) | 0, (actor.y + actor.momy) | 0, hooks).fits) return;
  }
  stairStep();
}

export function moveXY(
  world: World, actor: Actor, hooks: MovementHooks,
  input: MovementInput = { forwardMove: 0, sideMove: 0 },
): void {
  if (actor.momx === 0 && actor.momy === 0) {
    if ((actor.flags & MobjFlag.MF_SKULLFLY) !== 0) {
      actor.flags &= ~MobjFlag.MF_SKULLFLY;
      actor.momx = actor.momy = actor.momz = 0;
      setActorState(actor, element(actors, actor.type).spawnstate, hooks.runActorAction);
    }
    return;
  }
  actor.momx = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, actor.momx));
  actor.momy = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, actor.momy));
  let xMove = actor.momx, yMove = actor.momy;
  do {
    let x: number, y: number;
    // Vanilla only splits positive moves; signed division truncates toward zero.
    if (xMove > MAX_MOVE / 2 || yMove > MAX_MOVE / 2) {
      x = (actor.x + Math.trunc(xMove / 2)) | 0;
      y = (actor.y + Math.trunc(yMove / 2)) | 0;
      xMove >>= 1; yMove >>= 1;
    } else {
      x = (actor.x + xMove) | 0; y = (actor.y + yMove) | 0;
      xMove = yMove = 0;
    }
    const result = tryMove(world, actor, x, y, hooks);
    if (!result.fits) {
      if (actor.player !== null) slideMove(world, actor, hooks);
      else if ((actor.flags & MobjFlag.MF_MISSILE) !== 0) {
        const ceiling = result.ceilingLine === null ? null : element(world.spatial.lines, result.ceilingLine);
        if (ceiling?.backSector !== null && ceiling?.backSector !== undefined &&
          element(world.sectors, ceiling.backSector).ceilingTexture === 'F_SKY1') {
          removeActor(world, actor);
          return;
        }
        hooks.explodeMissile(actor);
      } else actor.momx = actor.momy = 0;
    }
  } while (xMove !== 0 || yMove !== 0);
  if (actor.player !== null && (world.player.cheats & CheatFlag.CF_NOMOMENTUM) !== 0) {
    actor.momx = actor.momy = 0;
    return;
  }
  if ((actor.flags & (MobjFlag.MF_MISSILE | MobjFlag.MF_SKULLFLY)) !== 0 || actor.z > actor.floorZ) return;
  if ((actor.flags & MobjFlag.MF_CORPSE) !== 0 &&
    (Math.abs(actor.momx) > FRAC_UNIT / 4 || Math.abs(actor.momy) > FRAC_UNIT / 4) &&
    actor.floorZ !== element(world.sectors, actor.sector).floorHeight) return;
  if (actor.momx > -STOP_SPEED && actor.momx < STOP_SPEED && actor.momy > -STOP_SPEED && actor.momy < STOP_SPEED &&
    (actor.player === null || (input.forwardMove === 0 && input.sideMove === 0))) {
    if (actor.player !== null && ((actor.state - StateId.S_PLAY_RUN1) >>> 0) < 4) {
      setActorState(actor, StateId.S_PLAY, hooks.runActorAction);
    }
    actor.momx = actor.momy = 0;
  } else {
    actor.momx = fixedMul(actor.momx, FRICTION);
    actor.momy = fixedMul(actor.momy, FRICTION);
  }
}

export function moveZ(world: World, actor: Actor, hooks: MovementHooks): void {
  if (actor.player !== null && actor.z < actor.floorZ) {
    world.player.viewHeight = (world.player.viewHeight - ((actor.floorZ - actor.z) | 0)) | 0;
    world.player.deltaViewHeight = ((41 * FRAC_UNIT - world.player.viewHeight) | 0) >> 3;
  }
  actor.z = (actor.z + actor.momz) | 0;
  const target = actor.target === null ? null : world.actorsById.get(actor.target);
  if ((actor.flags & MobjFlag.MF_FLOAT) !== 0 && target &&
    (actor.flags & (MobjFlag.MF_SKULLFLY | MobjFlag.MF_INFLOAT)) === 0) {
    const distance = approximateDistance((actor.x - target.x) | 0, (actor.y - target.y) | 0);
    const delta = (target.z + (actor.height >> 1) - actor.z) | 0;
    if (delta < 0 && distance < -Math.imul(delta, 3)) actor.z = (actor.z - 4 * FRAC_UNIT) | 0;
    else if (delta > 0 && distance < Math.imul(delta, 3)) actor.z = (actor.z + 4 * FRAC_UNIT) | 0;
  }
  if (actor.z <= actor.floorZ) {
    if ((actor.flags & MobjFlag.MF_SKULLFLY) !== 0) actor.momz = -actor.momz | 0;
    if (actor.momz < 0) {
      if (actor.player !== null && actor.momz < -8 * FRAC_UNIT) {
        world.player.deltaViewHeight = actor.momz >> 3;
        world.events.push({ type: 'sound', sound: SfxId.sfx_oof, actor: actor.id });
      }
      actor.momz = 0;
    }
    actor.z = actor.floorZ;
    if ((actor.flags & MobjFlag.MF_MISSILE) !== 0 && (actor.flags & MobjFlag.MF_NOCLIP) === 0) {
      hooks.explodeMissile(actor);
      return;
    }
  } else if ((actor.flags & MobjFlag.MF_NOGRAVITY) === 0) {
    actor.momz = actor.momz === 0 ? -2 * FRAC_UNIT : (actor.momz - FRAC_UNIT) | 0;
  }
  if (((actor.z + actor.height) | 0) > actor.ceilingZ) {
    if (actor.momz > 0) actor.momz = 0;
    actor.z = (actor.ceilingZ - actor.height) | 0;
    // This ordering intentionally retains vanilla's lost-soul ceiling bug.
    if ((actor.flags & MobjFlag.MF_SKULLFLY) !== 0) actor.momz = -actor.momz | 0;
    if ((actor.flags & MobjFlag.MF_MISSILE) !== 0 && (actor.flags & MobjFlag.MF_NOCLIP) === 0) hooks.explodeMissile(actor);
  }
}
