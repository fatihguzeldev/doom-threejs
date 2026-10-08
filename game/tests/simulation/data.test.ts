import { describe, expect, it } from 'vitest';
import { ActionId, SpriteId, StateId, spriteNames, states } from '../../src/simulation/data/states';
import { ActorType, MobjFlag, SfxId, actors } from '../../src/simulation/data/actors';
import { AmmoType, WeaponType, weapons } from '../../src/simulation/data/weapons';

describe('original Doom simulation data', () => {
  it('preserves original table sizes and stable IDs, including unused Doom II data', () => {
    expect(states).toHaveLength(967);
    expect(actors).toHaveLength(137);
    expect(weapons).toHaveLength(9);
    expect(StateId.NUMSTATES).toBe(states.length);
    expect(ActorType.NUMMOBJTYPES).toBe(actors.length);
    expect(WeaponType.NUMWEAPONS).toBe(weapons.length);
    expect(StateId.S_PISTOL).toBe(10);
    expect(StateId.S_PISTOL2).toBe(14);
    expect(StateId.S_CHAIN3).toBe(54);
    expect(ActorType.MT_BRUISER).toBe(15);
    expect(ActorType.MT_CYBORG).toBe(21);
    expect(WeaponType.wp_supershotgun).toBe(8);
  });

  it('retains weapon action timing, zero-tic transitions and fullbright frames', () => {
    expect(states[StateId.S_PISTOL2]).toEqual({
      sprite: SpriteId.SPR_PISG, frame: 1, tics: 6, action: ActionId.A_FirePistol,
      nextstate: StateId.S_PISTOL3, misc1: 0, misc2: 0,
    });
    expect(states[StateId.S_CHAIN3]).toMatchObject({ tics: 0, action: ActionId.A_ReFire });
    expect(states[StateId.S_NULL]).toMatchObject({ tics: -1, action: ActionId.None });
    expect(states[StateId.S_PISTOLFLASH]?.frame).toBe(32768);
  });

  it('retains fixed-point dimensions, actor attributes and flags', () => {
    expect(actors[ActorType.MT_BRUISER]).toMatchObject({
      doomednum: 3003, spawnhealth: 1000, speed: 8, radius: 24 * 65536,
      height: 64 * 65536, painchance: 50,
      seesound: SfxId.sfx_brssit, spawnstate: StateId.S_BOSS_STND,
    });
    expect(actors[ActorType.MT_BRUISER]?.flags)
      .toBe(MobjFlag.MF_SOLID | MobjFlag.MF_SHOOTABLE | MobjFlag.MF_COUNTKILL);
    expect(actors[ActorType.MT_CYBORG]?.spawnhealth).toBe(4000);
  });

  it('uses original ammo categories and state references for every weapon', () => {
    expect(weapons[WeaponType.wp_bfg]).toEqual({
      ammo: AmmoType.am_cell,
      upstate: StateId.S_BFGUP, downstate: StateId.S_BFGDOWN, readystate: StateId.S_BFG,
      atkstate: StateId.S_BFG1, flashstate: StateId.S_BFGFLASH1,
    });
    expect(weapons[WeaponType.wp_fist]?.ammo).toBe(AmmoType.am_noammo);
    expect(weapons[WeaponType.wp_chainsaw]?.ammo).toBe(AmmoType.am_noammo);
  });

  it('resolves every sprite, action, state and sound reference', () => {
    expect(spriteNames).toHaveLength(SpriteId.NUMSPRITES);
    expect(spriteNames[SpriteId.SPR_TROO]).toBe('TROO');
    for (const state of states) {
      expect(spriteNames[state.sprite]).toMatch(/^[A-Z0-9]{4}$/);
      expect(ActionId[state.action]).toBeTypeOf('string');
      expect(states[state.nextstate]).toBeDefined();
    }
    for (const actor of actors) {
      for (const field of ['spawnstate', 'seestate', 'painstate', 'meleestate', 'missilestate',
        'deathstate', 'xdeathstate', 'raisestate'] as const) {
        expect(states[actor[field]]).toBeDefined();
      }
      for (const field of ['seesound', 'attacksound', 'painsound', 'deathsound', 'activesound'] as const) {
        expect(actor[field]).toBeGreaterThanOrEqual(0);
        expect(actor[field]).toBeLessThan(SfxId.NUMSFX);
      }
      for (const value of Object.values(actor)) expect(Number.isInteger(value)).toBe(true);
    }
    for (const weapon of weapons) {
      expect(weapon.ammo).toBeGreaterThanOrEqual(0);
      expect(weapon.ammo).toBeLessThanOrEqual(AmmoType.am_noammo);
      for (const field of ['upstate', 'downstate', 'readystate', 'atkstate', 'flashstate'] as const) {
        expect(states[weapon[field]]).toBeDefined();
      }
    }
  });
});
