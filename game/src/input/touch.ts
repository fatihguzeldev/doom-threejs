import { TicButton, type TicCommand } from '../simulation/command';

export type TouchControl = 'left' | 'forward' | 'back' | 'right' | 'fire' | 'use' |
  'strafeLeft' | 'strafeRight' | 'run';
export interface TouchInput {
  press(pointerId: number, control: TouchControl): void;
  release(pointerId: number): void;
  clear(): void;
  command(): TicCommand | null;
}

export function createTouchInput(): TouchInput {
  const held = new Map<number, TouchControl>(), pulses = new Set<TouchControl>();
  return {
    press(pointerId, control): void {
      held.set(pointerId, control); pulses.add(control);
    },
    release(pointerId): void { held.delete(pointerId); },
    clear(): void { held.clear(); pulses.clear(); },
    command(): TicCommand | null {
      // Pointer taps can begin and end between two 35 Hz simulation tics.
      const controls = new Set([...held.values(), ...pulses]);
      pulses.clear();
      const run = controls.has('run');
      const forwardMove = (Number(controls.has('forward')) - Number(controls.has('back'))) * (run ? 50 : 25);
      const sideMove = (Number(controls.has('strafeRight')) - Number(controls.has('strafeLeft'))) * (run ? 40 : 24);
      const angleTurn = (Number(controls.has('left')) - Number(controls.has('right'))) * (run ? 1280 : 640);
      const buttons = (controls.has('fire') ? TicButton.attack : 0) | (controls.has('use') ? TicButton.use : 0);
      return forwardMove || sideMove || angleTurn || buttons ? { forwardMove, sideMove, angleTurn, buttons } : null;
    },
  };
}
