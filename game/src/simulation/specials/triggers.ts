// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native p_spec.c and p_switch.c special routing. See ../../../LICENSE.
import type { DoomResources } from '../../wad/resources';
import type { Actor } from '../actors';
import { ActorType, SfxId } from '../data/actors';
import { FRAC_UNIT } from '../fixed';
import { CheatFlag, PowerType } from '../player';
import { gameRandom } from '../random';
import type { ButtonState, World } from '../world';
import { doCeiling, stopCeilings, tickCeiling } from './ceilings';
import { doDoor, doLockedDoor, spawnTimedDoor, tickDoor, useDoor } from './doors';
import { buildStairs, doDonut, doFloor, tickFloor } from './floors';
import { lightsOff, lightsOn, spawnLight, startStrobes, tickLight } from './lighting';
import type { PlaneHooks } from './planes';
import { doPlatform, stopPlatforms, tickPlatform } from './platforms';
import { teleport } from './teleport';
import type { CeilingType, DoorType, FloorType, PlatformType, SectorThinker } from './types';

export interface Specials {
  setup(): void;
  cross(line: number, side: 0 | 1, actor: Actor): void;
  shoot(line: number, actor: Actor): void;
  use(line: number, side: 0 | 1, actor: Actor): boolean;
  playerInSector(actor: Actor): void;
  tick(thinker: SectorThinker): void;
  update(): void;
}

type Action =
  | readonly ['door', DoorType]
  | readonly ['lockedDoor']
  | readonly ['floor', Exclude<FloorType, 'stairs' | 'donutRaise'>]
  | readonly ['ceiling', CeilingType]
  | readonly ['platform', PlatformType, number]
  | readonly ['stairs', 'build8' | 'turbo16']
  | readonly ['donut']
  | readonly ['lights', number]
  | readonly ['lightsOff']
  | readonly ['strobe']
  | readonly ['stopCeilings']
  | readonly ['stopPlatforms']
  | readonly ['teleport']
  | readonly ['ceilingAndFloor']
  | readonly ['exit', boolean];
type ActionTable = Readonly<Partial<Record<number, Action>>>;

const WALK_ONCE: ActionTable = {
  2: ['door', 'open'], 3: ['door', 'close'], 4: ['door', 'normal'],
  5: ['floor', 'raiseFloor'], 6: ['ceiling', 'fastCrushAndRaise'], 8: ['stairs', 'build8'],
  10: ['platform', 'downWaitUpStay', 0], 12: ['lights', 0], 13: ['lights', 255],
  16: ['door', 'close30ThenOpen'], 17: ['strobe'], 19: ['floor', 'lowerFloor'],
  22: ['platform', 'raiseToNearestAndChange', 0], 25: ['ceiling', 'crushAndRaise'],
  30: ['floor', 'raiseToTexture'], 35: ['lights', 35], 36: ['floor', 'turboLower'],
  37: ['floor', 'lowerAndChange'], 38: ['floor', 'lowerFloorToLowest'], 39: ['teleport'],
  40: ['ceilingAndFloor'], 44: ['ceiling', 'lowerAndCrush'], 53: ['platform', 'perpetualRaise', 0],
  54: ['stopPlatforms'], 56: ['floor', 'raiseFloorCrush'], 57: ['stopCeilings'],
  58: ['floor', 'raiseFloor24'], 59: ['floor', 'raiseFloor24AndChange'], 100: ['stairs', 'turbo16'],
  104: ['lightsOff'], 108: ['door', 'blazeRaise'], 109: ['door', 'blazeOpen'], 110: ['door', 'blazeClose'],
  119: ['floor', 'raiseFloorToNearest'], 121: ['platform', 'blazeDownWaitUpStay', 0],
  125: ['teleport'], 130: ['floor', 'raiseFloorTurbo'], 141: ['ceiling', 'silentCrushAndRaise'],
};

const WALK_REPEAT: ActionTable = {
  52: ['exit', false], 72: ['ceiling', 'lowerAndCrush'], 73: ['ceiling', 'crushAndRaise'],
  74: ['stopCeilings'], 75: ['door', 'close'], 76: ['door', 'close30ThenOpen'],
  77: ['ceiling', 'fastCrushAndRaise'], 79: ['lights', 35], 80: ['lights', 0], 81: ['lights', 255],
  82: ['floor', 'lowerFloorToLowest'], 83: ['floor', 'lowerFloor'], 84: ['floor', 'lowerAndChange'],
  86: ['door', 'open'], 87: ['platform', 'perpetualRaise', 0], 88: ['platform', 'downWaitUpStay', 0],
  89: ['stopPlatforms'], 90: ['door', 'normal'], 91: ['floor', 'raiseFloor'],
  92: ['floor', 'raiseFloor24'], 93: ['floor', 'raiseFloor24AndChange'], 94: ['floor', 'raiseFloorCrush'],
  95: ['platform', 'raiseToNearestAndChange', 0], 96: ['floor', 'raiseToTexture'],
  97: ['teleport'], 98: ['floor', 'turboLower'], 105: ['door', 'blazeRaise'],
  106: ['door', 'blazeOpen'], 107: ['door', 'blazeClose'], 120: ['platform', 'blazeDownWaitUpStay', 0],
  124: ['exit', true], 126: ['teleport'], 128: ['floor', 'raiseFloorToNearest'], 129: ['floor', 'raiseFloorTurbo'],
};

const USE_ONCE: ActionTable = {
  7: ['stairs', 'build8'], 9: ['donut'], 11: ['exit', false],
  14: ['platform', 'raiseAndChange', 32], 15: ['platform', 'raiseAndChange', 24],
  18: ['floor', 'raiseFloorToNearest'], 20: ['platform', 'raiseToNearestAndChange', 0],
  21: ['platform', 'downWaitUpStay', 0], 23: ['floor', 'lowerFloorToLowest'], 29: ['door', 'normal'],
  41: ['ceiling', 'lowerToFloor'], 49: ['ceiling', 'crushAndRaise'], 50: ['door', 'close'],
  51: ['exit', true], 55: ['floor', 'raiseFloorCrush'], 71: ['floor', 'turboLower'],
  101: ['floor', 'raiseFloor'], 102: ['floor', 'lowerFloor'], 103: ['door', 'open'],
  111: ['door', 'blazeRaise'], 112: ['door', 'blazeOpen'], 113: ['door', 'blazeClose'],
  122: ['platform', 'blazeDownWaitUpStay', 0], 127: ['stairs', 'turbo16'], 131: ['floor', 'raiseFloorTurbo'],
  133: ['lockedDoor'], 135: ['lockedDoor'], 137: ['lockedDoor'], 140: ['floor', 'raiseFloor512'],
};

const USE_REPEAT: ActionTable = {
  42: ['door', 'close'], 43: ['ceiling', 'lowerToFloor'], 45: ['floor', 'lowerFloor'],
  60: ['floor', 'lowerFloorToLowest'], 61: ['door', 'open'], 62: ['platform', 'downWaitUpStay', 1],
  63: ['door', 'normal'], 64: ['floor', 'raiseFloor'], 65: ['floor', 'raiseFloorCrush'],
  66: ['platform', 'raiseAndChange', 24], 67: ['platform', 'raiseAndChange', 32],
  68: ['platform', 'raiseToNearestAndChange', 0], 69: ['floor', 'raiseFloorToNearest'], 70: ['floor', 'turboLower'],
  99: ['lockedDoor'], 114: ['door', 'blazeRaise'], 115: ['door', 'blazeOpen'], 116: ['door', 'blazeClose'],
  123: ['platform', 'blazeDownWaitUpStay', 0], 132: ['floor', 'raiseFloorTurbo'],
  134: ['lockedDoor'], 136: ['lockedDoor'], 138: ['lights', 255], 139: ['lights', 35],
};

const SHOOT: ActionTable = {
  24: ['floor', 'raiseFloor'], 46: ['door', 'open'], 47: ['platform', 'raiseToNearestAndChange', 0],
};
const MANUAL_DOORS = new Set([1, 26, 27, 28, 31, 32, 33, 34, 117, 118]);
const MONSTER_WALK = new Set([39, 97, 125, 126, 4, 10, 88]);
const MONSTER_USE = new Set([1, 32, 33, 34]);
const EXCLUDED_PROJECTILES = new Set([ActorType.MT_ROCKET, ActorType.MT_PLASMA, ActorType.MT_BFG,
  ActorType.MT_TROOPSHOT, ActorType.MT_HEADSHOT, ActorType.MT_BRUISERSHOT]);
const SWITCH_SUFFIXES = ['BRCOM', 'BRN1', 'BRN2', 'BRNGN', 'BROWN', 'COMM', 'COMP', 'DIRT', 'EXIT',
  'GRAY', 'GRAY1', 'METAL', 'PIPE', 'SLAD', 'STARG', 'STON1', 'STON2', 'STONE', 'STRTN',
  'BLUE', 'CMT', 'GARG', 'GSTON', 'HOT', 'LION', 'SATYR', 'SKIN', 'VINE', 'WOOD'];
const TEXTURE_FIELDS = ['upperTexture', 'middleTexture', 'lowerTexture'] as const;

export function createSpecials(
  world: World, resources: Pick<DoomResources, 'wallNames' | 'textureHeight'>, hooks: PlaneHooks,
): Specials {
  const names = new Set(resources.wallNames.map(name => name.toUpperCase()));
  // Ultimate Doom uses the registered pairs too; the old C mode check omitted retail.
  const switchList = SWITCH_SUFFIXES.slice(0, world.mode === 'shareware' ? 19 : 29)
    .flatMap(suffix => [`SW1${suffix}`, `SW2${suffix}`]);
  for (const name of switchList) if (!names.has(name)) throw new Error(`Missing WAD switch texture ${name}`);
  let scrollLines = [...world.lineSpecials.entries()].filter(([, special]) => special === 48).map(([line]) => line);

  const lineAt = (index: number) => {
    const line = world.spatial.lines[index];
    if (!line) throw new Error(`Special references invalid line ${index}`);
    return line;
  };
  const startButton = (line: number, where: ButtonState['where'], texture: string): void => {
    if (world.buttons.some(button => button !== null && button.timer !== 0 && button.line === line)) return;
    for (let slot = 0; slot < 16; slot++) {
      const button = world.buttons[slot];
      if (button == null || button.timer === 0) {
        world.buttons[slot] = { line, where, texture, timer: 35, soundSector: lineAt(line).frontSector };
        return;
      }
    }
    throw new Error('P_StartButton: no button slots left');
  };
  const changeSwitch = (index: number, repeat: boolean): void => {
    if (!repeat) world.lineSpecials[index] = 0;
    const line = world.spatial.map.lines[index];
    const side = line === undefined ? undefined : world.sides[line.frontSide];
    if (!side) throw new Error('Switch has no valid front side');
    const sound = world.lineSpecials[index] === 11 ? SfxId.sfx_swtchx : SfxId.sfx_swtchn;
    for (let switchIndex = 0; switchIndex < switchList.length; switchIndex++) {
      const texture = switchList[switchIndex], opposite = switchList[switchIndex ^ 1];
      if (texture === undefined || opposite === undefined) throw new Error('Invalid switch texture pair');
      for (const where of TEXTURE_FIELDS) {
        if (side[where] !== texture) continue;
        // P_ChangeSwitchTexture uses buttonlist[0].soundorg before P_StartButton.
        const source = world.buttons[0]?.soundSector;
        world.events.push(source === undefined ? { type: 'sound', sound, actor: null } : { type: 'sectorSound', sound, sector: source });
        side[where] = opposite;
        if (repeat) startButton(index, where, texture);
        return;
      }
    }
  };
  const activate = (index: number, side: 0 | 1, actor: Actor, action: Action): boolean => {
    const tag = lineAt(index).tag;
    switch (action[0]) {
      case 'door': return doDoor(world, tag, action[1]);
      case 'lockedDoor': return doLockedDoor(world, index, actor, 'blazeOpen');
      case 'floor': return doFloor(world, tag, action[1], index, resources.textureHeight);
      case 'ceiling': return doCeiling(world, tag, action[1]);
      case 'platform': return doPlatform(world, tag, action[1], action[2], index);
      case 'stairs': return buildStairs(world, tag, action[1]);
      case 'donut': return doDonut(world, tag);
      case 'lights': lightsOn(world, tag, action[1]); return true;
      case 'lightsOff': lightsOff(world, tag); return true;
      case 'strobe': startStrobes(world, tag); return true;
      case 'stopCeilings': return stopCeilings(world, tag);
      case 'stopPlatforms': stopPlatforms(world, tag); return true;
      case 'teleport': return teleport(world, index, side, actor, hooks);
      case 'ceilingAndFloor':
        doCeiling(world, tag, 'raiseToHighest');
        return doFloor(world, tag, 'lowerFloorToLowest', index);
      case 'exit': world.events.push({ type: 'exit', secret: action[1] }); return true;
    }
  };

  const cross = (line: number, side: 0 | 1, actor: Actor): void => {
    lineAt(line);
    const special = world.lineSpecials[line] ?? 0;
    if (actor.player === null && (EXCLUDED_PROJECTILES.has(actor.type) || !MONSTER_WALK.has(special))) return;
    if ((special === 125 || special === 126) && actor.player !== null) return;
    const once = WALK_ONCE[special], action = once ?? WALK_REPEAT[special];
    if (action === undefined) return;
    activate(line, side, actor, action);
    if (once !== undefined) world.lineSpecials[line] = 0;
  };
  const shoot = (line: number, actor: Actor): void => {
    lineAt(line);
    const special = world.lineSpecials[line] ?? 0;
    if (actor.player === null && special !== 46) return;
    const action = SHOOT[special];
    if (action === undefined) return;
    activate(line, 0, actor, action);
    changeSwitch(line, special === 46);
  };
  const use = (line: number, side: 0 | 1, actor: Actor): boolean => {
    lineAt(line);
    const special = world.lineSpecials[line] ?? 0;
    if (side !== 0 && special !== 124) return false;
    if (actor.player === null && (((world.lineFlags[line] ?? 0) & 32) !== 0 || !MONSTER_USE.has(special))) return false;
    if (MANUAL_DOORS.has(special)) {
      useDoor(world, line, actor);
      return true;
    }
    const once = USE_ONCE[special], action = once ?? USE_REPEAT[special];
    if (action === undefined) return true;
    if (action[0] === 'exit') {
      changeSwitch(line, false);
      activate(line, side, actor, action);
    } else if (activate(line, side, actor, action)) changeSwitch(line, once === undefined);
    return true;
  };

  const setup = (): void => {
    for (const [index, sector] of world.sectors.entries()) {
      switch (sector.special) {
        case 1: spawnLight(world, index, 'flash'); break;
        case 2: spawnLight(world, index, 'strobe', 15); break;
        case 3: spawnLight(world, index, 'strobe', 35); break;
        case 4: spawnLight(world, index, 'strobe', 15); sector.special = 4; break;
        case 8: spawnLight(world, index, 'glow'); break;
        // World setup already counts secret sectors before their mutable specials.
        case 9: break;
        case 10: spawnTimedDoor(world, index, 'closeIn30'); break;
        case 12: spawnLight(world, index, 'strobe', 35, true); break;
        case 13: spawnLight(world, index, 'strobe', 15, true); break;
        case 14: spawnTimedDoor(world, index, 'raiseIn5Mins'); break;
        case 17: spawnLight(world, index, 'fire'); break;
      }
    }
    scrollLines = [...world.lineSpecials.entries()].filter(([, special]) => special === 48).map(([line]) => line);
    world.buttons.fill(null);
  };
  const playerInSector = (actor: Actor): void => {
    if (actor.player === null) return;
    const subsector = world.spatial.map.subsectors[actor.subsector];
    const sector = subsector === undefined ? undefined : world.sectors[subsector.sector];
    if (!sector) throw new Error('Player has no valid subsector');
    if (actor.z !== sector.floorHeight || sector.special === 0) return;
    const boots = world.player.powers[PowerType.pw_ironfeet] ?? 0;
    const damageTic = (world.levelTime & 31) === 0;
    switch (sector.special) {
      case 5: if (!boots && damageTic) hooks.damageActor(actor, null, null, 10); break;
      case 7: if (!boots && damageTic) hooks.damageActor(actor, null, null, 5); break;
      case 4:
      case 16:
        if ((!boots || gameRandom(world.random) < 5) && damageTic) hooks.damageActor(actor, null, null, 20);
        break;
      case 9: world.player.secretCount++; sector.special = 0; break;
      case 11:
        world.player.cheats &= ~CheatFlag.CF_GODMODE;
        if (damageTic) hooks.damageActor(actor, null, null, 20);
        if (world.player.health <= 10) world.events.push({ type: 'exit', secret: false });
        break;
      default: throw new Error(`P_PlayerInSpecialSector: unknown special ${sector.special}`);
    }
  };
  const tick = (thinker: SectorThinker): void => {
    if (thinker.removed) return;
    switch (thinker.kind) {
      case 'door': tickDoor(world, thinker, hooks); break;
      case 'floor': tickFloor(world, thinker, hooks); break;
      case 'ceiling': tickCeiling(world, thinker, hooks); break;
      case 'platform': tickPlatform(world, thinker, hooks); break;
      case 'light': tickLight(world, thinker); break;
    }
  };
  const update = (): void => {
    for (const index of scrollLines) {
      if (world.lineSpecials[index] !== 48) continue;
      const line = world.spatial.map.lines[index];
      const side = line === undefined ? undefined : world.sides[line.frontSide];
      if (!side) throw new Error('Scrolling line has no valid side');
      side.textureOffset = (side.textureOffset + FRAC_UNIT) | 0;
    }
    for (let slot = 0; slot < 16; slot++) {
      const button = world.buttons[slot];
      if (button == null || button.timer === 0 || --button.timer !== 0) continue;
      const line = world.spatial.map.lines[button.line];
      const side = line === undefined ? undefined : world.sides[line.frontSide];
      if (!side) throw new Error('Button has no valid front side');
      side[button.where] = button.texture;
      // The C address-of-pointer sound typo has no safe runtime counterpart.
      world.events.push({ type: 'sectorSound', sector: button.soundSector, sound: SfxId.sfx_swtchn });
      world.buttons[slot] = null;
    }
  };
  return { setup, cross, shoot, use, playerInSector, tick, update };
}
