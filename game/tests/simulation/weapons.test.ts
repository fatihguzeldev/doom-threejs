import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { createWorld, spawnActor } from '../../src/simulation/world';
import { createWeapons, type WeaponHooks } from '../../src/simulation/weapons';
import { idleCommand, TicButton } from '../../src/simulation/command';
import { StateId } from '../../src/simulation/data/states';
import { AmmoType, WeaponType } from '../../src/simulation/data/weapons';
import { ActorType, SfxId } from '../../src/simulation/data/actors';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { PowerType } from '../../src/simulation/player';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');

function fixture(mode: 'registered' | 'shareware' = 'registered', hookOverrides: Partial<WeaponHooks> = {}) {
  const world = createWorld(map, { skill: 2, mode });
  const shots: { angle: number; slope: number; damage: number }[] = [];
  const missiles: ActorType[] = [];
  let alerts = 0;
  const hooks: WeaponHooks = {
    runActorAction: () => {},
    noiseAlert: () => { alerts++; },
    aimLineAttack: () => ({ slope: 0, target: null }),
    lineAttack: (_actor, angle, _range, slope, damage) => {
      shots.push({ angle, slope, damage });
      return null;
    },
    spawnPlayerMissile: (_actor, type) => { missiles.push(type); },
    ...hookOverrides,
  };
  const weapons = createWeapons(world, hooks);
  weapons.setup();
  return { world, weapons, shots, missiles, alerts: () => alerts };
}

function raise(weapons: ReturnType<typeof createWeapons>): void {
  for (let tic = 0; tic < 15; tic++) weapons.move(idleCommand);
}

describe('native player weapon animation and fire rules', () => {
  it('raises the pistol through original one-tic states and follows flash position', () => {
    const { world, weapons } = fixture();
    expect(world.player.psprites[0].state).toBe(StateId.S_PISTOLUP);
    expect(world.player.psprites[0].sy).toBe(122 * FRAC_UNIT);
    raise(weapons);
    expect(world.player.psprites[0].state).toBe(StateId.S_PISTOL);
    expect(world.player.psprites[0].sy).toBe(32 * FRAC_UNIT);
    expect(world.player.pendingWeapon).toBe(WeaponType.wp_nochange);
    expect(world.player.psprites[1].sy).toBe(world.player.psprites[0].sy);
  });

  it('fires an accurate first pistol shot with a flash and noise alert', () => {
    const { world, weapons, shots, alerts } = fixture();
    raise(weapons);
    weapons.move({ ...idleCommand, buttons: TicButton.attack });
    expect(world.player.ammo[AmmoType.am_clip]).toBe(50);
    expect(world.player.psprites[0].state).toBe(StateId.S_PISTOL1);
    for (let tic = 0; tic < 4; tic++) weapons.move(idleCommand);
    expect(world.player.ammo[AmmoType.am_clip]).toBe(49);
    expect(shots).toHaveLength(1);
    const actor = world.actorsById.get(world.player.actorId);
    expect(shots[0]?.angle).toBe(actor?.angle);
    expect([5, 10, 15]).toContain(shots[0]?.damage);
    expect(world.player.psprites[0].state).toBe(StateId.S_PISTOL2);
    expect(world.player.psprites[1].state).toBe(StateId.S_PISTOLFLASH);
    expect(alerts()).toBe(1);
    expect(world.events.some(event => event.type === 'sound' && event.sound === SfxId.sfx_pistol)).toBe(true);
  });

  it('uses seven randomized pellets for the shotgun and consumes one shell', () => {
    const { world, weapons, shots } = fixture();
    world.player.readyWeapon = WeaponType.wp_shotgun;
    world.player.ammo[AmmoType.am_shell] = 4;
    weapons.setup();
    raise(weapons);
    weapons.move({ ...idleCommand, buttons: TicButton.attack });
    for (let tic = 0; tic < 3; tic++) weapons.move(idleCommand);
    expect(shots).toHaveLength(7);
    expect(world.player.ammo[AmmoType.am_shell]).toBe(3);
    expect(new Set(shots.map(shot => shot.angle)).size).toBeGreaterThan(1);
  });

  it('selects the original fallback and lowers when the current gun has no ammo', () => {
    const { world, weapons } = fixture();
    raise(weapons);
    world.player.ammo[AmmoType.am_clip] = 0;
    world.player.ownedWeapons[WeaponType.wp_shotgun] = true;
    world.player.ammo[AmmoType.am_shell] = 1;
    weapons.move({ ...idleCommand, buttons: TicButton.attack });
    expect(world.player.pendingWeapon).toBe(WeaponType.wp_shotgun);
    expect(world.player.psprites[0].state).toBe(StateId.S_PISTOLDOWN);
  });

  it('does not select an owned plasma gun as a shareware fallback', () => {
    const { world, weapons } = fixture('shareware');
    raise(weapons);
    world.player.ammo[AmmoType.am_clip] = 0;
    world.player.ownedWeapons[WeaponType.wp_plasma] = true;
    world.player.ammo[AmmoType.am_cell] = 100;
    weapons.move({ ...idleCommand, buttons: TicButton.attack });
    expect(world.player.pendingWeapon).toBe(WeaponType.wp_fist);
  });

  it('keeps a dead player’s lowered weapon at the bottom', () => {
    const { world, weapons } = fixture();
    raise(weapons);
    world.player.state = 'dead';
    world.player.health = 0;
    weapons.drop();
    for (let tic = 0; tic < 30; tic++) weapons.move(idleCommand);
    expect(world.player.psprites[0].state).toBe(StateId.S_PISTOLDOWN);
    expect(world.player.psprites[0].sy).toBe(128 * FRAC_UNIT);
  });

  it('multiplies punch damage by ten for berserk without using ammo', () => {
    const { world, weapons, shots } = fixture();
    world.player.readyWeapon = WeaponType.wp_fist;
    world.player.powers[PowerType.pw_strength] = 1;
    weapons.setup();
    raise(weapons);
    weapons.move({ ...idleCommand, buttons: TicButton.attack });
    for (let tic = 0; tic < 4; tic++) weapons.move(idleCommand);
    expect(shots).toHaveLength(1);
    expect(shots[0]?.damage).toBeGreaterThanOrEqual(20);
    expect((shots[0]?.damage ?? 0) % 20).toBe(0);
    expect(world.player.ammo[AmmoType.am_clip]).toBe(50);
  });

  it('starts a rocket only after its original eight-tic gun flash delay', () => {
    const { world, weapons, missiles } = fixture();
    world.player.readyWeapon = WeaponType.wp_missile;
    world.player.ammo[AmmoType.am_misl] = 3;
    weapons.setup();
    raise(weapons);
    weapons.move({ ...idleCommand, buttons: TicButton.attack });
    expect(missiles).toHaveLength(0);
    for (let tic = 0; tic < 8; tic++) weapons.move(idleCommand);
    expect(missiles).toEqual([ActorType.MT_ROCKET]);
    expect(world.player.ammo[AmmoType.am_misl]).toBe(2);
  });

  it('repeats rockets through A_ReFire despite the ready-state trigger guard', () => {
    const { world, weapons, missiles } = fixture();
    world.player.readyWeapon = WeaponType.wp_missile;
    world.player.ammo[AmmoType.am_misl] = 3;
    weapons.setup();
    raise(weapons);
    const pressed = { ...idleCommand, buttons: TicButton.attack };
    for (let tic = 0; tic < 29; tic++) weapons.move(pressed);
    expect(missiles).toEqual([ActorType.MT_ROCKET, ActorType.MT_ROCKET]);
    expect(world.player.ammo[AmmoType.am_misl]).toBe(1);
  });

  it('fires plasma immediately and chooses either original muzzle flash', () => {
    const { world, weapons, missiles } = fixture();
    world.player.readyWeapon = WeaponType.wp_plasma;
    world.player.ammo[AmmoType.am_cell] = 3;
    weapons.setup();
    raise(weapons);
    weapons.move({ ...idleCommand, buttons: TicButton.attack });
    expect(missiles).toEqual([ActorType.MT_PLASMA]);
    expect(world.player.ammo[AmmoType.am_cell]).toBe(2);
    expect([StateId.S_PLASMAFLASH1, StateId.S_PLASMAFLASH2]).toContain(world.player.psprites[1].state);
  });

  it('charges the BFG for thirty tics and consumes forty cells', () => {
    const { world, weapons, missiles } = fixture();
    world.player.readyWeapon = WeaponType.wp_bfg;
    world.player.ammo[AmmoType.am_cell] = 40;
    weapons.setup();
    raise(weapons);
    weapons.move({ ...idleCommand, buttons: TicButton.attack });
    expect(world.events.some(event => event.type === 'sound' && event.sound === SfxId.sfx_bfg)).toBe(true);
    for (let tic = 0; tic < 29; tic++) weapons.move(idleCommand);
    expect(missiles).toHaveLength(0);
    weapons.move(idleCommand);
    expect(missiles).toEqual([ActorType.MT_BFG]);
    expect(world.player.ammo[AmmoType.am_cell]).toBe(0);
  });

  it('does not fire the second chaingun frame when only one bullet remained', () => {
    const { world, weapons, shots } = fixture();
    world.player.readyWeapon = WeaponType.wp_chaingun;
    world.player.ammo[AmmoType.am_clip] = 1;
    weapons.setup();
    raise(weapons);
    weapons.move({ ...idleCommand, buttons: TicButton.attack });
    for (let tic = 0; tic < 4; tic++) weapons.move(idleCommand);
    expect(shots).toHaveLength(1);
    expect(world.player.ammo[AmmoType.am_clip]).toBe(0);
  });

  it('uses the autoaim target for punch facing even when the shot reports no hit', () => {
    const { world, weapons } = fixture('registered', {
      aimLineAttack: actor => ({ slope: 0, target: spawnActor(world, ActorType.MT_TROOP, actor.x, actor.y + FRAC_UNIT) }),
      lineAttack: () => null,
    });
    world.player.readyWeapon = WeaponType.wp_fist;
    weapons.setup();
    raise(weapons);
    weapons.move({ ...idleCommand, buttons: TicButton.attack });
    for (let tic = 0; tic < 4; tic++) weapons.move(idleCommand);
    expect(world.actorsById.get(world.player.actorId)?.angle).toBe(0x40000000 - 1);
    expect(world.events.some(event => event.type === 'sound' && event.sound === SfxId.sfx_punch)).toBe(true);
  });
});
