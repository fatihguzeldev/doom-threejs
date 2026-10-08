import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSession, type Session } from '../../src/session/session';
import { loadWorld, saveWorld } from '../../src/session/save';
import { idleCommand } from '../../src/simulation/command';
import { ActorType } from '../../src/simulation/data/actors';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { doDoor, useDoor } from '../../src/simulation/specials/doors';
import { doFloor } from '../../src/simulation/specials/floors';
import { doPlatform, stopPlatforms } from '../../src/simulation/specials/platforms';
import { linkActorBlock, removeActor, spawnActor, unlinkActorBlock } from '../../src/simulation/world';
import { findLump, parseWad, readLump } from '../../src/wad/archive';
import { decodeDemo } from '../../src/wad/demo';
import { createResources } from '../../src/wad/resources';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const resources = createResources(wad);
const lump = findLump(wad, 'DEMO1');
if (!lump) throw new Error('Original demo missing');
const demo = decodeDemo(readLump(wad, lump));

function level(session: Session) {
  if (session.state.kind !== 'level') throw new Error('Expected level state');
  return session.state;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Fixture object missing');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Fixture array missing');
  return value as unknown[];
}
function parse(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return record(value);
}
const savedWorld = (envelope: Record<string, unknown>) => record(record(envelope['state'])['world']);

describe('validated session save and load', () => {
  it('restores the exact mid-demo state and produces identical state through the next 200 real commands', () => {
    const original = createSession(wad, resources, { skill: demo.header.skill, mapNumber: demo.header.mapNumber });
    for (const tic of demo.tics.slice(0, 400)) original.tick(tic[0]?.command);
    const snapshot = original.save();
    const restored = createSession(wad, resources);
    restored.load(snapshot);
    expect(parse(restored.save())).toEqual(parse(snapshot));
    for (const [index, tic] of demo.tics.slice(400, 600).entries()) {
      original.events.length = restored.events.length = 0;
      original.tick(tic[0]?.command); restored.tick(tic[0]?.command);
      expect(parse(restored.save()), `native demo continuation tic ${index}`).toEqual(parse(original.save()));
      expect(restored.events, `native demo events tic ${index}`).toEqual(original.events);
    }
  });

  it('retains removed source/target records, actor cache head order, thinker order and shared sector associations', () => {
    const session = createSession(wad, resources, { noMonsters: true });
    const world = level(session).world;
    const player = world.actorsById.get(world.player.actorId);
    if (!player) throw new Error('Player missing');
    const first = spawnActor(world, ActorType.MT_TROOP, player.x + 64 * FRAC_UNIT, player.y);
    const second = spawnActor(world, ActorType.MT_TROOP, first.x, first.y);
    unlinkActorBlock(world, first); linkActorBlock(world, first);
    removeActor(world, second);
    first.target = second.id; world.player.attacker = second.id;
    const sector = world.sectors.find(candidate => candidate.specialData === null);
    if (!sector) throw new Error('Free sector missing');
    sector.tag = 111;
    doDoor(world, 111, 'normal');
    const snapshot = session.save();
    session.load(snapshot);
    const restored = level(session).world;
    expect(restored.actorsById.get(second.id)).toMatchObject({ removed: true });
    expect(restored.activeActorIds.has(second.id)).toBe(false);
    expect(restored.actorsById.get(first.id)?.target).toBe(second.id);
    expect(restored.actorBlocks).toEqual(world.actorBlocks);
    expect(restored.thinkers).toEqual(world.thinkers);
    for (const sector of restored.sectors) if (sector.specialData !== null) expect(restored.thinkers).toContain(sector.specialData);
    expect(parse(session.save())).toEqual(parse(snapshot));
  });

  it('preserves in-progress movement thinkers, stasis and persistent switch buttons without initialization', () => {
    const session = createSession(wad, resources, { noMonsters: true });
    const world = level(session).world;
    const free = world.sectors.filter(sector => sector.specialData === null).slice(0, 2);
    const floorSector = free[0], platformSector = free[1];
    if (!floorSector || !platformSector) throw new Error('Free sectors missing');
    floorSector.tag = 111; platformSector.tag = 222;
    doFloor(world, 111, 'raiseFloor24');
    doPlatform(world, 222, 'perpetualRaise', 0, 0);
    stopPlatforms(world, 222);
    const mapLine = world.spatial.map.lines[0];
    const side = mapLine === undefined ? undefined : world.sides[mapLine.frontSide];
    if (!side || !mapLine) throw new Error('Switch side missing');
    side.middleTexture = 'SW2BRCOM';
    world.buttons[0] = { line: 0, where: 'middleTexture', texture: 'SW1BRCOM', timer: 7, soundSector: 0 };
    const snapshot = session.save();
    session.load(snapshot);
    const restored = level(session).world;
    expect(restored.buttons[0]?.timer).toBe(7);
    expect(restored.sectors.find(sector => sector.tag === 222)?.specialData).toMatchObject({ kind: 'platform', status: 'stasis' });
    expect(parse(session.save())).toEqual(parse(snapshot));
    for (let tic = 0; tic < 7; tic++) session.tick();
    expect(restored.buttons[0]).toBe(null);
    expect(restored.sides[mapLine.frontSide]?.middleTexture).toBe('SW1BRCOM');
    expect(restored.sectors.find(sector => sector.tag === 111)?.floorHeight).toBe(floorSector.floorHeight + 7 * FRAC_UNIT);
  });

  it('retains an older movement thinker when a native manual open door replaces its sector association', () => {
    const session = createSession(wad, resources, { noMonsters: true });
    const world = level(session).world;
    const index = world.spatial.lines.findIndex(line => line.backSector !== null && line.frontSector !== line.backSector);
    const line = world.spatial.lines[index];
    const sector = line?.backSector == null ? undefined : world.sectors[line.backSector];
    const player = world.actorsById.get(world.player.actorId);
    if (!sector || !player) throw new Error('Manual door missing');
    sector.tag = 111;
    doFloor(world, 111, 'raiseFloor24');
    const old = sector.specialData;
    world.lineSpecials[index] = 31;
    useDoor(world, index, player);
    expect(old?.removed).toBe(false);
    expect(sector.specialData).not.toBe(old);
    const snapshot = session.save();
    session.load(snapshot);
    expect(parse(session.save())).toEqual(parse(snapshot));
    expect(level(session).world.thinkers.some(thinker => thinker.kind === 'floor' && thinker.sector === line?.backSector)).toBe(true);
  });

  it('restores nightmare actor fast-state flags and respawn mode', () => {
    const session = createSession(wad, resources, { skill: 4 });
    const snapshot = session.save();
    session.load(snapshot);
    expect(level(session).world.fastMonsters).toBe(true);
    expect(level(session).world.respawnMonsters).toBe(true);
    expect(level(session).world.actors.every(actor => actor.fastStates)).toBe(true);
  });

  it.each(['fastMonsters', 'respawnMonsters'] as const)('rejects disabled Nightmare %s rather than changing the saved state', flag => {
    const session = createSession(wad, resources, { skill: 4 });
    const before = session.save();
    const envelope = parse(before);
    savedWorld(envelope)[flag] = false;
    expect(() => session.load(JSON.stringify(envelope))).toThrow(/Invalid save/i);
    expect(session.save()).toBe(before);
  });

  it.each(['intermission', 'finale'] as const)('round-trips %s clocks and player inventory', kind => {
    const session = createSession(wad, resources, { mapNumber: kind === 'finale' ? 8 : 1, noMonsters: true });
    level(session).world.events.push({ type: 'exit', secret: false });
    session.tick();
    for (let tic = 0; tic < 47; tic++) session.tick();
    const snapshot = session.save();
    const restored = createSession(wad, resources);
    restored.load(snapshot);
    expect(restored.state.kind).toBe(kind);
    expect(restored.save()).toBe(snapshot);
    for (let tic = 0; tic < 100; tic++) { session.tick(); restored.tick(); }
    expect(restored.save()).toBe(session.save());
  });

  it.each([
    ['intermission', 'empty animation state'], ['intermission', 'wrong next map'], ['intermission', 'expired next-screen clock'],
    ['finale', 'changed source text'], ['finale', 'changed source art'], ['finale', 'invalid text reveal'],
  ] as const)('rejects %s with %s', (kind, defect) => {
    const session = createSession(wad, resources, { mapNumber: kind === 'finale' ? 8 : 1, noMonsters: true });
    level(session).world.events.push({ type: 'exit', secret: false });
    session.tick();
    if (defect === 'expired next-screen clock') { session.advanceIntermission(); session.advanceIntermission(); }
    const before = session.save();
    const envelope = parse(before), state = record(envelope['state']);
    if (defect === 'empty animation state') state['animations'] = [];
    if (defect === 'wrong next map') state['nextMapNumber'] = 9;
    if (defect === 'expired next-screen clock') { state['stage'] = 'showNext'; state['remaining'] = 0; state['statsStage'] = 10; }
    if (defect === 'changed source text') state['text'] = 'placeholder';
    if (defect === 'changed source art') state['picture'] = 'PFUB1';
    if (defect === 'invalid text reveal') state['textVisibleChars'] = 999;
    expect(() => session.load(JSON.stringify(envelope))).toThrow(/Invalid save/i);
    expect(session.save()).toBe(before);
  });

  it.each(['{', 'null', '[]', '1', '{}'])('rejects malformed or unshaped JSON %s without changing the current session', text => {
    const session = createSession(wad, resources, { noMonsters: true });
    const snapshot = session.save();
    expect(() => session.load(text)).toThrow(/Invalid save/i);
    expect(session.save()).toBe(snapshot);
  });

  const mutations: readonly [string, (envelope: Record<string, unknown>) => void][] = [
    ['unknown version', saved => { saved['version'] = 2; }],
    ['other assets', saved => { saved['wad'] = 'different'; }],
    ['unknown top field', saved => { saved['unexpected'] = true; }],
    ['invalid state kind', saved => { record(saved['state'])['kind'] = 'title'; }],
    ['missing player field', saved => { delete record(savedWorld(saved)['player'])['health']; }],
    ['nonboolean cards', saved => { list(record(savedWorld(saved)['player'])['cards'])[0] = 'yes'; }],
    ['wrong psprite count', saved => { list(record(savedWorld(saved)['player'])['psprites']).pop(); }],
    ['invalid state enum', saved => { record(list(savedWorld(saved)['actors'])[0])['state'] = 99999; }],
    ['negative actor angle', saved => { record(list(savedWorld(saved)['actors'])[0])['angle'] = -1; }],
    ['unknown actor field', saved => { record(list(savedWorld(saved)['actors'])[0])['surprise'] = 1; }],
    ['duplicate actor IDs', saved => { const actors = list(savedWorld(saved)['actors']); actors.push(actors[0]); }],
    ['missing target record', saved => { record(list(savedWorld(saved)['actors'])[0])['target'] = 999999; }],
    ['missing player actor', saved => { record(savedWorld(saved)['player'])['actorId'] = 999999; }],
    ['duplicate active ID', saved => { const ids = list(savedWorld(saved)['activeActorIds']); ids.push(ids[0]); }],
    ['missing active ID', saved => { list(savedWorld(saved)['activeActorIds']).pop(); }],
    ['truncated sector list', saved => { list(savedWorld(saved)['sectors']).pop(); }],
    ['invalid sector association', saved => { record(list(savedWorld(saved)['sectors'])[0])['specialData'] = 0; }],
    ['invalid line flag', saved => { list(savedWorld(saved)['lineFlags'])[0] = 65536; }],
    ['invalid thinker kind', saved => { record(list(savedWorld(saved)['thinkers'])[0])['kind'] = 'magic'; }],
    ['missing actor thinker', saved => { list(savedWorld(saved)['thinkers']).shift(); }],
    ['duplicate block membership', saved => { const block = list(savedWorld(saved)['actorBlocks']).map(list).find(values => values.length !== 0); if (!block) throw new Error('Block missing'); block.push(block[0]); }],
    ['invalid button line', saved => { list(savedWorld(saved)['buttons'])[0] = { line: 999999, where: 'middleTexture', texture: 'SW1BRCOM', timer: 35, soundSector: 0 }; }],
    ['zero button timer', saved => { list(savedWorld(saved)['buttons'])[0] = { line: 0, where: 'middleTexture', texture: 'SW1BRCOM', timer: 0, soundSector: 0 }; }],
    ['invalid RNG index', saved => { record(savedWorld(saved)['random'])['gameIndex'] = 256; }],
    ['inconsistent settings', saved => { record(saved['settings'])['skill'] = 3; }],
  ];
  it.each(mutations)('rejects %s atomically', (_name, mutate) => {
    const session = createSession(wad, resources, { noMonsters: true });
    const snapshot = session.save();
    const saved = parse(snapshot);
    mutate(saved);
    expect(() => session.load(JSON.stringify(saved))).toThrow(/Invalid save/i);
    expect(session.save()).toBe(snapshot);
  });

  it('rejects an oversized document before parsing it', () => {
    const session = createSession(wad, resources);
    expect(() => session.load(' '.repeat(16 * 1024 * 1024 + 1))).toThrow(/16 MiB/i);
  });

  it('reconstructs spatial metadata from the WAD while preserving all mutable world fields', () => {
    const session = createSession(wad, resources, { noMonsters: true });
    const original = level(session).world;
    original.lineFlags[0] = 32;
    original.lineSpecials[0] = 0;
    original.onGround = true;
    const restored = loadWorld(wad, parse(JSON.stringify(saveWorld(original))));
    expect(restored.spatial.map).toEqual(original.spatial.map);
    expect(restored.spatial).not.toBe(original.spatial);
    expect(restored.lineFlags[0]).toBe(32);
    expect(restored.onGround).toBe(true);
    expect(saveWorld(restored)).toEqual(saveWorld(original));
    const initialTime = restored.levelTime;
    level(session).simulation.tick(idleCommand);
    expect(original.levelTime).toBe(initialTime + 1);
    expect(restored.levelTime).toBe(initialTime);
  });
});
