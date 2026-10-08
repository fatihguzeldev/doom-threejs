// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Single-player P_Ticker wiring. See ../../LICENSE.
import type { DoomResources } from '../wad/resources';
import { thinkActor } from './actor-thinking';
import type { Actor } from './actors';
import { damageActor, type CombatHooks } from './combat';
import { idleCommand, type TicCommand } from './command';
import type { ActorType } from './data/actors';
import type { ActionId } from './data/states';
import { createEnemies } from './enemy';
import { touchSpecialThing } from './pickups';
import { tryMove, type MovementHooks } from './movement';
import { thinkPlayer } from './player-thinking';
import {
  aimLineAttack, explodeMissile, lineAttack, radiusAttack, spawnMissile,
  spawnPlayerMissile, useLines, type ShootingHooks,
} from './shooting';
import { doDoor } from './specials/doors';
import { doFloor } from './specials/floors';
import { createSpecials } from './specials/triggers';
import { checkSight } from './trace';
import { createWeapons } from './weapons';
import { sweepActors, type World } from './world';

export interface Simulation {
  readonly world: World;
  tick(command?: TicCommand): void;
  damage(target: Actor, inflictor: Actor | null, source: Actor | null, amount: number): void;
}

export interface SimulationOptions {
  // Restoring a saved world preserves thinkers, buttons and psprite state.
  readonly initialize?: boolean;
  readonly stopAutomap?: () => void;
}

export function createSimulation(world: World, resources: DoomResources, options: SimulationOptions = {}): Simulation {
  // These closures join the engine's cyclic interactions. No callback executes
  // until all systems exist, then level specials and weapon sprites initialize.
  const runActorAction = (action: ActionId, actor: Actor): void => enemies.runAction(action, actor);
  const damage = (target: Actor, inflictor: Actor | null, source: Actor | null, amount: number): void => {
    damageActor(world, target, inflictor, source, amount, combatHooks);
  };
  const movement: MovementHooks = {
    touchPickup: (thing, toucher) => { touchSpecialThing(world, thing, toucher); },
    damageActor: damage, runActorAction,
    explodeMissile: actor => explodeMissile(world, actor, shooting),
    crossSpecial: (line, side, actor) => specials.cross(line, side, actor),
  };
  const shooting: ShootingHooks = {
    damageActor: damage, runActorAction,
    shootSpecial: (line, actor) => specials.shoot(line, actor),
    useSpecial: (line, side, actor) => { specials.use(line, side, actor); },
  };
  const combatHooks: CombatHooks = {
    runActorAction, dropWeapon: () => weapons.drop(), stopAutomap: options.stopAutomap ?? (() => {}),
  };
  const specials = createSpecials(world, resources, { movement, damageActor: damage });
  const weapons = createWeapons(world, {
    runActorAction,
    noiseAlert: actor => enemies.noiseAlert(actor, actor),
    aimLineAttack: (actor, angle, range) => aimLineAttack(world, actor, angle, range),
    lineAttack: (actor, angle, range, slope, amount) => lineAttack(world, actor, angle, range, slope, amount, shooting),
    spawnPlayerMissile: (actor, type) => { spawnPlayerMissile(world, actor, type, shooting); },
  });
  const enemies = createEnemies(world, {
    tryMove: (actor, x, y) => tryMove(world, actor, x, y, movement),
    checkSight: (actor, target) => checkSight(world, actor, target),
    aimLineAttack: (actor, angle, range) => aimLineAttack(world, actor, angle, range),
    lineAttack: (actor, angle, range, slope, amount) => lineAttack(world, actor, angle, range, slope, amount, shooting),
    spawnMissile: (actor: Actor, target: Actor, type: ActorType) => spawnMissile(world, actor, target, type, shooting),
    damageActor: damage, radiusAttack: (actor, source, amount) => radiusAttack(world, actor, source, amount, shooting),
    runActorAction, useSpecial: (line, side, actor) => specials.use(line, side, actor),
    bossDeath: effect => {
      if (effect.kind === 'lowerFloorToLowest') doFloor(world, effect.tag, effect.kind);
      else if (effect.kind === 'blazeOpen') doDoor(world, effect.tag, effect.kind);
      else world.events.push({ type: 'exit', secret: false });
    },
  }, world.fastMonsters);
  if (options.initialize !== false) {
    specials.setup();
    weapons.setup();
  }
  const tick = (input: TicCommand = idleCommand): void => {
    const command = thinkPlayer(world, input, {
      runActorAction, moveWeaponSprites: next => weapons.move(next),
      useLines: actor => useLines(world, actor, shooting),
      playerInSpecialSector: actor => specials.playerInSector(actor),
    });
    // P_RunThinkers sees newly appended thinkers later in this very tic.
    // Deferred removal preserves this creation order until the final sweep.
    for (let index = 0; index < world.thinkers.length; index++) {
      const thinker = world.thinkers[index];
      if (!thinker) throw new Error('Invalid thinker slot');
      if (thinker.kind !== 'actor') specials.tick(thinker);
      else {
        const actor = world.actorsById.get(thinker.id);
        if (actor && !actor.removed) thinkActor(world, actor, movement,
          actor.player === null ? 0 : command.forwardMove, actor.player === null ? 0 : command.sideMove);
      }
    }
    specials.update();
    world.levelTime = (world.levelTime + 1) | 0;
    sweepActors(world);
  };
  return { world, tick, damage };
}
