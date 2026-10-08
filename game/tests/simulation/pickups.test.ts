import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { touchSpecialThing } from '../../src/simulation/pickups';
import { createWorld, spawnActor, type World } from '../../src/simulation/world';
import { ActorType, MobjFlag, SfxId, actors } from '../../src/simulation/data/actors';
import { SpriteId, states } from '../../src/simulation/data/states';
import { AmmoType, WeaponType } from '../../src/simulation/data/weapons';
import { CardType, PowerType } from '../../src/simulation/player';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import type { Actor } from '../../src/simulation/actors';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');

function pickup(sprite: SpriteId, skill: 0 | 1 | 2 | 3 | 4 = 2): { world: World; special: Actor; toucher: Actor } {
  const world = createWorld(map, { skill, noMonsters: true });
  const toucher = world.actorsById.get(world.player.actorId);
  if (!toucher) throw new Error('Player missing');
  const type = actors.findIndex(info => (info.flags & MobjFlag.MF_SPECIAL) !== 0
    && states[info.spawnstate]?.sprite === sprite);
  if (type < 0) throw new Error(`No original collectible for sprite ${sprite}`);
  const special = spawnActor(world, type, toucher.x, toucher.y, toucher.z);
  return { world, special, toucher };
}

function sounds(world: World) {
  return world.events.filter(event => event.type === 'sound');
}

describe('pickup eligibility and removal', () => {
  it.each([-8 * FRAC_UNIT - 1, 56 * FRAC_UNIT + 1])('leaves vertically unreachable items at delta %i', delta => {
    const { world, special, toucher } = pickup(SpriteId.SPR_BON1);
    special.z = toucher.z + delta;
    touchSpecialThing(world, special, toucher);
    expect(special.removed).toBe(false);
    expect(world.player.health).toBe(100);
    expect(world.events).toEqual([]);
  });

  it.each([-8 * FRAC_UNIT, 56 * FRAC_UNIT])('accepts the original inclusive vertical boundary %i', delta => {
    const { world, special, toucher } = pickup(SpriteId.SPR_BON1);
    special.z = toucher.z + delta;
    touchSpecialThing(world, special, toucher);
    expect(special.removed).toBe(true);
    expect(world.player.health).toBe(101);
  });

  it.each([0, -1])('prevents a sliding dead player with health %i from collecting', health => {
    const { world, special, toucher } = pickup(SpriteId.SPR_BON1);
    toucher.health = health;
    touchSpecialThing(world, special, toucher);
    expect(special.removed).toBe(false);
    expect(world.player.health).toBe(100);
    expect(world.events).toEqual([]);
  });

  it('ignores non-player actors', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_BON1);
    const monster = spawnActor(world, ActorType.MT_TROOP, toucher.x, toucher.y, toucher.z);
    touchSpecialThing(world, special, monster);
    expect(special.removed).toBe(false);
    expect(world.player.health).toBe(100);
    expect(world.events).toEqual([]);
  });

  it('counts the item, stops its sound, and defers actor-pool removal', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_BON1);
    const actorsBefore = [...world.actors];
    const thinkersBefore = [...world.thinkers];
    touchSpecialThing(world, special, toucher);
    expect(world.player.itemCount).toBe(1);
    expect(world.player.bonusCount).toBe(6);
    expect(world.player.message).toBe('Picked up a health bonus.');
    expect(world.actors).toEqual(actorsBefore);
    expect(world.thinkers).toEqual(thinkersBefore);
    expect(world.activeActorIds.has(special.id)).toBe(false);
    expect(world.events).toContainEqual({ type: 'stopSound', actor: special.id });
    expect(sounds(world)).toEqual([{ type: 'sound', sound: SfxId.sfx_itemup, actor: null }]);
    const after = { health: world.player.health, itemCount: world.player.itemCount,
      bonusCount: world.player.bonusCount, events: [...world.events] };
    touchSpecialThing(world, special, toucher);
    expect({ health: world.player.health, itemCount: world.player.itemCount,
      bonusCount: world.player.bonusCount, events: world.events }).toEqual(after);
  });

  it('does not add item statistics without MF_COUNTITEM', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_CLIP);
    touchSpecialThing(world, special, toucher);
    expect(special.removed).toBe(true);
    expect(world.player.itemCount).toBe(0);
  });

  it('reports an unknown collectible sprite instead of silently discarding it', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_BON1);
    special.sprite = SpriteId.SPR_BAR1;
    expect(() => touchSpecialThing(world, special, toucher)).toThrow(/unknown.*gettable/i);
    expect(special.removed).toBe(false);
  });
});

describe('armor and health pickups', () => {
  it.each([[SpriteId.SPR_ARM1, 1, 100, 'Picked up the armor.'],
    [SpriteId.SPR_ARM2, 2, 200, 'Picked up the MegaArmor!']] as const)
    ('grants original armor sprite %i', (sprite, armorType, armorPoints, message) => {
      const { world, special, toucher } = pickup(sprite);
      touchSpecialThing(world, special, toucher);
      expect(world.player).toMatchObject({ armorType, armorPoints, message });
      expect(special.removed).toBe(true);
    });

  it('leaves weaker or equal armor on the map', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_ARM1);
    world.player.armorType = 2;
    world.player.armorPoints = 150;
    touchSpecialThing(world, special, toucher);
    expect(special.removed).toBe(false);
    expect(world.player.armorPoints).toBe(150);
    expect(world.events).toEqual([]);
  });

  it.each([199, 200, 250])('consumes health bonuses at health %i and caps at 200', health => {
    const { world, special, toucher } = pickup(SpriteId.SPR_BON1);
    world.player.health = toucher.health = health;
    touchSpecialThing(world, special, toucher);
    expect(world.player.health).toBe(200);
    expect(toucher.health).toBe(200);
    expect(special.removed).toBe(true);
  });

  it('grants green armor type for an armor bonus and preserves existing blue type', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_BON2);
    touchSpecialThing(world, special, toucher);
    expect(world.player).toMatchObject({ armorType: 1, armorPoints: 1,
      message: 'Picked up an armor bonus.' });
    const another = spawnActor(world, special.type, toucher.x, toucher.y, toucher.z);
    world.player.armorType = 2;
    world.player.armorPoints = 200;
    touchSpecialThing(world, another, toucher);
    expect(world.player).toMatchObject({ armorType: 2, armorPoints: 200 });
    expect(another.removed).toBe(true);
  });

  it('adds soul-sphere health up to 200 and uses the power pickup sound', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_SOUL);
    world.player.health = toucher.health = 150;
    touchSpecialThing(world, special, toucher);
    expect(world.player.health).toBe(200);
    expect(toucher.health).toBe(200);
    expect(world.player.message).toBe('Supercharge!');
    expect(sounds(world)).toEqual([{ type: 'sound', sound: SfxId.sfx_getpow, actor: null }]);
  });

  it.each([[SpriteId.SPR_STIM, 90, 'Picked up a stimpack.'],
    [SpriteId.SPR_MEDI, 100, 'Picked up a medikit.']] as const)
    ('heals with sprite %i and synchronizes actor health', (sprite, health, message) => {
      const { world, special, toucher } = pickup(sprite);
      world.player.health = toucher.health = 80;
      touchSpecialThing(world, special, toucher);
      expect(world.player).toMatchObject({ health, message });
      expect(toucher.health).toBe(health);
      expect(special.removed).toBe(true);
    });

  it('checks the medikit message after healing, matching the original normal message at low health', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_MEDI);
    world.player.health = toucher.health = 1;
    touchSpecialThing(world, special, toucher);
    expect(world.player.health).toBe(26);
    expect(world.player.message).toBe('Picked up a medikit.');
  });

  it.each([SpriteId.SPR_STIM, SpriteId.SPR_MEDI])('leaves unneeded normal healing sprite %i', sprite => {
    const { world, special, toucher } = pickup(sprite);
    touchSpecialThing(world, special, toucher);
    expect(special.removed).toBe(false);
    expect(world.player.message).toBeNull();
    expect(world.events).toEqual([]);
  });

  it('leaves the commercial-only megasphere uncollected in Doom I', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_MEGA);
    world.player.health = toucher.health = 1;
    touchSpecialThing(world, special, toucher);
    expect(special.removed).toBe(false);
    expect(world.player.health).toBe(1);
    expect(world.events).toEqual([]);
  });
});

describe('keys and powerups', () => {
  const keys: [SpriteId, CardType, string][] = [
    [SpriteId.SPR_BKEY, CardType.it_bluecard, 'Picked up a blue keycard.'],
    [SpriteId.SPR_YKEY, CardType.it_yellowcard, 'Picked up a yellow keycard.'],
    [SpriteId.SPR_RKEY, CardType.it_redcard, 'Picked up a red keycard.'],
    [SpriteId.SPR_BSKU, CardType.it_blueskull, 'Picked up a blue skull key.'],
    [SpriteId.SPR_YSKU, CardType.it_yellowskull, 'Picked up a yellow skull key.'],
    [SpriteId.SPR_RSKU, CardType.it_redskull, 'Picked up a red skull key.'],
  ];
  it.each(keys)('grants separate key sprite %i/card %i', (sprite, card, message) => {
    const { world, special, toucher } = pickup(sprite);
    world.player.bonusCount = 30;
    touchSpecialThing(world, special, toucher);
    expect(world.player.cards.filter(Boolean)).toHaveLength(1);
    expect(world.player.cards[card]).toBe(true);
    expect(world.player.bonusCount).toBe(12);
    expect(world.player.message).toBe(message);
    expect(special.removed).toBe(true);
  });

  it('consumes duplicate single-player keys without changing the prior message', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_BKEY);
    world.player.cards[CardType.it_bluecard] = true;
    world.player.message = 'prior message';
    world.player.bonusCount = 20;
    touchSpecialThing(world, special, toucher);
    expect(special.removed).toBe(true);
    expect(world.player.message).toBe('prior message');
    expect(world.player.bonusCount).toBe(26);
    expect(world.events.filter(event => event.type === 'message')).toEqual([]);
  });

  const powers: [SpriteId, PowerType, number, string][] = [
    [SpriteId.SPR_PINV, PowerType.pw_invulnerability, 1050, 'Invulnerability!'],
    [SpriteId.SPR_PSTR, PowerType.pw_strength, 1, 'Berserk!'],
    [SpriteId.SPR_PINS, PowerType.pw_invisibility, 2100, 'Partial Invisibility'],
    [SpriteId.SPR_SUIT, PowerType.pw_ironfeet, 2100, 'Radiation Shielding Suit'],
    [SpriteId.SPR_PMAP, PowerType.pw_allmap, 1, 'Computer Area Map'],
    [SpriteId.SPR_PVIS, PowerType.pw_infrared, 4200, 'Light Amplification Visor'],
  ];
  it.each(powers)('grants power sprite %i', (sprite, power, duration, message) => {
    const { world, special, toucher } = pickup(sprite);
    touchSpecialThing(world, special, toucher);
    expect(world.player.powers[power]).toBe(duration);
    expect(world.player.message).toBe(message);
    expect(special.removed).toBe(true);
    expect(sounds(world)).toEqual([{ type: 'sound', sound: SfxId.sfx_getpow, actor: null }]);
  });

  it('berserk heals and selects the fist without replacing the currently ready weapon', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_PSTR);
    world.player.health = toucher.health = 10;
    touchSpecialThing(world, special, toucher);
    expect(world.player.health).toBe(100);
    expect(toucher.health).toBe(100);
    expect(world.player.readyWeapon).toBe(WeaponType.wp_pistol);
    expect(world.player.pendingWeapon).toBe(WeaponType.wp_fist);
  });

  it('leaves a redundant computer map on the ground', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_PMAP);
    world.player.powers[PowerType.pw_allmap] = 1;
    touchSpecialThing(world, special, toucher);
    expect(special.removed).toBe(false);
    expect(world.events).toEqual([]);
  });
});

describe('ammo and weapon pickups', () => {
  const ammoCases: [SpriteId, AmmoType, number, string][] = [
    [SpriteId.SPR_CLIP, AmmoType.am_clip, 10, 'Picked up a clip.'],
    [SpriteId.SPR_AMMO, AmmoType.am_clip, 50, 'Picked up a box of bullets.'],
    [SpriteId.SPR_ROCK, AmmoType.am_misl, 1, 'Picked up a rocket.'],
    [SpriteId.SPR_BROK, AmmoType.am_misl, 5, 'Picked up a box of rockets.'],
    [SpriteId.SPR_CELL, AmmoType.am_cell, 20, 'Picked up an energy cell.'],
    [SpriteId.SPR_CELP, AmmoType.am_cell, 100, 'Picked up an energy cell pack.'],
    [SpriteId.SPR_SHEL, AmmoType.am_shell, 4, 'Picked up 4 shotgun shells.'],
    [SpriteId.SPR_SBOX, AmmoType.am_shell, 20, 'Picked up a box of shotgun shells.'],
  ];
  it.each(ammoCases)('grants original ammo pickup sprite %i', (sprite, ammo, amount, message) => {
    const { world, special, toucher } = pickup(sprite);
    world.player.ammo.fill(0);
    touchSpecialThing(world, special, toucher);
    expect(world.player.ammo[ammo]).toBe(amount);
    expect(world.player.message).toBe(message);
    expect(special.removed).toBe(true);
  });

  it.each([[2, 5], [0, 10], [4, 10]] as const)('grants half a clip from a dropped clip on skill %i',
    (skill, amount) => {
      const { world, special, toucher } = pickup(SpriteId.SPR_CLIP, skill);
      world.player.ammo[AmmoType.am_clip] = 0;
      special.flags |= MobjFlag.MF_DROPPED;
      touchSpecialThing(world, special, toucher);
      expect(world.player.ammo[AmmoType.am_clip]).toBe(amount);
    });

  it('leaves full ammo without sounds, messages, bonus flash or item removal', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_AMMO);
    world.player.ammo[AmmoType.am_clip] = 200;
    touchSpecialThing(world, special, toucher);
    expect(special.removed).toBe(false);
    expect(world.player).toMatchObject({ message: null, bonusCount: 0, itemCount: 0 });
    expect(world.events).toEqual([]);
  });

  const weaponCases: [SpriteId, WeaponType, AmmoType, number, string][] = [
    [SpriteId.SPR_BFUG, WeaponType.wp_bfg, AmmoType.am_cell, 40, 'You got the BFG9000!  Oh, yes.'],
    [SpriteId.SPR_MGUN, WeaponType.wp_chaingun, AmmoType.am_clip, 20, 'You got the chaingun!'],
    [SpriteId.SPR_CSAW, WeaponType.wp_chainsaw, AmmoType.am_noammo, 0, 'A chainsaw!  Find some meat!'],
    [SpriteId.SPR_LAUN, WeaponType.wp_missile, AmmoType.am_misl, 2, 'You got the rocket launcher!'],
    [SpriteId.SPR_PLAS, WeaponType.wp_plasma, AmmoType.am_cell, 40, 'You got the plasma gun!'],
    [SpriteId.SPR_SHOT, WeaponType.wp_shotgun, AmmoType.am_shell, 8, 'You got the shotgun!'],
    [SpriteId.SPR_SGN2, WeaponType.wp_supershotgun, AmmoType.am_shell, 8, 'You got the super shotgun!'],
  ];
  it.each(weaponCases)('grants the original weapon pickup sprite %i', (sprite, weapon, ammo, amount, message) => {
    const { world, special, toucher } = pickup(sprite);
    world.player.ammo.fill(0);
    touchSpecialThing(world, special, toucher);
    expect(world.player.ownedWeapons[weapon]).toBe(true);
    expect(world.player.pendingWeapon).toBe(weapon);
    if (ammo !== AmmoType.am_noammo) expect(world.player.ammo[ammo]).toBe(amount);
    expect(world.player.message).toBe(message);
    expect(special.removed).toBe(true);
    expect(sounds(world)).toEqual([{ type: 'sound', sound: SfxId.sfx_wpnup, actor: null }]);
  });

  it.each([[SpriteId.SPR_MGUN, AmmoType.am_clip, 10],
    [SpriteId.SPR_SHOT, AmmoType.am_shell, 4], [SpriteId.SPR_SGN2, AmmoType.am_shell, 4]] as const)
    ('honors dropped weapon ammo for sprite %i', (sprite, ammo, amount) => {
      const { world, special, toucher } = pickup(sprite);
      world.player.ammo.fill(0);
      special.flags |= MobjFlag.MF_DROPPED;
      touchSpecialThing(world, special, toucher);
      expect(world.player.ammo[ammo]).toBe(amount);
    });

  it('ignores the dropped flag for BFG as the original pickup case does', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_BFUG);
    special.flags |= MobjFlag.MF_DROPPED;
    touchSpecialThing(world, special, toucher);
    expect(world.player.ammo[AmmoType.am_cell]).toBe(40);
  });

  it('leaves an owned chainsaw rather than consuming it for unlimited ammo', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_CSAW);
    world.player.ownedWeapons[WeaponType.wp_chainsaw] = true;
    touchSpecialThing(world, special, toucher);
    expect(special.removed).toBe(false);
    expect(world.events).toEqual([]);
  });

  it('grants backpack capacity and still consumes repeated backpacks with full ammo', () => {
    const { world, special, toucher } = pickup(SpriteId.SPR_BPAK);
    touchSpecialThing(world, special, toucher);
    expect(world.player.maxAmmo).toEqual([400, 100, 600, 100]);
    expect(world.player.ammo).toEqual([60, 4, 20, 1]);
    expect(world.player.message).toBe('Picked up a backpack full of ammo!');
    world.player.ammo = [...world.player.maxAmmo];
    const another = spawnActor(world, special.type, toucher.x, toucher.y, toucher.z);
    touchSpecialThing(world, another, toucher);
    expect(another.removed).toBe(true);
    expect(world.player.maxAmmo).toEqual([400, 100, 600, 100]);
    expect(world.player.ammo).toEqual(world.player.maxAmmo);
  });
});
