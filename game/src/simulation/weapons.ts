// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native player weapon states and attacks from p_pspr.c. See ../../LICENSE.
import { setActorState, type Actor } from './actors';
import { ANG90, ANG180, fineCos, fineSin, pointToAngle } from './angle';
import { idleCommand, TicButton, type TicCommand } from './command';
import { ActorType, MobjFlag, SfxId } from './data/actors';
import { ActionId, StateId, states } from './data/states';
import { AmmoType, WeaponType, weapons } from './data/weapons';
import { fixedMul, FRAC_UNIT } from './fixed';
import { PowerType, WeaponSpriteSlot, type WeaponSprite } from './player';
import { gameRandom } from './random';
import type { World } from './world';

export interface AimResult {
  readonly slope: number;
  readonly target: Actor | null;
}

export interface WeaponHooks {
  readonly runActorAction: (action: ActionId, actor: Actor) => void;
  readonly noiseAlert: (actor: Actor) => void;
  readonly aimLineAttack: (actor: Actor, angle: number, range: number) => AimResult;
  readonly lineAttack: (actor: Actor, angle: number, range: number, slope: number, damage: number) => Actor | null;
  readonly spawnPlayerMissile: (actor: Actor, type: ActorType) => void;
}

export interface WeaponSystem {
  setup(): void;
  drop(): void;
  move(command: TicCommand): void;
}

interface WeaponContext {
  readonly world: World;
  readonly hooks: WeaponHooks;
  command: TicCommand;
}

const TOP = 32 * FRAC_UNIT;
const BOTTOM = 128 * FRAC_UNIT;
const SPEED = 6 * FRAC_UNIT;
const MELEE_RANGE = 64 * FRAC_UNIT;
const MISSILE_RANGE = 32 * 64 * FRAC_UNIT;
type WeaponSlot = WeaponSpriteSlot.ps_weapon | WeaponSpriteSlot.ps_flash;

function actorOf(context: WeaponContext): Actor {
  const actor = context.world.actorsById.get(context.world.player.actorId);
  if (!actor) throw new Error('Weapon has no player actor');
  return actor;
}

function weaponInfo(context: WeaponContext) {
  const info = weapons[context.world.player.readyWeapon];
  if (!info) throw new Error('Invalid ready weapon');
  return info;
}

function sound(context: WeaponContext, sound: SfxId): void {
  context.world.events.push({ type: 'sound', sound, actor: actorOf(context).id });
}

function setSprite(context: WeaponContext, slot: WeaponSlot, stateId: StateId): void {
  const sprite = context.world.player.psprites[slot];
  if (!sprite) throw new Error('Invalid weapon sprite slot');
  do {
    if (stateId === StateId.S_NULL) {
      sprite.state = StateId.S_NULL;
      return;
    }
    const state = states[stateId];
    if (!state) throw new Error('Invalid weapon state');
    sprite.state = stateId;
    sprite.tics = state.tics;
    if (state.misc1 !== 0) {
      sprite.sx = state.misc1 << 16;
      sprite.sy = state.misc2 << 16;
    }
    if (state.action !== ActionId.None) {
      runAction(context, state.action, sprite);
      if ((sprite.state as StateId) === StateId.S_NULL) return;
    }
    // A nested action may replace the sprite state; follow that state's link.
    const current = states[sprite.state];
    if (!current) throw new Error('Weapon action entered an invalid state');
    stateId = current.nextstate;
  } while (sprite.tics === 0);
}

function bringUp(context: WeaponContext): void {
  const player = context.world.player;
  if (player.pendingWeapon === WeaponType.wp_nochange) player.pendingWeapon = player.readyWeapon;
  if (player.pendingWeapon === WeaponType.wp_chainsaw) sound(context, SfxId.sfx_sawup);
  const info = weapons[player.pendingWeapon];
  if (!info) throw new Error('Invalid pending weapon');
  player.pendingWeapon = WeaponType.wp_nochange;
  player.psprites[0].sy = BOTTOM;
  setSprite(context, WeaponSpriteSlot.ps_weapon, info.upstate);
}

function checkAmmo(context: WeaponContext): boolean {
  const { player, mode } = context.world;
  const info = weaponInfo(context);
  const count = player.readyWeapon === WeaponType.wp_bfg ? 40 :
    player.readyWeapon === WeaponType.wp_supershotgun ? 2 : 1;
  if (info.ammo === AmmoType.am_noammo || (player.ammo[info.ammo] ?? 0) >= count) return true;
  const has = (weapon: WeaponType, ammo: AmmoType, minimum = 1): boolean =>
    !!player.ownedWeapons[weapon] && (player.ammo[ammo] ?? 0) >= minimum;
  if (mode !== 'shareware' && has(WeaponType.wp_plasma, AmmoType.am_cell)) player.pendingWeapon = WeaponType.wp_plasma;
  else if (has(WeaponType.wp_chaingun, AmmoType.am_clip)) player.pendingWeapon = WeaponType.wp_chaingun;
  else if (has(WeaponType.wp_shotgun, AmmoType.am_shell)) player.pendingWeapon = WeaponType.wp_shotgun;
  else if (player.ammo[AmmoType.am_clip]) player.pendingWeapon = WeaponType.wp_pistol;
  else if (player.ownedWeapons[WeaponType.wp_chainsaw]) player.pendingWeapon = WeaponType.wp_chainsaw;
  else if (has(WeaponType.wp_missile, AmmoType.am_misl)) player.pendingWeapon = WeaponType.wp_missile;
  else if (mode !== 'shareware' && has(WeaponType.wp_bfg, AmmoType.am_cell, 41)) player.pendingWeapon = WeaponType.wp_bfg;
  else player.pendingWeapon = WeaponType.wp_fist;
  setSprite(context, WeaponSpriteSlot.ps_weapon, info.downstate);
  return false;
}

function fire(context: WeaponContext): void {
  if (!checkAmmo(context)) return;
  const actor = actorOf(context);
  setActorState(actor, StateId.S_PLAY_ATK1, context.hooks.runActorAction);
  setSprite(context, WeaponSpriteSlot.ps_weapon, weaponInfo(context).atkstate);
  context.hooks.noiseAlert(actor);
}

function ready(context: WeaponContext, sprite: WeaponSprite): void {
  const { world, command } = context;
  const player = world.player, actor = actorOf(context);
  if (actor.state === StateId.S_PLAY_ATK1 || actor.state === StateId.S_PLAY_ATK2) {
    setActorState(actor, StateId.S_PLAY, context.hooks.runActorAction);
  }
  if (player.readyWeapon === WeaponType.wp_chainsaw && sprite.state === StateId.S_SAW) sound(context, SfxId.sfx_sawidl);
  if (player.pendingWeapon !== WeaponType.wp_nochange || player.health === 0) {
    setSprite(context, WeaponSpriteSlot.ps_weapon, weaponInfo(context).downstate);
    return;
  }
  if ((command.buttons & TicButton.attack) !== 0) {
    if (!player.attackDown || (player.readyWeapon !== WeaponType.wp_missile && player.readyWeapon !== WeaponType.wp_bfg)) {
      player.attackDown = true;
      fire(context);
      return;
    }
  } else player.attackDown = false;
  const angle = (128 * world.levelTime) & 8191;
  sprite.sx = (FRAC_UNIT + fixedMul(player.bob, fineCos(angle << 19))) | 0;
  sprite.sy = (TOP + fixedMul(player.bob, fineSin((angle & 4095) << 19))) | 0;
}

function lower(context: WeaponContext, sprite: WeaponSprite): void {
  const player = context.world.player;
  sprite.sy = (sprite.sy + SPEED) | 0;
  if (sprite.sy < BOTTOM) return;
  if (player.state === 'dead') { sprite.sy = BOTTOM; return; }
  if (player.health === 0) { setSprite(context, WeaponSpriteSlot.ps_weapon, StateId.S_NULL); return; }
  player.readyWeapon = player.pendingWeapon;
  bringUp(context);
}

function flash(context: WeaponContext, offset = 0): void {
  setSprite(context, WeaponSpriteSlot.ps_flash, weaponInfo(context).flashstate + offset);
}

function consumeAmmo(context: WeaponContext, count = 1): void {
  const ammo = weaponInfo(context).ammo;
  const value = context.world.player.ammo[ammo];
  if (value === undefined) throw new Error('Weapon consumes an unavailable ammo type');
  context.world.player.ammo[ammo] = value - count;
}

function bulletSlope(context: WeaponContext): number {
  const actor = actorOf(context), hooks = context.hooks;
  const range = 16 * 64 * FRAC_UNIT;
  let aim = hooks.aimLineAttack(actor, actor.angle, range);
  if (aim.target === null) {
    aim = hooks.aimLineAttack(actor, (actor.angle + (1 << 26)) >>> 0, range);
    if (aim.target === null) aim = hooks.aimLineAttack(actor, (actor.angle - (1 << 26)) >>> 0, range);
  }
  return aim.slope;
}

function gunShot(context: WeaponContext, slope: number, accurate: boolean): void {
  const actor = actorOf(context), random = context.world.random;
  const damage = 5 * (gameRandom(random) % 3 + 1);
  let angle = actor.angle;
  if (!accurate) angle = (angle + ((gameRandom(random) - gameRandom(random)) << 18)) >>> 0;
  context.hooks.lineAttack(actor, angle, MISSILE_RANGE, slope, damage);
}

function melee(context: WeaponContext, saw: boolean): void {
  const { world, hooks } = context, actor = actorOf(context);
  let damage = 2 * (gameRandom(world.random) % 10 + 1);
  if (!saw && world.player.powers[PowerType.pw_strength]) damage *= 10;
  const angle = (actor.angle + ((gameRandom(world.random) - gameRandom(world.random)) << 18)) >>> 0;
  const range = MELEE_RANGE + (saw ? 1 : 0);
  const aim = hooks.aimLineAttack(actor, angle, range);
  hooks.lineAttack(actor, angle, range, aim.slope, damage);
  // P_LineAttack does not change the linetarget left by P_AimLineAttack.
  const target = aim.target;
  if (!saw) {
    if (target !== null) {
      sound(context, SfxId.sfx_punch);
      actor.angle = pointToAngle(actor.x, actor.y, target.x, target.y);
    }
    return;
  }
  if (target === null) { sound(context, SfxId.sfx_sawful); return; }
  sound(context, SfxId.sfx_sawhit);
  const targetAngle = pointToAngle(actor.x, actor.y, target.x, target.y);
  const delta = (targetAngle - actor.angle) >>> 0;
  const step = Math.trunc(ANG90 / 20), offset = Math.trunc(ANG90 / 21);
  if (delta > ANG180) actor.angle = (delta < (-step >>> 0) ? targetAngle + offset : actor.angle - step) >>> 0;
  else actor.angle = (delta > step ? targetAngle - offset : actor.angle + step) >>> 0;
  actor.flags |= MobjFlag.MF_JUSTATTACKED;
}

function runAction(context: WeaponContext, action: ActionId, sprite: WeaponSprite): void {
  const { world, hooks } = context, player = world.player;
  switch (action) {
    case ActionId.A_WeaponReady: ready(context, sprite); break;
    case ActionId.A_Lower: lower(context, sprite); break;
    case ActionId.A_Raise:
      sprite.sy = (sprite.sy - SPEED) | 0;
      if (sprite.sy <= TOP) { sprite.sy = TOP; setSprite(context, WeaponSpriteSlot.ps_weapon, weaponInfo(context).readystate); }
      break;
    case ActionId.A_ReFire:
      if ((context.command.buttons & TicButton.attack) !== 0 && player.pendingWeapon === WeaponType.wp_nochange && player.health !== 0) {
        player.refire++; fire(context);
      } else { player.refire = 0; checkAmmo(context); }
      break;
    case ActionId.A_CheckReload: checkAmmo(context); break;
    case ActionId.A_GunFlash:
      setActorState(actorOf(context), StateId.S_PLAY_ATK2, hooks.runActorAction); flash(context); break;
    case ActionId.A_Light0: player.extraLight = 0; break;
    case ActionId.A_Light1: player.extraLight = 1; break;
    case ActionId.A_Light2: player.extraLight = 2; break;
    case ActionId.A_Punch: melee(context, false); break;
    case ActionId.A_Saw: melee(context, true); break;
    case ActionId.A_FireMissile: consumeAmmo(context); hooks.spawnPlayerMissile(actorOf(context), ActorType.MT_ROCKET); break;
    case ActionId.A_FireBFG: consumeAmmo(context, 40); hooks.spawnPlayerMissile(actorOf(context), ActorType.MT_BFG); break;
    case ActionId.A_FirePlasma:
      consumeAmmo(context); flash(context, gameRandom(world.random) & 1);
      hooks.spawnPlayerMissile(actorOf(context), ActorType.MT_PLASMA); break;
    case ActionId.A_FirePistol:
      sound(context, SfxId.sfx_pistol);
      setActorState(actorOf(context), StateId.S_PLAY_ATK2, hooks.runActorAction);
      consumeAmmo(context); flash(context); gunShot(context, bulletSlope(context), player.refire === 0); break;
    case ActionId.A_FireShotgun:
      sound(context, SfxId.sfx_shotgn);
      setActorState(actorOf(context), StateId.S_PLAY_ATK2, hooks.runActorAction);
      consumeAmmo(context); flash(context);
      { const slope = bulletSlope(context); for (let i = 0; i < 7; i++) gunShot(context, slope, false); }
      break;
    case ActionId.A_FireCGun:
      sound(context, SfxId.sfx_pistol);
      if (!player.ammo[weaponInfo(context).ammo]) break;
      setActorState(actorOf(context), StateId.S_PLAY_ATK2, hooks.runActorAction);
      consumeAmmo(context); flash(context, sprite.state - StateId.S_CHAIN1);
      gunShot(context, bulletSlope(context), player.refire === 0); break;
    case ActionId.A_BFGsound: sound(context, SfxId.sfx_bfg); break;
    default: throw new Error(`Unsupported player weapon action ${ActionId[action]}`);
  }
}

export function createWeapons(world: World, hooks: WeaponHooks): WeaponSystem {
  const context: WeaponContext = { world, hooks, command: idleCommand };
  return {
    setup: () => {
      for (const sprite of world.player.psprites) sprite.state = StateId.S_NULL;
      world.player.pendingWeapon = world.player.readyWeapon;
      bringUp(context);
    },
    drop: () => setSprite(context, WeaponSpriteSlot.ps_weapon, weaponInfo(context).downstate),
    move: command => {
      context.command = command;
      for (const slot of [WeaponSpriteSlot.ps_weapon, WeaponSpriteSlot.ps_flash] as const) {
        const sprite = world.player.psprites[slot];
        if (sprite.state !== StateId.S_NULL && sprite.tics !== -1 && --sprite.tics === 0) {
          const state = states[sprite.state];
          if (!state) throw new Error('Invalid weapon sprite state');
          setSprite(context, slot, state.nextstate);
        }
      }
      const [weapon, flash] = world.player.psprites;
      flash.sx = weapon.sx;
      flash.sy = weapon.sy;
    },
  };
}
