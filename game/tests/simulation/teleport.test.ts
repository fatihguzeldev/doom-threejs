import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWad } from '../../src/wad/archive';
import { decodeMap } from '../../src/wad/map';
import { createWorld, removeActor, spawnActor } from '../../src/simulation/world';
import { teleport, teleportMove, type TeleportHooks } from '../../src/simulation/specials/teleport';
import { ActorType, MobjFlag, SfxId } from '../../src/simulation/data/actors';
import { FRAC_UNIT } from '../../src/simulation/fixed';
import { ANG90 } from '../../src/simulation/angle';

const wad = parseWad(readFileSync(new URL('../../assets/doom1.wad', import.meta.url)));
const map = decodeMap(wad, 'E1M1');

function fixture() {
  const world = createWorld(map, { skill: 2 });
  const actor = world.actorsById.get(world.player.actorId);
  if (!actor) throw new Error('Player missing');
  for (const thing of world.actors) if (thing !== actor) removeActor(world, thing);
  const hits: { id: number; damage: number }[] = [];
  const hooks: TeleportHooks = { damageActor: (target, _inflictor, _source, damage) => { hits.push({ id: target.id, damage }); } };
  return { world, actor, hooks, hits };
}

describe('native teleport activation and stomping', () => {
  it('telefrags overlapping shootable actors without a vertical overlap test', () => {
    const { world, actor, hooks, hits } = fixture();
    const destinationX = actor.x + 64 * FRAC_UNIT;
    const victim = spawnActor(world, ActorType.MT_TROOP, destinationX, actor.y, actor.z + 128 * FRAC_UNIT);
    expect(teleportMove(world, actor, destinationX, actor.y, hooks)).toBe(true);
    expect(hits).toEqual([{ id: victim.id, damage: 10000 }]);
    expect(actor.x).toBe(destinationX);
    expect(world.actorBlocks.flat().filter(id => id === actor.id)).toHaveLength(1);
  });

  it('blocks a Doom I monster from stomping the occupied destination', () => {
    const { world, actor, hooks, hits } = fixture();
    const monster = spawnActor(world, ActorType.MT_TROOP, actor.x + 64 * FRAC_UNIT, actor.y);
    const before = monster.x;
    expect(teleportMove(world, monster, actor.x, actor.y, hooks)).toBe(false);
    expect(monster.x).toBe(before);
    expect(hits).toHaveLength(0);
  });

  it('chooses the tagged marker, creates two fog actors and freezes the player for eighteen tics', () => {
    const { world, actor, hooks } = fixture();
    const marker = spawnActor(world, ActorType.MT_TELEPORTMAN, actor.x + 64 * FRAC_UNIT, actor.y);
    const sector = world.sectors[marker.sector];
    if (!sector) throw new Error('Marker sector missing');
    sector.tag = world.spatial.lines[0]?.tag ?? 0;
    marker.angle = ANG90;
    actor.momx = actor.momy = actor.momz = FRAC_UNIT;
    const oldX = actor.x;
    world.random.gameIndex = 0;
    expect(teleport(world, 0, 0, actor, hooks)).toBe(true);
    expect(actor.x).toBe(marker.x);
    expect(actor.angle).toBe(ANG90);
    expect(actor.reactionTime).toBe(18);
    expect([actor.momx, actor.momy, actor.momz]).toEqual([0, 0, 0]);
    expect(world.player.viewZ).toBe(actor.z + world.player.viewHeight);
    const fog = world.actors.filter(thing => !thing.removed && thing.type === ActorType.MT_TFOG);
    expect(fog).toHaveLength(2);
    expect(fog[0]?.x).toBe(oldX);
    expect(fog[1]?.x).toBe(marker.x - 500);
    expect(fog[1]?.y).toBe(marker.y + 1310700);
    expect(world.random.gameIndex).toBe(2);
    expect(world.events.filter(event => event.type === 'sound' && event.sound === SfxId.sfx_telept)).toHaveLength(2);
  });

  it('rejects back-side crossings and missiles without consuming randomness', () => {
    const { world, actor, hooks } = fixture();
    world.random.gameIndex = 0;
    expect(teleport(world, 0, 1, actor, hooks)).toBe(false);
    actor.flags |= MobjFlag.MF_MISSILE;
    expect(teleport(world, 0, 0, actor, hooks)).toBe(false);
    expect(world.random.gameIndex).toBe(0);
  });
});
