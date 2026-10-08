// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native Doom1 ST_Responder / AM_Responder and m_cheat.c recognition. See ../../LICENSE.
import { WeaponType } from './data/weapons';
import { givePower } from './inventory';
import { CheatFlag, MAX_HEALTH, PowerType } from './player';
import type { World } from './world';

export type CheatEffect =
  | { readonly type: 'message'; readonly text: string }
  | { readonly type: 'warp'; readonly episode: number; readonly mapNumber: number }
  | { readonly type: 'music'; readonly name: string; readonly loop: true }
  | { readonly type: 'automapReveal'; readonly level: 0 | 1 | 2 };

export interface Cheats {
  feed(world: World, text: string, automapActive?: boolean): CheatEffect[];
  reset(): void;
}

type CheatName = 'god' | 'ammo' | 'keys' | 'music' | 'noclip' | 'noclipAlias' |
  'invulnerability' | 'strength' | 'invisibility' | 'ironfeet' | 'allmap' | 'infrared' |
  'behold' | 'choppers' | 'position' | 'level' | 'automap';
interface Sequence {
  readonly name: CheatName;
  readonly text: string;
  readonly parameterCount: 0 | 2;
}
interface Matcher {
  readonly sequence: Sequence;
  index: number;
  parameters: string;
}
const sequences: readonly Sequence[] = [
  { name: 'god', text: 'iddqd', parameterCount: 0 },
  { name: 'ammo', text: 'idfa', parameterCount: 0 },
  { name: 'keys', text: 'idkfa', parameterCount: 0 },
  { name: 'music', text: 'idmus', parameterCount: 2 },
  { name: 'noclip', text: 'idspispopd', parameterCount: 0 },
  { name: 'noclipAlias', text: 'idclip', parameterCount: 0 },
  { name: 'invulnerability', text: 'idbeholdv', parameterCount: 0 },
  { name: 'strength', text: 'idbeholds', parameterCount: 0 },
  { name: 'invisibility', text: 'idbeholdi', parameterCount: 0 },
  { name: 'ironfeet', text: 'idbeholdr', parameterCount: 0 },
  { name: 'allmap', text: 'idbeholda', parameterCount: 0 },
  { name: 'infrared', text: 'idbeholdl', parameterCount: 0 },
  { name: 'behold', text: 'idbehold', parameterCount: 0 },
  { name: 'choppers', text: 'idchoppers', parameterCount: 0 },
  { name: 'position', text: 'idmypos', parameterCount: 0 },
  { name: 'level', text: 'idclev', parameterCount: 2 },
  { name: 'automap', text: 'iddt', parameterCount: 0 },
];
const powers: Readonly<Partial<Record<CheatName, PowerType>>> = {
  invulnerability: PowerType.pw_invulnerability, strength: PowerType.pw_strength,
  invisibility: PowerType.pw_invisibility, ironfeet: PowerType.pw_ironfeet,
  allmap: PowerType.pw_allmap, infrared: PowerType.pw_infrared,
};
const music: readonly string[] = [
  'D_E1M1', 'D_E1M2', 'D_E1M3', 'D_E1M4', 'D_E1M5', 'D_E1M6', 'D_E1M7', 'D_E1M8', 'D_E1M9',
  'D_E2M1', 'D_E2M2', 'D_E2M3', 'D_E2M4', 'D_E2M5', 'D_E2M6', 'D_E2M7', 'D_E2M8', 'D_E2M9',
  'D_E3M1', 'D_E3M2', 'D_E3M3', 'D_E3M4', 'D_E3M5', 'D_E3M6', 'D_E3M7', 'D_E3M8', 'D_E3M9',
  'D_INTER', 'D_INTRO', 'D_BUNNY', 'D_VICTOR', 'D_INTROA',
];

function match(matcher: Matcher, character: string): string | null {
  const { sequence } = matcher;
  if (matcher.index < sequence.text.length) {
    if (character !== sequence.text[matcher.index]) {
      // cht_CheckCheat consumes a mismatching key; it does not try that key again.
      matcher.index = 0; matcher.parameters = '';
      return null;
    }
    matcher.index++;
  } else {
    matcher.parameters += character;
    matcher.index++;
  }
  if (matcher.index < sequence.text.length + sequence.parameterCount) return null;
  const parameters = matcher.parameters;
  matcher.index = 0; matcher.parameters = '';
  return parameters;
}

export function createCheats(): Cheats {
  const matchers: Matcher[] = sequences.map(sequence => ({ sequence, index: 0, parameters: '' }));
  let previousWorld: World | null = null, reveal: 0 | 1 | 2 = 0;
  const reset = (): void => {
    for (const matcher of matchers) { matcher.index = 0; matcher.parameters = ''; }
    previousWorld = null; reveal = 0;
  };
  return {
    reset,
    feed(world, text, automapActive = false): CheatEffect[] {
      if (world !== previousWorld) { reset(); previousWorld = world; }
      const effects: CheatEffect[] = [], player = world.player;
      const actor = world.actorsById.get(player.actorId);
      const message = (value: string): void => {
        player.message = value; effects.push({ type: 'message', text: value });
      };
      for (const character of text.toLowerCase()) {
        for (const matcher of matchers) {
          const name = matcher.sequence.name;
          if (name === 'automap' && !automapActive) continue;
          const parameters = match(matcher, character);
          if (parameters === null) continue;
          const power = powers[name];
          if (power !== undefined) {
            if (player.powers[power]) player.powers[power] = power === PowerType.pw_strength ? 0 : 1;
            else if (actor) givePower(player, power, actor);
            message('Power-up Toggled');
            continue;
          }
          switch (name) {
            case 'god':
              player.cheats ^= CheatFlag.CF_GODMODE;
              if (player.cheats & CheatFlag.CF_GODMODE) {
                player.health = MAX_HEALTH;
                if (actor) actor.health = MAX_HEALTH;
                message('Degreelessness Mode On');
              } else message('Degreelessness Mode Off');
              break;
            case 'ammo':
            case 'keys':
              player.armorPoints = 200; player.armorType = 2;
              player.ownedWeapons.fill(true);
              for (let index = 0; index < player.ammo.length; index++) {
                const maximum = player.maxAmmo[index];
                if (maximum === undefined) throw new Error('Missing maximum ammo');
                player.ammo[index] = maximum;
              }
              if (name === 'keys') player.cards.fill(true);
              message(name === 'keys' ? 'Very Happy Ammo Added' : 'Ammo (no keys) Added');
              break;
            case 'noclip':
            case 'noclipAlias':
              player.cheats ^= CheatFlag.CF_NOCLIP;
              // P_PlayerThink copies this cheat bit to MF_NOCLIP at the next tic.
              message(player.cheats & CheatFlag.CF_NOCLIP ? 'No Clipping Mode ON' : 'No Clipping Mode OFF');
              break;
            case 'behold':
              message('inVuln, Str, Inviso, Rad, Allmap, or Lite-amp');
              break;
            case 'choppers':
              player.ownedWeapons[WeaponType.wp_chainsaw] = true;
              player.powers[PowerType.pw_invulnerability] = 1;
              message("... doesn't suck - GM");
              break;
            case 'position':
              if (actor) message(`ang=0x${(actor.angle >>> 0).toString(16)};x,y=(0x${(actor.x >>> 0).toString(16)},0x${(actor.y >>> 0).toString(16)})`);
              break;
            case 'music': {
              const index = (Number(parameters[0]) - 1) * 9 + Number(parameters[1]) - 1;
              const selection = /^[0-9]{2}$/.test(parameters) ? music[index] : undefined;
              if (!selection) message('IMPOSSIBLE SELECTION');
              else { message('Music Change'); effects.push({ type: 'music', name: selection, loop: true }); }
              break;
            }
            case 'level': {
              if (!/^[1-9]{2}$/.test(parameters)) break;
              const episode = Number(parameters[0]), mapNumber = Number(parameters[1]);
              const maximumEpisode = world.mode === 'retail' ? 4 : world.mode === 'registered' ? 3 : 1;
              if (episode > maximumEpisode) break;
              message('Changing Level...'); effects.push({ type: 'warp', episode, mapNumber });
              break;
            }
            case 'automap':
              reveal = reveal === 2 ? 0 : reveal === 1 ? 2 : 1;
              effects.push({ type: 'automapReveal', level: reveal });
              break;
          }
        }
      }
      return effects;
    },
  };
}
