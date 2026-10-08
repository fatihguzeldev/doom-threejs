import type { Actor } from '../simulation/actors';
import { ActorType, MobjFlag, SfxId, actors } from '../simulation/data/actors';
import { SpriteId, StateId, spriteNames, states } from '../simulation/data/states';
import { WeaponType } from '../simulation/data/weapons';
import type { Player, WeaponSprite } from '../simulation/player';
import type { RandomState } from '../simulation/random';
import type { CeilingThinker, DoorThinker, FloorThinker, LightThinker, PlatformThinker, SectorThinker } from '../simulation/specials/types';
import { actorBlock, createWorld, type ActorThinker, type ButtonState, type GameEvent, type GameMode, type SectorState, type SideState, type Skill, type World } from '../simulation/world';
import type { WadArchive } from '../wad/archive';
import { decodeMap, type MapThing } from '../wad/map';
import { array, boolean, int32, integer, invalid, nonnegative, nullable, object, oneOf, shape, string, uint32, type Parser } from './json';

export const readMode = oneOf<GameMode>(['shareware', 'registered', 'retail']);
export const readSkill = oneOf<Skill>([0, 1, 2, 3, 4]);
export const readRandom = shape<RandomState>({ gameIndex: integer(0, 255), menuIndex: integer(0, 255) });
const readState = oneOf(Object.values(StateId).filter((value): value is StateId => typeof value === 'number' && value < states.length));
const readSprite = oneOf(Object.values(SpriteId).filter((value): value is SpriteId => typeof value === 'number' && value < spriteNames.length));
const readActorType = oneOf(Object.values(ActorType).filter((value): value is ActorType => typeof value === 'number' && value < actors.length));
const readWeapon = oneOf(Object.values(WeaponType).filter((value): value is WeaponType => typeof value === 'number' && value < WeaponType.NUMWEAPONS));
const readPendingWeapon = oneOf([...Object.values(WeaponType).filter((value): value is WeaponType => typeof value === 'number' && value < WeaponType.NUMWEAPONS), WeaponType.wp_nochange]);
const readWeaponSprite = shape<WeaponSprite>({ state: readState, tics: int32, sx: int32, sy: int32 });
const readWeaponSprites: Parser<Player['psprites']> = (value, path) => {
  const values = array(readWeaponSprite, 2)(value, path);
  const first = values[0], second = values[1];
  if (!first || !second) invalid(path, 'two weapon sprites');
  return [first, second];
};

export const readPlayer = shape<Player>({
  actorId: nonnegative, state: oneOf(['alive', 'dead', 'reborn']), health: int32,
  armorPoints: nonnegative, armorType: integer(0, 2), ammo: array(nonnegative, 4), maxAmmo: array(nonnegative, 4),
  ownedWeapons: array(boolean, 9), readyWeapon: readWeapon, pendingWeapon: readPendingWeapon,
  psprites: readWeaponSprites, cards: array(boolean, 6), powers: array(nonnegative, 6),
  backpack: boolean, didSecret: boolean, bonusCount: nonnegative, damageCount: nonnegative,
  killCount: nonnegative, itemCount: nonnegative, secretCount: nonnegative,
  viewZ: int32, viewHeight: int32, deltaViewHeight: int32, bob: int32, extraLight: int32,
  fixedColormap: int32, colormap: int32, refire: nonnegative, attackDown: boolean, useDown: boolean,
  cheats: uint32, attacker: nullable(nonnegative), message: nullable(string()),
});
const readThing = shape<MapThing>({ x: integer(-32768, 32767), y: integer(-32768, 32767), angle: integer(0, 65535), type: integer(0, 65535), flags: integer(0, 65535) });
const readActor = shape<Actor>({
  id: nonnegative, type: readActorType, state: readState, tics: int32, sprite: readSprite, frame: integer(0, 65535),
  x: int32, y: int32, z: int32, momx: int32, momy: int32, momz: int32, angle: uint32,
  radius: integer(0), height: integer(0), flags: uint32, health: int32, reactionTime: int32,
  threshold: int32, moveDir: integer(0, 8), moveCount: int32, lastLook: integer(0, 3),
  target: nullable(nonnegative), tracer: nullable(nonnegative), sector: nonnegative, subsector: nonnegative,
  floorZ: int32, ceilingZ: int32, spawnpoint: nullable(readThing), player: nullable(oneOf([0])), removed: boolean, fastStates: boolean,
});
const readButton = shape<ButtonState>({
  line: nonnegative, where: oneOf(['upperTexture', 'middleTexture', 'lowerTexture']), texture: string(8), timer: integer(1, 35), soundSector: nonnegative,
});
const readSide = shape<SideState>({ textureOffset: int32, rowOffset: int32, upperTexture: string(8), lowerTexture: string(8), middleTexture: string(8) });

type SavedSector = Pick<SectorState, 'floorHeight' | 'ceilingHeight' | 'floorTexture' | 'ceilingTexture' | 'lightLevel' | 'special' | 'tag' | 'soundTarget' | 'soundTraversed' | 'soundValidCount'> & { readonly specialData: number | null };
const readSector = shape<SavedSector>({
  floorHeight: int32, ceilingHeight: int32, floorTexture: string(8), ceilingTexture: string(8),
  lightLevel: int32, special: integer(0, 65535), tag: integer(0, 65535), soundTarget: nullable(nonnegative),
  soundTraversed: nonnegative, soundValidCount: nonnegative, specialData: nullable(nonnegative),
});
const readActorThinker = shape<ActorThinker>({ kind: oneOf(['actor']), id: nonnegative });
const readDoor = shape<DoorThinker>({
  kind: oneOf(['door']), sector: nonnegative, removed: boolean,
  type: oneOf(['normal', 'close30ThenOpen', 'close', 'open', 'raiseIn5Mins', 'blazeRaise', 'blazeOpen', 'blazeClose']),
  speed: integer(0), topHeight: int32, direction: oneOf([-1, 0, 1, 2]), topWait: nonnegative, count: int32,
});
const readFloor = shape<FloorThinker>({
  kind: oneOf(['floor']), sector: nonnegative, removed: boolean,
  type: oneOf(['lowerFloor', 'lowerFloorToLowest', 'turboLower', 'raiseFloor', 'raiseFloorToNearest', 'raiseToTexture', 'lowerAndChange', 'raiseFloor24', 'raiseFloor24AndChange', 'raiseFloorCrush', 'raiseFloorTurbo', 'raiseFloor512', 'donutRaise', 'stairs']),
  speed: integer(0), destination: int32, direction: oneOf([-1, 1]), crush: boolean, texture: string(8), newSpecial: integer(0, 65535),
});
const readCeiling = shape<CeilingThinker>({
  kind: oneOf(['ceiling']), sector: nonnegative, removed: boolean, activeSlot: nullable(integer(0, 29)),
  type: oneOf(['lowerToFloor', 'raiseToHighest', 'lowerAndCrush', 'crushAndRaise', 'fastCrushAndRaise', 'silentCrushAndRaise']),
  speed: integer(0), topHeight: int32, bottomHeight: int32, direction: oneOf([-1, 0, 1]), oldDirection: oneOf([-1, 1]), crush: boolean, tag: integer(0, 65535),
});
const readPlatform = shape<PlatformThinker>({
  kind: oneOf(['platform']), sector: nonnegative, removed: boolean, activeSlot: nullable(integer(0, 29)),
  type: oneOf(['perpetualRaise', 'downWaitUpStay', 'raiseAndChange', 'raiseToNearestAndChange', 'blazeDownWaitUpStay']),
  speed: integer(0), low: int32, high: int32, wait: nonnegative, count: int32,
  status: oneOf(['up', 'down', 'waiting', 'stasis']), oldStatus: oneOf(['up', 'down', 'waiting']), crush: boolean, tag: integer(0, 65535),
});
const readLight = shape<LightThinker>({
  kind: oneOf(['light']), sector: nonnegative, removed: boolean, type: oneOf(['flash', 'strobe', 'glow', 'fire']),
  count: int32, min: int32, max: int32, minTime: nonnegative, maxTime: nonnegative, direction: oneOf([-1, 1]),
});
type Thinker = ActorThinker | SectorThinker;
const readThinker: Parser<Thinker> = (value, path) => {
  const source = object(value, path);
  switch (source['kind']) {
    case 'actor': return readActorThinker(value, path);
    case 'door': return readDoor(value, path);
    case 'floor': return readFloor(value, path);
    case 'ceiling': return readCeiling(value, path);
    case 'platform': return readPlatform(value, path);
    case 'light': return readLight(value, path);
    default: return invalid(`${path}.kind`, 'known thinker kind');
  }
};
const readSound = oneOf(Object.values(SfxId).filter((value): value is SfxId => typeof value === 'number' && value < SfxId.NUMSFX));
const readEvent: Parser<GameEvent> = (value, path) => {
  switch (object(value, path)['type']) {
    case 'sound': return shape<Extract<GameEvent, { type: 'sound' }>>({ type: oneOf(['sound']), sound: readSound, actor: nullable(nonnegative) })(value, path);
    case 'sectorSound': return shape<Extract<GameEvent, { type: 'sectorSound' }>>({ type: oneOf(['sectorSound']), sound: readSound, sector: nonnegative })(value, path);
    case 'stopSound': return shape<Extract<GameEvent, { type: 'stopSound' }>>({ type: oneOf(['stopSound']), actor: nonnegative })(value, path);
    case 'message': return shape<Extract<GameEvent, { type: 'message' }>>({ type: oneOf(['message']), text: string() })(value, path);
    case 'exit': return shape<Extract<GameEvent, { type: 'exit' }>>({ type: oneOf(['exit']), secret: boolean })(value, path);
    default: return invalid(`${path}.type`, 'known game event');
  }
};

interface SavedWorld {
  readonly mapName: string;
  readonly skill: Skill;
  readonly mode: GameMode;
  readonly fastMonsters: boolean;
  readonly respawnMonsters: boolean;
  readonly player: Player;
  readonly random: RandomState;
  readonly sectors: SavedSector[];
  readonly sides: SideState[];
  readonly buttons: (ButtonState | null)[];
  readonly lineSpecials: number[];
  readonly lineFlags: number[];
  readonly actors: Actor[];
  readonly actorOrder: number[];
  readonly activeActorIds: number[];
  readonly actorBlocks: number[][];
  readonly thinkers: Thinker[];
  readonly events: GameEvent[];
  readonly nextActorId: number;
  readonly levelTime: number;
  readonly totalKills: number;
  readonly totalItems: number;
  readonly totalSecrets: number;
  readonly onGround: boolean;
}
const readWorld = shape<SavedWorld>({
  mapName: string(4), skill: readSkill, mode: readMode, fastMonsters: boolean, respawnMonsters: boolean,
  player: readPlayer, random: readRandom, sectors: array(readSector), sides: array(readSide), buttons: array(nullable(readButton), 16),
  lineSpecials: array(integer(0, 65535)), lineFlags: array(integer(0, 65535)), actors: array(readActor), actorOrder: array(nonnegative),
  activeActorIds: array(nonnegative), actorBlocks: array(array(nonnegative), undefined, 0x10000), thinkers: array(readThinker), events: array(readEvent),
  nextActorId: nonnegative, levelTime: int32, totalKills: nonnegative, totalItems: nonnegative, totalSecrets: nonnegative, onGround: boolean,
});

export function saveWorld(world: World): SavedWorld {
  return {
    mapName: world.spatial.map.name, skill: world.skill, mode: world.mode,
    fastMonsters: world.fastMonsters, respawnMonsters: world.respawnMonsters,
    player: world.player, random: world.random,
    sectors: world.sectors.map(sector => {
      const index = sector.specialData === null ? null : world.thinkers.indexOf(sector.specialData);
      if (index === -1) throw new Error('Cannot save sector thinker missing from the world');
      return {
        floorHeight: sector.floorHeight, ceilingHeight: sector.ceilingHeight, floorTexture: sector.floorTexture, ceilingTexture: sector.ceilingTexture,
        lightLevel: sector.lightLevel, special: sector.special, tag: sector.tag, soundTarget: sector.soundTarget,
        soundTraversed: sector.soundTraversed, soundValidCount: sector.soundValidCount, specialData: index,
      };
    }),
    sides: world.sides, buttons: world.buttons,
    lineSpecials: [...world.lineSpecials], lineFlags: [...world.lineFlags], actors: [...world.actorsById.values()],
    actorOrder: world.actors.map(actor => actor.id), activeActorIds: [...world.activeActorIds],
    actorBlocks: world.actorBlocks, thinkers: world.thinkers, events: world.events,
    nextActorId: world.nextActorId, levelTime: world.levelTime, totalKills: world.totalKills,
    totalItems: world.totalItems, totalSecrets: world.totalSecrets, onGround: world.onGround,
  };
}

export function loadWorld(wad: WadArchive, value: unknown): World {
  const saved = readWorld(value, 'world');
  if (!/^E[1-4]M[1-9]$/.test(saved.mapName)) invalid('world.mapName', 'Doom 1 map name');
  if (saved.skill === 4 && (!saved.fastMonsters || !saved.respawnMonsters)) invalid('world', 'Nightmare fast and respawn modes');
  const map = decodeMap(wad, saved.mapName);
  if (saved.sectors.length !== map.sectors.length || saved.sides.length !== map.sides.length ||
    saved.lineSpecials.length !== map.lines.length || saved.lineFlags.length !== map.lines.length ||
    saved.actorBlocks.length !== map.blockmap.cells.length) invalid('world', 'map-matching sector/side/line/block counts');
  const world = createWorld(map, { skill: saved.skill, mode: saved.mode, fastMonsters: saved.fastMonsters, respawnMonsters: saved.respawnMonsters, noMonsters: true });
  world.actors.length = 0; world.actorsById.clear(); world.activeActorIds.clear(); world.thinkers.length = 0; world.events.length = 0;
  for (const list of world.actorBlocks) list.length = 0;
  Object.assign(world.player, saved.player);
  Object.assign(world.random, saved.random);
  Object.assign(world, { nextActorId: saved.nextActorId, levelTime: saved.levelTime, totalKills: saved.totalKills,
    totalItems: saved.totalItems, totalSecrets: saved.totalSecrets, onGround: saved.onGround });
  world.lineSpecials.set(saved.lineSpecials); world.lineFlags.set(saved.lineFlags);
  world.sides.forEach((side, index) => Object.assign(side, saved.sides[index]));
  world.buttons.splice(0, 16, ...saved.buttons);
  for (const actor of saved.actors) {
    if (world.actorsById.has(actor.id) || actor.id >= saved.nextActorId) invalid('world.actors', 'unique actor IDs below nextActorId');
    const subsector = map.subsectors[actor.subsector];
    if (!subsector || subsector.sector !== actor.sector) invalid('world.actors', 'matching valid subsector and sector');
    world.actorsById.set(actor.id, actor);
  }
  const reference = (id: number | null): Actor | null => {
    if (id === null) return null;
    const actor = world.actorsById.get(id);
    if (!actor) invalid('world.actor reference', `existing ID ${id}`);
    return actor;
  };
  for (const actor of saved.actors) { reference(actor.target); reference(actor.tracer); }
  reference(world.player.attacker);
  const pooled = new Set<number>();
  for (const id of saved.actorOrder) {
    if (pooled.has(id)) invalid('world.actorOrder', 'unique actor IDs');
    pooled.add(id);
    const actor = reference(id);
    if (actor) world.actors.push(actor);
  }
  for (const id of saved.activeActorIds) {
    const actor = reference(id);
    if (!actor || actor.removed || !pooled.has(id) || world.activeActorIds.has(id)) invalid('world.activeActorIds', 'unique live pooled actor IDs');
    world.activeActorIds.add(id);
  }
  for (const actor of saved.actors) {
    if (!actor.removed && !world.activeActorIds.has(actor.id)) invalid('world.actors', 'active ID for every live actor');
  }
  const playerActor = reference(world.player.actorId);
  if (!playerActor || playerActor.player !== 0 || !world.activeActorIds.has(playerActor.id)) invalid('world.player.actorId', 'active single-player actor');
  const linked = new Set<number>();
  for (const [block, ids] of saved.actorBlocks.entries()) {
    const list = world.actorBlocks[block];
    if (!list) invalid('world.actorBlocks', 'valid block index');
    for (const id of ids) {
      const actor = reference(id);
      if (!actor || !world.activeActorIds.has(id) || linked.has(id) || (actor.flags & MobjFlag.MF_NOBLOCKMAP) !== 0 || actorBlock(world, actor.x, actor.y) !== block) invalid('world.actorBlocks', 'unique live actors linked in their center block');
      linked.add(id);
      // Persist head order; replaying registration order changes collision traversal.
      list.push(id);
    }
  }
  for (const id of world.activeActorIds) {
    const actor = reference(id);
    if (actor && (actor.flags & MobjFlag.MF_NOBLOCKMAP) === 0 && actorBlock(world, actor.x, actor.y) !== null && !linked.has(id)) invalid('world.actorBlocks', 'block membership for every linked actor');
  }
  const actorThinkers = new Set<number>();
  const ceilingSlots = new Set<number>(), platformSlots = new Set<number>();
  for (const thinker of saved.thinkers) {
    if (thinker.kind === 'actor') {
      reference(thinker.id);
      if (!pooled.has(thinker.id) || actorThinkers.has(thinker.id)) invalid('world.thinkers', 'unique pooled actor thinkers');
      actorThinkers.add(thinker.id);
    } else {
      if (!world.sectors[thinker.sector]) invalid('world.thinkers.sector', 'valid sector index');
      if (!thinker.removed && (thinker.kind === 'ceiling' || thinker.kind === 'platform') && thinker.activeSlot !== null) {
        const slots = thinker.kind === 'ceiling' ? ceilingSlots : platformSlots;
        if (slots.has(thinker.activeSlot)) invalid('world.thinkers.activeSlot', 'unique active slot');
        slots.add(thinker.activeSlot);
      }
    }
    world.thinkers.push(thinker);
  }
  for (const id of world.activeActorIds) if (!actorThinkers.has(id)) invalid('world.thinkers', 'thinker for every live actor');
  for (const [index, savedSector] of saved.sectors.entries()) {
    const sector = world.sectors[index];
    if (!sector) invalid('world.sectors', 'valid sector index');
    const { specialData, ...state } = savedSector;
    Object.assign(sector, state);
    reference(sector.soundTarget);
    const thinker = specialData === null ? null : world.thinkers[specialData];
    if (thinker === undefined || (thinker !== null && (thinker.kind === 'actor' || thinker.kind === 'light' || thinker.sector !== index || thinker.removed))) invalid('world.sector.specialData', 'matching live movement thinker');
    sector.specialData = thinker;
  }
  // Manual open doors and donuts can replace specialData while an older native
  // movement thinker remains scheduled; only the actual association is checked.
  const buttonLines = new Set<number>();
  for (const button of world.buttons) {
    if (button === null) continue;
    if (!map.lines[button.line] || !world.sectors[button.soundSector] || buttonLines.has(button.line)) invalid('world.buttons', 'unique valid lines and sound sectors');
    buttonLines.add(button.line);
  }
  for (const event of saved.events) {
    if (event.type === 'sectorSound' && !world.sectors[event.sector]) invalid('world.events', 'valid sound sector');
    world.events.push(event);
  }
  return world;
}
