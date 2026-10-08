import { describe, expect, it } from 'vitest';
import { CardType, CheatFlag, PowerType, WeaponSpriteSlot, createPlayer } from '../../src/simulation/player';
import { StateId } from '../../src/simulation/data/states';
import { WeaponType } from '../../src/simulation/data/weapons';

describe('reborn player defaults', () => {
  it('starts alive with the original inventory and held-button protection', () => {
    const player = createPlayer();
    expect(player).toEqual({
      actorId: -1, state: 'alive', health: 100, armorPoints: 0, armorType: 0,
      ammo: [50, 0, 0, 0], maxAmmo: [200, 50, 300, 50],
      ownedWeapons: [true, true, false, false, false, false, false, false, false],
      readyWeapon: WeaponType.wp_pistol, pendingWeapon: WeaponType.wp_pistol,
      psprites: [
        { state: StateId.S_NULL, tics: 0, sx: 0, sy: 0 },
        { state: StateId.S_NULL, tics: 0, sx: 0, sy: 0 },
      ],
      cards: [false, false, false, false, false, false], powers: [0, 0, 0, 0, 0, 0],
      backpack: false, didSecret: false,
      bonusCount: 0, damageCount: 0, killCount: 0, itemCount: 0, secretCount: 0,
      viewZ: 0, viewHeight: 0, deltaViewHeight: 0, bob: 0,
      extraLight: 0, fixedColormap: 0, colormap: 0,
      refire: 0, attackDown: true, useDown: true, cheats: 0,
      attacker: null, message: null,
    });
  });

  it('allocates independent inventory and psprite storage for each player', () => {
    const first = createPlayer();
    const second = createPlayer();
    first.ammo[0] = 1;
    first.maxAmmo[0] = 400;
    first.ownedWeapons[2] = true;
    first.cards[0] = true;
    first.powers[0] = 123;
    first.psprites[0].tics = 12;
    expect(second.ammo[0]).toBe(50);
    expect(second.maxAmmo[0]).toBe(200);
    expect(second.ownedWeapons[2]).toBe(false);
    expect(second.cards[0]).toBe(false);
    expect(second.powers[0]).toBe(0);
    expect(second.psprites[0].tics).toBe(0);
    expect(first.psprites[1].tics).toBe(0);
  });

  it('preserves original power, card, cheat and overlay slot IDs', () => {
    expect([PowerType.pw_invulnerability, PowerType.pw_strength, PowerType.pw_invisibility,
      PowerType.pw_ironfeet, PowerType.pw_allmap, PowerType.pw_infrared]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([CardType.it_bluecard, CardType.it_yellowcard, CardType.it_redcard,
      CardType.it_blueskull, CardType.it_yellowskull, CardType.it_redskull]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(CheatFlag.CF_NOCLIP).toBe(1);
    expect(CheatFlag.CF_GODMODE).toBe(2);
    expect(CheatFlag.CF_NOMOMENTUM).toBe(4);
    expect(WeaponSpriteSlot.ps_weapon).toBe(0);
    expect(WeaponSpriteSlot.ps_flash).toBe(1);
  });
});
