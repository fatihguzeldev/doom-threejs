import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { createWorld, removeActor, spawnActor, sweepActors } from '../../src/simulation/world';
import { movePlane, type PlaneHooks } from '../../src/simulation/specials/planes';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { ActorType, MobjFlag } from '../../src/simulation/data/actors';
import { StateId } from '../../src/simulation/data/states';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');

function fixture() {
  const world = createWorld(map, { skill: 2 });
  const actor = world.actorsById.get(world.player.actorId);
  if (!actor) throw new Error('Player missing');
  for (const thing of world.actors) if (thing !== actor) removeActor(world, thing);
  sweepActors(world);
  const sector = world.sectors[actor.sector];
  if (!sector) throw new Error('Player sector missing');
  let damage = 0;
  const hooks: PlaneHooks = {
    movement: {
      touchPickup: () => {}, damageActor: () => {}, explodeMissile: () => {},
      crossSpecial: () => {}, runActorAction: () => {},
    },
    damageActor: (_target, _inflictor, _source, amount) => { damage += amount; },
  };
  return { world, actor, sector, hooks, damage: () => damage };
}

describe('original moving-sector clipping and crushing', () => {
  it('moves grounded actors with floors and completes only after strict overshoot', () => {
    const { world, actor, sector, hooks } = fixture();
    const destination = sector.floorHeight + FRAC_UNIT;
    expect(movePlane(world, actor.sector, FRAC_UNIT, destination, false, 'floor', 1, hooks)).toBe('ok');
    expect(actor.z).toBe(destination);
    expect(movePlane(world, actor.sector, FRAC_UNIT, destination, false, 'floor', 1, hooks)).toBe('pastDestination');
  });

  it('rolls back a blocked ordinary ceiling without damage', () => {
    const { world, actor, sector, hooks, damage } = fixture();
    sector.ceilingHeight = actor.floorZ + actor.height;
    actor.ceilingZ = sector.ceilingHeight;
    const before = sector.ceilingHeight;
    expect(movePlane(world, actor.sector, FRAC_UNIT, sector.floorHeight, false, 'ceiling', -1, hooks)).toBe('crushed');
    expect(sector.ceilingHeight).toBe(before);
    expect(actor.ceilingZ).toBe(before);
    expect(damage()).toBe(0);
  });

  it('keeps a crusher’s intermediate movement and damages every fourth tic', () => {
    const { world, actor, sector, hooks, damage } = fixture();
    sector.ceilingHeight = actor.floorZ + actor.height;
    actor.ceilingZ = sector.ceilingHeight;
    expect(movePlane(world, actor.sector, FRAC_UNIT, sector.floorHeight, true, 'ceiling', -1, hooks)).toBe('crushed');
    expect(sector.ceilingHeight).toBe(actor.floorZ + actor.height - FRAC_UNIT);
    expect(damage()).toBe(10);
    expect(world.actors.some(thing => thing.type === ActorType.MT_BLOOD)).toBe(true);
    world.levelTime = 1;
    movePlane(world, actor.sector, FRAC_UNIT, sector.floorHeight, true, 'ceiling', -1, hooks);
    expect(damage()).toBe(10);
  });

  it('restores a blocked overshoot yet reports destination reached, even with crushing', () => {
    const { world, actor, sector, hooks } = fixture();
    sector.ceilingHeight = actor.floorZ + actor.height;
    actor.ceilingZ = sector.ceilingHeight;
    const before = sector.ceilingHeight;
    const destination = before - FRAC_UNIT;
    expect(movePlane(world, actor.sector, 2 * FRAC_UNIT, destination, true, 'ceiling', -1, hooks)).toBe('pastDestination');
    expect(sector.ceilingHeight).toBe(before);
  });

  it('crunches corpses into nonsolid gibs and removes dropped items', () => {
    const { world, actor, sector, hooks } = fixture();
    const corpse = spawnActor(world, ActorType.MT_TROOP, actor.x + 32 * FRAC_UNIT, actor.y);
    corpse.health = 0;
    corpse.flags |= MobjFlag.MF_CORPSE;
    const item = spawnActor(world, ActorType.MT_CLIP, actor.x - 32 * FRAC_UNIT, actor.y);
    item.flags |= MobjFlag.MF_DROPPED;
    item.height = 64 * FRAC_UNIT;
    sector.ceilingHeight = sector.floorHeight + 16 * FRAC_UNIT;
    movePlane(world, actor.sector, FRAC_UNIT, sector.floorHeight, true, 'ceiling', -1, hooks);
    expect(corpse.state).toBe(StateId.S_GIBS);
    expect(corpse.radius).toBe(0);
    expect(corpse.height).toBe(0);
    expect(corpse.flags & MobjFlag.MF_SOLID).toBe(0);
    expect(item.removed).toBe(true);
  });
});
