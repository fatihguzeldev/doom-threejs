// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native light flashes, strobes, glow and fire from p_lights.c. See ../../../LICENSE.
import { gameRandom } from '../random';
import type { World } from '../world';
import { neighbors } from './planes';
import type { LightThinker } from './types';

function minimumLight(world: World, index: number, initial: number): number {
  let minimum = initial;
  for (const neighbor of neighbors(world, index)) minimum = Math.min(minimum, world.sectors[neighbor]?.lightLevel ?? minimum);
  return minimum;
}

export function spawnLight(
  world: World, index: number, type: LightThinker['type'], darkTime: 15 | 35 = 35, synchronized = false,
): LightThinker {
  const sector = world.sectors[index];
  if (!sector) throw new Error('Invalid light sector');
  const light: LightThinker = {
    kind: 'light', sector: index, removed: false, type,
    max: sector.lightLevel, min: minimumLight(world, index, sector.lightLevel),
    count: 0, maxTime: 64, minTime: 7, direction: -1,
  };
  sector.special = 0;
  if (type === 'flash') light.count = (gameRandom(world.random) & light.maxTime) + 1;
  if (type === 'strobe') {
    if (light.min === light.max) light.min = 0;
    light.minTime = darkTime;
    light.maxTime = 5;
    light.count = synchronized ? 1 : (gameRandom(world.random) & 7) + 1;
  }
  if (type === 'fire') { light.min += 16; light.count = 4; }
  world.thinkers.push(light);
  return light;
}

export function tickLight(world: World, light: LightThinker): void {
  const sector = world.sectors[light.sector];
  if (!sector) throw new Error('Invalid light sector');
  if (light.type === 'glow') {
    sector.lightLevel += light.direction * 8;
    if ((light.direction === -1 && sector.lightLevel <= light.min) ||
      (light.direction === 1 && sector.lightLevel >= light.max)) {
      sector.lightLevel -= light.direction * 8;
      light.direction = light.direction === -1 ? 1 : -1;
    }
    return;
  }
  if (--light.count !== 0) return;
  if (light.type === 'fire') {
    const amount = (gameRandom(world.random) & 3) * 16;
    sector.lightLevel = sector.lightLevel - amount < light.min ? light.min : light.max - amount;
    light.count = 4;
  } else if (light.type === 'flash') {
    if (sector.lightLevel === light.max) {
      sector.lightLevel = light.min;
      light.count = (gameRandom(world.random) & light.minTime) + 1;
    } else {
      sector.lightLevel = light.max;
      light.count = (gameRandom(world.random) & light.maxTime) + 1;
    }
  } else if (sector.lightLevel === light.min) {
    sector.lightLevel = light.max;
    light.count = light.maxTime;
  } else {
    sector.lightLevel = light.min;
    light.count = light.minTime;
  }
}

export function startStrobes(world: World, tag: number): void {
  for (const [index, sector] of world.sectors.entries()) {
    if (sector.tag === tag && sector.specialData === null) spawnLight(world, index, 'strobe');
  }
}

export function lightsOff(world: World, tag: number): void {
  for (const [index, sector] of world.sectors.entries()) {
    if (sector.tag === tag) sector.lightLevel = minimumLight(world, index, sector.lightLevel);
  }
}

export function lightsOn(world: World, tag: number, brightness: number): void {
  for (const [index, sector] of world.sectors.entries()) {
    if (sector.tag !== tag) continue;
    if (brightness === 0) {
      for (const neighbor of neighbors(world, index)) brightness = Math.max(brightness, world.sectors[neighbor]?.lightLevel ?? brightness);
    }
    // Native EV_LightTurnOn reuses the first resolved brightness for later tags.
    sector.lightLevel = brightness;
  }
}
