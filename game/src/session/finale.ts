// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native episode finale text and F_Ticker/BunnyScroll. See ../../LICENSE.
import { SfxId } from '../simulation/data/actors';
import type { Player } from '../simulation/player';
import type { RandomState } from '../simulation/random';
import type { World } from '../simulation/world';
import { integer, invalid, nonnegative, nullable, oneOf, shape, string, type Parser } from './json';
import { readPlayer, readRandom } from './save';

const TEXTS: readonly string[] = [
  '',
  [
    "Once you beat the big badasses and\n",
    "clean out the moon base you're supposed\n",
    "to win, aren't you? Aren't you? Where's\n",
    "your fat reward and ticket home? What\n",
    "the hell is this? It's not supposed to\n",
    "end this way!\n",
    "\n",
    "It stinks like rotten meat, but looks\n",
    "like the lost Deimos base.  Looks like\n",
    "you're stuck on The Shores of Hell.\n",
    "The only way out is through.\n",
    "\n",
    "To continue the DOOM experience, play\n",
    "The Shores of Hell and its amazing\n",
    "sequel, Inferno!\n",
  ].join(''),
  [
    "You've done it! The hideous cyber-\n",
    "demon lord that ruled the lost Deimos\n",
    "moon base has been slain and you\n",
    "are triumphant! But ... where are\n",
    "you? You clamber to the edge of the\n",
    "moon and look down to see the awful\n",
    "truth.\n",
    "\n",
    "Deimos floats above Hell itself!\n",
    "You've never heard of anyone escaping\n",
    "from Hell, but you'll make the bastards\n",
    "sorry they ever heard of you! Quickly,\n",
    "you rappel down to  the surface of\n",
    "Hell.\n",
    "\n",
    "Now, it's on to the final chapter of\n",
    "DOOM! -- Inferno.",
  ].join(''),
  [
    "The loathsome spiderdemon that\n",
    "masterminded the invasion of the moon\n",
    "bases and caused so much death has had\n",
    "its ass kicked for all time.\n",
    "\n",
    "A hidden doorway opens and you enter.\n",
    "You've proven too tough for Hell to\n",
    "contain, and now Hell at last plays\n",
    "fair -- for you emerge from the door\n",
    "to see the green fields of Earth!\n",
    "Home at last.\n",
    "\n",
    "You wonder what's been happening on\n",
    "Earth while you were battling evil\n",
    "unleashed. It's good that no Hell-\n",
    "spawn could have come through that\n",
    "door with you ...",
  ].join(''),
  [
    "the spider mastermind must have sent forth\n",
    "its legions of hellspawn before your\n",
    "final confrontation with that terrible\n",
    "beast from hell.  but you stepped forward\n",
    "and brought forth eternal damnation and\n",
    "suffering upon the horde as a true hero\n",
    "would in the face of something so evil.\n",
    "\n",
    "besides, someone was gonna pay for what\n",
    "happened to daisy, your pet rabbit.\n",
    "\n",
    "but now, you see spread before you more\n",
    "potential pain and gibbitude as a nation\n",
    "of demons run amok among our cities.\n",
    "\n",
    "next stop, hell on earth!",
  ].join(''),
];

export interface FinaleState {
  readonly kind: 'finale';
  readonly episode: number;
  readonly player: Player;
  readonly random: RandomState;
  readonly text: string;
  readonly flat: string;
  readonly picture: string | null;
  stage: 'text' | 'art';
  ticks: number;
  textVisibleChars: number;
  bunnyScroll: number;
  bunnyEndFrame: number | null;
}

export function createFinale(world: World): FinaleState {
  const text = TEXTS[world.episode];
  const flat = ['', 'FLOOR4_8', 'SFLR6_1', 'MFLR8_4', 'MFLR8_3'][world.episode];
  if (text === undefined || flat === undefined) throw new Error('Unknown Doom episode finale');
  return { kind: 'finale', episode: world.episode, player: world.player, random: world.random, text, flat,
    picture: world.episode === 1 ? world.mode === 'retail' ? 'CREDIT' : 'HELP2' : world.episode === 2 ? 'VICTORY2' : world.episode === 4 ? 'ENDPIC' : null,
    stage: 'text', ticks: 0, textVisibleChars: 0, bunnyScroll: 320, bunnyEndFrame: null };
}

export function tickFinale(state: FinaleState, sound: (sound: SfxId) => void): boolean {
  state.ticks++;
  if (state.stage === 'text') {
    state.textVisibleChars = Math.min(state.text.length, Math.max(0, Math.trunc((state.ticks - 10) / 3)));
    if (state.ticks > state.text.length * 3 + 250) {
      state.stage = 'art'; state.ticks = 0;
      return state.episode === 3;
    }
  } else if (state.episode === 3) {
    state.bunnyScroll = Math.min(320, Math.max(0, 320 - Math.trunc((state.ticks - 230) / 2)));
    const frame = state.ticks < 1130 ? null : state.ticks < 1180 ? 0 : Math.min(6, Math.trunc((state.ticks - 1180) / 5));
    if (frame !== null && state.bunnyEndFrame !== null && frame > state.bunnyEndFrame) sound(SfxId.sfx_pistol);
    state.bunnyEndFrame = frame;
  }
  return false;
}

const parseFinale = shape<FinaleState>({
  kind: oneOf(['finale']), episode: integer(1, 4), player: readPlayer, random: readRandom,
  text: string(4096), flat: string(8), picture: nullable(string(8)), stage: oneOf(['text', 'art']),
  ticks: nonnegative, textVisibleChars: integer(0, 4096), bunnyScroll: integer(0, 320), bunnyEndFrame: nullable(integer(0, 6)),
});

export const readFinale: Parser<FinaleState> = (value, path) => {
  const state = parseFinale(value, path);
  const flat = ['', 'FLOOR4_8', 'SFLR6_1', 'MFLR8_4', 'MFLR8_3'][state.episode];
  const pictureMatches = state.episode === 1 ? state.picture === 'HELP2' || state.picture === 'CREDIT' :
    state.episode === 2 ? state.picture === 'VICTORY2' : state.episode === 3 ? state.picture === null : state.picture === 'ENDPIC';
  if (state.text !== TEXTS[state.episode] || state.flat !== flat || !pictureMatches) invalid(path, 'original episode finale assets');
  const textChars = state.stage === 'text' ? Math.min(state.text.length, Math.max(0, Math.trunc((state.ticks - 10) / 3))) : state.text.length;
  if (state.textVisibleChars !== textChars || (state.stage === 'text' && state.ticks > state.text.length * 3 + 250)) invalid(path, 'native finale text clock');
  const bunny = state.stage === 'art' && state.episode === 3;
  const scroll = bunny ? Math.min(320, Math.max(0, 320 - Math.trunc((state.ticks - 230) / 2))) : 320;
  const end = !bunny || state.ticks < 1130 ? null : state.ticks < 1180 ? 0 : Math.min(6, Math.trunc((state.ticks - 1180) / 5));
  if (state.bunnyScroll !== scroll || state.bunnyEndFrame !== end) invalid(path, 'native bunny animation clock');
  return state;
};
