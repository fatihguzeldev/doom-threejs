// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native player tic, view height and power counters from p_user.c. See ../../LICENSE.
import { setActorState, type Actor } from './actors';
import { ANG90, ANG180, fineCos, fineSin, pointToAngle } from './angle';
import { TicButton, WEAPON_MASK, WEAPON_SHIFT, type TicCommand } from './command';
import { MobjFlag } from './data/actors';
import { StateId, type ActionId } from './data/states';
import { WeaponType } from './data/weapons';
import { fixedMul, FRAC_UNIT } from './fixed';
import { CheatFlag, PowerType } from './player';
import type { World } from './world';

export interface PlayerHooks {
  readonly runActorAction: (action: ActionId, actor: Actor) => void;
  readonly moveWeaponSprites: (command: TicCommand) => void;
  readonly useLines: (actor: Actor) => void;
  readonly playerInSpecialSector: (actor: Actor) => void;
}

const VIEW_HEIGHT = 41 * FRAC_UNIT;
const ANG5 = Math.trunc(ANG90 / 18);

function thrust(actor: Actor, angle: number, amount: number): void {
  actor.momx = (actor.momx + fixedMul(amount, fineCos(angle))) | 0;
  actor.momy = (actor.momy + fixedMul(amount, fineSin(angle))) | 0;
}

function calculateHeight(world: World, actor: Actor): void {
  const player = world.player;
  player.bob = ((fixedMul(actor.momx, actor.momx) + fixedMul(actor.momy, actor.momy)) | 0) >> 2;
  if (player.bob > 0x100000) player.bob = 0x100000;
  if ((player.cheats & CheatFlag.CF_NOMOMENTUM) !== 0 || !world.onGround) {
    // The original airborne branch overwrote its own ceiling clamp.
    player.viewZ = (actor.z + player.viewHeight) | 0;
    return;
  }
  const bobAngle = (409 * world.levelTime) & 8191;
  const bob = fixedMul(Math.trunc(player.bob / 2), fineSin(bobAngle << 19));
  if (player.state === 'alive') {
    player.viewHeight = (player.viewHeight + player.deltaViewHeight) | 0;
    if (player.viewHeight > VIEW_HEIGHT) {
      player.viewHeight = VIEW_HEIGHT;
      player.deltaViewHeight = 0;
    }
    if (player.viewHeight < VIEW_HEIGHT / 2) {
      player.viewHeight = VIEW_HEIGHT / 2;
      if (player.deltaViewHeight <= 0) player.deltaViewHeight = 1;
    }
    if (player.deltaViewHeight !== 0) {
      player.deltaViewHeight = (player.deltaViewHeight + FRAC_UNIT / 4) | 0;
      if (player.deltaViewHeight === 0) player.deltaViewHeight = 1;
    }
  }
  player.viewZ = (actor.z + player.viewHeight + bob) | 0;
  player.viewZ = Math.min(player.viewZ, actor.ceilingZ - 4 * FRAC_UNIT);
}

function deathThink(world: World, actor: Actor, command: TicCommand, hooks: PlayerHooks): void {
  const player = world.player;
  hooks.moveWeaponSprites(command);
  player.viewHeight = Math.max(6 * FRAC_UNIT, player.viewHeight - FRAC_UNIT);
  player.deltaViewHeight = 0;
  world.onGround = actor.z <= actor.floorZ;
  calculateHeight(world, actor);
  const attacker = player.attacker === null ? undefined : world.actorsById.get(player.attacker);
  if (attacker !== undefined && attacker.id !== actor.id) {
    const angle = pointToAngle(actor.x, actor.y, attacker.x, attacker.y);
    const delta = (angle - actor.angle) >>> 0;
    if (delta < ANG5 || delta > (-ANG5 >>> 0)) {
      actor.angle = angle;
      if (player.damageCount !== 0) player.damageCount--;
    } else {
      actor.angle = (actor.angle + (delta < ANG180 ? ANG5 : -ANG5)) >>> 0;
    }
  } else if (player.damageCount !== 0) player.damageCount--;
  if ((command.buttons & TicButton.use) !== 0) player.state = 'reborn';
}

export function thinkPlayer(world: World, input: TicCommand, hooks: PlayerHooks): TicCommand {
  const player = world.player;
  const actor = world.actorsById.get(player.actorId);
  if (actor === undefined) throw new Error('Player actor is missing');
  let command = input;
  if ((player.cheats & CheatFlag.CF_NOCLIP) !== 0) actor.flags |= MobjFlag.MF_NOCLIP;
  else actor.flags &= ~MobjFlag.MF_NOCLIP;
  if ((actor.flags & MobjFlag.MF_JUSTATTACKED) !== 0) {
    command = { ...command, forwardMove: 100, sideMove: 0, angleTurn: 0 };
    actor.flags &= ~MobjFlag.MF_JUSTATTACKED;
  }
  if (player.state === 'dead') {
    deathThink(world, actor, command, hooks);
    return command;
  }
  if (actor.reactionTime !== 0) actor.reactionTime--;
  else {
    actor.angle = (actor.angle + (command.angleTurn << 16)) >>> 0;
    world.onGround = actor.z <= actor.floorZ;
    if (world.onGround) {
      if (command.forwardMove !== 0) thrust(actor, actor.angle, command.forwardMove * 2048);
      if (command.sideMove !== 0) thrust(actor, (actor.angle - ANG90) >>> 0, command.sideMove * 2048);
    }
    if ((command.forwardMove !== 0 || command.sideMove !== 0) && actor.state === StateId.S_PLAY) {
      setActorState(actor, StateId.S_PLAY_RUN1, hooks.runActorAction);
    }
  }
  calculateHeight(world, actor);
  if (world.sectors[actor.sector]?.special !== 0) hooks.playerInSpecialSector(actor);
  if ((command.buttons & TicButton.special) !== 0) command = { ...command, buttons: 0 };
  if ((command.buttons & TicButton.changeWeapon) !== 0) {
    let weapon = (command.buttons & WEAPON_MASK) >> WEAPON_SHIFT;
    if (weapon === WeaponType.wp_fist && player.ownedWeapons[WeaponType.wp_chainsaw] &&
      !(player.readyWeapon === WeaponType.wp_chainsaw && player.powers[PowerType.pw_strength])) {
      weapon = WeaponType.wp_chainsaw;
    }
    if (player.ownedWeapons[weapon] && weapon !== player.readyWeapon &&
      (world.mode !== 'shareware' || (weapon !== WeaponType.wp_plasma && weapon !== WeaponType.wp_bfg))) {
      player.pendingWeapon = weapon;
    }
  }
  if ((command.buttons & TicButton.use) !== 0) {
    if (!player.useDown) {
      hooks.useLines(actor);
      player.useDown = true;
    }
  } else player.useDown = false;
  hooks.moveWeaponSprites(command);
  if (player.powers[PowerType.pw_strength]) player.powers[PowerType.pw_strength]++;
  for (const power of [PowerType.pw_invulnerability, PowerType.pw_infrared, PowerType.pw_ironfeet]) {
    if (player.powers[power]) player.powers[power]--;
  }
  if (player.powers[PowerType.pw_invisibility] && --player.powers[PowerType.pw_invisibility] === 0) {
    actor.flags &= ~MobjFlag.MF_SHADOW;
  }
  if (player.damageCount !== 0) player.damageCount--;
  if (player.bonusCount !== 0) player.bonusCount--;
  const invulnerability = player.powers[PowerType.pw_invulnerability] ?? 0;
  const infrared = player.powers[PowerType.pw_infrared] ?? 0;
  player.fixedColormap = invulnerability ? (invulnerability > 128 || (invulnerability & 8) ? 32 : 0) :
    infrared ? (infrared > 128 || (infrared & 8) ? 1 : 0) : 0;
  return command;
}
