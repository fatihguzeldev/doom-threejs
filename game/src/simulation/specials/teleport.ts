// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native teleport move and EV_Teleport. See ../../../LICENSE.
import type { Actor } from '../actors';
import { fineCos, fineSin } from '../angle';
import { ActorType, MobjFlag, SfxId } from '../data/actors';
import { FRAC_UNIT } from '../fixed';
import { linkActor, unlinkActor } from '../movement';
import { findSubsector } from '../spatial';
import { spawnActor, type World } from '../world';

export interface TeleportHooks {
  readonly damageActor: (target: Actor, inflictor: Actor | null, source: Actor | null, damage: number) => void;
}

export function teleportMove(world: World, actor: Actor, x: number, y: number, hooks: TeleportHooks): boolean {
  const spatial = world.spatial, { width, height } = spatial.map.blockmap;
  const subsector = findSubsector(spatial, x, y);
  const index = spatial.map.subsectors[subsector]?.sector;
  const sector = index === undefined ? undefined : world.sectors[index];
  if (!sector) throw new Error('Teleport destination has no sector');
  const floorZ = sector.floorHeight, ceilingZ = sector.ceilingHeight;
  const extent = (actor.radius + 32 * FRAC_UNIT) | 0;
  const left = Math.max(0, ((x - extent - spatial.blockOriginX) | 0) >> 23);
  const right = Math.min(width - 1, ((x + extent - spatial.blockOriginX) | 0) >> 23);
  const bottom = Math.max(0, ((y - extent - spatial.blockOriginY) | 0) >> 23);
  const top = Math.min(height - 1, ((y + extent - spatial.blockOriginY) | 0) >> 23);
  for (let bx = left; bx <= right; bx++) {
    for (let by = bottom; by <= top; by++) {
      const list = world.actorBlocks[by * width + bx];
      if (!list) continue;
      for (const id of [...list]) {
        const target = world.actorsById.get(id);
        if (!target || target.removed || target === actor || (target.flags & MobjFlag.MF_SHOOTABLE) === 0) continue;
        const distance = (target.radius + actor.radius) | 0;
        if (Math.abs((target.x - x) | 0) >= distance || Math.abs((target.y - y) | 0) >= distance) continue;
        // Doom I has no MAP30, so only a player can stomp another actor.
        if (actor.player === null) return false;
        hooks.damageActor(target, actor, actor, 10000);
      }
    }
  }
  unlinkActor(world, actor);
  actor.floorZ = floorZ; actor.ceilingZ = ceilingZ;
  actor.x = x; actor.y = y;
  linkActor(world, actor);
  return true;
}

export function teleport(world: World, lineIndex: number, side: 0 | 1, actor: Actor, hooks: TeleportHooks): boolean {
  if ((actor.flags & MobjFlag.MF_MISSILE) !== 0 || side === 1) return false;
  const line = world.spatial.lines[lineIndex];
  if (!line) throw new Error('Teleport references an invalid line');
  for (const [index, sector] of world.sectors.entries()) {
    if (sector.tag !== line.tag) continue;
    for (const thinker of world.thinkers) {
      if (thinker.kind !== 'actor') continue;
      const marker = world.actorsById.get(thinker.id);
      if (!marker || marker.removed || marker.type !== ActorType.MT_TELEPORTMAN || marker.sector !== index) continue;
      const oldX = actor.x, oldY = actor.y, oldZ = actor.z;
      if (!teleportMove(world, actor, marker.x, marker.y, hooks)) return false;
      actor.z = actor.floorZ;
      if (actor.player !== null) world.player.viewZ = (actor.z + world.player.viewHeight) | 0;
      const sourceFog = spawnActor(world, ActorType.MT_TFOG, oldX, oldY, oldZ);
      world.events.push({ type: 'sound', sound: SfxId.sfx_telept, actor: sourceFog.id });
      const destinationFog = spawnActor(world, ActorType.MT_TFOG,
        (marker.x + Math.imul(20, fineCos(marker.angle))) | 0,
        (marker.y + Math.imul(20, fineSin(marker.angle))) | 0, actor.z);
      world.events.push({ type: 'sound', sound: SfxId.sfx_telept, actor: destinationFog.id });
      if (actor.player !== null) actor.reactionTime = 18;
      actor.angle = marker.angle;
      actor.momx = actor.momy = actor.momz = 0;
      return true;
    }
  }
  return false;
}
