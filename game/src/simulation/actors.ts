// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native lifecycle port of linuxdoom-1.10/p_mobj.c. See ../../LICENSE.
import type { MapThing } from '../wad/map';
import { actors, type ActorType } from './data/actors';
import { ActionId, StateId, states, type SpriteId, type StateDefinition } from './data/states';
import { gameRandom, type RandomState } from './random';

export interface Actor {
  id: number;
  type: ActorType;
  state: StateId;
  tics: number;
  sprite: SpriteId;
  frame: number;
  x: number;
  y: number;
  z: number;
  momx: number;
  momy: number;
  momz: number;
  angle: number;
  radius: number;
  height: number;
  flags: number;
  health: number;
  reactionTime: number;
  threshold: number;
  moveDir: number;
  moveCount: number;
  lastLook: number;
  target: number | null;
  tracer: number | null;
  sector: number;
  subsector: number;
  floorZ: number;
  ceilingZ: number;
  spawnpoint: MapThing | null;
  player: number | null;
  removed: boolean;
  readonly fastStates: boolean;
}

function stateDefinition(state: StateId): StateDefinition {
  const definition = states[state];
  if (definition === undefined) throw new RangeError(`Unknown actor state ${state}`);
  return definition;
}

export function createActor(
  type: ActorType,
  id: number,
  x: number,
  y: number,
  floorZ: number,
  ceilingZ: number,
  sector: number,
  subsector: number,
  skill: number,
  random: RandomState,
  z: 'floor' | 'ceiling' | number = 'floor',
  fastStates = skill === 4,
): Actor {
  const info = actors[type];
  if (info === undefined) throw new RangeError(`Unknown actor type ${type}`);
  // P_SpawnMobj installs the initial state directly: its action must not run yet.
  const initial = stateDefinition(info.spawnstate);
  return {
    id, type, state: info.spawnstate, tics: stateTics(info.spawnstate, fastStates),
    sprite: initial.sprite, frame: initial.frame,
    x, y,
    z: z === 'floor' ? floorZ : z === 'ceiling' ? (ceilingZ - info.height) | 0 : z,
    momx: 0, momy: 0, momz: 0, angle: 0,
    radius: info.radius, height: info.height, flags: info.flags,
    health: info.spawnhealth,
    reactionTime: skill === 4 ? 0 : info.reactiontime,
    threshold: 0, moveDir: 0, moveCount: 0,
    lastLook: gameRandom(random) % 4,
    target: null, tracer: null,
    sector, subsector, floorZ, ceilingZ,
    spawnpoint: null, player: null, removed: false, fastStates,
  };
}

function stateTics(state: StateId, fast: boolean): number {
  const tics = stateDefinition(state).tics;
  return fast && state >= StateId.S_SARG_RUN1 && state <= StateId.S_SARG_PAIN2 ? tics >> 1 : tics;
}

export function setActorState(
  actor: Actor,
  state: StateId,
  runAction: (action: ActionId, actor: Actor) => void,
): boolean {
  do {
    if (state === StateId.S_NULL) {
      actor.state = StateId.S_NULL;
      actor.removed = true;
      return false;
    }
    const entered = stateDefinition(state);
    actor.state = state;
    actor.tics = stateTics(state, actor.fastStates);
    actor.sprite = entered.sprite;
    actor.frame = entered.frame;
    if (entered.action !== ActionId.None) runAction(entered.action, actor);
    // The original uses this entry's successor but the post-action actor tics.
    // Nested entry/removal can change the actor. Its removed flag is independent
    // of this call's return value; callers handle deferred removal separately.
    state = entered.nextstate;
  } while (actor.tics === 0);
  return true;
}

export function tickActorState(
  actor: Actor,
  runAction: (action: ActionId, actor: Actor) => void,
): void {
  if (actor.tics === -1) return;
  actor.tics--;
  if (actor.tics === 0) setActorState(actor, stateDefinition(actor.state).nextstate, runAction);
}
