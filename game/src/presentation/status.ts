// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Doom status widgets and face priorities from st_stuff.c. See ../../LICENSE.
import { ANG45, ANG180, pointToAngle } from '../simulation/angle';
import { weapons, AmmoType } from '../simulation/data/weapons';
import { CheatFlag, PowerType } from '../simulation/player';
import { menuRandom } from '../simulation/random';
import type { World } from '../simulation/world';
import type { PatchPainter } from './patches';

export interface StatusBar {
  tick(world: World): void;
  draw(context: CanvasRenderingContext2D, world: World, palette: number): void;
}

export function createStatusBar(painter: PatchPainter): StatusBar {
  let worldIdentity: World | null = null, oldHealth = -1, owned: boolean[] = [];
  let priority = 0, count = 0, lastAttack = -1, face = 'STFST00';
  const number = (context: CanvasRenderingContext2D, value: number, x: number, y: number, small: boolean, palette: number): void => {
    const prefix = small ? 'STYSNUM' : 'STTNUM', width = small ? 4 : 14;
    const negative = value < 0;
    const digits = Math.min(999, Math.abs(value)).toString();
    for (let index = digits.length - 1; index >= 0; index--) {
      x -= width; painter.patch(context, prefix + digits[index], x, y, palette);
    }
    if (negative && !small) painter.patch(context, 'STTMINUS', x - 8, y, palette);
  };
  return {
    tick(world): void {
      const player = world.player, actor = world.actorsById.get(player.actorId);
      if (!actor) return;
      if (worldIdentity !== world) {
        worldIdentity = world; oldHealth = -1; owned = [...player.ownedWeapons];
        priority = count = 0; lastAttack = -1;
      }
      const random = menuRandom(world.random);
      const pain = Math.trunc((100 - Math.min(100, player.health)) * 5 / 101);
      if (priority < 10 && player.health === 0) { priority = 9; face = 'STFDEAD0'; count = 1; }
      if (priority < 9 && player.bonusCount !== 0) {
        const grin = owned.some((value, index) => value !== player.ownedWeapons[index]);
        owned = [...player.ownedWeapons];
        if (grin) { priority = 8; face = `STFEVL${pain}`; count = 70; }
      }
      if (priority < 8 && player.damageCount !== 0 && player.attacker !== null && player.attacker !== actor.id) {
        const attacker = world.actorsById.get(player.attacker);
        if (attacker) {
          priority = 7; count = 35;
          if (player.health - oldHealth > 20) face = `STFOUCH${pain}`; // Original inverted much-pain test.
          else {
            const angle = pointToAngle(actor.x, actor.y, attacker.x, attacker.y);
            const difference = angle > actor.angle ? angle - actor.angle : actor.angle - angle;
            const right = angle > actor.angle ? difference > ANG180 : difference <= ANG180;
            face = difference < ANG45 ? `STFKILL${pain}` : `STF${right ? 'TR' : 'TL'}${pain}0`;
          }
        }
      }
      if (priority < 7 && player.damageCount !== 0) {
        const muchPain = player.health - oldHealth > 20;
        priority = muchPain ? 7 : 6; count = 35; face = `STF${muchPain ? 'OUCH' : 'KILL'}${pain}`;
      }
      if (priority < 6) {
        if (player.attackDown) {
          if (lastAttack === -1) lastAttack = 70;
          else if (--lastAttack === 0) { priority = 5; face = `STFKILL${pain}`; count = 1; lastAttack = 1; }
        } else lastAttack = -1;
      }
      if (priority < 5 && ((player.cheats & CheatFlag.CF_GODMODE) !== 0 || player.powers[PowerType.pw_invulnerability])) {
        priority = 4; face = 'STFGOD0'; count = 1;
      }
      if (count === 0) { face = `STFST${pain}${random % 3}`; count = 17; priority = 0; }
      count--; oldHealth = player.health;
    },
    draw(context, world, palette): void {
      const player = world.player;
      painter.patch(context, 'STBAR', 0, 168, palette);
      painter.patch(context, 'STARMS', 104, 168, palette);
      const ammo = weapons[player.readyWeapon]?.ammo ?? AmmoType.am_noammo;
      if (ammo !== AmmoType.am_noammo) number(context, player.ammo[ammo] ?? 0, 44, 171, false, palette);
      number(context, player.health, 90, 171, false, palette); painter.patch(context, 'STTPRCNT', 90, 171, palette);
      number(context, player.armorPoints, 221, 171, false, palette); painter.patch(context, 'STTPRCNT', 221, 171, palette);
      painter.patch(context, face, 143, 168, palette);
      for (let index = 0; index < 6; index++) {
        painter.patch(context, `${player.ownedWeapons[index + 1] ? 'STYSNUM' : 'STGNUM'}${index + 2}`,
          111 + index % 3 * 12, 172 + Math.trunc(index / 3) * 10, palette);
      }
      for (let color = 0; color < 3; color++) {
        const key = player.cards[color + 3] ? color + 3 : player.cards[color] ? color : -1;
        if (key >= 0) painter.patch(context, `STKEYS${key}`, 239, 171 + color * 10, palette);
      }
      for (let ammoIndex = 0; ammoIndex < 4; ammoIndex++) {
        const y = [173, 179, 191, 185][ammoIndex] ?? 173;
        number(context, player.ammo[ammoIndex] ?? 0, 288, y, true, palette);
        number(context, player.maxAmmo[ammoIndex] ?? 0, 314, y, true, palette);
      }
    },
  };
}
