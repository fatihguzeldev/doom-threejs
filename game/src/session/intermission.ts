// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native single-player WI clock and animation state. See ../../LICENSE.
import { TicButton, type TicCommand } from '../simulation/command';
import { SfxId } from '../simulation/data/actors';
import type { Player } from '../simulation/player';
import { menuRandom, type RandomState } from '../simulation/random';
import type { World } from '../simulation/world';
import { array, boolean, integer, invalid, nonnegative, oneOf, shape, type Parser } from './json';
import { readPlayer, readRandom } from './save';

export interface IntermissionStats {
  readonly kills: number;
  readonly maxKills: number;
  readonly items: number;
  readonly maxItems: number;
  readonly secrets: number;
  readonly maxSecrets: number;
  readonly time: number;
  readonly par: number;
}
export interface IntermissionCounters { kills: number; items: number; secrets: number; time: number; par: number }
export interface IntermissionAnimation { frame: number; nextTic: number }
export interface IntermissionState {
  readonly kind: 'intermission';
  readonly episode: number;
  readonly mapNumber: number;
  readonly nextMapNumber: number;
  readonly secretExit: boolean;
  readonly player: Player;
  readonly random: RandomState;
  readonly stats: IntermissionStats;
  readonly counters: IntermissionCounters;
  readonly animations: IntermissionAnimation[];
  stage: 'counting' | 'showNext' | 'leaving';
  statsStage: number;
  pause: number;
  remaining: number;
  ticks: number;
  pointerOn: boolean;
}
const PARS: readonly (readonly number[])[] = [
  [], [0, 30, 75, 120, 90, 165, 180, 180, 30, 165],
  [0, 90, 90, 90, 120, 90, 360, 240, 30, 170],
  [0, 90, 45, 90, 150, 90, 90, 165, 30, 135],
];
const RETURN_MAPS = [0, 4, 6, 7, 3];
const animationCount = (episode: number): number => episode === 1 ? 10 : episode === 2 ? 9 : episode === 3 ? 6 : 0;
const period = (episode: number, index: number): number => episode === 3 && index === 5 ? 8 : 11;

function resetAnimations(state: IntermissionState): void {
  state.animations.splice(0, state.animations.length, ...Array.from({ length: animationCount(state.episode) }, (_, index) => ({
    frame: -1, nextTic: state.ticks + 1 + (state.episode === 2 ? 0 : menuRandom(state.random) % period(state.episode, index)),
  })));
}

export function createIntermission(world: World, secret: boolean): IntermissionState {
  const state: IntermissionState = {
    kind: 'intermission', episode: world.episode, mapNumber: world.mapNumber,
    nextMapNumber: secret ? 9 : world.mapNumber === 9 ? RETURN_MAPS[world.episode] ?? 1 : world.mapNumber + 1,
    secretExit: secret, player: world.player, random: world.random,
    stats: { kills: world.player.killCount, maxKills: world.totalKills || 1,
      items: world.player.itemCount, maxItems: world.totalItems || 1,
      secrets: world.player.secretCount, maxSecrets: world.totalSecrets || 1,
      time: Math.trunc(world.levelTime / 35), par: PARS[world.episode]?.[world.mapNumber] ?? 0 },
    counters: { kills: -1, items: -1, secrets: -1, time: -1, par: -1 },
    animations: [], stage: 'counting', statsStage: 1, pause: 35, remaining: 0, ticks: 0, pointerOn: false,
  };
  resetAnimations(state);
  return state;
}

function completedCounters(state: IntermissionState): IntermissionCounters {
  const stats = state.stats;
  return { kills: Math.trunc(stats.kills * 100 / stats.maxKills), items: Math.trunc(stats.items * 100 / stats.maxItems),
    secrets: Math.trunc(stats.secrets * 100 / stats.maxSecrets), time: stats.time, par: stats.par };
}

export function advanceIntermission(state: IntermissionState, sound: (sound: SfxId) => void): void {
  if (state.stage === 'counting') {
    if (state.statsStage !== 10) {
      Object.assign(state.counters, completedCounters(state));
      state.statsStage = 10;
      sound(SfxId.sfx_barexp);
    } else {
      sound(SfxId.sfx_sgcock);
      state.stage = 'showNext'; state.remaining = 140;
      resetAnimations(state);
    }
  } else if (state.stage === 'showNext') {
    state.stage = 'leaving'; state.remaining = 10; state.pointerOn = true;
  }
}

export function tickIntermission(state: IntermissionState, command: TicCommand, sound: (sound: SfxId) => void): boolean {
  state.ticks++;
  const attack = (command.buttons & TicButton.attack) !== 0, use = (command.buttons & TicButton.use) !== 0;
  const accelerate = (attack && !state.player.attackDown) || (use && !state.player.useDown);
  state.player.attackDown = attack; state.player.useDown = use;
  for (const [index, animation] of state.animations.entries()) {
    if (animation.nextTic !== state.ticks) continue;
    if (state.episode === 2) {
      const target = index < 7 ? index + 1 : 8;
      if ((state.stage === 'counting' && index === 7) || state.nextMapNumber - 1 !== target) continue;
      animation.frame = Math.min(animation.frame + 1, index === 7 ? 2 : 0);
    } else animation.frame = (animation.frame + 1) % 3;
    animation.nextTic = state.ticks + period(state.episode, index);
  }
  if (state.stage === 'leaving') return --state.remaining === 0;
  if (state.stage === 'showNext') {
    if (--state.remaining === 0 || accelerate) advanceIntermission(state, sound);
    else state.pointerOn = (state.remaining & 31) < 20;
    return false;
  }
  if (accelerate) { advanceIntermission(state, sound); return false; }
  const target = completedCounters(state);
  const field = state.statsStage === 2 ? 'kills' : state.statsStage === 4 ? 'items' : state.statsStage === 6 ? 'secrets' : null;
  if (field !== null) {
    if ((state.ticks & 3) === 0) sound(SfxId.sfx_pistol);
    state.counters[field] = Math.min(state.counters[field] + 2, target[field]);
    if (state.counters[field] === target[field]) { sound(SfxId.sfx_barexp); state.statsStage++; }
  } else if (state.statsStage === 8) {
    if ((state.ticks & 3) === 0) sound(SfxId.sfx_pistol);
    state.counters.time = Math.min(state.counters.time + 3, target.time);
    state.counters.par = Math.min(state.counters.par + 3, target.par);
    if (state.counters.time === target.time && state.counters.par === target.par) { sound(SfxId.sfx_barexp); state.statsStage++; }
  } else if ((state.statsStage & 1) !== 0 && --state.pause === 0) { state.statsStage++; state.pause = 35; }
  return false;
}

const readStats = shape<IntermissionStats>({ kills: nonnegative, maxKills: integer(1, Number.MAX_SAFE_INTEGER), items: nonnegative, maxItems: integer(1, Number.MAX_SAFE_INTEGER),
  secrets: nonnegative, maxSecrets: integer(1, Number.MAX_SAFE_INTEGER), time: nonnegative, par: nonnegative });
const readCounters = shape<IntermissionCounters>({ kills: integer(-1, Number.MAX_SAFE_INTEGER), items: integer(-1, Number.MAX_SAFE_INTEGER), secrets: integer(-1, Number.MAX_SAFE_INTEGER), time: integer(-1, Number.MAX_SAFE_INTEGER), par: integer(-1, Number.MAX_SAFE_INTEGER) });
const readAnimation = shape<IntermissionAnimation>({ frame: integer(-1, 2), nextTic: nonnegative });
const parseIntermission = shape<IntermissionState>({
  kind: oneOf(['intermission']), episode: integer(1, 4), mapNumber: integer(1, 9), nextMapNumber: integer(1, 9), secretExit: boolean,
  player: readPlayer, random: readRandom, stats: readStats, counters: readCounters, animations: array(readAnimation, undefined, 10),
  stage: oneOf(['counting', 'showNext', 'leaving']), statsStage: integer(1, 10), pause: integer(1, 35), remaining: integer(0, 140), ticks: nonnegative, pointerOn: boolean,
});

export const readIntermission: Parser<IntermissionState> = (value, path) => {
  const state = parseIntermission(value, path);
  const next = state.secretExit ? 9 : state.mapNumber === 9 ? RETURN_MAPS[state.episode] : state.mapNumber + 1;
  if (state.nextMapNumber !== next || state.animations.length !== animationCount(state.episode)) invalid(path, 'native route and animation count');
  if ((state.stage === 'counting' && state.remaining !== 0) || (state.stage !== 'counting' && state.statsStage !== 10) ||
    (state.stage === 'showNext' && state.remaining === 0) || (state.stage === 'leaving' && (state.remaining === 0 || state.remaining > 10))) invalid(path, 'valid intermission phase clock');
  const target = completedCounters(state);
  for (const field of ['kills', 'items', 'secrets', 'time', 'par'] as const) {
    if (state.counters[field] > target[field] || (state.statsStage === 10 && state.counters[field] !== target[field])) invalid(`${path}.counters.${field}`, 'native progress counter');
  }
  if (state.stats.kills !== state.player.killCount || state.stats.items !== state.player.itemCount || state.stats.secrets !== state.player.secretCount ||
    state.stats.par !== (PARS[state.episode]?.[state.mapNumber] ?? 0)) invalid(`${path}.stats`, 'matching player statistics and par');
  return state;
};
