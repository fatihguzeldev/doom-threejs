// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native Doom I P_TouchSpecialThing and d_englsh.h pickup strings. See ../../LICENSE.
import type { Actor } from './actors';
import { MobjFlag, SfxId } from './data/actors';
import { SpriteId } from './data/states';
import { AmmoType, WeaponType } from './data/weapons';
import { FRAC_UNIT } from './fixed';
import { BONUS_ADD, giveAmmo, giveArmor, giveBackpack, giveBody, giveCard, givePower, giveWeapon } from './inventory';
import { CardType, PowerType } from './player';
import { removeActor, type World } from './world';

export function touchSpecialThing(world: World, special: Actor, toucher: Actor): void {
  if (special.removed || toucher.removed || toucher.player !== 0 || toucher.id !== world.player.actorId) return;
  const delta = (special.z - toucher.z) | 0;
  if (delta > toucher.height || delta < -8 * FRAC_UNIT || toucher.health <= 0) return;
  const player = world.player;
  let sound = SfxId.sfx_itemup;
  let message: string | null = null;

  switch (special.sprite) {
    case SpriteId.SPR_ARM1:
      if (!giveArmor(player, 1)) return;
      message = 'Picked up the armor.';
      break;
    case SpriteId.SPR_ARM2:
      if (!giveArmor(player, 2)) return;
      message = 'Picked up the MegaArmor!';
      break;
    case SpriteId.SPR_BON1:
      player.health = Math.min(player.health + 1, 200);
      toucher.health = player.health;
      message = 'Picked up a health bonus.';
      break;
    case SpriteId.SPR_BON2:
      player.armorPoints = Math.min(player.armorPoints + 1, 200);
      if (player.armorType === 0) player.armorType = 1;
      message = 'Picked up an armor bonus.';
      break;
    case SpriteId.SPR_SOUL:
      player.health = Math.min(player.health + 100, 200);
      toucher.health = player.health;
      message = 'Supercharge!';
      sound = SfxId.sfx_getpow;
      break;
    case SpriteId.SPR_MEGA:
      // The original commercial-only megasphere is not collectible in Doom I.
      return;
    case SpriteId.SPR_BKEY:
      if (!player.cards[CardType.it_bluecard]) message = 'Picked up a blue keycard.';
      giveCard(player, CardType.it_bluecard);
      break;
    case SpriteId.SPR_YKEY:
      if (!player.cards[CardType.it_yellowcard]) message = 'Picked up a yellow keycard.';
      giveCard(player, CardType.it_yellowcard);
      break;
    case SpriteId.SPR_RKEY:
      if (!player.cards[CardType.it_redcard]) message = 'Picked up a red keycard.';
      giveCard(player, CardType.it_redcard);
      break;
    case SpriteId.SPR_BSKU:
      if (!player.cards[CardType.it_blueskull]) message = 'Picked up a blue skull key.';
      giveCard(player, CardType.it_blueskull);
      break;
    case SpriteId.SPR_YSKU:
      if (!player.cards[CardType.it_yellowskull]) message = 'Picked up a yellow skull key.';
      giveCard(player, CardType.it_yellowskull);
      break;
    case SpriteId.SPR_RSKU:
      if (!player.cards[CardType.it_redskull]) message = 'Picked up a red skull key.';
      giveCard(player, CardType.it_redskull);
      break;
    case SpriteId.SPR_STIM:
      if (!giveBody(player, 10, toucher)) return;
      message = 'Picked up a stimpack.';
      break;
    case SpriteId.SPR_MEDI:
      if (!giveBody(player, 25, toucher)) return;
      // This original test happens after healing, including its unreachable
      // urgent message for a living player's ordinary positive health.
      message = player.health < 25
        ? 'Picked up a medikit that you REALLY need!' : 'Picked up a medikit.';
      break;
    case SpriteId.SPR_PINV:
      if (!givePower(player, PowerType.pw_invulnerability, toucher)) return;
      message = 'Invulnerability!';
      sound = SfxId.sfx_getpow;
      break;
    case SpriteId.SPR_PSTR:
      if (!givePower(player, PowerType.pw_strength, toucher)) return;
      message = 'Berserk!';
      if (player.readyWeapon !== WeaponType.wp_fist) player.pendingWeapon = WeaponType.wp_fist;
      sound = SfxId.sfx_getpow;
      break;
    case SpriteId.SPR_PINS:
      if (!givePower(player, PowerType.pw_invisibility, toucher)) return;
      message = 'Partial Invisibility';
      sound = SfxId.sfx_getpow;
      break;
    case SpriteId.SPR_SUIT:
      if (!givePower(player, PowerType.pw_ironfeet, toucher)) return;
      message = 'Radiation Shielding Suit';
      sound = SfxId.sfx_getpow;
      break;
    case SpriteId.SPR_PMAP:
      if (!givePower(player, PowerType.pw_allmap, toucher)) return;
      message = 'Computer Area Map';
      sound = SfxId.sfx_getpow;
      break;
    case SpriteId.SPR_PVIS:
      if (!givePower(player, PowerType.pw_infrared, toucher)) return;
      message = 'Light Amplification Visor';
      sound = SfxId.sfx_getpow;
      break;
    case SpriteId.SPR_CLIP:
      if (!giveAmmo(player, AmmoType.am_clip, (special.flags & MobjFlag.MF_DROPPED) !== 0 ? 0 : 1, world.skill)) return;
      message = 'Picked up a clip.';
      break;
    case SpriteId.SPR_AMMO:
      if (!giveAmmo(player, AmmoType.am_clip, 5, world.skill)) return;
      message = 'Picked up a box of bullets.';
      break;
    case SpriteId.SPR_ROCK:
      if (!giveAmmo(player, AmmoType.am_misl, 1, world.skill)) return;
      message = 'Picked up a rocket.';
      break;
    case SpriteId.SPR_BROK:
      if (!giveAmmo(player, AmmoType.am_misl, 5, world.skill)) return;
      message = 'Picked up a box of rockets.';
      break;
    case SpriteId.SPR_CELL:
      if (!giveAmmo(player, AmmoType.am_cell, 1, world.skill)) return;
      message = 'Picked up an energy cell.';
      break;
    case SpriteId.SPR_CELP:
      if (!giveAmmo(player, AmmoType.am_cell, 5, world.skill)) return;
      message = 'Picked up an energy cell pack.';
      break;
    case SpriteId.SPR_SHEL:
      if (!giveAmmo(player, AmmoType.am_shell, 1, world.skill)) return;
      message = 'Picked up 4 shotgun shells.';
      break;
    case SpriteId.SPR_SBOX:
      if (!giveAmmo(player, AmmoType.am_shell, 5, world.skill)) return;
      message = 'Picked up a box of shotgun shells.';
      break;
    case SpriteId.SPR_BPAK:
      giveBackpack(player, world.skill);
      message = 'Picked up a backpack full of ammo!';
      break;
    case SpriteId.SPR_BFUG:
      if (!giveWeapon(player, WeaponType.wp_bfg, false, world.skill)) return;
      message = 'You got the BFG9000!  Oh, yes.';
      sound = SfxId.sfx_wpnup;
      break;
    case SpriteId.SPR_MGUN:
      if (!giveWeapon(player, WeaponType.wp_chaingun, (special.flags & MobjFlag.MF_DROPPED) !== 0, world.skill)) return;
      message = 'You got the chaingun!';
      sound = SfxId.sfx_wpnup;
      break;
    case SpriteId.SPR_CSAW:
      if (!giveWeapon(player, WeaponType.wp_chainsaw, false, world.skill)) return;
      message = 'A chainsaw!  Find some meat!';
      sound = SfxId.sfx_wpnup;
      break;
    case SpriteId.SPR_LAUN:
      if (!giveWeapon(player, WeaponType.wp_missile, false, world.skill)) return;
      message = 'You got the rocket launcher!';
      sound = SfxId.sfx_wpnup;
      break;
    case SpriteId.SPR_PLAS:
      if (!giveWeapon(player, WeaponType.wp_plasma, false, world.skill)) return;
      message = 'You got the plasma gun!';
      sound = SfxId.sfx_wpnup;
      break;
    case SpriteId.SPR_SHOT:
      if (!giveWeapon(player, WeaponType.wp_shotgun, (special.flags & MobjFlag.MF_DROPPED) !== 0, world.skill)) return;
      message = 'You got the shotgun!';
      sound = SfxId.sfx_wpnup;
      break;
    case SpriteId.SPR_SGN2:
      if (!giveWeapon(player, WeaponType.wp_supershotgun, (special.flags & MobjFlag.MF_DROPPED) !== 0, world.skill)) return;
      message = 'You got the super shotgun!';
      sound = SfxId.sfx_wpnup;
      break;
    default:
      throw new Error('P_SpecialThing: Unknown gettable thing');
  }

  if (message !== null) {
    player.message = message;
    world.events.push({ type: 'message', text: message });
  }
  if ((special.flags & MobjFlag.MF_COUNTITEM) !== 0) player.itemCount++;
  removeActor(world, special);
  player.bonusCount += BONUS_ADD;
  // S_StartSound(NULL, sound) uses the global channel origin, not the player.
  world.events.push({ type: 'sound', sound, actor: null });
}
