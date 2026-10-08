// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// P_MobjThinker and P_NightmareRespawn from p_mobj.c. See ../../LICENSE.
import { tickActorState, type Actor } from './actors';
import { ANG45 } from './angle';
import { ActorType, MobjFlag, SfxId, actors } from './data/actors';
import { checkPosition, moveXY, moveZ, type MovementHooks } from './movement';
import { gameRandom } from './random';
import { findSubsector } from './spatial';
import { removeActor, spawnActor, type World } from './world';

function nightmareRespawn(world: World, corpse: Actor, hooks: MovementHooks): void {
  const point = corpse.spawnpoint ?? { x: 0, y: 0, angle: 0, type: 0, flags: 0 };
  const x = point.x << 16, y = point.y << 16;
  if (!checkPosition(world, corpse, x, y, hooks).fits) return;
  const oldSector = world.sectors[corpse.sector];
  const subsector = findSubsector(world.spatial, x, y);
  const sectorIndex = world.spatial.map.subsectors[subsector]?.sector;
  const sector = sectorIndex === undefined ? undefined : world.sectors[sectorIndex];
  if (!oldSector || !sector) throw new Error('Respawning monster has an invalid sector');
  const oldFog = spawnActor(world, ActorType.MT_TFOG, corpse.x, corpse.y, oldSector.floorHeight);
  world.events.push({ type: 'sound', sound: SfxId.sfx_telept, actor: oldFog.id });
  const newFog = spawnActor(world, ActorType.MT_TFOG, x, y, sector.floorHeight);
  world.events.push({ type: 'sound', sound: SfxId.sfx_telept, actor: newFog.id });
  const info = actors[corpse.type];
  if (!info) throw new Error('Respawning monster has an invalid type');
  const replacement = spawnActor(world, corpse.type, x, y,
    (info.flags & MobjFlag.MF_SPAWNCEILING) !== 0 ? 'ceiling' : 'floor');
  replacement.spawnpoint = point;
  replacement.angle = (ANG45 * Math.trunc(point.angle / 45)) >>> 0;
  if ((point.flags & 8) !== 0) replacement.flags |= MobjFlag.MF_AMBUSH;
  replacement.reactionTime = 18;
  removeActor(world, corpse);
}

export function thinkActor(
  world: World, actor: Actor, hooks: MovementHooks,
  forwardMove = 0, sideMove = 0,
): void {
  if (actor.removed) return;
  if (actor.momx !== 0 || actor.momy !== 0 || (actor.flags & MobjFlag.MF_SKULLFLY) !== 0) {
    moveXY(world, actor, hooks, { forwardMove, sideMove });
    if (actor.removed) return;
  }
  if (actor.z !== actor.floorZ || actor.momz !== 0) {
    moveZ(world, actor, hooks);
    if (actor.removed) return;
  }
  if (actor.tics !== -1) {
    tickActorState(actor, hooks.runActorAction);
    if (actor.removed) removeActor(world, actor);
    return;
  }
  if (!world.respawnMonsters || (actor.flags & MobjFlag.MF_COUNTKILL) === 0) return;
  actor.moveCount++;
  if (actor.moveCount < 12 * 35 || (world.levelTime & 31) !== 0 || gameRandom(world.random) > 4) return;
  nightmareRespawn(world, actor, hooks);
}
