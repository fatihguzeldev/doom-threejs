import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findLump, parseWad, readLump } from '../../src/wad/archive';
import { decodeDemo } from '../../src/wad/demo';
import { decodeMap } from '../../src/wad/map';
import { createResources } from '../../src/wad/resources';
import { setActorState } from '../../src/simulation/actors';
import { idleCommand } from '../../src/simulation/command';
import { ActorType, MobjFlag } from '../../src/simulation/data/actors';
import { StateId } from '../../src/simulation/data/states';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { CheatFlag } from '../../src/simulation/player';
import { createSimulation } from '../../src/simulation/simulation';
import { createWorld, spawnActor } from '../../src/simulation/world';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const resources = createResources(wad);

describe('complete native level ticker', () => {
  it.each(Array.from({ length: 9 }, (_, index) => `E1M${index + 1}`))('initializes and ticks all specials in %s', name => {
    const world = createWorld(decodeMap(wad, name), { skill: 2, mode: 'shareware' });
    const simulation = createSimulation(world, resources);
    for (let tic = 0; tic < 70; tic++) { simulation.tick(); world.events.length = 0; }
    expect(world.levelTime).toBe(70);
    expect(world.player.viewZ).toBeGreaterThan(1);
    expect(world.actors.every(actor => !actor.removed && world.activeActorIds.has(actor.id))).toBe(true);
  });

  it('runs player thrust before the actor movement in the same tic', () => {
    const world = createWorld(decodeMap(wad, 'E1M1'), { skill: 2, mode: 'shareware', noMonsters: true });
    const simulation = createSimulation(world, resources);
    const player = world.actorsById.get(world.player.actorId);
    if (!player) throw new Error('Player missing');
    const oldX = player.x, oldY = player.y;
    simulation.tick({ ...idleCommand, forwardMove: 25 });
    expect([player.x, player.y]).not.toEqual([oldX, oldY]);
    expect(player.state).toBe(StateId.S_PLAY_RUN1);
    expect(player.tics).toBe(3);
  });

  it('updates a missile appended by an enemy action later in that same tic', () => {
    const world = createWorld(decodeMap(wad, 'E1M1'), { skill: 2, mode: 'shareware', noMonsters: true });
    const simulation = createSimulation(world, resources);
    const player = world.actorsById.get(world.player.actorId);
    if (!player) throw new Error('Player missing');
    player.flags &= ~MobjFlag.MF_SOLID;
    const imp = spawnActor(world, ActorType.MT_TROOP, player.x + 80 * FRAC_UNIT, player.y);
    imp.target = player.id;
    setActorState(imp, StateId.S_TROO_ATK2, () => {});
    imp.tics = 1;
    const before = world.nextActorId;
    simulation.tick();
    const missile = world.actorsById.get(before);
    expect(missile?.type).toBe(ActorType.MT_TROOPSHOT);
    expect(missile?.tics).toBeLessThan(4); // Initial three/four tics, then its own thinker.
    expect(missile?.x).toBeLessThan(imp.x - 10 * FRAC_UNIT);
  });

  it.each(['DEMO1', 'DEMO2', 'DEMO3'])('plays every command in bundled %s through actual gameplay', name => {
    const lump = findLump(wad, name);
    if (!lump) throw new Error('Demo missing');
    const demo = decodeDemo(readLump(wad, lump));
    const world = createWorld(decodeMap(wad, `E${demo.header.episode}M${demo.header.mapNumber}`), {
      skill: demo.header.skill, mode: 'shareware', fastMonsters: demo.header.fast,
      respawnMonsters: demo.header.respawn, noMonsters: demo.header.noMonsters,
    });
    const simulation = createSimulation(world, resources);
    for (const tic of demo.tics) {
      simulation.tick(tic[0]?.command);
      world.events.length = 0;
    }
    expect(world.levelTime).toBe(demo.tics.length);
    expect(world.actors.every(actor => Number.isInteger(actor.x) && Number.isInteger(actor.y) && Number.isInteger(actor.z))).toBe(true);
    expect(world.actors.length).toBeLessThan(1000);
  });

  it('repeats the same demo state deterministically without shared mutable state tables', () => {
    const lump = findLump(wad, 'DEMO1');
    if (!lump) throw new Error('Demo missing');
    const commands = decodeDemo(readLump(wad, lump)).tics.slice(0, 400);
    const replay = () => {
      const world = createWorld(decodeMap(wad, 'E1M5'), { skill: 2, mode: 'shareware' });
      const simulation = createSimulation(world, resources);
      world.player.cheats |= CheatFlag.CF_GODMODE;
      for (const tic of commands) { simulation.tick(tic[0]?.command); world.events.length = 0; }
      return { player: world.player, actors: world.actors, sectors: world.sectors, random: world.random };
    };
    expect(replay()).toEqual(replay());
  });
});
