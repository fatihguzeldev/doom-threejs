// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native sector height clipping and T_MovePlane. See ../../../LICENSE.
import { setActorState, type Actor } from '../actors';
import { ActorType, MobjFlag } from '../data/actors';
import { StateId } from '../data/states';
import { FRAC_UNIT } from '../fixed';
import { checkPosition, type MovementHooks } from '../movement';
import { gameRandom } from '../random';
import { removeActor, spawnActor, type World } from '../world';

export interface PlaneHooks {
  readonly movement: MovementHooks;
  readonly damageActor: (target: Actor, inflictor: Actor | null, source: Actor | null, damage: number) => void;
}

export type PlaneResult = 'ok' | 'crushed' | 'pastDestination';

function clipHeight(world: World, actor: Actor, hooks: PlaneHooks): boolean {
  const onFloor = actor.z === actor.floorZ;
  const result = checkPosition(world, actor, actor.x, actor.y, hooks.movement);
  actor.floorZ = result.floorZ;
  actor.ceilingZ = result.ceilingZ;
  if (onFloor) actor.z = actor.floorZ;
  else if (((actor.z + actor.height) | 0) > actor.ceilingZ) actor.z = (actor.ceilingZ - actor.height) | 0;
  return ((actor.ceilingZ - actor.floorZ) | 0) >= actor.height;
}

export function changeSector(world: World, index: number, crush: boolean, hooks: PlaneHooks): boolean {
  const sector = world.sectors[index];
  if (!sector) throw new Error('Invalid moving sector');
  const box = sector.blockBounds, width = world.spatial.map.blockmap.width;
  let noFit = false;
  for (let x = box.left; x <= box.right; x++) {
    for (let y = box.bottom; y <= box.top; y++) {
      const list = world.actorBlocks[y * width + x];
      if (!list) continue;
      for (const id of [...list]) {
        const actor = world.actorsById.get(id);
        if (!actor || actor.removed || clipHeight(world, actor, hooks)) continue;
        if (actor.health <= 0) {
          setActorState(actor, StateId.S_GIBS, hooks.movement.runActorAction);
          if (actor.removed) removeActor(world, actor);
          actor.flags &= ~MobjFlag.MF_SOLID;
          actor.height = actor.radius = 0;
          continue;
        }
        if ((actor.flags & MobjFlag.MF_DROPPED) !== 0) { removeActor(world, actor); continue; }
        if ((actor.flags & MobjFlag.MF_SHOOTABLE) === 0) continue;
        noFit = true;
        if (crush && (world.levelTime & 3) === 0) {
          hooks.damageActor(actor, null, null, 10);
          const blood = spawnActor(world, ActorType.MT_BLOOD, actor.x, actor.y, (actor.z + Math.trunc(actor.height / 2)) | 0);
          blood.momx = (gameRandom(world.random) - gameRandom(world.random)) << 12;
          blood.momy = (gameRandom(world.random) - gameRandom(world.random)) << 12;
        }
      }
    }
  }
  return noFit;
}

export function movePlane(
  world: World, index: number, speed: number, destination: number,
  crush: boolean, plane: 'floor' | 'ceiling', direction: -1 | 1, hooks: PlaneHooks,
): PlaneResult {
  const sector = world.sectors[index];
  if (!sector) throw new Error('Invalid moving sector');
  const field = plane === 'floor' ? 'floorHeight' : 'ceilingHeight';
  const previous = sector[field];
  const next = (previous + direction * speed) | 0;
  const past = direction === -1 ? next < destination : next > destination;
  sector[field] = past ? destination : next;
  const blocked = changeSector(world, index, crush, hooks);
  const floorDown = plane === 'floor' && direction === -1;
  const ceilingUp = plane === 'ceiling' && direction === 1;
  if (blocked && (past || floorDown || (!ceilingUp && !crush))) {
    sector[field] = previous;
    changeSector(world, index, crush, hooks);
  }
  if (past) return 'pastDestination';
  return blocked && !ceilingUp ? 'crushed' : 'ok';
}

export function otherSector(world: World, lineIndex: number, sector: number): number | null {
  const line = world.spatial.lines[lineIndex];
  if (!line || ((world.lineFlags[lineIndex] ?? line.flags) & 4) === 0 || line.backSector === null) return null;
  return line.frontSector === sector ? line.backSector : line.frontSector;
}

export function* neighbors(world: World, index: number): Generator<number> {
  const sector = world.sectors[index];
  if (!sector) throw new Error('Invalid sector neighbor query');
  for (const line of sector.lines) {
    const other = otherSector(world, line, index);
    if (other !== null) yield other;
  }
}

export function lowestCeiling(world: World, index: number): number {
  let height = 0x7fffffff;
  for (const neighbor of neighbors(world, index)) height = Math.min(height, world.sectors[neighbor]?.ceilingHeight ?? height);
  return height;
}

export function lowestFloor(world: World, index: number): number {
  let height = world.sectors[index]?.floorHeight ?? 0;
  for (const neighbor of neighbors(world, index)) height = Math.min(height, world.sectors[neighbor]?.floorHeight ?? height);
  return height;
}

export function highestFloor(world: World, index: number): number {
  let height = -500 * FRAC_UNIT;
  for (const neighbor of neighbors(world, index)) height = Math.max(height, world.sectors[neighbor]?.floorHeight ?? height);
  return height;
}

export function highestCeiling(world: World, index: number): number {
  let height = 0;
  for (const neighbor of neighbors(world, index)) height = Math.max(height, world.sectors[neighbor]?.ceilingHeight ?? height);
  return height;
}

export function nextHighestFloor(world: World, index: number, current: number): number {
  let height: number | null = null;
  let found = 0;
  for (const neighbor of neighbors(world, index)) {
    const candidate = world.sectors[neighbor]?.floorHeight;
    if (candidate !== undefined && candidate > current) {
      if (height === null || candidate < height) height = candidate;
      if (++found === 20) break;
    }
  }
  return height ?? current;
}
