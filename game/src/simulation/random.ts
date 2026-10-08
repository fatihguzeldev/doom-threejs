// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native port of m_random.c. See ../../LICENSE.
import { randomBytes } from './data/math';

export interface RandomState {
  gameIndex: number;
  menuIndex: number;
}

export function createRandom(): RandomState {
  return { gameIndex: 0, menuIndex: 0 };
}

export function gameRandom(random: RandomState): number {
  random.gameIndex = (random.gameIndex + 1) & 255;
  return randomBytes[random.gameIndex] as number;
}

export function menuRandom(random: RandomState): number {
  random.menuIndex = (random.menuIndex + 1) & 255;
  return randomBytes[random.menuIndex] as number;
}
