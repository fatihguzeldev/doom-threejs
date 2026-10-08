import { describe, expect, it } from 'vitest';
import { giveAmmo, giveArmor, giveBackpack, giveBody, giveCard, givePower, giveWeapon } from '../../src/simulation/inventory';
import { CardType, PowerType, createPlayer } from '../../src/simulation/player';
import { createActor } from '../../src/simulation/actors';
import { ActorType, MobjFlag } from '../../src/simulation/data/actors';
import { AmmoType, WeaponType } from '../../src/simulation/data/weapons';
import { createRandom } from '../../src/simulation/random';

function livePlayer() {
  const player = createPlayer();
  const actor = createActor(ActorType.MT_PLAYER, 0, 0, 0, 0, 128 * 65536,
    0, 0, 2, createRandom());
  actor.player = 0;
  player.actorId = actor.id;
  actor.health = player.health;
  return { player, actor };
}

describe('ammo pickup rules', () => {
  it.each([
    [AmmoType.am_clip, 10], [AmmoType.am_shell, 4],
    [AmmoType.am_cell, 20], [AmmoType.am_misl, 1],
  ])('grants original clip size for ammo type %i', (ammo, amount) => {
    const player = createPlayer();
    player.ammo[ammo] = 0;
    expect(giveAmmo(player, ammo, 1, 2)).toBe(true);
    expect(player.ammo[ammo]).toBe(amount);
  });

  it.each([0, 4])('doubles ammo on skill %i', (skill) => {
    const player = createPlayer();
    expect(giveAmmo(player, AmmoType.am_clip, 2, skill)).toBe(true);
    expect(player.ammo[AmmoType.am_clip]).toBe(90);
  });

  it('treats zero clips as an integer half clip, including the original zero half-rocket', () => {
    const player = createPlayer();
    expect(giveAmmo(player, AmmoType.am_clip, 0, 2)).toBe(true);
    expect(player.ammo[AmmoType.am_clip]).toBe(55);
    expect(giveAmmo(player, AmmoType.am_misl, 0, 2)).toBe(true);
    expect(player.ammo[AmmoType.am_misl]).toBe(0);
  });

  it('caps at the player maximum and rejects full or unlimited ammo', () => {
    const player = createPlayer();
    player.ammo[AmmoType.am_clip] = 199;
    expect(giveAmmo(player, AmmoType.am_clip, 5, 2)).toBe(true);
    expect(player.ammo[AmmoType.am_clip]).toBe(200);
    expect(giveAmmo(player, AmmoType.am_clip, 1, 2)).toBe(false);
    expect(giveAmmo(player, AmmoType.am_noammo, 1, 2)).toBe(false);
  });

  const switches: [AmmoType, WeaponType, WeaponType | null, WeaponType][] = [
    [AmmoType.am_clip, WeaponType.wp_fist, null, WeaponType.wp_pistol],
    [AmmoType.am_clip, WeaponType.wp_fist, WeaponType.wp_chaingun, WeaponType.wp_chaingun],
    [AmmoType.am_shell, WeaponType.wp_pistol, WeaponType.wp_shotgun, WeaponType.wp_shotgun],
    [AmmoType.am_shell, WeaponType.wp_fist, null, WeaponType.wp_fist],
    [AmmoType.am_cell, WeaponType.wp_pistol, WeaponType.wp_plasma, WeaponType.wp_plasma],
    [AmmoType.am_cell, WeaponType.wp_pistol, WeaponType.wp_bfg, WeaponType.wp_pistol],
    [AmmoType.am_misl, WeaponType.wp_fist, WeaponType.wp_missile, WeaponType.wp_missile],
    [AmmoType.am_misl, WeaponType.wp_pistol, WeaponType.wp_missile, WeaponType.wp_pistol],
    [AmmoType.am_shell, WeaponType.wp_chainsaw, WeaponType.wp_shotgun, WeaponType.wp_chainsaw],
    [AmmoType.am_clip, WeaponType.wp_shotgun, WeaponType.wp_chaingun, WeaponType.wp_shotgun],
  ];
  it.each(switches)('applies zero-ammo preference for ammo %i, ready %i, owned %s',
    (ammo, ready, owned, expected) => {
      const player = createPlayer();
      player.ammo[ammo] = 0;
      player.readyWeapon = ready;
      player.pendingWeapon = ready;
      if (owned !== null) player.ownedWeapons[owned] = true;
      expect(giveAmmo(player, ammo, 1, 2)).toBe(true);
      expect(player.pendingWeapon).toBe(expected);
      expect(player.readyWeapon).toBe(ready);
    });

  it('preserves a deliberate lower weapon when the ammo was already nonzero', () => {
    const player = createPlayer();
    player.readyWeapon = WeaponType.wp_fist;
    player.pendingWeapon = WeaponType.wp_fist;
    player.ownedWeapons[WeaponType.wp_chaingun] = true;
    expect(giveAmmo(player, AmmoType.am_clip, 1, 2)).toBe(true);
    expect(player.pendingWeapon).toBe(WeaponType.wp_fist);
  });

  it('rejects enum sentinels and out-of-range ammo instead of creating invalid array entries', () => {
    const player = createPlayer();
    expect(() => giveAmmo(player, AmmoType.NUMAMMO, 1, 2)).toThrow(/ammo/i);
    expect(() => giveAmmo(player, -1 as AmmoType, 1, 2)).toThrow(/ammo/i);
  });
});

describe('weapon pickup rules', () => {
  it.each([[false, 8], [true, 4]] as const)('grants placed/dropped shotgun ammo (dropped=%s)',
    (dropped, shells) => {
      const player = createPlayer();
      expect(giveWeapon(player, WeaponType.wp_shotgun, dropped, 2)).toBe(true);
      expect(player.ammo[AmmoType.am_shell]).toBe(shells);
      expect(player.ownedWeapons[WeaponType.wp_shotgun]).toBe(true);
      expect(player.pendingWeapon).toBe(WeaponType.wp_shotgun);
      expect(player.readyWeapon).toBe(WeaponType.wp_pistol);
    });

  it('collects ammo from an owned weapon and rejects it only when neither ammo nor ownership changes', () => {
    const player = createPlayer();
    player.ownedWeapons[WeaponType.wp_shotgun] = true;
    expect(giveWeapon(player, WeaponType.wp_shotgun, false, 2)).toBe(true);
    expect(player.ammo[AmmoType.am_shell]).toBe(8);
    player.ammo[AmmoType.am_shell] = 50;
    expect(giveWeapon(player, WeaponType.wp_shotgun, false, 2)).toBe(false);
  });

  it('grants a new weapon even at full ammo and only grants the chainsaw once', () => {
    const player = createPlayer();
    player.ammo[AmmoType.am_shell] = 50;
    expect(giveWeapon(player, WeaponType.wp_shotgun, false, 2)).toBe(true);
    expect(player.pendingWeapon).toBe(WeaponType.wp_shotgun);
    const ammo = [...player.ammo];
    expect(giveWeapon(player, WeaponType.wp_chainsaw, false, 2)).toBe(true);
    expect(player.pendingWeapon).toBe(WeaponType.wp_chainsaw);
    expect(player.ammo).toEqual(ammo);
    expect(giveWeapon(player, WeaponType.wp_chainsaw, false, 2)).toBe(false);
  });

  it('applies the skill multiplier to dropped weapon ammo', () => {
    const player = createPlayer();
    giveWeapon(player, WeaponType.wp_chaingun, true, 4);
    expect(player.ammo[AmmoType.am_clip]).toBe(70);
  });
});

describe('health, armor and keys', () => {
  it('heals both player and actor, caps normal healing at 100 and preserves overhealth', () => {
    const { player, actor } = livePlayer();
    player.health = actor.health = 92;
    expect(giveBody(player, 25, actor)).toBe(true);
    expect(player.health).toBe(100);
    expect(actor.health).toBe(100);
    player.health = actor.health = 150;
    expect(giveBody(player, 10, actor)).toBe(false);
    expect(player.health).toBe(150);
    expect(actor.health).toBe(150);
  });

  it('compares armor point totals, including green armor replacing low blue armor', () => {
    const player = createPlayer();
    expect(giveArmor(player, 2)).toBe(true);
    expect(player).toMatchObject({ armorType: 2, armorPoints: 200 });
    expect(giveArmor(player, 1)).toBe(false);
    player.armorPoints = 99;
    expect(giveArmor(player, 1)).toBe(true);
    expect(player).toMatchObject({ armorType: 1, armorPoints: 100 });
    expect(giveArmor(player, 1)).toBe(false);
  });

  it('sets a new key bonus to six and leaves duplicate keys unchanged', () => {
    const player = createPlayer();
    player.bonusCount = 30;
    giveCard(player, CardType.it_bluecard);
    expect(player.cards[CardType.it_bluecard]).toBe(true);
    expect(player.bonusCount).toBe(6);
    player.bonusCount = 18;
    giveCard(player, CardType.it_bluecard);
    expect(player.bonusCount).toBe(18);
    expect(player.cards[CardType.it_blueskull]).toBe(false);
  });
});

describe('powerups', () => {
  it.each([
    [PowerType.pw_invulnerability, 1050], [PowerType.pw_invisibility, 2100],
    [PowerType.pw_ironfeet, 2100], [PowerType.pw_infrared, 4200],
  ])('starts and refreshes original duration for power %i', (power, tics) => {
    const { player, actor } = livePlayer();
    expect(givePower(player, power, actor)).toBe(true);
    expect(player.powers[power]).toBe(tics);
    player.powers[power] = 1;
    expect(givePower(player, power, actor)).toBe(true);
    expect(player.powers[power]).toBe(tics);
  });

  it('marks the actor invisible without discarding its other flags', () => {
    const { player, actor } = livePlayer();
    const flags = actor.flags;
    givePower(player, PowerType.pw_invisibility, actor);
    expect(actor.flags).toBe(flags | MobjFlag.MF_SHADOW);
  });

  it('always grants strength, restores health and resets its counter to one', () => {
    const { player, actor } = livePlayer();
    player.health = actor.health = 2;
    expect(givePower(player, PowerType.pw_strength, actor)).toBe(true);
    expect(player.health).toBe(100);
    expect(actor.health).toBe(100);
    player.powers[PowerType.pw_strength] = 10000;
    expect(givePower(player, PowerType.pw_strength, actor)).toBe(true);
    expect(player.powers[PowerType.pw_strength]).toBe(1);
  });

  it('only grants the persistent map power once', () => {
    const { player, actor } = livePlayer();
    expect(givePower(player, PowerType.pw_allmap, actor)).toBe(true);
    expect(player.powers[PowerType.pw_allmap]).toBe(1);
    expect(givePower(player, PowerType.pw_allmap, actor)).toBe(false);
  });
});

describe('backpacks', () => {
  it('doubles capacities only once but grants one clip of every ammo on every pickup', () => {
    const player = createPlayer();
    giveBackpack(player, 2);
    expect(player.backpack).toBe(true);
    expect(player.maxAmmo).toEqual([400, 100, 600, 100]);
    expect(player.ammo).toEqual([60, 4, 20, 1]);
    giveBackpack(player, 2);
    expect(player.maxAmmo).toEqual([400, 100, 600, 100]);
    expect(player.ammo).toEqual([70, 8, 40, 2]);
  });

  it('applies skill doubling and preserves the ammo preference iteration order', () => {
    const player = createPlayer();
    player.ammo.fill(0);
    player.readyWeapon = WeaponType.wp_fist;
    player.ownedWeapons.fill(true);
    giveBackpack(player, 0);
    expect(player.ammo).toEqual([20, 8, 40, 2]);
    expect(player.pendingWeapon).toBe(WeaponType.wp_missile);
  });
});
