import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { thinkActor } from '../../src/simulation/actor-thinking';
import { setActorState } from '../../src/simulation/actors';
import { ActorType, MobjFlag } from '../../src/simulation/data/actors';
import { StateId } from '../../src/simulation/data/states';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import type { MovementHooks } from '../../src/simulation/movement';
import { createWorld, removeActor, spawnActor } from '../../src/simulation/world';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');
const hooks: MovementHooks = {
  touchPickup: () => {}, damageActor: () => {}, explodeMissile: () => {},
  crossSpecial: () => {}, runActorAction: () => {},
};

describe('actor thinkers', () => {
  it('moves before entering the successor state and unlinks an expired effect immediately', () => {
    const world = createWorld(map, { skill: 2, noMonsters: true });
    const player = world.actorsById.get(world.player.actorId);
    if (!player) throw new Error('Player missing');
    const puff = spawnActor(world, ActorType.MT_PUFF, player.x, player.y, player.z + 20 * FRAC_UNIT);
    puff.momz = FRAC_UNIT;
    setActorState(puff, StateId.S_PUFF4, () => {});
    puff.tics = 1;
    const oldZ = puff.z;
    thinkActor(world, puff, hooks);
    expect(puff.z).toBe(oldZ + FRAC_UNIT);
    expect(puff.removed).toBe(true);
    expect(world.activeActorIds.has(puff.id)).toBe(false);
  });

  it('waits twelve seconds and the 32-tic gate before drawing the nightmare respawn chance', () => {
    const world = createWorld(map, { skill: 4, noMonsters: true });
    const corpse = spawnActor(world, ActorType.MT_POSSESSED, 0, 0);
    corpse.flags |= MobjFlag.MF_CORPSE;
    corpse.tics = -1;
    corpse.moveCount = 418;
    world.random.gameIndex = 0;
    thinkActor(world, corpse, hooks);
    expect(corpse.moveCount).toBe(419);
    expect(world.random.gameIndex).toBe(0);
    world.levelTime = 1;
    thinkActor(world, corpse, hooks);
    expect(world.random.gameIndex).toBe(0);
    world.levelTime = 32;
    thinkActor(world, corpse, hooks);
    expect(world.random.gameIndex).toBe(1); // 8 > 4: chance rejected.
    expect(corpse.removed).toBe(false);
  });

  it('respawns a map monster with two fogs, its spawn angle/ambush flag and eighteen-tic freeze', () => {
    const world = createWorld(map, { skill: 2, respawnMonsters: true, noMonsters: true });
    const player = world.actorsById.get(world.player.actorId);
    if (!player) throw new Error('Player missing');
    for (const actor of world.actors) removeActor(world, actor);
    const corpse = spawnActor(world, ActorType.MT_POSSESSED, player.x, player.y);
    corpse.spawnpoint = { x: player.x >> 16, y: player.y >> 16, angle: 90, type: 3004, flags: 15 };
    corpse.health = -10;
    corpse.flags = MobjFlag.MF_CORPSE | MobjFlag.MF_COUNTKILL;
    corpse.height /= 4;
    corpse.tics = -1;
    corpse.moveCount = 419;
    world.random.gameIndex = 255; // Next source byte is zero, then three spawn draws.
    thinkActor(world, corpse, hooks);
    expect(corpse.removed).toBe(true);
    const replacement = world.actors.find(actor => actor.type === ActorType.MT_POSSESSED && actor.id !== corpse.id);
    expect(replacement).toMatchObject({ health: 20, reactionTime: 18, angle: 0x40000000, spawnpoint: corpse.spawnpoint });
    expect((replacement?.flags ?? 0) & MobjFlag.MF_AMBUSH).toBe(MobjFlag.MF_AMBUSH);
    expect(world.actors.filter(actor => actor.type === ActorType.MT_TFOG)).toHaveLength(2);
    expect(world.random.gameIndex).toBe(3);
  });
});
