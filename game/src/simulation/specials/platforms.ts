// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native platforms from p_plats.c. See ../../../LICENSE.
import { SfxId } from '../data/actors';
import { FRAC_UNIT } from '../fixed';
import { gameRandom } from '../random';
import type { World } from '../world';
import { highestFloor, lowestFloor, movePlane, nextHighestFloor, type PlaneHooks } from './planes';
import type { PlatformThinker, PlatformType } from './types';

const MAX_PLATFORMS = 30;
const PLATFORM_WAIT = 35 * 3;

function activePlatforms(world: World): (PlatformThinker | null)[] {
  const slots: (PlatformThinker | null)[] = Array.from({ length: MAX_PLATFORMS }, () => null);
  for (const thinker of world.thinkers) {
    if (thinker.kind === 'platform' && !thinker.removed && thinker.activeSlot !== null) slots[thinker.activeSlot] = thinker;
  }
  return slots;
}

function removePlatform(world: World, thinker: PlatformThinker): void {
  if (thinker.activeSlot === null || activePlatforms(world)[thinker.activeSlot] !== thinker) {
    throw new Error("P_RemoveActivePlat: can't find plat!");
  }
  const sector = world.sectors[thinker.sector];
  if (!sector) throw new Error('Invalid platform sector');
  sector.specialData = null;
  thinker.removed = true;
}

function modelTexture(world: World, lineIndex: number): string {
  const line = world.spatial.lines[lineIndex];
  const sector = line ? world.sectors[line.frontSector] : undefined;
  if (!sector) throw new Error('Invalid platform model line');
  return sector.floorTexture;
}

export function doPlatform(world: World, tag: number, type: PlatformType, amount: number, lineIndex: number): boolean {
  const active = activePlatforms(world);
  if (type === 'perpetualRaise') {
    for (const thinker of active) {
      if (thinker?.tag === tag && thinker.status === 'stasis') thinker.status = thinker.oldStatus;
    }
  }
  let started = false;
  world.sectors.forEach((sector, index) => {
    if (sector.tag !== tag || sector.specialData !== null) return;
    const slot = active.indexOf(null);
    const thinker: PlatformThinker = {
      kind: 'platform', sector: index, type, removed: false, activeSlot: slot < 0 ? null : slot,
      speed: FRAC_UNIT, low: 0, high: 0, wait: 0, count: 0, status: 'up', oldStatus: 'up', crush: false, tag,
    };
    // As in EV_DoPlat, install the association before the active-list capacity
    // check. Unused C fields have explicit zero defaults in the typed record.
    world.thinkers.push(thinker);
    sector.specialData = thinker;
    switch (type) {
      case 'raiseToNearestAndChange':
        thinker.speed = FRAC_UNIT / 2;
        sector.floorTexture = modelTexture(world, lineIndex);
        thinker.high = nextHighestFloor(world, index, sector.floorHeight);
        sector.special = 0;
        world.events.push({ type: 'sectorSound', sound: SfxId.sfx_stnmov, sector: index });
        break;
      case 'raiseAndChange':
        thinker.speed = FRAC_UNIT / 2;
        sector.floorTexture = modelTexture(world, lineIndex);
        thinker.high = (sector.floorHeight + Math.imul(amount, FRAC_UNIT)) | 0;
        world.events.push({ type: 'sectorSound', sound: SfxId.sfx_stnmov, sector: index });
        break;
      case 'downWaitUpStay':
      case 'blazeDownWaitUpStay':
        thinker.speed = (type === 'downWaitUpStay' ? 4 : 8) * FRAC_UNIT;
        thinker.low = Math.min(lowestFloor(world, index), sector.floorHeight);
        thinker.high = sector.floorHeight;
        thinker.wait = PLATFORM_WAIT;
        thinker.status = 'down';
        world.events.push({ type: 'sectorSound', sound: SfxId.sfx_pstart, sector: index });
        break;
      case 'perpetualRaise':
        thinker.low = Math.min(lowestFloor(world, index), sector.floorHeight);
        thinker.high = Math.max(highestFloor(world, index), sector.floorHeight);
        thinker.wait = PLATFORM_WAIT;
        thinker.status = (gameRandom(world.random) & 1) === 0 ? 'up' : 'down';
        world.events.push({ type: 'sectorSound', sound: SfxId.sfx_pstart, sector: index });
        break;
    }
    if (slot < 0) throw new Error('P_AddActivePlat: no more plats!');
    active[slot] = thinker;
    started = true;
  });
  return started;
}

export function stopPlatforms(world: World, tag: number): void {
  for (const thinker of activePlatforms(world)) {
    if (thinker?.tag !== tag || thinker.status === 'stasis') continue;
    thinker.oldStatus = thinker.status;
    thinker.status = 'stasis';
  }
}

export function tickPlatform(world: World, thinker: PlatformThinker, hooks: PlaneHooks): void {
  if (thinker.removed || thinker.status === 'stasis') return;
  const sector = world.sectors[thinker.sector];
  if (!sector) throw new Error('Invalid platform sector');
  if (thinker.status === 'waiting') {
    thinker.count = (thinker.count - 1) | 0;
    if (thinker.count === 0) {
      thinker.status = sector.floorHeight === thinker.low ? 'up' : 'down';
      world.events.push({ type: 'sectorSound', sound: SfxId.sfx_pstart, sector: thinker.sector });
    }
    return;
  }
  const goingUp = thinker.status === 'up';
  const result = movePlane(world, thinker.sector, thinker.speed, goingUp ? thinker.high : thinker.low,
    goingUp && thinker.crush, 'floor', goingUp ? 1 : -1, hooks);
  if (goingUp && (thinker.type === 'raiseAndChange' || thinker.type === 'raiseToNearestAndChange') && (world.levelTime & 7) === 0) {
    world.events.push({ type: 'sectorSound', sound: SfxId.sfx_stnmov, sector: thinker.sector });
  }
  if (goingUp && result === 'crushed' && !thinker.crush) {
    thinker.count = thinker.wait;
    thinker.status = 'down';
    world.events.push({ type: 'sectorSound', sound: SfxId.sfx_pstart, sector: thinker.sector });
  } else if (result === 'pastDestination') {
    thinker.count = thinker.wait;
    thinker.status = 'waiting';
    world.events.push({ type: 'sectorSound', sound: SfxId.sfx_pstop, sector: thinker.sector });
    if (goingUp && thinker.type !== 'perpetualRaise') removePlatform(world, thinker);
  }
}
