import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { createWorld, removeActor } from '../../src/simulation/world';
import { doFloor, tickFloor, buildStairs } from '../../src/simulation/specials/floors';
import type { PlaneHooks } from '../../src/simulation/specials/planes';
import { FRAC_UNIT } from '../../src/simulation/fixed';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');
const hooks: PlaneHooks = {
  movement: { touchPickup: () => {}, damageActor: () => {}, explodeMissile: () => {}, crossSpecial: () => {}, runActorAction: () => {} },
  damageActor: () => {},
};

function fixture() {
  const world = createWorld(map, { skill: 2 });
  const index = world.actorsById.get(world.player.actorId)?.sector;
  const sector = index === undefined ? undefined : world.sectors[index];
  if (!sector || index === undefined) throw new Error('Floor fixture missing');
  for (const actor of world.actors) removeActor(world, actor);
  sector.tag = 123;
  return { world, sector, index };
}

describe('native floors and stairs', () => {
  it('raises a tagged floor by 24 units and removes its thinker only after overshoot', () => {
    const { world, sector } = fixture();
    const before = sector.floorHeight;
    expect(doFloor(world, 123, 'raiseFloor24')).toBe(true);
    const floor = sector.specialData;
    if (floor?.kind !== 'floor') throw new Error('Floor missing');
    expect(floor.destination).toBe(before + 24 * FRAC_UNIT);
    for (let tic = 0; tic < 24; tic++) { world.levelTime = tic; tickFloor(world, floor, hooks); }
    expect(floor.removed).toBe(false);
    expect(sector.floorHeight).toBe(floor.destination);
    tickFloor(world, floor, hooks);
    expect(floor.removed).toBe(true);
    expect(sector.specialData).toBe(null);
  });

  it('does not replace a floor already in motion', () => {
    const { world, sector } = fixture();
    doFloor(world, 123, 'raiseFloor24');
    const first = sector.specialData;
    expect(doFloor(world, 123, 'lowerFloor')).toBe(false);
    expect(sector.specialData).toBe(first);
  });

  it('sets the crush destination eight units below the lowest adjacent ceiling', () => {
    const { world, sector } = fixture();
    doFloor(world, 123, 'raiseFloorCrush');
    const floor = sector.specialData;
    if (floor?.kind !== 'floor') throw new Error('Floor missing');
    expect(floor.crush).toBe(true);
    expect(floor.destination).toBeLessThanOrEqual(sector.ceilingHeight - 8 * FRAC_UNIT);
  });

  it('copies floor texture and special immediately for raise-and-change', () => {
    const { world, sector } = fixture();
    const line = world.spatial.lines.findIndex(line => line.frontSector !== world.sectors.indexOf(sector));
    const front = world.spatial.lines[line]?.frontSector;
    const model = front === undefined ? undefined : world.sectors[front];
    if (!model) throw new Error('Model sector missing');
    model.floorTexture = 'NUKAGE2'; model.special = 5;
    doFloor(world, 123, 'raiseFloor24AndChange', line);
    expect(sector.floorTexture).toBe('NUKAGE2');
    expect(sector.special).toBe(5);
  });

  it('starts slow eight-unit stairs with original quarter-unit movement', () => {
    const { world, sector } = fixture();
    const before = sector.floorHeight;
    expect(buildStairs(world, 123, 'build8')).toBe(true);
    expect(sector.specialData).toMatchObject({ kind: 'floor', type: 'stairs', speed: FRAC_UNIT / 4, destination: before + 8 * FRAC_UNIT });
  });

  it('starts turbo sixteen-unit stairs at four units per tic', () => {
    const { world, sector } = fixture();
    expect(buildStairs(world, 123, 'turbo16')).toBe(true);
    expect(sector.specialData).toMatchObject({ kind: 'floor', speed: 4 * FRAC_UNIT, destination: sector.floorHeight + 16 * FRAC_UNIT });
  });
});
