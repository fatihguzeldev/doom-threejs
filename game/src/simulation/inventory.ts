// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native singleplayer pickup rules from linuxdoom-1.10/p_inter.c. See ../../LICENSE.
import type { Actor } from './actors';
import { MobjFlag } from './data/actors';
import { AmmoType, WeaponType, weapons } from './data/weapons';
import { MAX_HEALTH, PowerType, type CardType, type Player } from './player';

export const BONUS_ADD = 6;
const clipAmmo: readonly number[] = [10, 4, 20, 1];

export function giveAmmo(player: Player, ammo: AmmoType, numClips: number, skill: number): boolean {
  if (ammo === AmmoType.am_noammo) return false;
  const clip = clipAmmo[ammo];
  const oldAmmo = player.ammo[ammo];
  const maximum = player.maxAmmo[ammo];
  if (clip === undefined || oldAmmo === undefined || maximum === undefined) {
    throw new RangeError(`Unknown ammo type ${ammo}`);
  }
  if (oldAmmo === maximum) return false;
  let amount = numClips !== 0 ? numClips * clip : Math.trunc(clip / 2);
  if (skill === 0 || skill === 4) amount *= 2;
  player.ammo[ammo] = Math.min(oldAmmo + amount, maximum);
  if (oldAmmo !== 0) return true;

  // Only zero ammo triggers these original hardcoded weapon preferences.
  switch (ammo) {
    case AmmoType.am_clip:
      if (player.readyWeapon === WeaponType.wp_fist) {
        player.pendingWeapon = player.ownedWeapons[WeaponType.wp_chaingun]
          ? WeaponType.wp_chaingun : WeaponType.wp_pistol;
      }
      break;
    case AmmoType.am_shell:
      if ((player.readyWeapon === WeaponType.wp_fist || player.readyWeapon === WeaponType.wp_pistol)
        && player.ownedWeapons[WeaponType.wp_shotgun]) {
        player.pendingWeapon = WeaponType.wp_shotgun;
      }
      break;
    case AmmoType.am_cell:
      if ((player.readyWeapon === WeaponType.wp_fist || player.readyWeapon === WeaponType.wp_pistol)
        && player.ownedWeapons[WeaponType.wp_plasma]) {
        player.pendingWeapon = WeaponType.wp_plasma;
      }
      break;
    case AmmoType.am_misl:
      if (player.readyWeapon === WeaponType.wp_fist && player.ownedWeapons[WeaponType.wp_missile]) {
        player.pendingWeapon = WeaponType.wp_missile;
      }
      break;
  }
  return true;
}

export function giveWeapon(player: Player, weapon: WeaponType, dropped: boolean, skill: number): boolean {
  const info = weapons[weapon];
  if (info === undefined) throw new RangeError(`Unknown weapon type ${weapon}`);
  const gaveAmmo = info.ammo !== AmmoType.am_noammo
    && giveAmmo(player, info.ammo, dropped ? 1 : 2, skill);
  const gaveWeapon = !player.ownedWeapons[weapon];
  if (gaveWeapon) {
    player.ownedWeapons[weapon] = true;
    player.pendingWeapon = weapon;
  }
  return gaveWeapon || gaveAmmo;
}

export function giveBody(player: Player, amount: number, actor: Actor): boolean {
  if (player.health >= MAX_HEALTH) return false;
  player.health = Math.min(player.health + amount, MAX_HEALTH);
  actor.health = player.health;
  return true;
}

export function giveArmor(player: Player, armorType: number): boolean {
  const points = armorType * 100;
  if (player.armorPoints >= points) return false;
  player.armorType = armorType;
  player.armorPoints = points;
  return true;
}

export function giveCard(player: Player, card: CardType): void {
  if (player.cards[card] === undefined) throw new RangeError(`Unknown card type ${card}`);
  if (player.cards[card]) return;
  player.bonusCount = BONUS_ADD;
  player.cards[card] = true;
}

export function givePower(player: Player, power: PowerType, actor: Actor): boolean {
  if (player.powers[power] === undefined) throw new RangeError(`Unknown power type ${power}`);
  switch (power) {
    case PowerType.pw_invulnerability:
      player.powers[power] = 30 * 35;
      return true;
    case PowerType.pw_invisibility:
      player.powers[power] = 60 * 35;
      actor.flags |= MobjFlag.MF_SHADOW;
      return true;
    case PowerType.pw_infrared:
      player.powers[power] = 120 * 35;
      return true;
    case PowerType.pw_ironfeet:
      player.powers[power] = 60 * 35;
      return true;
    case PowerType.pw_strength:
      giveBody(player, 100, actor);
      player.powers[power] = 1;
      return true;
    default:
      if (player.powers[power]) return false;
      player.powers[power] = 1;
      return true;
  }
}

export function giveBackpack(player: Player, skill: number): void {
  if (!player.backpack) {
    for (let ammo = 0; ammo < AmmoType.NUMAMMO; ammo++) {
      const maximum = player.maxAmmo[ammo];
      if (maximum === undefined) throw new RangeError(`Missing maximum for ammo type ${ammo}`);
      player.maxAmmo[ammo] = maximum * 2;
    }
    player.backpack = true;
  }
  for (let ammo = 0; ammo < AmmoType.NUMAMMO; ammo++) giveAmmo(player, ammo, 1, skill);
}
