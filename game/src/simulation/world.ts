// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native level setup from p_setup.c and p_mobj.c. See ../../LICENSE.
import type { BBox, DoomMap } from '../wad/map';
import { createActor, type Actor } from './actors';
import { ANG45 } from './angle';
import { ActorType, MobjFlag, actors, type SfxId } from './data/actors';
import { FRAC_BITS, FRAC_UNIT } from './fixed';
import { createPlayer, type Player } from './player';
import { createRandom, gameRandom, type RandomState } from './random';
import { buildSpatialMap, findSubsector, type SpatialMap } from './spatial';
import type { SectorThinker } from './specials/types';

export type Skill = 0 | 1 | 2 | 3 | 4;
export type GameMode = 'shareware' | 'registered' | 'retail';

export interface SectorState {
  floorHeight: number;
  ceilingHeight: number;
  floorTexture: string;
  ceilingTexture: string;
  lightLevel: number;
  special: number;
  tag: number;
  soundTarget: number | null;
  soundTraversed: number;
  soundValidCount: number;
  readonly lines: readonly number[];
  readonly blockBounds: BBox;
  readonly soundX: number;
  readonly soundY: number;
  specialData: SectorThinker | null;
}

export interface SideState {
  textureOffset: number;
  rowOffset: number;
  upperTexture: string;
  lowerTexture: string;
  middleTexture: string;
}

export interface ButtonState {
  readonly line: number;
  readonly where: 'upperTexture' | 'middleTexture' | 'lowerTexture';
  readonly texture: string;
  timer: number;
  readonly soundSector: number;
}

export type GameEvent =
  | { readonly type: 'sound'; readonly sound: SfxId; readonly actor: number | null }
  | { readonly type: 'sectorSound'; readonly sound: SfxId; readonly sector: number }
  | { readonly type: 'stopSound'; readonly actor: number }
  | { readonly type: 'message'; readonly text: string }
  | { readonly type: 'exit'; readonly secret: boolean };

export interface ActorThinker {
  readonly kind: 'actor';
  readonly id: number;
}

export interface World {
  readonly spatial: SpatialMap;
  readonly skill: Skill;
  readonly mode: GameMode;
  readonly fastMonsters: boolean;
  readonly respawnMonsters: boolean;
  readonly episode: number;
  readonly mapNumber: number;
  readonly random: RandomState;
  readonly player: Player;
  readonly sectors: SectorState[];
  readonly sides: SideState[];
  readonly buttons: (ButtonState | null)[];
  readonly lineSpecials: Uint16Array;
  readonly lineFlags: Uint16Array;
  readonly actors: Actor[];
  readonly actorsById: Map<number, Actor>;
  readonly activeActorIds: Set<number>;
  readonly actorBlocks: number[][];
  readonly thinkers: (ActorThinker | SectorThinker)[];
  readonly events: GameEvent[];
  nextActorId: number;
  levelTime: number;
  totalKills: number;
  totalItems: number;
  totalSecrets: number;
  onGround: boolean;
}

export interface WorldOptions {
  readonly skill: Skill;
  readonly mode?: GameMode;
  readonly random?: RandomState;
  readonly player?: Player;
  readonly noMonsters?: boolean;
  readonly fastMonsters?: boolean;
  readonly respawnMonsters?: boolean;
}

const mapActorTypes = new Map<number, ActorType>();
actors.forEach((info, type) => {
  if (info.doomednum !== -1) mapActorTypes.set(info.doomednum, type);
});
const doomTwoThings = new Set([68, 64, 88, 89, 69, 67, 71, 65, 66, 84]);

export function actorBlock(world: World, x: number, y: number): number | null {
  const { width, height } = world.spatial.map.blockmap;
  const bx = ((x - world.spatial.blockOriginX) | 0) >> (FRAC_BITS + 7);
  const by = ((y - world.spatial.blockOriginY) | 0) >> (FRAC_BITS + 7);
  return bx >= 0 && by >= 0 && bx < width && by < height ? by * width + bx : null;
}

export function linkActorBlock(world: World, actor: Actor): void {
  if ((actor.flags & MobjFlag.MF_NOBLOCKMAP) !== 0) return;
  const block = actorBlock(world, actor.x, actor.y);
  if (block !== null) world.actorBlocks[block]?.unshift(actor.id);
}

export function unlinkActorBlock(world: World, actor: Actor): void {
  if ((actor.flags & MobjFlag.MF_NOBLOCKMAP) !== 0) return;
  const block = actorBlock(world, actor.x, actor.y);
  const list = block === null ? undefined : world.actorBlocks[block];
  const index = list?.indexOf(actor.id) ?? -1;
  if (index !== -1) list?.splice(index, 1);
}

export function removeActor(world: World, actor: Actor): void {
  if (!world.activeActorIds.delete(actor.id)) return;
  unlinkActorBlock(world, actor);
  actor.removed = true;
  world.events.push({ type: 'stopSound', actor: actor.id });
}

// Keep source/target metadata alive while an active object still references it.
// Vanilla retained pointers after unlinking; IDs need an explicit lifetime here.
export function sweepActors(world: World): void {
  let write = 0;
  for (const actor of world.actors) {
    if (actor.removed) removeActor(world, actor);
    else world.actors[write++] = actor;
  }
  world.actors.length = write;
  write = 0;
  for (const thinker of world.thinkers) {
    if (thinker.kind === 'actor' ? world.activeActorIds.has(thinker.id) : !thinker.removed) world.thinkers[write++] = thinker;
  }
  world.thinkers.length = write;

  const retained = new Set(world.activeActorIds);
  const pending = [...retained];
  const retain = (id: number | null): void => {
    if (id !== null && !retained.has(id) && world.actorsById.has(id)) {
      retained.add(id);
      pending.push(id);
    }
  };
  retain(world.player.attacker);
  for (const sector of world.sectors) retain(sector.soundTarget);
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i];
    const actor = id === undefined ? undefined : world.actorsById.get(id);
    if (actor !== undefined) {
      retain(actor.target);
      retain(actor.tracer);
    }
  }
  for (const id of world.actorsById.keys()) {
    if (!retained.has(id)) world.actorsById.delete(id);
  }
}

export function spawnActor(
  world: World, type: ActorType, x: number, y: number,
  z: 'floor' | 'ceiling' | number = 'floor',
): Actor {
  const subsector = findSubsector(world.spatial, x, y);
  const sectorIndex = world.spatial.map.subsectors[subsector]?.sector;
  const sector = sectorIndex === undefined ? undefined : world.sectors[sectorIndex];
  if (sector === undefined || sectorIndex === undefined) throw new Error('Actor has no valid map sector');
  const actor = createActor(type, world.nextActorId++, x, y,
    sector.floorHeight, sector.ceilingHeight, sectorIndex, subsector,
    world.skill, world.random, z, world.fastMonsters);
  world.actors.push(actor);
  world.actorsById.set(actor.id, actor);
  world.activeActorIds.add(actor.id);
  linkActorBlock(world, actor);
  world.thinkers.push({ kind: 'actor', id: actor.id });
  return actor;
}

function spawnPlayer(world: World, x: number, y: number, angle: number): void {
  const actor = spawnActor(world, ActorType.MT_PLAYER, x, y);
  const player = world.player;
  actor.player = 0;
  actor.angle = angle;
  actor.health = player.health;
  player.actorId = actor.id;
  player.state = 'alive';
  player.refire = 0;
  player.message = null;
  player.damageCount = 0;
  player.bonusCount = 0;
  player.extraLight = 0;
  player.fixedColormap = 0;
  player.viewHeight = 41 * FRAC_UNIT;
  player.viewZ = 1;
}

export function createWorld(map: DoomMap, options: WorldOptions): World {
  const level = /^E([1-4])M([1-9])$/.exec(map.name);
  if (!level) throw new Error(`Invalid Doom 1 level name ${map.name}`);
  const player = options.player ?? createPlayer();
  const spatial = buildSpatialMap(map);
  const sectorLines: number[][] = Array.from({ length: map.sectors.length }, () => []);
  for (const [index, line] of spatial.lines.entries()) {
    sectorLines[line.frontSector]?.push(index);
    if (line.backSector !== null && line.backSector !== line.frontSector) sectorLines[line.backSector]?.push(index);
  }
  const sectorGroups = sectorLines.map(lines => {
    const bounds = { left: 0x7fffffff, right: -0x80000000, bottom: 0x7fffffff, top: -0x80000000 };
    for (const index of lines) {
      const line = spatial.lines[index];
      if (!line) throw new Error('Sector references an invalid line');
      bounds.left = Math.min(bounds.left, line.bbox.left);
      bounds.right = Math.max(bounds.right, line.bbox.right);
      bounds.bottom = Math.min(bounds.bottom, line.bbox.bottom);
      bounds.top = Math.max(bounds.top, line.bbox.top);
    }
    return {
      lines,
      blockBounds: {
        left: Math.max(0, ((bounds.left - spatial.blockOriginX - 32 * FRAC_UNIT) | 0) >> 23),
        right: Math.min(map.blockmap.width - 1, ((bounds.right - spatial.blockOriginX + 32 * FRAC_UNIT) | 0) >> 23),
        bottom: Math.max(0, ((bounds.bottom - spatial.blockOriginY - 32 * FRAC_UNIT) | 0) >> 23),
        top: Math.min(map.blockmap.height - 1, ((bounds.top - spatial.blockOriginY + 32 * FRAC_UNIT) | 0) >> 23),
      },
      soundX: Math.trunc(((bounds.right + bounds.left) | 0) / 2),
      soundY: Math.trunc(((bounds.top + bounds.bottom) | 0) / 2),
    };
  });
  const world: World = {
    spatial, skill: options.skill,
    mode: options.mode ?? 'registered', episode: Number(level[1]), mapNumber: Number(level[2]),
    fastMonsters: options.fastMonsters === true || options.skill === 4,
    respawnMonsters: options.respawnMonsters === true || options.skill === 4,
    random: options.random ?? createRandom(), player,
    sectors: map.sectors.map((sector, index) => {
      const group = sectorGroups[index];
      if (!group) throw new Error('Sector line group is missing');
      return {
      ...sector, floorHeight: sector.floorHeight << FRAC_BITS,
      ceilingHeight: sector.ceilingHeight << FRAC_BITS,
      soundTarget: null, soundTraversed: 0, soundValidCount: 0,
      ...group,
      specialData: null,
      };
    }),
    sides: map.sides.map(side => ({
      textureOffset: side.textureOffset << FRAC_BITS, rowOffset: side.rowOffset << FRAC_BITS,
      upperTexture: side.upperTexture, lowerTexture: side.lowerTexture,
      middleTexture: side.middleTexture,
    })),
    buttons: Array.from({ length: 16 }, () => null),
    lineSpecials: Uint16Array.from(map.lines, line => line.special),
    lineFlags: Uint16Array.from(map.lines, line => line.flags),
    actors: [], actorsById: new Map(), activeActorIds: new Set(),
    actorBlocks: Array.from({ length: map.blockmap.width * map.blockmap.height }, () => []),
    thinkers: [], events: [],
    nextActorId: 0, levelTime: 0, totalKills: 0, totalItems: 0,
    totalSecrets: map.sectors.filter(sector => sector.special === 9).length,
    onGround: false,
  };
  player.actorId = -1;
  player.killCount = player.itemCount = player.secretCount = 0;
  const skillFlag = options.skill === 0 ? 1 : options.skill === 4 ? 4 : 1 << (options.skill - 1);
  for (const thing of map.things) {
    // Vanilla non-commercial P_LoadThings ends its loop on a Doom II actor.
    if (doomTwoThings.has(thing.type)) break;
    const x = thing.x << FRAC_BITS, y = thing.y << FRAC_BITS;
    const angle = (ANG45 * Math.trunc(thing.angle / 45)) >>> 0;
    if (thing.type === 1) {
      spawnPlayer(world, x, y, angle);
      continue;
    }
    if (thing.type <= 4 || thing.type === 11 || (thing.flags & 16) !== 0 ||
      (thing.flags & skillFlag) === 0) continue;
    const type = mapActorTypes.get(thing.type);
    if (type === undefined) throw new Error(`Unknown map thing ${thing.type} at (${thing.x}, ${thing.y})`);
    const info = actors[type];
    if (info === undefined) throw new Error(`Unknown actor type ${type}`);
    if (options.noMonsters && (type === ActorType.MT_SKULL || (info.flags & MobjFlag.MF_COUNTKILL) !== 0)) continue;
    const actor = spawnActor(world, type, x, y, (info.flags & MobjFlag.MF_SPAWNCEILING) !== 0 ? 'ceiling' : 'floor');
    actor.spawnpoint = thing;
    actor.angle = angle;
    if (actor.tics > 0) actor.tics = 1 + gameRandom(world.random) % actor.tics;
    if ((actor.flags & MobjFlag.MF_COUNTKILL) !== 0) world.totalKills++;
    if ((actor.flags & MobjFlag.MF_COUNTITEM) !== 0) world.totalItems++;
    if ((thing.flags & 8) !== 0) actor.flags |= MobjFlag.MF_AMBUSH;
  }
  if (player.actorId < 0) throw new Error(`Map ${map.name} has no single-player start`);
  return world;
}
