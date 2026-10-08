import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { ActorType, MobjFlag } from '../../src/simulation/data/actors';
import { createWorld, removeActor, spawnActor, sweepActors } from '../../src/simulation/world';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { createRandom } from '../../src/simulation/random';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');

describe('single-player level setup', () => {
  it('spawns the player at the original map start with fixed-point sector heights', () => {
    const world = createWorld(map, { skill: 2 });
    const start = map.things.find(thing => thing.type === 1);
    const player = world.actorsById.get(world.player.actorId);
    if (!start || !player) throw new Error('E1M1 player start missing');
    expect(player.type).toBe(ActorType.MT_PLAYER);
    expect(player.x).toBe(start.x * FRAC_UNIT);
    expect(player.y).toBe(start.y * FRAC_UNIT);
    expect(player.subsector).toBe(103);
    expect(player.player).toBe(0);
    expect(player.health).toBe(100);
    expect(world.player.viewHeight).toBe(41 * FRAC_UNIT);
    expect(world.sectors[player.sector]?.floorHeight).toBe(player.floorZ);
    expect(world.actors.filter(actor => actor.type === ActorType.MT_PLAYER)).toHaveLength(1);
  });

  it('filters monsters while preserving scenery and collectible things', () => {
    const world = createWorld(map, { skill: 3, noMonsters: true });
    expect(world.totalKills).toBe(0);
    expect(world.actors.some(actor => (actor.flags & MobjFlag.MF_COUNTKILL) !== 0)).toBe(false);
    expect(world.actors.some(actor => (actor.flags & MobjFlag.MF_SPECIAL) !== 0)).toBe(true);
    expect(world.actors.some(actor => (actor.flags & MobjFlag.MF_SOLID) !== 0 && actor.player === null)).toBe(true);
  });

  it('retains source map definitions while changing runtime heights and texture names', () => {
    const world = createWorld(map, { skill: 2 });
    const sector = world.sectors[0];
    const mapSector = map.sectors[0];
    if (!sector || !mapSector) throw new Error('Sector missing');
    const original = { ...mapSector };
    sector.floorHeight += 8 * FRAC_UNIT;
    sector.floorTexture = 'NUKAGE1';
    expect(map.sectors[0]).toEqual(original);
    expect(world.lineSpecials.length).toBe(map.lines.length);
    expect(world.lineFlags.length).toBe(map.lines.length);
  });

  it('registers dynamically spawned actors after the existing thinker order', () => {
    const world = createWorld(map, { skill: 2 });
    const player = world.actorsById.get(world.player.actorId);
    if (!player) throw new Error('Player missing');
    const count = world.actors.length;
    const actor = spawnActor(world, ActorType.MT_PUFF, player.x, player.y, player.z);
    expect(world.actorsById.get(actor.id)).toBe(actor);
    expect(world.actors.length).toBe(count + 1);
    expect(world.thinkers.at(-1)).toEqual({ kind: 'actor', id: actor.id });
  });

  it('uses a supplied random stream rather than resetting it between levels', () => {
    const random = createRandom();
    random.gameIndex = 4;
    const world = createWorld(map, { skill: 2, random });
    expect(world.random).toBe(random);
    expect(random.menuIndex).toBe(0);
  });

  it('unlinks a removed source immediately but retains projectile references until released', () => {
    const world = createWorld(map, { skill: 2 });
    const player = world.actorsById.get(world.player.actorId);
    if (!player) throw new Error('Player missing');
    const source = spawnActor(world, ActorType.MT_TROOP, player.x, player.y);
    const missile = spawnActor(world, ActorType.MT_TROOPSHOT, player.x, player.y);
    missile.target = source.id;
    removeActor(world, source);
    removeActor(world, source);
    expect(world.activeActorIds.has(source.id)).toBe(false);
    expect(world.actorBlocks.some(block => block.includes(source.id))).toBe(false);
    expect(world.events.filter(event => event.type === 'stopSound' && event.actor === source.id)).toHaveLength(1);
    sweepActors(world);
    expect(world.actors).not.toContain(source);
    expect(world.thinkers.some(thinker => thinker.kind === 'actor' && thinker.id === source.id)).toBe(false);
    expect(world.actorsById.get(source.id)).toBe(source);
    missile.target = null;
    sweepActors(world);
    expect(world.actorsById.has(source.id)).toBe(false);
  });

  it('releases unreachable removed reference cycles without disturbing active thinker order', () => {
    const world = createWorld(map, { skill: 2 });
    const first = spawnActor(world, ActorType.MT_PUFF, 0, 0);
    const second = spawnActor(world, ActorType.MT_PUFF, 0, 0);
    first.tracer = second.id;
    second.tracer = first.id;
    const order = world.thinkers.filter(thinker => thinker.kind !== 'actor' || (thinker.id !== first.id && thinker.id !== second.id));
    removeActor(world, first);
    removeActor(world, second);
    sweepActors(world);
    expect(world.actorsById.has(first.id)).toBe(false);
    expect(world.actorsById.has(second.id)).toBe(false);
    expect(world.thinkers).toEqual(order);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('constructs every shareware map, including E1M%i', mapNumber => {
    const world = createWorld(decodeMap(wad, `E1M${mapNumber}`), { skill: 2 });
    expect(world.player.state).toBe('alive');
    expect(world.totalKills).toBeGreaterThan(0);
    expect(world.actors.every(actor => actor.floorZ <= actor.ceilingZ)).toBe(true);
  });
});
