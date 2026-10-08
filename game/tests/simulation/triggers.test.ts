import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ActorType, MobjFlag, SfxId } from '../../src/simulation/data/actors';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { CardType, CheatFlag, PowerType } from '../../src/simulation/player';
import { createSpecials } from '../../src/simulation/specials/triggers';
import type { PlaneHooks } from '../../src/simulation/specials/planes';
import { createWorld, spawnActor, type GameMode } from '../../src/simulation/world';
import { parseWad } from '../../src/wad/archive';
import { decodeMap, type DoomMap, type MapSector } from '../../src/wad/map';
import { createResources } from '../../src/wad/resources';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const resources = createResources(wad);
const registeredNames = ['BLUE', 'CMT', 'GARG', 'GSTON', 'HOT', 'LION', 'SATYR', 'SKIN', 'VINE', 'WOOD'].flatMap(name => [`SW1${name}`, `SW2${name}`]);
const allResources = { ...resources, wallNames: [...resources.wallNames, ...registeredNames] };
const sector = (floorHeight: number, special = 0, tag = 0): MapSector => ({
  floorHeight, ceilingHeight: 128, floorTexture: 'FLOOR', ceilingTexture: 'CEILING', lightLevel: 160, special, tag,
});

function fixture(special = 0, mode: GameMode = 'shareware') {
  const map: DoomMap = {
    name: 'E1M1', vertices: [{ x: 0, y: 0 }, { x: 128, y: 0 }, { x: 0, y: 128 }, { x: 128, y: 128 }],
    sectors: [sector(0), sector(32, 0, 7), sector(64)],
    sides: [0, 1, 1, 2].map(index => ({ textureOffset: 0, rowOffset: 0, upperTexture: '-', middleTexture: 'SW1BRCOM', lowerTexture: 'BIGDOOR2', sector: index })),
    lines: [
      { v1: 0, v2: 1, flags: 4, special, tag: 7, frontSide: 0, backSide: 1 },
      { v1: 2, v2: 3, flags: 4, special: 0, tag: 0, frontSide: 2, backSide: 3 },
    ],
    segs: [{ v1: 0, v2: 1, angle: 0, line: 0, side: 0, offset: 0 }, { v1: 1, v2: 0, angle: 0, line: 0, side: 1, offset: 0 }],
    subsectors: [{ firstSeg: 0, segCount: 1, sector: 0 }, { firstSeg: 1, segCount: 1, sector: 1 }],
    nodes: [{ x: 0, y: 0, dx: 128, dy: 0, boxes: [{ left: 0, right: 128, bottom: -128, top: 0 }, { left: 0, right: 128, bottom: 0, top: 128 }], children: [0x8000, 0x8001] }],
    things: [{ x: 32, y: -32, angle: 90, type: 1, flags: 7 }],
    blockmap: { originX: -128, originY: -128, width: 4, height: 4, cells: Array.from({ length: 16 }, () => [0, 1]) },
    reject: new Uint8Array(2),
  };
  const world = createWorld(map, { skill: 2, mode });
  const actor = world.actorsById.get(world.player.actorId);
  const target = world.sectors[1], front = world.sectors[0], side = world.sides[0];
  if (!actor || !target || !front || !side) throw new Error('Trigger fixture missing');
  const hits: number[] = [];
  const hooks: PlaneHooks = {
    damageActor: (victim, _inflictor, _source, damage) => { hits.push(damage); victim.health -= damage; if (victim.player !== null) world.player.health -= damage; },
    movement: { touchPickup: () => {}, damageActor: () => {}, explodeMissile: () => {}, crossSpecial: () => {}, runActorAction: () => {} },
  };
  const specials = createSpecials(world, allResources, hooks);
  return { world, actor, target, front, side, hooks, hits, specials };
}

describe('native special line routing', () => {
  it.each([
    [2, 'door', 'open'], [3, 'door', 'close'], [4, 'door', 'normal'], [16, 'door', 'close30ThenOpen'],
    [108, 'door', 'blazeRaise'], [109, 'door', 'blazeOpen'], [110, 'door', 'blazeClose'],
    [5, 'floor', 'raiseFloor'], [19, 'floor', 'lowerFloor'], [30, 'floor', 'raiseToTexture'],
    [36, 'floor', 'turboLower'], [37, 'floor', 'lowerAndChange'], [38, 'floor', 'lowerFloorToLowest'],
    [56, 'floor', 'raiseFloorCrush'], [58, 'floor', 'raiseFloor24'], [59, 'floor', 'raiseFloor24AndChange'],
    [119, 'floor', 'raiseFloorToNearest'], [130, 'floor', 'raiseFloorTurbo'],
    [6, 'ceiling', 'fastCrushAndRaise'], [25, 'ceiling', 'crushAndRaise'], [44, 'ceiling', 'lowerAndCrush'], [141, 'ceiling', 'silentCrushAndRaise'],
    [10, 'platform', 'downWaitUpStay'], [22, 'platform', 'raiseToNearestAndChange'], [53, 'platform', 'perpetualRaise'], [121, 'platform', 'blazeDownWaitUpStay'],
    [8, 'floor', 'stairs'], [100, 'floor', 'stairs'],
  ])('routes walk-once %s to %s/%s and consumes the line', (code, kind, type) => {
    const { specials, actor, world, target } = fixture(Number(code));
    specials.cross(0, 0, actor);
    expect(target.specialData).toMatchObject({ kind, type });
    expect(world.lineSpecials[0]).toBe(0);
  });

  it.each([
    [72, 'ceiling', 'lowerAndCrush'], [73, 'ceiling', 'crushAndRaise'], [77, 'ceiling', 'fastCrushAndRaise'],
    [75, 'door', 'close'], [76, 'door', 'close30ThenOpen'], [86, 'door', 'open'], [90, 'door', 'normal'],
    [105, 'door', 'blazeRaise'], [106, 'door', 'blazeOpen'], [107, 'door', 'blazeClose'],
    [82, 'floor', 'lowerFloorToLowest'], [83, 'floor', 'lowerFloor'], [84, 'floor', 'lowerAndChange'],
    [91, 'floor', 'raiseFloor'], [92, 'floor', 'raiseFloor24'], [93, 'floor', 'raiseFloor24AndChange'],
    [94, 'floor', 'raiseFloorCrush'], [96, 'floor', 'raiseToTexture'], [98, 'floor', 'turboLower'],
    [128, 'floor', 'raiseFloorToNearest'], [129, 'floor', 'raiseFloorTurbo'],
    [87, 'platform', 'perpetualRaise'], [88, 'platform', 'downWaitUpStay'], [95, 'platform', 'raiseToNearestAndChange'], [120, 'platform', 'blazeDownWaitUpStay'],
  ])('routes repeating walk %s to %s/%s without consuming it', (code, kind, type) => {
    const { specials, actor, world, target } = fixture(Number(code));
    specials.cross(0, 0, actor);
    expect(target.specialData).toMatchObject({ kind, type });
    expect(world.lineSpecials[0]).toBe(code);
  });

  it('consumes failed walk-once activations but retains failed use switches', () => {
    const { specials, actor, world, target, side } = fixture(2);
    target.tag = 8;
    specials.cross(0, 0, actor);
    expect(world.lineSpecials[0]).toBe(0);
    world.lineSpecials[0] = 103;
    expect(specials.use(0, 0, actor)).toBe(true);
    expect(world.lineSpecials[0]).toBe(103);
    expect(side.middleTexture).toBe('SW1BRCOM');
  });

  it('creates the ceiling first for special 40 so its shared movement slot prevents a floor thinker', () => {
    const { specials, actor, target, world } = fixture(40);
    specials.cross(0, 0, actor);
    expect(target.specialData).toMatchObject({ kind: 'ceiling', type: 'raiseToHighest' });
    expect(world.thinkers.filter(thinker => thinker.kind === 'floor')).toHaveLength(0);
  });

  it.each([[12, 224, true], [13, 255, true], [35, 35, true], [79, 35, false], [80, 224, false], [81, 255, false], [104, 64, true]])('routes walk light special %s to brightness %s with its native consumption policy', (code, brightness, once) => {
    const { specials, actor, target, front, world } = fixture(Number(code));
    front.lightLevel = 64;
    const neighbor = world.sectors[2];
    if (!neighbor) throw new Error('Neighbor missing');
    neighbor.lightLevel = 224;
    specials.cross(0, 0, actor);
    expect(target.lightLevel).toBe(brightness);
    expect(world.lineSpecials[0]).toBe(once ? 0 : code);
  });

  it('starts tagged light strobes, consuming their walk-once trigger', () => {
    const { specials, actor, world } = fixture(17);
    specials.cross(0, 0, actor);
    expect(world.thinkers.at(-1)).toMatchObject({ kind: 'light', type: 'strobe', sector: 1, minTime: 35 });
    expect(world.lineSpecials[0]).toBe(0);
  });

  it.each([[54, true], [89, false]])('stops active platform special %s with its native consumption policy', (code, once) => {
    const { specials, actor, target, world } = fixture(53);
    specials.cross(0, 0, actor);
    world.lineSpecials[0] = Number(code);
    specials.cross(0, 0, actor);
    expect(target.specialData).toMatchObject({ kind: 'platform', status: 'stasis' });
    expect(world.lineSpecials[0]).toBe(once ? 0 : code);
  });

  it.each([[57, true], [74, false]])('stops active ceiling special %s with its native consumption policy', (code, once) => {
    const { specials, actor, target, world } = fixture(25);
    specials.cross(0, 0, actor);
    world.lineSpecials[0] = Number(code);
    specials.cross(0, 0, actor);
    expect(target.specialData).toMatchObject({ kind: 'ceiling', direction: 0 });
    expect(world.lineSpecials[0]).toBe(once ? 0 : code);
    world.lineSpecials[0] = 25;
    specials.cross(0, 0, actor);
    expect(target.specialData).toMatchObject({ direction: -1 });
    expect(world.lineSpecials[0]).toBe(0);
  });

  it.each([ActorType.MT_ROCKET, ActorType.MT_PLASMA, ActorType.MT_BFG, ActorType.MT_TROOPSHOT, ActorType.MT_HEADSHOT, ActorType.MT_BRUISERSHOT])('rejects the literal source projectile type %s from crossing specials', type => {
    const { specials, world, target, actor } = fixture(4);
    const missile = spawnActor(world, type, actor.x, actor.y);
    specials.cross(0, 0, missile);
    expect(target.specialData).toBe(null);
    expect(world.lineSpecials[0]).toBe(4);
  });

  it('allows other source actor types through the monster guard even with a missile flag', () => {
    const { specials, world, target, actor } = fixture(4);
    const tracer = spawnActor(world, ActorType.MT_TRACER, actor.x, actor.y);
    expect(tracer.flags & MobjFlag.MF_MISSILE).not.toBe(0);
    specials.cross(0, 0, tracer);
    expect(target.specialData?.kind).toBe('door');
  });

  it('limits monsters to the native walk trigger list and secret manual-door restriction', () => {
    const { specials, world, target, actor } = fixture(2);
    const monster = spawnActor(world, ActorType.MT_TROOP, actor.x, actor.y);
    specials.cross(0, 0, monster);
    expect(target.specialData).toBe(null);
    world.lineSpecials[0] = 1;
    world.lineFlags[0] = 4 | 32;
    expect(specials.use(0, 0, monster)).toBe(false);
    world.lineFlags[0] = 4;
    expect(specials.use(0, 0, monster)).toBe(true);
    expect(target.specialData?.kind).toBe('door');
  });

  it('rejects back-side use except the unused special 124 and preserves native unknown-use success', () => {
    const { specials, actor, target, world } = fixture(1);
    expect(specials.use(0, 1, actor)).toBe(false);
    expect(target.specialData).toBe(null);
    world.lineSpecials[0] = 124;
    expect(specials.use(0, 1, actor)).toBe(true);
    world.lineSpecials[0] = 999;
    expect(specials.use(0, 0, actor)).toBe(true);
  });

  it.each([
    [7, 'floor', 'stairs'], [18, 'floor', 'raiseFloorToNearest'], [23, 'floor', 'lowerFloorToLowest'],
    [29, 'door', 'normal'], [41, 'ceiling', 'lowerToFloor'], [71, 'floor', 'turboLower'],
    [49, 'ceiling', 'crushAndRaise'], [50, 'door', 'close'], [55, 'floor', 'raiseFloorCrush'],
    [101, 'floor', 'raiseFloor'], [102, 'floor', 'lowerFloor'], [103, 'door', 'open'],
    [111, 'door', 'blazeRaise'], [112, 'door', 'blazeOpen'], [113, 'door', 'blazeClose'],
    [122, 'platform', 'blazeDownWaitUpStay'], [127, 'floor', 'stairs'], [131, 'floor', 'raiseFloorTurbo'], [140, 'floor', 'raiseFloor512'],
    [14, 'platform', 'raiseAndChange'], [15, 'platform', 'raiseAndChange'], [20, 'platform', 'raiseToNearestAndChange'], [21, 'platform', 'downWaitUpStay'],
  ])('routes use-once %s to %s/%s and changes its switch', (code, kind, type) => {
    const { specials, actor, world, target, side } = fixture(Number(code));
    expect(specials.use(0, 0, actor)).toBe(true);
    expect(target.specialData).toMatchObject({ kind, type });
    expect(world.lineSpecials[0]).toBe(0);
    expect(side.middleTexture).toBe('SW2BRCOM');
    expect(world.buttons.every(button => button === null)).toBe(true);
  });

  it.each([
    [42, 'door', 'close'], [43, 'ceiling', 'lowerToFloor'], [45, 'floor', 'lowerFloor'], [60, 'floor', 'lowerFloorToLowest'],
    [61, 'door', 'open'], [62, 'platform', 'downWaitUpStay'], [63, 'door', 'normal'], [64, 'floor', 'raiseFloor'],
    [65, 'floor', 'raiseFloorCrush'], [66, 'platform', 'raiseAndChange'], [67, 'platform', 'raiseAndChange'],
    [68, 'platform', 'raiseToNearestAndChange'], [69, 'floor', 'raiseFloorToNearest'], [70, 'floor', 'turboLower'],
    [114, 'door', 'blazeRaise'], [115, 'door', 'blazeOpen'], [116, 'door', 'blazeClose'], [123, 'platform', 'blazeDownWaitUpStay'], [132, 'floor', 'raiseFloorTurbo'],
  ])('routes use-repeat %s to %s/%s and starts a persistent button', (code, kind, type) => {
    const { specials, actor, world, target, side } = fixture(Number(code));
    expect(specials.use(0, 0, actor)).toBe(true);
    expect(target.specialData).toMatchObject({ kind, type });
    expect(world.lineSpecials[0]).toBe(code);
    expect(side.middleTexture).toBe('SW2BRCOM');
    expect(world.buttons[0]).toMatchObject({ line: 0, where: 'middleTexture', texture: 'SW1BRCOM', timer: 35, soundSector: 0 });
  });

  it.each([[26, 'blue'], [27, 'yellow'], [28, 'red'], [32, 'blue'], [33, 'red'], [34, 'yellow']])('reports the manual key color for special %s without claiming failure to handle use', (code, color) => {
    const { specials, actor, target, world } = fixture(Number(code));
    expect(specials.use(0, 0, actor)).toBe(true);
    expect(target.specialData).toBe(null);
    expect(world.player.message).toBe(`You need a ${color} key to open this door`);
  });

  it.each([[1, 'normal', 2, false], [31, 'open', 2, true], [117, 'blazeRaise', 8, false], [118, 'blazeOpen', 8, true]])('routes manual door %s to native %s and speed %s', (code, type, speed, once) => {
    const { specials, actor, target, world, side } = fixture(Number(code));
    specials.use(0, 0, actor);
    expect(target.specialData).toMatchObject({ kind: 'door', type, speed: Number(speed) * FRAC_UNIT });
    expect(world.lineSpecials[0]).toBe(once ? 0 : code);
    expect(side.middleTexture).toBe('SW1BRCOM');
  });

  it('routes donut use through its ring and model sector before changing the switch', () => {
    const initial = fixture(9);
    const map = initial.world.spatial.map;
    const ringSide = map.sides[2];
    if (!ringSide) throw new Error('Donut side missing');
    const world = createWorld({ ...map, sides: [...map.sides.slice(0, 2), { ...ringSide, sector: 0 }, ...map.sides.slice(3)] }, { skill: 2, mode: 'shareware' });
    const actor = world.actorsById.get(world.player.actorId);
    if (!actor) throw new Error('Donut player missing');
    createSpecials(world, allResources, initial.hooks).use(0, 0, actor);
    expect(world.sectors[0]?.specialData).toMatchObject({ kind: 'floor', type: 'donutRaise', destination: 64 * FRAC_UNIT });
    expect(world.sectors[1]?.specialData).toMatchObject({ kind: 'floor', type: 'lowerFloor', destination: 64 * FRAC_UNIT });
    expect(world.lineSpecials[0]).toBe(0);
    expect(world.sides[0]?.middleTexture).toBe('SW2BRCOM');
  });

  it.each([[99, CardType.it_bluecard, true], [133, CardType.it_blueskull, false], [134, CardType.it_redcard, true], [135, CardType.it_redskull, false], [136, CardType.it_yellowcard, true], [137, CardType.it_yellowskull, false]])('routes locked switch %s with matching card/skull and repeat policy', (code, key, repeat) => {
    const { specials, actor, target, world, side } = fixture(Number(code));
    specials.use(0, 0, actor);
    expect(target.specialData).toBe(null);
    expect(side.middleTexture).toBe('SW1BRCOM');
    world.player.cards[Number(key)] = true;
    specials.use(0, 0, actor);
    expect(target.specialData).toMatchObject({ kind: 'door', type: 'blazeOpen' });
    expect(world.lineSpecials[0]).toBe(repeat ? code : 0);
  });

  it('consumes failed shoot-once triggers and lets only special 46 respond to monster fire', () => {
    const { specials, actor, target, world, side } = fixture(24);
    target.tag = 8;
    specials.shoot(0, actor);
    expect(world.lineSpecials[0]).toBe(0);
    expect(side.middleTexture).toBe('SW2BRCOM');
    const monster = spawnActor(world, ActorType.MT_TROOP, actor.x, actor.y);
    target.tag = 7;
    world.lineSpecials[0] = 47;
    specials.shoot(0, monster);
    expect(target.specialData).toBe(null);
    world.lineSpecials[0] = 46;
    specials.shoot(0, monster);
    expect(target.specialData).toMatchObject({ kind: 'door', type: 'open' });
    expect(world.lineSpecials[0]).toBe(46);
  });

  it('routes shoot 47 to nearest-height texture-changing platform', () => {
    const { specials, actor, target, world } = fixture(47);
    specials.shoot(0, actor);
    expect(target.specialData).toMatchObject({ kind: 'platform', type: 'raiseToNearestAndChange' });
    expect(world.lineSpecials[0]).toBe(0);
  });

  it('keeps walk exit specials while clearing exit-switch specials before sound selection', () => {
    const { specials, actor, world } = fixture(52);
    specials.cross(0, 1, actor);
    expect(world.events.at(-1)).toEqual({ type: 'exit', secret: false });
    expect(world.lineSpecials[0]).toBe(52);
    world.lineSpecials[0] = 124;
    specials.cross(0, 0, actor);
    expect(world.events.at(-1)).toEqual({ type: 'exit', secret: true });
    world.lineSpecials[0] = 11;
    specials.use(0, 0, actor);
    expect(world.lineSpecials[0]).toBe(0);
    expect(world.events.slice(-2)).toEqual([{ type: 'sound', sound: SfxId.sfx_swtchn, actor: null }, { type: 'exit', secret: false }]);
    world.lineSpecials[0] = 51;
    specials.use(0, 0, actor);
    expect(world.lineSpecials[0]).toBe(0);
    expect(world.events.at(-1)).toEqual({ type: 'exit', secret: true });
  });

  it('consumes failed teleport-once crossings, preserves repeats, and ignores players on monster-only teleporters', () => {
    const { specials, actor, world } = fixture(39);
    specials.cross(0, 1, actor);
    expect(world.lineSpecials[0]).toBe(0);
    world.lineSpecials[0] = 97;
    specials.cross(0, 1, actor);
    expect(world.lineSpecials[0]).toBe(97);
    world.lineSpecials[0] = 125;
    specials.cross(0, 0, actor);
    expect(world.lineSpecials[0]).toBe(125);
    const monster = spawnActor(world, ActorType.MT_TROOP, actor.x, actor.y);
    specials.cross(0, 1, monster);
    expect(world.lineSpecials[0]).toBe(0);
    world.lineSpecials[0] = 126;
    specials.cross(0, 1, monster);
    expect(world.lineSpecials[0]).toBe(126);
  });

  it('dispatches a tagged teleport to the original destination marker', () => {
    const { specials, actor, world } = fixture(39);
    const marker = spawnActor(world, ActorType.MT_TELEPORTMAN, 96 * FRAC_UNIT, 64 * FRAC_UNIT);
    specials.cross(0, 0, actor);
    expect(actor.x).toBe(marker.x);
    expect(actor.y).toBe(marker.y);
    expect(actor.reactionTime).toBe(18);
  });
});

describe('switch textures and persistent buttons', () => {
  it('matches switch-list order before top/middle/bottom field order', () => {
    const { specials, actor, side } = fixture(103);
    side.upperTexture = 'SW1BRN1';
    side.middleTexture = 'SW1BRCOM';
    specials.use(0, 0, actor);
    expect(side.upperTexture).toBe('SW1BRN1');
    expect(side.middleTexture).toBe('SW2BRCOM');
  });

  it('prefers top then middle then bottom when the same switch entry occurs in several fields', () => {
    const { specials, actor, side } = fixture(103);
    side.upperTexture = side.middleTexture = side.lowerTexture = 'SW1BRCOM';
    specials.use(0, 0, actor);
    expect([side.upperTexture, side.middleTexture, side.lowerTexture]).toEqual(['SW2BRCOM', 'SW1BRCOM', 'SW1BRCOM']);
  });

  it('restores a button exactly on update 35 and retains it across a recreated specials controller', () => {
    const { specials, actor, side, world, hooks } = fixture(138);
    specials.use(0, 0, actor);
    for (let tic = 0; tic < 34; tic++) specials.update();
    expect(side.middleTexture).toBe('SW2BRCOM');
    expect(world.buttons[0]?.timer).toBe(1);
    createSpecials(world, allResources, hooks).update();
    expect(side.middleTexture).toBe('SW1BRCOM');
    expect(world.buttons[0]).toBe(null);
    expect(world.events.at(-1)).toEqual({ type: 'sectorSound', sector: 0, sound: SfxId.sfx_swtchn });
  });

  it('does not reset an already pressed line timer even if its texture toggles again', () => {
    const { specials, actor, side, world } = fixture(138);
    specials.use(0, 0, actor);
    specials.update();
    specials.use(0, 0, actor);
    expect(side.middleTexture).toBe('SW1BRCOM');
    expect(world.buttons[0]?.timer).toBe(34);
    expect(world.buttons.filter(button => button !== null)).toHaveLength(1);
  });

  it('uses the first button slot sound source for subsequent switch activations', () => {
    const { specials, actor, world } = fixture(138);
    specials.use(0, 0, actor);
    world.lineSpecials[1] = 138;
    specials.use(1, 0, actor);
    expect(world.buttons[1]?.soundSector).toBe(1);
    expect(world.events.at(-1)).toEqual({ type: 'sectorSound', sector: 0, sound: SfxId.sfx_swtchn });
  });

  it('throws when all sixteen button slots are occupied after changing the switch texture', () => {
    const { specials, actor, world, side } = fixture(138);
    for (let slot = 0; slot < 16; slot++) world.buttons[slot] = { line: slot + 10, where: 'middleTexture', texture: 'SW1BRCOM', timer: 35, soundSector: 1 };
    expect(() => specials.use(0, 0, actor)).toThrow(/button slots/i);
    expect(side.middleTexture).toBe('SW2BRCOM');
  });

  it.each(['registered', 'retail'] as const)('enables the registered switch pairs for %s', mode => {
    const { specials, actor, side } = fixture(138, mode);
    side.middleTexture = 'SW1BLUE';
    specials.use(0, 0, actor);
    expect(side.middleTexture).toBe('SW2BLUE');
  });

  it('leaves registered switch textures unchanged in shareware mode', () => {
    const { specials, actor, side, world } = fixture(138);
    side.middleTexture = 'SW1BLUE';
    specials.use(0, 0, actor);
    expect(side.middleTexture).toBe('SW1BLUE');
    expect(world.buttons.every(button => button === null)).toBe(true);
  });

  it('reports a missing required switch texture as an asset error', () => {
    const { world, hooks } = fixture();
    expect(() => createSpecials(world, { ...allResources, wallNames: ['SW1BRCOM'] }, hooks)).toThrow(/switch texture/i);
  });
});

describe('sector setup, ticking and grounded damage', () => {
  it('spawns sector specials in sector order and keeps damaging strobe special 4', () => {
    const { specials, world, front, target } = fixture();
    front.special = 1;
    target.special = 4;
    world.random.gameIndex = 0;
    specials.setup();
    expect(world.thinkers.filter(thinker => thinker.kind !== 'actor')).toMatchObject([
      { kind: 'light', sector: 0, type: 'flash', count: 1 },
      { kind: 'light', sector: 1, type: 'strobe', count: 6, minTime: 15 },
    ]);
    expect(world.random.gameIndex).toBe(2);
    expect(target.special).toBe(4);
    expect(front.special).toBe(0);
  });

  it.each([[2, 'strobe', 15], [3, 'strobe', 35], [8, 'glow', 7], [12, 'strobe', 35], [13, 'strobe', 15], [17, 'fire', 7]])('sets up sector special %s as native %s with dark time %s', (special, type, minTime) => {
    const { specials, world, front } = fixture();
    front.special = Number(special);
    specials.setup();
    expect(world.thinkers.at(-1)).toMatchObject({ kind: 'light', sector: 0, type, minTime });
    expect(front.special).toBe(0);
  });

  it.each([[10, 'normal', 30 * 35, 0], [14, 'raiseIn5Mins', 5 * 60 * 35, 2]])('sets up timed door sector %s', (special, type, count, direction) => {
    const { specials, front } = fixture();
    front.special = Number(special);
    specials.setup();
    expect(front.specialData).toMatchObject({ kind: 'door', type, count, direction });
    expect(front.special).toBe(0);
  });

  it('does not count secret sectors again during setup, and awards each grounded secret once', () => {
    const { specials, actor, front, world } = fixture();
    front.special = 9;
    world.totalSecrets = 1;
    specials.setup();
    expect(world.totalSecrets).toBe(1);
    actor.z++;
    specials.playerInSector(actor);
    expect(world.player.secretCount).toBe(0);
    actor.z = front.floorHeight;
    specials.playerInSector(actor);
    expect(world.player.secretCount).toBe(1);
    expect(front.special).toBe(0);
    specials.playerInSector(actor);
    expect(world.player.secretCount).toBe(1);
  });

  it.each([[5, 10], [7, 5], [4, 20], [16, 20]])('applies sector %s damage %s only on a 32-tic boundary at floor height', (special, damage) => {
    const { specials, actor, front, hits, world } = fixture();
    front.special = special;
    world.levelTime = 31;
    specials.playerInSector(actor);
    expect(hits).toEqual([]);
    world.levelTime = 32;
    actor.z++;
    specials.playerInSector(actor);
    expect(hits).toEqual([]);
    actor.z = front.floorHeight;
    specials.playerInSector(actor);
    expect(hits).toEqual([damage]);
  });

  it('consumes leak RNG on every grounded damaging-floor tic when boots are active, before the damage-period test', () => {
    const { specials, actor, front, hits, world } = fixture();
    front.special = 16;
    world.player.powers[PowerType.pw_ironfeet] = 35;
    world.random.gameIndex = 0;
    world.levelTime = 1;
    specials.playerInSector(actor);
    expect(world.random.gameIndex).toBe(1);
    expect(hits).toEqual([]);
    world.levelTime = 32;
    world.random.gameIndex = 0;
    specials.playerInSector(actor);
    expect(hits).toEqual([]);
    world.random.gameIndex = 255;
    specials.playerInSector(actor);
    expect(hits).toEqual([20]);
  });

  it('skips both damage and RNG for boots on sector 5/7, and never uses leak RNG without boots', () => {
    const { specials, actor, front, hits, world } = fixture();
    world.player.powers[PowerType.pw_ironfeet] = 35;
    world.random.gameIndex = 0;
    front.special = 5;
    specials.playerInSector(actor);
    front.special = 7;
    specials.playerInSector(actor);
    expect(hits).toEqual([]);
    expect(world.random.gameIndex).toBe(0);
    world.player.powers[PowerType.pw_ironfeet] = 0;
    front.special = 16;
    specials.playerInSector(actor);
    expect(hits).toEqual([20]);
    expect(world.random.gameIndex).toBe(0);
  });

  it('clears god mode before E1M8 finale damage, then exits at health ten', () => {
    const { specials, actor, front, world, hits } = fixture();
    front.special = 11;
    world.player.health = actor.health = 30;
    world.player.cheats = CheatFlag.CF_GODMODE | CheatFlag.CF_NOCLIP;
    specials.playerInSector(actor);
    expect(hits).toEqual([20]);
    expect(world.player.cheats).toBe(CheatFlag.CF_NOCLIP);
    expect(world.events.at(-1)).toEqual({ type: 'exit', secret: false });
  });

  it('rejects unknown grounded player sector specials but ignores ordinary sector zero', () => {
    const { specials, actor, front } = fixture();
    expect(() => specials.playerInSector(actor)).not.toThrow();
    front.special = 99;
    expect(() => specials.playerInSector(actor)).toThrow(/unknown.*99/i);
  });

  it('scrolls only setup-listed special 48 lines using wrapped fixed offsets and current special state', () => {
    const { specials, world, side } = fixture(48);
    specials.setup();
    side.textureOffset = 0x7fffffff;
    specials.update();
    expect(side.textureOffset).toBe((0x7fffffff + FRAC_UNIT) | 0);
    world.lineSpecials[0] = 0;
    world.lineSpecials[1] = 48;
    specials.update();
    expect(side.textureOffset).toBe((0x7fffffff + FRAC_UNIT) | 0);
    expect(world.sides[2]?.textureOffset).toBe(0);
  });

  it('routes motion and light thinker ticks through the same controller', () => {
    const { specials, world, actor, target } = fixture(58);
    specials.cross(0, 0, actor);
    const floor = target.specialData;
    if (!floor) throw new Error('Floor missing');
    const before = target.floorHeight;
    specials.tick(floor);
    expect(target.floorHeight).toBe(before + FRAC_UNIT);
    world.sectors[0]!.special = 12;
    specials.setup();
    const light = world.thinkers.find(thinker => thinker.kind === 'light');
    if (!light || light.kind !== 'light') throw new Error('Light missing');
    specials.tick(light);
    expect(light.count).toBe(35);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('sets up every original shareware E1M%s map without changing counted secrets', number => {
    const world = createWorld(decodeMap(wad, `E1M${number}`), { skill: 2, mode: 'shareware' });
    const expected = world.totalSecrets;
    const hooks: PlaneHooks = { damageActor: () => {}, movement: { touchPickup: () => {}, damageActor: () => {}, explodeMissile: () => {}, crossSpecial: () => {}, runActorAction: () => {} } };
    const specials = createSpecials(world, resources, hooks);
    specials.setup();
    expect(world.totalSecrets).toBe(expected);
    expect(world.buttons).toHaveLength(16);
    specials.update();
    for (const thinker of world.thinkers) if (thinker.kind !== 'actor') specials.tick(thinker);
  });
});
