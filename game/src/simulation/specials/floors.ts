// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native floor events, stairs and donut movers. See ../../../LICENSE.
import { SfxId } from '../data/actors';
import { FRAC_UNIT } from '../fixed';
import type { SectorState, World } from '../world';
import { highestFloor, lowestCeiling, lowestFloor, movePlane, neighbors, nextHighestFloor, otherSector, type PlaneHooks } from './planes';
import type { FloorThinker, FloorType } from './types';

type FloorActivation = Exclude<FloorType, 'stairs' | 'donutRaise'>;

function newFloor(world: World, index: number, type: FloorType): FloorThinker {
  const sector = world.sectors[index];
  if (!sector) throw new Error('Invalid floor sector');
  const floor: FloorThinker = {
    kind: 'floor', sector: index, removed: false, type,
    speed: FRAC_UNIT, destination: sector.floorHeight, direction: 1, crush: false,
    texture: sector.floorTexture, newSpecial: sector.special,
  };
  sector.specialData = floor;
  world.thinkers.push(floor);
  return floor;
}

export function tickFloor(world: World, floor: FloorThinker, hooks: PlaneHooks): void {
  const sector = world.sectors[floor.sector];
  if (!sector) throw new Error('Invalid floor sector');
  const result = movePlane(world, floor.sector, floor.speed, floor.destination, floor.crush, 'floor', floor.direction, hooks);
  if ((world.levelTime & 7) === 0) world.events.push({ type: 'sectorSound', sector: floor.sector, sound: SfxId.sfx_stnmov });
  if (result === 'pastDestination') {
    sector.specialData = null;
    if ((floor.direction === 1 && floor.type === 'donutRaise') || (floor.direction === -1 && floor.type === 'lowerAndChange')) {
      sector.special = floor.newSpecial;
      sector.floorTexture = floor.texture;
    }
    floor.removed = true;
    world.events.push({ type: 'sectorSound', sector: floor.sector, sound: SfxId.sfx_pstop });
  }
}

export function doFloor(
  world: World, tag: number, type: FloorActivation,
  lineIndex: number | null = null, textureHeight?: (name: string) => number,
): boolean {
  let activated = false;
  for (const [index, sector] of world.sectors.entries()) {
    if (sector.tag !== tag || sector.specialData !== null) continue;
    const floor = newFloor(world, index, type);
    activated = true;
    switch (type) {
      case 'lowerFloor': floor.direction = -1; floor.destination = highestFloor(world, index); break;
      case 'lowerFloorToLowest': floor.direction = -1; floor.destination = lowestFloor(world, index); break;
      case 'turboLower':
        floor.direction = -1; floor.speed *= 4; floor.destination = highestFloor(world, index);
        if (floor.destination !== sector.floorHeight) floor.destination = (floor.destination + 8 * FRAC_UNIT) | 0;
        break;
      case 'raiseFloor':
      case 'raiseFloorCrush':
        floor.crush = type === 'raiseFloorCrush';
        floor.destination = (Math.min(lowestCeiling(world, index), sector.ceilingHeight) - (floor.crush ? 8 * FRAC_UNIT : 0)) | 0;
        break;
      case 'raiseFloorTurbo': floor.speed *= 4; floor.destination = nextHighestFloor(world, index, sector.floorHeight); break;
      case 'raiseFloorToNearest': floor.destination = nextHighestFloor(world, index, sector.floorHeight); break;
      case 'raiseFloor24': floor.destination = (sector.floorHeight + 24 * FRAC_UNIT) | 0; break;
      case 'raiseFloor512': floor.destination = (sector.floorHeight + 512 * FRAC_UNIT) | 0; break;
      case 'raiseFloor24AndChange': {
        const line = lineIndex === null ? undefined : world.spatial.lines[lineIndex];
        const model = line === undefined ? undefined : world.sectors[line.frontSector];
        if (!model) throw new Error('Raise-and-change requires a valid triggering line');
        floor.destination = (sector.floorHeight + 24 * FRAC_UNIT) | 0;
        sector.floorTexture = model.floorTexture;
        sector.special = model.special;
        break;
      }
      case 'raiseToTexture': {
        if (!textureHeight) throw new Error('Raise-to-texture requires WAD texture heights');
        let minimum = 0x7fffffff;
        for (const lineIndex of sector.lines) {
          if (otherSector(world, lineIndex, index) === null) continue;
          const line = world.spatial.map.lines[lineIndex];
          if (!line) throw new Error('Floor references an invalid line');
          for (const sideIndex of [line.frontSide, line.backSide]) {
            const side = sideIndex === null ? undefined : world.sides[sideIndex];
            if (side) minimum = Math.min(minimum, textureHeight(side.lowerTexture) * FRAC_UNIT);
          }
        }
        floor.destination = (sector.floorHeight + minimum) | 0;
        break;
      }
      case 'lowerAndChange':
        floor.direction = -1;
        floor.destination = lowestFloor(world, index);
        for (const neighbor of neighbors(world, index)) {
          const model = world.sectors[neighbor];
          if (model?.floorHeight === floor.destination) {
            floor.texture = model.floorTexture; floor.newSpecial = model.special;
            break;
          }
        }
        break;
    }
  }
  return activated;
}

export function buildStairs(world: World, tag: number, type: 'build8' | 'turbo16'): boolean {
  let activated = false;
  const speed = type === 'build8' ? FRAC_UNIT / 4 : 4 * FRAC_UNIT;
  const step = (type === 'build8' ? 8 : 16) * FRAC_UNIT;
  for (let index = 0; index < world.sectors.length; index++) {
    const initial = world.sectors[index];
    if (!initial || initial.tag !== tag || initial.specialData !== null) continue;
    let sector: SectorState = initial;
    activated = true;
    const texture = sector.floorTexture;
    let height = (sector.floorHeight + step) | 0;
    let floor = newFloor(world, index, 'stairs');
    floor.speed = speed; floor.destination = height;
    let found: boolean;
    do {
      found = false;
      for (const lineIndex of sector.lines) {
        const line = world.spatial.lines[lineIndex];
        if (!line || ((world.lineFlags[lineIndex] ?? line.flags) & 4) === 0 || line.frontSector !== index || line.backSector === null) continue;
        const next = world.sectors[line.backSector];
        if (!next || next.floorTexture !== texture) continue;
        // Vanilla advances stair height even when that neighboring sector is busy.
        height = (height + step) | 0;
        if (next.specialData !== null) continue;
        index = line.backSector;
        sector = next;
        floor = newFloor(world, index, 'stairs');
        floor.speed = speed; floor.destination = height;
        found = true;
        break;
      }
    } while (found);
  }
  return activated;
}

export function doDonut(world: World, tag: number): boolean {
  let activated = false;
  for (const [index, hole] of world.sectors.entries()) {
    if (hole.tag !== tag || hole.specialData !== null) continue;
    activated = true;
    const firstLine = hole.lines[0];
    const ringIndex = firstLine === undefined ? null : otherSector(world, firstLine, index);
    const ring = ringIndex === null ? undefined : world.sectors[ringIndex];
    if (!ring || ringIndex === null) continue;
    for (const lineIndex of ring.lines) {
      const line = world.spatial.lines[lineIndex];
      // The C expression !flags & ML_TWOSIDED never rejects a line. It then
      // selects the back sector directly, retaining original line orientation.
      if (!line || line.backSector === index || line.backSector === null) continue;
      const model = world.sectors[line.backSector];
      if (!model) continue;
      const rising = newFloor(world, ringIndex, 'donutRaise');
      rising.speed = FRAC_UNIT / 2;
      rising.texture = model.floorTexture;
      rising.newSpecial = 0;
      rising.destination = model.floorHeight;
      const lowering = newFloor(world, index, 'lowerFloor');
      lowering.direction = -1;
      lowering.speed = FRAC_UNIT / 2;
      lowering.destination = model.floorHeight;
      break;
    }
  }
  return activated;
}
