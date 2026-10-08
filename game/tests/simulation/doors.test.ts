import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { createWorld } from '../../src/simulation/world';
import { doDoor, tickDoor, useDoor } from '../../src/simulation/specials/doors';
import type { PlaneHooks } from '../../src/simulation/specials/planes';
import { CardType } from '../../src/simulation/player';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import type { DoorThinker } from '../../src/simulation/specials/types';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');
const hooks: PlaneHooks = {
  movement: { touchPickup: () => {}, damageActor: () => {}, explodeMissile: () => {}, crossSpecial: () => {}, runActorAction: () => {} },
  damageActor: () => {},
};

function fixture() {
  const world = createWorld(map, { skill: 2 });
  const line = world.spatial.lines.findIndex(line => line.backSector !== null && line.backSector !== line.frontSector);
  const back = world.spatial.lines[line]?.backSector;
  const sector = back === null || back === undefined ? undefined : world.sectors[back];
  const actor = world.actorsById.get(world.player.actorId);
  if (!sector || !actor || back === null || back === undefined) throw new Error('Door fixture missing');
  sector.tag = 123;
  world.lineSpecials[line] = 1;
  return { world, line, sector, actor, index: back };
}

describe('native vertical doors', () => {
  it('creates a tagged door only when the sector is free', () => {
    const { world, sector } = fixture();
    expect(doDoor(world, 123, 'normal')).toBe(true);
    expect(sector.specialData?.kind).toBe('door');
    expect(doDoor(world, 123, 'normal')).toBe(false);
    expect(world.thinkers.at(-1)).toBe(sector.specialData);
  });

  it('requires a keycard or corresponding skull before opening a locked door', () => {
    const { world, line, sector, actor } = fixture();
    world.lineSpecials[line] = 26;
    expect(useDoor(world, line, actor)).toBe(false);
    expect(sector.specialData).toBe(null);
    expect(world.player.message).toBe('You need a blue key to open this door');
    expect(world.events.at(-1)).toMatchObject({ type: 'sound', actor: null });
    world.player.cards[CardType.it_blueskull] = true;
    expect(useDoor(world, line, actor)).toBe(true);
    expect(sector.specialData?.kind).toBe('door');
  });

  it('reverses an existing raise door without spawning another thinker', () => {
    const { world, line, sector, actor } = fixture();
    useDoor(world, line, actor);
    const door = sector.specialData;
    if (door?.kind !== 'door') throw new Error('Door missing');
    door.direction = -1;
    const count = world.thinkers.length;
    useDoor(world, line, actor);
    expect(door.direction).toBe(1);
    useDoor(world, line, actor);
    expect(door.direction).toBe(-1);
    expect(world.thinkers.length).toBe(count);
  });

  it('clears a one-shot manual open special and uses blazing speed when requested', () => {
    const { world, line, sector, actor } = fixture();
    world.lineSpecials[line] = 118;
    useDoor(world, line, actor);
    expect(world.lineSpecials[line]).toBe(0);
    expect(sector.specialData).toMatchObject({ type: 'blazeOpen', speed: 8 * FRAC_UNIT });
  });

  it('counts the full wait before beginning the next downward movement', () => {
    const { world, index, sector } = fixture();
    const door: DoorThinker = { kind: 'door', sector: index, removed: false, type: 'normal', speed: 2 * FRAC_UNIT,
      topHeight: sector.ceilingHeight, direction: 0, topWait: 150, count: 2 };
    const before = sector.ceilingHeight;
    tickDoor(world, door, hooks);
    expect(door.direction).toBe(0);
    tickDoor(world, door, hooks);
    expect(door.direction).toBe(-1);
    expect(sector.ceilingHeight).toBe(before);
  });

  it('removes an open-only door thinker after the strict destination overshoot', () => {
    const { world, index, sector } = fixture();
    const door: DoorThinker = { kind: 'door', sector: index, removed: false, type: 'open', speed: 2 * FRAC_UNIT,
      topHeight: sector.ceilingHeight + 2 * FRAC_UNIT, direction: 1, topWait: 150, count: 0 };
    sector.specialData = door;
    tickDoor(world, door, hooks);
    expect(door.removed).toBe(false);
    tickDoor(world, door, hooks);
    expect(door.removed).toBe(true);
    expect(sector.specialData).toBe(null);
  });
});
