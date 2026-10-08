// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native ceilings from p_ceilng.c. See ../../../LICENSE.
import { SfxId } from '../data/actors';
import { FRAC_UNIT } from '../fixed';
import type { World } from '../world';
import { highestCeiling, movePlane, type PlaneHooks } from './planes';
import type { CeilingThinker, CeilingType } from './types';

const MAX_CEILINGS = 30;

function activeCeilings(world: World): (CeilingThinker | null)[] {
  const slots: (CeilingThinker | null)[] = Array.from({ length: MAX_CEILINGS }, () => null);
  for (const thinker of world.thinkers) {
    if (thinker.kind === 'ceiling' && !thinker.removed && thinker.activeSlot !== null) slots[thinker.activeSlot] = thinker;
  }
  return slots;
}

function removeCeiling(world: World, thinker: CeilingThinker): void {
  // Vanilla silently leaves overflow ceilings outside activeceilings. They
  // cannot be stopped, restarted, or removed through P_RemoveActiveCeiling.
  if (thinker.activeSlot === null || activeCeilings(world)[thinker.activeSlot] !== thinker) return;
  const sector = world.sectors[thinker.sector];
  if (!sector) throw new Error('Invalid ceiling sector');
  sector.specialData = null;
  thinker.removed = true;
}

export function doCeiling(world: World, tag: number, type: CeilingType): boolean {
  const active = activeCeilings(world);
  if (type === 'crushAndRaise' || type === 'fastCrushAndRaise' || type === 'silentCrushAndRaise') {
    for (const thinker of active) {
      if (thinker?.tag === tag && thinker.direction === 0) thinker.direction = thinker.oldDirection;
    }
  }
  let started = false;
  world.sectors.forEach((sector, index) => {
    if (sector.tag !== tag || sector.specialData !== null) return;
    const slot = active.indexOf(null);
    const thinker: CeilingThinker = {
      kind: 'ceiling', sector: index, type, removed: false, activeSlot: slot < 0 ? null : slot,
      speed: FRAC_UNIT, topHeight: 0, bottomHeight: sector.floorHeight,
      direction: -1, oldDirection: -1, crush: false, tag: sector.tag,
    };
    switch (type) {
      case 'fastCrushAndRaise':
        thinker.crush = true;
        thinker.speed = 2 * FRAC_UNIT;
        thinker.topHeight = sector.ceilingHeight;
        thinker.bottomHeight = (sector.floorHeight + 8 * FRAC_UNIT) | 0;
        break;
      case 'crushAndRaise':
      case 'silentCrushAndRaise':
        thinker.crush = true;
        thinker.topHeight = sector.ceilingHeight;
        thinker.bottomHeight = (sector.floorHeight + 8 * FRAC_UNIT) | 0;
        break;
      case 'lowerAndCrush':
        thinker.bottomHeight = (sector.floorHeight + 8 * FRAC_UNIT) | 0;
        break;
      case 'lowerToFloor': break;
      case 'raiseToHighest':
        thinker.topHeight = highestCeiling(world, index);
        thinker.direction = 1;
        break;
    }
    world.thinkers.push(thinker);
    sector.specialData = thinker;
    if (slot >= 0) active[slot] = thinker;
    started = true;
  });
  return started;
}

export function stopCeilings(world: World, tag: number): boolean {
  let stopped = false;
  for (const thinker of activeCeilings(world)) {
    if (thinker?.tag !== tag || thinker.direction === 0) continue;
    thinker.oldDirection = thinker.direction;
    thinker.direction = 0;
    stopped = true;
  }
  return stopped;
}

export function tickCeiling(world: World, thinker: CeilingThinker, hooks: PlaneHooks): void {
  if (thinker.removed || thinker.direction === 0) return;
  const direction = thinker.direction;
  const result = movePlane(world, thinker.sector, thinker.speed,
    direction === 1 ? thinker.topHeight : thinker.bottomHeight,
    direction === -1 && thinker.crush, 'ceiling', direction, hooks);
  if ((world.levelTime & 7) === 0 && thinker.type !== 'silentCrushAndRaise') {
    world.events.push({ type: 'sectorSound', sound: SfxId.sfx_stnmov, sector: thinker.sector });
  }
  if (result === 'pastDestination') {
    if (direction === 1) {
      if (thinker.type === 'raiseToHighest') removeCeiling(world, thinker);
      else if (thinker.type === 'crushAndRaise' || thinker.type === 'fastCrushAndRaise' || thinker.type === 'silentCrushAndRaise') {
        if (thinker.type === 'silentCrushAndRaise') world.events.push({ type: 'sectorSound', sound: SfxId.sfx_pstop, sector: thinker.sector });
        thinker.direction = -1;
      }
    } else {
      if (thinker.type === 'lowerToFloor' || thinker.type === 'lowerAndCrush') removeCeiling(world, thinker);
      else if (thinker.type === 'crushAndRaise' || thinker.type === 'fastCrushAndRaise' || thinker.type === 'silentCrushAndRaise') {
        if (thinker.type === 'silentCrushAndRaise') world.events.push({ type: 'sectorSound', sound: SfxId.sfx_pstop, sector: thinker.sector });
        if (thinker.type === 'silentCrushAndRaise' || thinker.type === 'crushAndRaise') thinker.speed = FRAC_UNIT;
        thinker.direction = 1;
      }
    }
  } else if (direction === -1 && result === 'crushed' &&
    (thinker.type === 'silentCrushAndRaise' || thinker.type === 'crushAndRaise' || thinker.type === 'lowerAndCrush')) {
    thinker.speed = FRAC_UNIT / 8;
  }
}
