// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native vertical door activation and thinkers from p_doors.c. See ../../../LICENSE.
import type { Actor } from '../actors';
import { SfxId } from '../data/actors';
import { FRAC_UNIT } from '../fixed';
import { CardType } from '../player';
import type { World } from '../world';
import { lowestCeiling, movePlane, type PlaneHooks } from './planes';
import type { DoorThinker, DoorType } from './types';

function sectorSound(world: World, sector: number, sound: SfxId): void {
  world.events.push({ type: 'sectorSound', sector, sound });
}

function newDoor(world: World, index: number, type: DoorType): DoorThinker {
  const sector = world.sectors[index];
  if (!sector) throw new Error('Invalid door sector');
  const door: DoorThinker = {
    kind: 'door', sector: index, removed: false, type,
    speed: 2 * FRAC_UNIT, topHeight: (lowestCeiling(world, index) - 4 * FRAC_UNIT) | 0,
    direction: 1, topWait: 150, count: 0,
  };
  sector.specialData = door;
  world.thinkers.push(door);
  return door;
}

function removeDoor(world: World, door: DoorThinker): void {
  const sector = world.sectors[door.sector];
  if (!sector) throw new Error('Invalid door sector');
  sector.specialData = null;
  door.removed = true;
}

export function tickDoor(world: World, door: DoorThinker, hooks: PlaneHooks): void {
  const sector = world.sectors[door.sector];
  if (!sector) throw new Error('Invalid door sector');
  if (door.direction === 0) {
    if (--door.count === 0) {
      if (door.type === 'normal' || door.type === 'blazeRaise') {
        door.direction = -1;
        sectorSound(world, door.sector, door.type === 'blazeRaise' ? SfxId.sfx_bdcls : SfxId.sfx_dorcls);
      } else if (door.type === 'close30ThenOpen') {
        door.direction = 1;
        sectorSound(world, door.sector, SfxId.sfx_doropn);
      }
    }
    return;
  }
  if (door.direction === 2) {
    if (--door.count === 0 && door.type === 'raiseIn5Mins') {
      door.direction = 1;
      door.type = 'normal';
      sectorSound(world, door.sector, SfxId.sfx_doropn);
    }
    return;
  }
  if (door.direction === -1) {
    const result = movePlane(world, door.sector, door.speed, sector.floorHeight, false, 'ceiling', -1, hooks);
    if (result === 'pastDestination') {
      if (door.type === 'blazeRaise' || door.type === 'blazeClose') {
        removeDoor(world, door);
        sectorSound(world, door.sector, SfxId.sfx_bdcls);
      } else if (door.type === 'normal' || door.type === 'close') removeDoor(world, door);
      else if (door.type === 'close30ThenOpen') { door.direction = 0; door.count = 35 * 30; }
    } else if (result === 'crushed' && door.type !== 'close' && door.type !== 'blazeClose') {
      door.direction = 1;
      sectorSound(world, door.sector, SfxId.sfx_doropn);
    }
    return;
  }
  const result = movePlane(world, door.sector, door.speed, door.topHeight, false, 'ceiling', 1, hooks);
  if (result === 'pastDestination') {
    if (door.type === 'normal' || door.type === 'blazeRaise') { door.direction = 0; door.count = door.topWait; }
    else if (door.type === 'open' || door.type === 'blazeOpen' || door.type === 'close30ThenOpen') removeDoor(world, door);
  }
}

export function doDoor(world: World, tag: number, type: DoorType): boolean {
  let activated = false;
  for (const [index, sector] of world.sectors.entries()) {
    if (sector.tag !== tag || sector.specialData !== null) continue;
    activated = true;
    const door = newDoor(world, index, type);
    if (type === 'blazeClose' || type === 'blazeRaise' || type === 'blazeOpen') door.speed *= 4;
    if (type === 'close' || type === 'blazeClose' || type === 'close30ThenOpen') {
      door.direction = -1;
      if (type === 'close30ThenOpen') door.topHeight = sector.ceilingHeight;
      sectorSound(world, index, type === 'blazeClose' ? SfxId.sfx_bdcls : SfxId.sfx_dorcls);
    } else if (door.topHeight !== sector.ceilingHeight) {
      sectorSound(world, index, type === 'blazeRaise' || type === 'blazeOpen' ? SfxId.sfx_bdopn : SfxId.sfx_doropn);
    }
  }
  return activated;
}

function checkKey(world: World, actor: Actor, special: number, manual: boolean): boolean {
  let color: 'blue' | 'red' | 'yellow' | null = null;
  if (manual) {
    if (special === 26 || special === 32) color = 'blue';
    if (special === 27 || special === 34) color = 'yellow';
    if (special === 28 || special === 33) color = 'red';
  } else {
    if (special === 99 || special === 133) color = 'blue';
    if (special === 134 || special === 135) color = 'red';
    if (special === 136 || special === 137) color = 'yellow';
  }
  if (color === null) return true;
  if (actor.player === null) return false;
  const cards = world.player.cards;
  const card = color === 'blue' ? CardType.it_bluecard : color === 'red' ? CardType.it_redcard : CardType.it_yellowcard;
  const skull = color === 'blue' ? CardType.it_blueskull : color === 'red' ? CardType.it_redskull : CardType.it_yellowskull;
  if (cards[card] || cards[skull]) return true;
  const text = `You need a ${color} key to ${manual ? 'open this door' : 'activate this object'}`;
  world.player.message = text;
  world.events.push({ type: 'message', text }, { type: 'sound', sound: SfxId.sfx_oof, actor: null });
  return false;
}

export function doLockedDoor(world: World, lineIndex: number, actor: Actor, type: DoorType): boolean {
  const line = world.spatial.lines[lineIndex];
  if (!line || actor.player === null || !checkKey(world, actor, world.lineSpecials[lineIndex] ?? line.special, false)) return false;
  return doDoor(world, line.tag, type);
}

export function useDoor(world: World, lineIndex: number, actor: Actor): boolean {
  const line = world.spatial.lines[lineIndex];
  if (!line || line.backSector === null) return false;
  const special = world.lineSpecials[lineIndex] ?? line.special;
  if (!checkKey(world, actor, special, true)) return false;
  const sector = world.sectors[line.backSector];
  if (!sector) throw new Error('Invalid manual door sector');
  const existing = sector.specialData;
  if (existing !== null && [1, 26, 27, 28, 117].includes(special)) {
    if (existing.kind !== 'door') return false;
    if (existing.direction === -1) existing.direction = 1;
    else {
      if (actor.player === null) return false;
      existing.direction = -1;
    }
    return true;
  }
  const blazing = special === 117 || special === 118;
  const open = special === 31 || special === 32 || special === 33 || special === 34 || special === 118;
  const type: DoorType = blazing ? (open ? 'blazeOpen' : 'blazeRaise') : (open ? 'open' : 'normal');
  sectorSound(world, line.backSector, blazing ? SfxId.sfx_bdopn : SfxId.sfx_doropn);
  const door = newDoor(world, line.backSector, type);
  if (blazing) door.speed *= 4;
  if (open) world.lineSpecials[lineIndex] = 0;
  return true;
}

export function spawnTimedDoor(world: World, index: number, type: 'closeIn30' | 'raiseIn5Mins'): void {
  const sector = world.sectors[index];
  if (!sector) throw new Error('Invalid timed door sector');
  const door = newDoor(world, index, type === 'closeIn30' ? 'normal' : 'raiseIn5Mins');
  sector.special = 0;
  door.direction = type === 'closeIn30' ? 0 : 2;
  door.count = type === 'closeIn30' ? 30 * 35 : 5 * 60 * 35;
}
