import { describe, expect, it } from 'vitest';
import { createActor, setActorState, tickActorState, type Actor } from '../../src/simulation/actors';
import { ActorType, MobjFlag } from '../../src/simulation/data/actors';
import { ActionId, SpriteId, StateId } from '../../src/simulation/data/states';
import { createRandom } from '../../src/simulation/random';

const unit = 65536;

function possessed(): Actor {
  return createActor(ActorType.MT_POSSESSED, 7, 10 * unit, -20 * unit,
    -8 * unit, 128 * unit, 3, 4, 2, createRandom());
}

describe('actor spawning', () => {
  it('copies original attributes and zero-initializes runtime fields without entering spawn actions', () => {
    const random = createRandom();
    const actor = createActor(ActorType.MT_POSSESSED, 7, 10 * unit, -20 * unit,
      -8 * unit, 128 * unit, 3, 4, 2, random);
    expect(actor).toEqual({
      id: 7, type: ActorType.MT_POSSESSED, state: StateId.S_POSS_STND,
      tics: 10, sprite: SpriteId.SPR_POSS, frame: 0,
      x: 10 * unit, y: -20 * unit, z: -8 * unit,
      momx: 0, momy: 0, momz: 0, angle: 0,
      radius: 20 * unit, height: 56 * unit,
      flags: MobjFlag.MF_SOLID | MobjFlag.MF_SHOOTABLE | MobjFlag.MF_COUNTKILL,
      health: 20, reactionTime: 8, threshold: 0,
      moveDir: 0, moveCount: 0, lastLook: 0,
      target: null, tracer: null,
      sector: 3, subsector: 4, floorZ: -8 * unit, ceilingZ: 128 * unit,
      spawnpoint: null, player: null, removed: false,
    });
    // P_SpawnMobj draws exactly once from the game RNG, even for static objects.
    expect(random).toEqual({ gameIndex: 1, menuIndex: 0 });
  });

  it('uses the sector floor, ceiling minus actor height, or explicit fixed-point z', () => {
    const spawn = (z: 'floor' | 'ceiling' | number): Actor =>
      createActor(ActorType.MT_BRUISER, 1, 0, 0, 12 * unit, 160 * unit,
        0, 0, 2, createRandom(), z);
    expect(spawn('floor').z).toBe(12 * unit);
    expect(spawn('ceiling').z).toBe(96 * unit);
    expect(spawn(35 * unit).z).toBe(35 * unit);
  });

  it('clears nightmare reaction time and preserves the original four-player last-look draw', () => {
    const random = createRandom();
    random.gameIndex = 1;
    const actor = createActor(ActorType.MT_POSSESSED, 1, 0, 0, 0, 128 * unit,
      0, 0, 4, random);
    expect(actor.reactionTime).toBe(0);
    expect(actor.lastLook).toBe(1); // Original random table index 2 contains 109.
    expect(random.gameIndex).toBe(2);
  });
});

describe('actor state transitions', () => {
  it('installs sprite, frame and tics before running the entry action', () => {
    const actor = possessed();
    const seen: number[][] = [];
    expect(setActorState(actor, StateId.S_POSS_DIE2, (action, current) => {
      seen.push([action, current.state, current.sprite, current.frame, current.tics]);
      current.health = 0;
    })).toBe(true);
    expect(seen).toEqual([[ActionId.A_Scream, StateId.S_POSS_DIE2, SpriteId.SPR_POSS, 8, 5]]);
    expect(actor.health).toBe(0);
  });

  it('follows zero-tic states and runs their actions in the same transition', () => {
    const actor = possessed();
    const actions: ActionId[] = [];
    expect(setActorState(actor, StateId.S_VILE_ATK1, (action) => actions.push(action))).toBe(true);
    expect(actions).toEqual([ActionId.A_VileStart, ActionId.A_FaceTarget]);
    expect(actor).toMatchObject({ state: StateId.S_VILE_ATK2, tics: 10,
      sprite: SpriteId.SPR_VILE, frame: 32774 });
  });

  it('preserves a state selected by a nested entry action', () => {
    const actor = possessed();
    const actions: ActionId[] = [];
    const runAction = (action: ActionId, current: Actor): void => {
      actions.push(action);
      if (action === ActionId.A_ReFire) setActorState(current, StateId.S_POSS_RUN1, runAction);
    };
    expect(setActorState(actor, StateId.S_CHAIN3, runAction)).toBe(true);
    expect(actions).toEqual([ActionId.A_ReFire, ActionId.A_Chase]);
    expect(actor).toMatchObject({ state: StateId.S_POSS_RUN1, tics: 4,
      sprite: SpriteId.SPR_POSS, frame: 0 });
  });

  it('follows the entered state nextstate when an action leaves the actor at zero tics', () => {
    const actor = possessed();
    const actions: ActionId[] = [];
    expect(setActorState(actor, StateId.S_POSS_STND, (action, current) => {
      actions.push(action);
      if (current.state === StateId.S_POSS_STND) {
        current.state = StateId.S_POSS_RUN1;
        current.tics = 0;
      }
    })).toBe(true);
    expect(actions).toEqual([ActionId.A_Look, ActionId.A_Look]);
    expect(actor.state).toBe(StateId.S_POSS_STND2);
    expect(actor.tics).toBe(10);
  });

  it('removes on S_NULL without overwriting the prior tics, sprite or frame', () => {
    const actor = possessed();
    const actions: ActionId[] = [];
    expect(setActorState(actor, StateId.S_NULL, (action) => actions.push(action))).toBe(false);
    expect(actor).toMatchObject({ state: StateId.S_NULL, removed: true, tics: 10,
      sprite: SpriteId.SPR_POSS, frame: 0 });
    expect(actions).toEqual([]);
  });

  it('retains the original outer return value when a nonzero-tic action removes the actor', () => {
    const actor = possessed();
    const actions: ActionId[] = [];
    const runAction = (action: ActionId, current: Actor): void => {
      actions.push(action);
      expect(setActorState(current, StateId.S_NULL, runAction)).toBe(false);
    };
    expect(setActorState(actor, StateId.S_POSS_STND, runAction)).toBe(true);
    expect(actor).toMatchObject({ state: StateId.S_NULL, removed: true, tics: 10 });
    expect(actions).toEqual([ActionId.A_Look]);
  });

  it('enters S_NULL immediately after a terminal zero-tic state', () => {
    const actor = possessed();
    const actions: ActionId[] = [];
    expect(setActorState(actor, StateId.S_LIGHTDONE, (action) => actions.push(action))).toBe(false);
    expect(actor.removed).toBe(true);
    expect(actor.state).toBe(StateId.S_NULL);
    expect(actor.tics).toBe(0);
    expect(actions).toEqual([ActionId.A_Light0]);
  });
});

describe('actor state ticks', () => {
  it('decrements tics and runs the successor entry action only on expiration', () => {
    const actor = possessed();
    actor.tics = 2;
    const actions: ActionId[] = [];
    const runAction = (action: ActionId): void => { actions.push(action); };
    tickActorState(actor, runAction);
    expect(actor.state).toBe(StateId.S_POSS_STND);
    expect(actor.tics).toBe(1);
    expect(actions).toEqual([]);
    tickActorState(actor, runAction);
    expect(actor.state).toBe(StateId.S_POSS_STND2);
    expect(actor.tics).toBe(10);
    expect(actions).toEqual([ActionId.A_Look]);
  });

  it('leaves a permanent corpse unchanged without respawning or reentering its action', () => {
    const actor = possessed();
    setActorState(actor, StateId.S_POSS_DIE5, () => { throw new Error('no entry action'); });
    actor.flags |= MobjFlag.MF_CORPSE;
    const before = { ...actor };
    for (let tic = 0; tic < 70; tic++) {
      tickActorState(actor, () => { throw new Error('permanent state must not run an action'); });
    }
    expect(actor).toEqual(before);
    expect(actor.tics).toBe(-1);
  });

  it('removes an expiring effect through its null successor', () => {
    const actor = possessed();
    setActorState(actor, StateId.S_PUFF4, () => { throw new Error('no entry action'); });
    actor.tics = 1;
    tickActorState(actor, () => { throw new Error('null successor must not run an action'); });
    expect(actor).toMatchObject({ state: StateId.S_NULL, removed: true, tics: 0 });
  });
});
