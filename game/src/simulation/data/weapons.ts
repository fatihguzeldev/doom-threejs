// Generated from id Software's original Doom tables. Do not edit by hand.
// Copyright (C) 1993-1996 id Software, Inc. GNU GPL version 2; see game/LICENSE.
// Source SHA: a77dfb96cb91780ca334d0d4cfd86957558007e0
// Regenerate with tools/generate-doom-data.ts.

import { StateId } from './states';

export enum WeaponType {
  wp_fist = 0,
  wp_pistol = 1,
  wp_shotgun = 2,
  wp_chaingun = 3,
  wp_missile = 4,
  wp_plasma = 5,
  wp_bfg = 6,
  wp_chainsaw = 7,
  wp_supershotgun = 8,
  NUMWEAPONS = 9,
  wp_nochange = 10,
}

export enum AmmoType {
  am_clip = 0,
  am_shell = 1,
  am_cell = 2,
  am_misl = 3,
  NUMAMMO = 4,
  am_noammo = 5,
}

export interface WeaponDefinition {
  readonly ammo: AmmoType;
  readonly upstate: StateId;
  readonly downstate: StateId;
  readonly readystate: StateId;
  readonly atkstate: StateId;
  readonly flashstate: StateId;
}

export const weapons: readonly WeaponDefinition[] = [
  // wp_fist
  { ammo: AmmoType.am_noammo, upstate: StateId.S_PUNCHUP, downstate: StateId.S_PUNCHDOWN, readystate: StateId.S_PUNCH, atkstate: StateId.S_PUNCH1, flashstate: StateId.S_NULL },
  // wp_pistol
  { ammo: AmmoType.am_clip, upstate: StateId.S_PISTOLUP, downstate: StateId.S_PISTOLDOWN, readystate: StateId.S_PISTOL, atkstate: StateId.S_PISTOL1, flashstate: StateId.S_PISTOLFLASH },
  // wp_shotgun
  { ammo: AmmoType.am_shell, upstate: StateId.S_SGUNUP, downstate: StateId.S_SGUNDOWN, readystate: StateId.S_SGUN, atkstate: StateId.S_SGUN1, flashstate: StateId.S_SGUNFLASH1 },
  // wp_chaingun
  { ammo: AmmoType.am_clip, upstate: StateId.S_CHAINUP, downstate: StateId.S_CHAINDOWN, readystate: StateId.S_CHAIN, atkstate: StateId.S_CHAIN1, flashstate: StateId.S_CHAINFLASH1 },
  // wp_missile
  { ammo: AmmoType.am_misl, upstate: StateId.S_MISSILEUP, downstate: StateId.S_MISSILEDOWN, readystate: StateId.S_MISSILE, atkstate: StateId.S_MISSILE1, flashstate: StateId.S_MISSILEFLASH1 },
  // wp_plasma
  { ammo: AmmoType.am_cell, upstate: StateId.S_PLASMAUP, downstate: StateId.S_PLASMADOWN, readystate: StateId.S_PLASMA, atkstate: StateId.S_PLASMA1, flashstate: StateId.S_PLASMAFLASH1 },
  // wp_bfg
  { ammo: AmmoType.am_cell, upstate: StateId.S_BFGUP, downstate: StateId.S_BFGDOWN, readystate: StateId.S_BFG, atkstate: StateId.S_BFG1, flashstate: StateId.S_BFGFLASH1 },
  // wp_chainsaw
  { ammo: AmmoType.am_noammo, upstate: StateId.S_SAWUP, downstate: StateId.S_SAWDOWN, readystate: StateId.S_SAW, atkstate: StateId.S_SAW1, flashstate: StateId.S_NULL },
  // wp_supershotgun
  { ammo: AmmoType.am_shell, upstate: StateId.S_DSGUNUP, downstate: StateId.S_DSGUNDOWN, readystate: StateId.S_DSGUN, atkstate: StateId.S_DSGUN1, flashstate: StateId.S_DSGUNFLASH1 },
];
