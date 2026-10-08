import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeMap } from '../../src/wad/map';
import { parseWad } from '../../src/wad/archive';
import { createWorld } from '../../src/simulation/world';
import { thinkPlayer, type PlayerHooks } from '../../src/simulation/player-thinking';
import { idleCommand, TicButton } from '../../src/simulation/command';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { MobjFlag } from '../../src/simulation/data/actors';
import { WeaponType } from '../../src/simulation/data/weapons';
import { CheatFlag, PowerType } from '../../src/simulation/player';
import { ANG90 } from '../../src/simulation/angle';
import { ActorType } from '../../src/simulation/data/actors';
import { spawnActor } from '../../src/simulation/world';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');
const hooks: PlayerHooks = {
  runActorAction: () => {},
  moveWeaponSprites: () => {},
  useLines: () => {},
  playerInSpecialSector: () => {},
};

describe('original player tic behavior', () => {
  it('accelerates only while grounded and quantizes turns as signed tic commands', () => {
    const world = createWorld(map, { skill: 2 });
    const actor = world.actorsById.get(world.player.actorId);
    if (!actor) throw new Error('Player missing');
    actor.angle = 0;
    thinkPlayer(world, { ...idleCommand, forwardMove: 25 }, hooks);
    expect(actor.momx).toBe(51199);
    expect(actor.momy).toBe(19);
    actor.z += 8 * FRAC_UNIT;
    const momentum = { x: actor.momx, y: actor.momy };
    thinkPlayer(world, { ...idleCommand, forwardMove: 25, angleTurn: -640 }, hooks);
    expect(actor.angle).toBe((-640 << 16) >>> 0);
    expect({ x: actor.momx, y: actor.momy }).toEqual(momentum);
  });

  it('keeps teleport reaction time and ground status without applying movement', () => {
    const world = createWorld(map, { skill: 2 });
    const actor = world.actorsById.get(world.player.actorId);
    if (!actor) throw new Error('Player missing');
    actor.reactionTime = 2;
    world.onGround = false;
    const angle = actor.angle;
    thinkPlayer(world, { ...idleCommand, forwardMove: 50, angleTurn: 640 }, hooks);
    expect(actor.reactionTime).toBe(1);
    expect(actor.angle).toBe(angle);
    expect(actor.momx).toBe(0);
    expect(world.onGround).toBe(false);
  });

  it('activates use once per button press and consumes special button payloads', () => {
    const world = createWorld(map, { skill: 2 });
    let activations = 0;
    const activeHooks = { ...hooks, useLines: () => { activations++; } };
    thinkPlayer(world, idleCommand, activeHooks);
    thinkPlayer(world, { ...idleCommand, buttons: TicButton.use }, activeHooks);
    thinkPlayer(world, { ...idleCommand, buttons: TicButton.use }, activeHooks);
    expect(activations).toBe(1);
    thinkPlayer(world, idleCommand, activeHooks);
    const consumed = thinkPlayer(world, { ...idleCommand, buttons: TicButton.special | TicButton.use }, activeHooks);
    expect(consumed.buttons).toBe(0);
    expect(activations).toBe(1);
  });

  it('uses the chainsaw on the fist key while retaining the berserk toggle', () => {
    const world = createWorld(map, { skill: 2 });
    world.player.ownedWeapons[WeaponType.wp_chainsaw] = true;
    thinkPlayer(world, { ...idleCommand, buttons: TicButton.changeWeapon }, hooks);
    expect(world.player.pendingWeapon).toBe(WeaponType.wp_chainsaw);
    world.player.readyWeapon = WeaponType.wp_chainsaw;
    world.player.powers[PowerType.pw_strength] = 1;
    thinkPlayer(world, { ...idleCommand, buttons: TicButton.changeWeapon }, hooks);
    expect(world.player.pendingWeapon).toBe(WeaponType.wp_fist);
  });

  it('expires invisibility and updates the original blinking power colormap', () => {
    const world = createWorld(map, { skill: 2 });
    const actor = world.actorsById.get(world.player.actorId);
    if (!actor) throw new Error('Player missing');
    actor.flags |= MobjFlag.MF_SHADOW;
    world.player.powers[PowerType.pw_invisibility] = 1;
    world.player.powers[PowerType.pw_invulnerability] = 140;
    thinkPlayer(world, idleCommand, hooks);
    expect(actor.flags & MobjFlag.MF_SHADOW).toBe(0);
    expect(world.player.fixedColormap).toBe(32);
  });

  it('lowers a dead player’s view and requests restart through use', () => {
    const world = createWorld(map, { skill: 2 });
    world.player.state = 'dead';
    world.player.damageCount = 10;
    thinkPlayer(world, { ...idleCommand, buttons: TicButton.use }, hooks);
    expect(world.player.viewHeight).toBe(40 * FRAC_UNIT);
    expect(world.player.damageCount).toBe(9);
    expect(world.player.state).toBe('reborn');
  });

  it('retains the original airborne view clamp overwrite and grounded ceiling clamp', () => {
    const world = createWorld(map, { skill: 2 });
    const actor = world.actorsById.get(world.player.actorId);
    if (!actor) throw new Error('Player missing');
    actor.ceilingZ = actor.floorZ + 42 * FRAC_UNIT;
    actor.z = actor.floorZ + FRAC_UNIT;
    thinkPlayer(world, idleCommand, hooks);
    expect(world.player.viewZ).toBe(actor.z + 41 * FRAC_UNIT);
    actor.z = actor.floorZ;
    thinkPlayer(world, idleCommand, hooks);
    expect(world.player.viewZ).toBe(actor.ceilingZ - 4 * FRAC_UNIT);
    world.player.cheats |= CheatFlag.CF_NOMOMENTUM;
    thinkPlayer(world, idleCommand, hooks);
    expect(world.player.viewZ).toBe(actor.z + 41 * FRAC_UNIT);
  });

  it('applies the chainsaw lunge without mutating the caller’s command', () => {
    const world = createWorld(map, { skill: 2 });
    const actor = world.actorsById.get(world.player.actorId);
    if (!actor) throw new Error('Player missing');
    actor.angle = 0;
    actor.flags |= MobjFlag.MF_JUSTATTACKED;
    const input = { ...idleCommand, angleTurn: 640, sideMove: 25 };
    const command = thinkPlayer(world, input, hooks);
    expect(command).toEqual({ ...idleCommand, forwardMove: 100 });
    expect(input.angleTurn).toBe(640);
    expect(actor.angle).toBe(0);
    expect(actor.momx).toBe(204796);
    expect(actor.flags & MobjFlag.MF_JUSTATTACKED).toBe(0);
  });

  it('turns toward a dead player’s attacker before fading damage', () => {
    const world = createWorld(map, { skill: 2 });
    const actor = world.actorsById.get(world.player.actorId);
    if (!actor) throw new Error('Player missing');
    const killer = spawnActor(world, ActorType.MT_TROOP, actor.x, actor.y + 128 * FRAC_UNIT);
    actor.angle = 0;
    world.player.state = 'dead';
    world.player.attacker = killer.id;
    world.player.damageCount = 5;
    thinkPlayer(world, idleCommand, hooks);
    expect(actor.angle).toBe(Math.trunc(ANG90 / 18));
    expect(world.player.damageCount).toBe(5);
    actor.angle = ANG90;
    thinkPlayer(world, idleCommand, hooks);
    expect(actor.angle).toBe(ANG90 - 1);
    expect(world.player.damageCount).toBe(4);
  });

  it('rejects plasma selection in shareware even when inventory owns it', () => {
    const world = createWorld(map, { skill: 2, mode: 'shareware' });
    world.player.ownedWeapons[WeaponType.wp_plasma] = true;
    const buttons = TicButton.changeWeapon | (WeaponType.wp_plasma << 3);
    thinkPlayer(world, { ...idleCommand, buttons }, hooks);
    expect(world.player.pendingWeapon).toBe(WeaponType.wp_pistol);
  });
});
