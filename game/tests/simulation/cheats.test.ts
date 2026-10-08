import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCheats } from '../../src/simulation/cheats';
import { createWorld } from '../../src/simulation/world';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { CheatFlag, PowerType } from '../../src/simulation/player';
import { MobjFlag } from '../../src/simulation/data/actors';
import { WeaponType } from '../../src/simulation/data/weapons';
import { thinkPlayer } from '../../src/simulation/player-thinking';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');
const world = (mode: 'shareware' | 'registered' | 'retail' = 'shareware', skill: 0 | 1 | 2 | 3 | 4 = 2) =>
  createWorld(map, { skill, mode, noMonsters: true });
const idleTic = (state: ReturnType<typeof world>) => thinkPlayer(state,
  { forwardMove: 0, sideMove: 0, angleTurn: 0, buttons: 0 },
  { runActorAction() {}, moveWeaponSprites() {}, useLines() {}, playerInSpecialSector() {} });

describe('native single-player cheats', () => {
  it('recognizes a sequence across input batches, normalizes case and toggles god health', () => {
    const state = world(), cheats = createCheats();
    const actor = state.actorsById.get(state.player.actorId);
    if (!actor) throw new Error('Missing player');
    state.player.health = actor.health = 12;
    expect(cheats.feed(state, 'ID')).toEqual([]);
    expect(cheats.feed(state, 'DQD')).toEqual([{ type: 'message', text: 'Degreelessness Mode On' }]);
    expect(state.player.cheats & CheatFlag.CF_GODMODE).toBe(CheatFlag.CF_GODMODE);
    expect([state.player.health, actor.health]).toEqual([100, 100]);
    actor.health = state.player.health = 87;
    expect(cheats.feed(state, 'iddqd')).toEqual([{ type: 'message', text: 'Degreelessness Mode Off' }]);
    expect([state.player.health, actor.health]).toEqual([87, 87]);
  });

  it('preserves original mismatch consumption rather than rescanning the same key', () => {
    const state = world(), cheats = createCheats();
    expect(cheats.feed(state, 'iiddqd')).toEqual([]);
    expect(cheats.feed(state, 'iddxd')).toEqual([]);
    expect(cheats.feed(state, 'iddqd')).toHaveLength(1);
  });

  it('resets incomplete sequences explicitly and when the world changes', () => {
    const a = world(), b = world(), cheats = createCheats();
    cheats.feed(a, 'idd'); cheats.reset(); expect(cheats.feed(a, 'qd')).toEqual([]);
    cheats.feed(a, 'idd'); expect(cheats.feed(b, 'qd')).toEqual([]);
    expect(cheats.feed(b, 'iddqd')).toHaveLength(1);
  });

  it('grants the original armor, all ownership slots and max ammo without pickup/autoswitch effects', () => {
    const state = world(), cheats = createCheats();
    state.player.maxAmmo = [400, 100, 600, 100]; state.player.ammo.fill(0);
    state.player.readyWeapon = WeaponType.wp_fist; state.player.pendingWeapon = WeaponType.wp_nochange;
    state.player.armorPoints = 250; state.player.armorType = 3;
    expect(cheats.feed(state, 'idfa')).toEqual([{ type: 'message', text: 'Ammo (no keys) Added' }]);
    expect(state.player.armorPoints).toBe(200); expect(state.player.armorType).toBe(2);
    expect(state.player.ammo).toEqual([400, 100, 600, 100]); expect(state.player.ownedWeapons.every(Boolean)).toBe(true);
    expect(state.player.cards.some(Boolean)).toBe(false); expect(state.player.bonusCount).toBe(0);
    expect(state.player.pendingWeapon).toBe(WeaponType.wp_nochange);
    expect(cheats.feed(state, 'idkfa')).toEqual([{ type: 'message', text: 'Very Happy Ammo Added' }]);
    expect(state.player.cards.every(Boolean)).toBe(true); expect(state.player.bonusCount).toBe(0);
  });

  it.each(['idspispopd', 'idclip'])('toggles Doom1 noclip with %s', sequence => {
    const state = world(), cheats = createCheats();
    expect(cheats.feed(state, sequence)).toEqual([{ type: 'message', text: 'No Clipping Mode ON' }]);
    expect(state.player.cheats & CheatFlag.CF_NOCLIP).toBe(CheatFlag.CF_NOCLIP);
    const actor = state.actorsById.get(state.player.actorId);
    if (!actor) throw new Error('Missing player');
    expect(actor.flags & MobjFlag.MF_NOCLIP).toBe(0);
    idleTic(state); expect(actor.flags & MobjFlag.MF_NOCLIP).toBe(MobjFlag.MF_NOCLIP);
    expect(cheats.feed(state, sequence)).toEqual([{ type: 'message', text: 'No Clipping Mode OFF' }]);
    expect(actor.flags & MobjFlag.MF_NOCLIP).toBe(MobjFlag.MF_NOCLIP);
    idleTic(state); expect(actor.flags & MobjFlag.MF_NOCLIP).toBe(0);
  });

  it('shows the behold prompt, gives native invisibility, then expires it on the next tic', () => {
    const state = world(), cheats = createCheats();
    const actor = state.actorsById.get(state.player.actorId);
    if (!actor) throw new Error('Missing player');
    expect(cheats.feed(state, 'idbehold')).toEqual([{ type: 'message', text: 'inVuln, Str, Inviso, Rad, Allmap, or Lite-amp' }]);
    expect(cheats.feed(state, 'i')).toEqual([{ type: 'message', text: 'Power-up Toggled' }]);
    expect(state.player.powers[PowerType.pw_invisibility]).toBe(2100);
    expect(actor.flags & MobjFlag.MF_SHADOW).toBe(MobjFlag.MF_SHADOW);
    cheats.feed(state, 'idbeholdi');
    expect(state.player.powers[PowerType.pw_invisibility]).toBe(1);
    expect(actor.flags & MobjFlag.MF_SHADOW).toBe(MobjFlag.MF_SHADOW);
    idleTic(state);
    expect(state.player.powers[PowerType.pw_invisibility]).toBe(0);
    expect(actor.flags & MobjFlag.MF_SHADOW).toBe(0);
  });

  it.each([['v', PowerType.pw_invulnerability, 1050], ['r', PowerType.pw_ironfeet, 2100],
    ['a', PowerType.pw_allmap, 1], ['l', PowerType.pw_infrared, 4200]] as const)
  ('toggles behold%s using the original power counter semantics', (suffix, power, duration) => {
    const state = world(), cheats = createCheats();
    cheats.feed(state, `idbehold${suffix}`); expect(state.player.powers[power]).toBe(duration);
    cheats.feed(state, `idbehold${suffix}`); expect(state.player.powers[power]).toBe(1);
  });

  it('berserk restores health and toggles off without switching the weapon', () => {
    const state = world(), cheats = createCheats();
    const actor = state.actorsById.get(state.player.actorId);
    if (!actor) throw new Error('Missing player');
    actor.health = state.player.health = 1; state.player.pendingWeapon = WeaponType.wp_nochange;
    cheats.feed(state, 'idbeholds');
    expect([state.player.health, actor.health]).toEqual([100, 100]);
    expect(state.player.powers[PowerType.pw_strength]).toBe(1);
    expect(state.player.pendingWeapon).toBe(WeaponType.wp_nochange);
    cheats.feed(state, 'idbeholds'); expect(state.player.powers[PowerType.pw_strength]).toBe(0);
  });

  it('preserves the original choppers one-tic invulnerability and weapon ownership only', () => {
    const state = world(), cheats = createCheats(); state.player.pendingWeapon = WeaponType.wp_nochange;
    expect(cheats.feed(state, 'idchoppers')).toEqual([{ type: 'message', text: "... doesn't suck - GM" }]);
    expect(state.player.ownedWeapons[WeaponType.wp_chainsaw]).toBe(true);
    expect(state.player.powers[PowerType.pw_invulnerability]).toBe(1);
    expect(state.player.pendingWeapon).toBe(WeaponType.wp_nochange);
  });

  it('allows cheats on Nightmare because the original gate was deliberately commented out', () => {
    const state = world('shareware', 4), cheats = createCheats();
    expect(cheats.feed(state, 'iddqd')).toHaveLength(1);
    expect(state.player.cheats & CheatFlag.CF_GODMODE).toBe(CheatFlag.CF_GODMODE);
  });

  it.each([['shareware', '19', true], ['shareware', '21', false], ['registered', '39', true],
    ['registered', '41', false], ['retail', '49', true], ['retail', '51', false],
    ['retail', '10', false], ['retail', '01', false]] as const)
  ('validates idclev%s%s against Doom1 mode', (mode, digits, valid) => {
    const state = world(mode), effects = createCheats().feed(state, `idclev${digits}`);
    expect(effects).toEqual(valid ? [{ type: 'message', text: 'Changing Level...' },
      { type: 'warp', episode: Number(digits[0]), mapNumber: Number(digits[1]) }] : []);
  });

  it('waits for exactly two idmus parameters and preserves the original linear music index', () => {
    const state = world('retail'), cheats = createCheats();
    expect(cheats.feed(state, 'idmus1')).toEqual([]);
    expect(cheats.feed(state, '9')).toEqual([{ type: 'message', text: 'Music Change' }, { type: 'music', name: 'D_E1M9', loop: true }]);
    expect(cheats.feed(state, 'idmus20')).toEqual([{ type: 'message', text: 'Music Change' }, { type: 'music', name: 'D_E1M9', loop: true }]);
    expect(cheats.feed(state, 'idmus41')).toEqual([{ type: 'message', text: 'Music Change' }, { type: 'music', name: 'D_INTER', loop: true }]);
    expect(cheats.feed(state, 'idmus45')).toEqual([{ type: 'message', text: 'Music Change' }, { type: 'music', name: 'D_INTROA', loop: true }]);
  });

  it.each(['00', '10', '49', '99', 'xx'])('rejects unsafe or impossible idmus%s without a music effect', digits => {
    expect(createCheats().feed(world('retail'), `idmus${digits}`)).toEqual([{ type: 'message', text: 'IMPOSSIBLE SELECTION' }]);
  });

  it('cycles iddt only while automap input is active, independent of Nightmare', () => {
    const state = world('shareware', 4), cheats = createCheats();
    expect(cheats.feed(state, 'iddt')).toEqual([]);
    expect(cheats.feed(state, 'iddt', true)).toEqual([{ type: 'automapReveal', level: 1 }]);
    expect(cheats.feed(state, 'iddt', true)).toEqual([{ type: 'automapReveal', level: 2 }]);
    expect(cheats.feed(state, 'iddt', true)).toEqual([{ type: 'automapReveal', level: 0 }]);
    cheats.reset(); expect(cheats.feed(state, 'iddt', true)).toEqual([{ type: 'automapReveal', level: 1 }]);
  });

  it('does not revive a dead player when toggling original god mode', () => {
    const state = world(), cheats = createCheats(); state.player.state = 'dead';
    cheats.feed(state, 'iddqd'); expect(state.player.health).toBe(100); expect(state.player.state).toBe('dead');
  });

  it('reports the original fixed-point position as unsigned hexadecimal', () => {
    const state = world(), actor = state.actorsById.get(state.player.actorId);
    if (!actor) throw new Error('Missing player');
    actor.angle = 0x80000000; actor.x = -65536; actor.y = 65536;
    expect(createCheats().feed(state, 'idmypos')).toEqual([
      { type: 'message', text: 'ang=0x80000000;x,y=(0xffff0000,0x10000)' },
    ]);
  });
});
