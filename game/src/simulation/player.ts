// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native player data and G_PlayerReborn defaults. See ../../LICENSE.
import { StateId } from './data/states';
import { WeaponType } from './data/weapons';

export const MAX_HEALTH = 100;

export enum CardType {
  it_bluecard = 0,
  it_yellowcard = 1,
  it_redcard = 2,
  it_blueskull = 3,
  it_yellowskull = 4,
  it_redskull = 5,
  NUMCARDS = 6,
}

export enum PowerType {
  pw_invulnerability = 0,
  pw_strength = 1,
  pw_invisibility = 2,
  pw_ironfeet = 3,
  pw_allmap = 4,
  pw_infrared = 5,
  NUMPOWERS = 6,
}

export enum CheatFlag {
  CF_NOCLIP = 1,
  CF_GODMODE = 2,
  CF_NOMOMENTUM = 4,
}

export enum WeaponSpriteSlot {
  ps_weapon = 0,
  ps_flash = 1,
  NUMPSPRITES = 2,
}

export interface WeaponSprite {
  state: StateId;
  tics: number;
  sx: number;
  sy: number;
}

export interface Player {
  actorId: number;
  state: 'alive' | 'dead' | 'reborn';
  health: number;
  armorPoints: number;
  armorType: number;
  ammo: number[];
  maxAmmo: number[];
  ownedWeapons: boolean[];
  readyWeapon: WeaponType;
  pendingWeapon: WeaponType;
  psprites: [WeaponSprite, WeaponSprite];
  cards: boolean[];
  powers: number[];
  backpack: boolean;
  didSecret: boolean;
  bonusCount: number;
  damageCount: number;
  killCount: number;
  itemCount: number;
  secretCount: number;
  viewZ: number;
  viewHeight: number;
  deltaViewHeight: number;
  bob: number;
  extraLight: number;
  fixedColormap: number;
  colormap: number;
  refire: number;
  attackDown: boolean;
  useDown: boolean;
  cheats: number;
  attacker: number | null;
  message: string | null;
}

export function createPlayer(): Player {
  return {
    actorId: -1, state: 'alive', health: MAX_HEALTH, armorPoints: 0, armorType: 0,
    ammo: [50, 0, 0, 0], maxAmmo: [200, 50, 300, 50],
    ownedWeapons: [true, true, false, false, false, false, false, false, false],
    readyWeapon: WeaponType.wp_pistol, pendingWeapon: WeaponType.wp_pistol,
    psprites: [
      { state: StateId.S_NULL, tics: 0, sx: 0, sy: 0 },
      { state: StateId.S_NULL, tics: 0, sx: 0, sy: 0 },
    ],
    cards: [false, false, false, false, false, false], powers: [0, 0, 0, 0, 0, 0],
    backpack: false, didSecret: false,
    bonusCount: 0, damageCount: 0, killCount: 0, itemCount: 0, secretCount: 0,
    viewZ: 0, viewHeight: 0, deltaViewHeight: 0, bob: 0,
    extraLight: 0, fixedColormap: 0, colormap: 0,
    refire: 0, attackDown: true, useDown: true, cheats: 0,
    attacker: null, message: null,
  };
}
