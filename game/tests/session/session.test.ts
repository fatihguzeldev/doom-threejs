import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSession, type Session } from '../../src/session/session';
import { idleCommand, TicButton } from '../../src/simulation/command';
import { WeaponType } from '../../src/simulation/data/weapons';
import { MobjFlag, SfxId } from '../../src/simulation/data/actors';
import { CardType, PowerType } from '../../src/simulation/player';
import { findLump, mapLumps, parseWad, type WadArchive } from '../../src/wad/archive';
import { createResources } from '../../src/wad/resources';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const resources = createResources(wad);
const registeredNames = ['BLUE', 'CMT', 'GARG', 'GSTON', 'HOT', 'LION', 'SATYR', 'SKIN', 'VINE', 'WOOD'].flatMap(name => [`SW1${name}`, `SW2${name}`]);
const allResources = { ...resources, wallNames: [...resources.wallNames, ...registeredNames] };
// Synthetic episode labels exercise routing without claiming registered map assets.
const labeledWad: WadArchive = {
  ...wad,
  lumps: [...wad.lumps, ...[2, 3, 4].flatMap(episode => [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(mapNumber => [
    { name: `E${episode}M${mapNumber}`, offset: 0, size: 0 }, ...mapLumps(wad, 'E1M1').values(),
  ]))],
};

function level(session: Session) {
  if (session.state.kind !== 'level') throw new Error('Expected level state');
  return session.state;
}

function complete(session: Session, secret = false): void {
  level(session).world.events.push({ type: 'exit', secret });
  session.tick();
}

function leaveIntermission(session: Session): void {
  session.advanceIntermission();
  session.advanceIntermission();
  session.advanceIntermission();
  for (let tic = 0; tic < 10; tic++) session.tick();
}

describe('native single-player session progression', () => {
  it('infers shareware mode, starts a real E1M1 world, and emits its music and state', () => {
    const session = createSession(wad, resources);
    expect(level(session).world).toMatchObject({ mode: 'shareware', episode: 1, mapNumber: 1, skill: 2, levelTime: 0 });
    expect(session.events).toContainEqual({ type: 'music', name: 'D_E1M1', loop: true });
    expect(session.events).toContainEqual({ type: 'state', kind: 'level' });
    session.tick({ ...idleCommand, forwardMove: 25 });
    expect(level(session).world.levelTime).toBe(1);
    expect(level(session).world.events).toEqual([]);
  });

  it.each([0, 1, 2, 3, 4] as const)('starts skill %s and resets the random stream on a new game', skill => {
    const session = createSession(wad, resources, { skill, noMonsters: true });
    const first = session.save();
    for (let tic = 0; tic < 20; tic++) session.tick();
    session.newGame({ skill, noMonsters: true });
    expect(session.save()).toBe(first);
    expect(level(session).world.fastMonsters).toBe(skill === 4);
    expect(level(session).world.respawnMonsters).toBe(skill === 4);
  });

  it('clamps new-game episode/map selections to the supported Doom mode as G_InitNew does', () => {
    const session = createSession(wad, resources, { episode: 3, mapNumber: 99 });
    expect(level(session).world).toMatchObject({ episode: 1, mapNumber: 9 });
    session.newGame({ episode: -2, mapNumber: -3 });
    expect(level(session).world).toMatchObject({ episode: 1, mapNumber: 1 });
  });

  it('keeps inventory between maps while clearing keys, powers and level palette effects', () => {
    const session = createSession(wad, resources, { noMonsters: true });
    const world = level(session).world;
    const player = world.player;
    const actor = world.actorsById.get(player.actorId);
    if (!actor) throw new Error('Player missing');
    player.health = actor.health = 73;
    player.armorPoints = 90; player.armorType = 2;
    player.ownedWeapons[WeaponType.wp_shotgun] = true;
    player.readyWeapon = WeaponType.wp_shotgun;
    player.ammo[1] = 24;
    player.cards[CardType.it_bluecard] = true;
    player.powers[PowerType.pw_strength] = 1;
    player.damageCount = 15; player.bonusCount = 12; player.extraLight = 2; player.fixedColormap = 32;
    actor.flags |= MobjFlag.MF_SHADOW;
    complete(session);
    expect(actor.flags & MobjFlag.MF_SHADOW).toBe(0);
    expect(player.cards.every(card => !card)).toBe(true);
    expect(player.powers.every(power => power === 0)).toBe(true);
    expect([player.damageCount, player.bonusCount, player.extraLight, player.fixedColormap]).toEqual([0, 0, 0, 0]);
    leaveIntermission(session);
    expect(level(session).world.mapNumber).toBe(2);
    expect(level(session).world.player).toMatchObject({ health: 73, armorPoints: 90, armorType: 2, readyWeapon: WeaponType.wp_shotgun });
    expect(level(session).world.player.ammo[1]).toBe(24);
    expect(level(session).world.player.ownedWeapons[WeaponType.wp_shotgun]).toBe(true);
    expect(level(session).world.random).toBe(world.random);
  });

  it.each([[1, 3, 4], [2, 5, 6], [3, 6, 7], [4, 2, 3]])('routes E%sM%s secret exit to map9, then back to map%s', (episode, sourceMap, returnMap) => {
    const session = createSession(labeledWad, allResources, { episode, mapNumber: sourceMap, noMonsters: true });
    complete(session, true);
    expect(session.state).toMatchObject({ kind: 'intermission', nextMapNumber: 9, secretExit: true });
    leaveIntermission(session);
    expect(level(session).world.mapNumber).toBe(9);
    expect(level(session).world.player.didSecret).toBe(true);
    complete(session);
    expect(session.state).toMatchObject({ nextMapNumber: returnMap });
    leaveIntermission(session);
    expect(level(session).world).toMatchObject({ episode, mapNumber: returnMap });
  });

  it('reloads the current map after death-use with reborn inventory and a continuing random stream', () => {
    const session = createSession(wad, resources, { noMonsters: true });
    const original = level(session).world;
    original.player.health = 0;
    original.player.state = 'dead';
    const actor = original.actorsById.get(original.player.actorId);
    if (!actor) throw new Error('Player missing');
    actor.health = 0;
    original.player.ammo[0] = 2;
    original.player.ownedWeapons[WeaponType.wp_shotgun] = true;
    session.tick({ ...idleCommand, buttons: TicButton.use });
    session.tick();
    const restarted = level(session).world;
    expect(restarted).not.toBe(original);
    expect(restarted.mapNumber).toBe(1);
    expect(restarted.player.health).toBe(100);
    expect(restarted.player.ammo[0]).toBe(50);
    expect(restarted.player.ownedWeapons[WeaponType.wp_shotgun]).toBe(false);
    expect(restarted.random).toBe(original.random);
  });

  it('drains ordinary world events and converts the last exit event like the original global gameaction', () => {
    const session = createSession(wad, resources, { noMonsters: true });
    session.events.length = 0;
    const world = level(session).world;
    world.events.push({ type: 'sound', sound: SfxId.sfx_pistol, actor: null }, { type: 'exit', secret: true }, { type: 'exit', secret: false });
    session.tick();
    expect(session.events).toContainEqual({ type: 'sound', sound: SfxId.sfx_pistol, actor: null });
    expect(session.events).not.toContainEqual({ type: 'exit', secret: true });
    expect(session.events).not.toContainEqual({ type: 'exit', secret: false });
    expect(world.events).toEqual([]);
    expect(session.state).toMatchObject({ kind: 'intermission', nextMapNumber: 2, secretExit: false });
  });
});

describe('native intermission and finale clocks', () => {
  it('reports original stats and par times, counts after 35 tics and requires fresh input edges to accelerate', () => {
    const session = createSession(wad, resources, { noMonsters: true });
    const world = level(session).world;
    world.player.killCount = 3; world.totalKills = 4;
    world.player.itemCount = 1; world.totalItems = 2;
    world.player.secretCount = 0; world.totalSecrets = 0;
    world.levelTime = 35 * 123;
    complete(session);
    expect(session.state).toMatchObject({ kind: 'intermission', stats: { kills: 3, maxKills: 4, items: 1, maxItems: 2, secrets: 0, maxSecrets: 1, time: 123, par: 30 }, counters: { kills: -1, items: -1, secrets: -1, time: -1, par: -1 } });
    for (let tic = 0; tic < 35; tic++) session.tick();
    session.tick();
    expect(session.state).toMatchObject({ counters: { kills: 1 } });
    session.tick({ ...idleCommand, buttons: TicButton.attack });
    expect(session.state).toMatchObject({ statsStage: 10, counters: { kills: 75, items: 50, secrets: 0, time: 123, par: 30 } });
    session.tick({ ...idleCommand, buttons: TicButton.attack });
    expect(session.state).toMatchObject({ stage: 'counting' });
    session.tick();
    session.tick({ ...idleCommand, buttons: TicButton.attack });
    expect(session.state).toMatchObject({ stage: 'showNext', remaining: 140 });
  });

  it('waits four seconds on the next-map screen followed by ten leaving tics', () => {
    const session = createSession(wad, resources, { noMonsters: true });
    complete(session);
    session.advanceIntermission(); session.advanceIntermission();
    for (let tic = 0; tic < 139; tic++) session.tick();
    expect(session.state).toMatchObject({ stage: 'showNext', remaining: 1 });
    session.tick();
    expect(session.state).toMatchObject({ stage: 'leaving', remaining: 10 });
    for (let tic = 0; tic < 9; tic++) session.tick();
    expect(session.state.kind).toBe('intermission');
    session.tick();
    expect(level(session).world.mapNumber).toBe(2);
  });

  it.each([[1, 'HELP2'], [2, 'VICTORY2'], [3, null], [4, 'ENDPIC']])('enters episode %s finale directly from map8 and changes to its art screen', (episode, picture) => {
    const session = createSession(labeledWad, allResources, { episode: Number(episode), mapNumber: 8, mode: Number(episode) === 4 ? 'retail' : 'registered', noMonsters: true });
    complete(session);
    if (session.state.kind !== 'finale') throw new Error('Finale missing');
    const text = session.state.text;
    expect(session.events).toContainEqual({ type: 'music', name: 'D_VICTOR', loop: true });
    expect(session.state.stage).toBe('text');
    for (let tic = 0; tic < text.length * 3 + 250; tic++) session.tick({ ...idleCommand, buttons: TicButton.attack });
    expect(session.state.stage).toBe('text');
    session.tick();
    expect(session.state).toMatchObject({ stage: 'art', ticks: 0, picture });
    if (episode === 3) {
      expect(session.events).toContainEqual({ type: 'music', name: 'D_BUNNY', loop: true });
      for (let tic = 0; tic < 1185; tic++) session.tick();
      expect(session.state).toMatchObject({ bunnyScroll: 0, bunnyEndFrame: 1 });
      expect(session.events.at(-1)).toEqual({ type: 'sound', sound: SfxId.sfx_pistol, actor: null });
    }
  });

  it('uses CREDIT instead of HELP2 for retail episode1 and native remapped music for episode4', () => {
    const session = createSession(labeledWad, allResources, { episode: 4, mapNumber: 1, noMonsters: true });
    expect(session.events).toContainEqual({ type: 'music', name: 'D_E3M4', loop: true });
    session.newGame({ episode: 1, mapNumber: 8, mode: 'retail', noMonsters: true });
    complete(session);
    expect(session.state).toMatchObject({ picture: 'CREDIT' });
  });

  it('has the complete original episode finale text rather than placeholder copy', () => {
    const session = createSession(wad, resources, { mapNumber: 8, noMonsters: true });
    complete(session);
    if (session.state.kind !== 'finale') throw new Error('Finale missing');
    expect(session.state.text).toContain('The Shores of Hell');
    expect(session.state.text).toContain('sequel, Inferno!');
    expect(session.state.textVisibleChars).toBe(0);
    expect(findLump(wad, session.state.flat)).toBeDefined();
    for (let tic = 0; tic < 13; tic++) session.tick();
    expect(session.state.textVisibleChars).toBe(1);
  });
});
