import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { createWorld } from '../../src/simulation/world';
import { spawnLight, tickLight, lightsOn, lightsOff } from '../../src/simulation/specials/lighting';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');

function fixture() {
  const world = createWorld(map, { skill: 2 });
  const index = world.actorsById.get(world.player.actorId)?.sector;
  const sector = index === undefined ? undefined : world.sectors[index];
  if (!sector || index === undefined) throw new Error('Light fixture missing');
  world.random.gameIndex = 0;
  sector.lightLevel = 160;
  sector.tag = 123;
  return { world, sector, index };
}

describe('native sector lighting thinkers', () => {
  it('uses original random bitmasks for broken-light timing', () => {
    const { world, sector, index } = fixture();
    const flash = spawnLight(world, index, 'flash');
    expect(flash.count).toBe(1);
    tickLight(world, flash);
    expect(sector.lightLevel).toBe(flash.min);
    expect(flash.count).toBe(6);
    expect(world.random.gameIndex).toBe(2);
  });

  it('starts synchronized strobes without consuming the random stream', () => {
    const { world, sector, index } = fixture();
    const strobe = spawnLight(world, index, 'strobe', 15, true);
    expect(world.random.gameIndex).toBe(0);
    tickLight(world, strobe);
    expect(sector.lightLevel).toBe(strobe.min);
    expect(strobe.count).toBe(15);
    for (let tic = 0; tic < 15; tic++) tickLight(world, strobe);
    expect(sector.lightLevel).toBe(strobe.max);
    expect(strobe.count).toBe(5);
  });

  it('does not reserve the sector’s movement slot for a lighting thinker', () => {
    const { world, sector, index } = fixture();
    sector.special = 8;
    const glow = spawnLight(world, index, 'glow');
    expect(sector.specialData).toBe(null);
    expect(sector.special).toBe(0);
    expect(world.thinkers.at(-1)).toBe(glow);
  });

  it('reverses glow direction before including the exact endpoint', () => {
    const { world, sector, index } = fixture();
    const glow = spawnLight(world, index, 'glow');
    glow.min = 144; glow.max = 160;
    tickLight(world, glow);
    expect(sector.lightLevel).toBe(152);
    tickLight(world, glow);
    expect(sector.lightLevel).toBe(152);
    expect(glow.direction).toBe(1);
  });

  it('waits four tics between fire random draws', () => {
    const { world, index } = fixture();
    const fire = spawnLight(world, index, 'fire');
    for (let tic = 0; tic < 3; tic++) tickLight(world, fire);
    expect(world.random.gameIndex).toBe(0);
    tickLight(world, fire);
    expect(world.random.gameIndex).toBe(1);
    expect(fire.count).toBe(4);
  });

  it('changes tagged lights without creating motion thinkers', () => {
    const { world, sector } = fixture();
    const before = world.thinkers.length;
    lightsOn(world, 123, 255);
    expect(sector.lightLevel).toBe(255);
    lightsOff(world, 123);
    expect(sector.lightLevel).toBeLessThan(255);
    expect(world.thinkers).toHaveLength(before);
  });
});
