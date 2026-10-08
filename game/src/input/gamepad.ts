import { idleCommand, TicButton, type TicCommand } from '../simulation/command';
import type { InputAction } from './browser';
import { createSystemButtons } from './system-buttons';

export type Direction = 'up' | 'down' | 'left' | 'right';
interface GamepadFrame {
  readonly command: TicCommand;
  readonly directions: readonly Direction[];
  readonly actions: readonly InputAction[];
  readonly run: boolean;
  readonly changed: boolean;
}

const actionsByButton: Readonly<Partial<Record<number, InputAction>>> = {
  0: 'back', 1: 'confirm', 2: 'nextWeapon', 6: 'previousWeapon', 7: 'nextWeapon',
};
const deadzone = 0.18;
const axis = (value: number): number => Math.abs(value) <= deadzone ? 0 :
  Math.sign(value) * (Math.min(1, Math.abs(value)) - deadzone) / (1 - deadzone);

export function createGamepadInput(window: Window, onActivity?: () => void) {
  let selected: string | null = null, seenPad = false, turnHeld = 0;
  let previousButtons: readonly boolean[] = [];
  const blockedButtons = new Set<number>(), blockedAxes = new Set<number>();
  const system = createSystemButtons();
  const read = (): Gamepad | null => {
    try { return [...(window.navigator.getGamepads?.() ?? [])].find(pad => pad?.connected) ?? null; }
    catch { return null; } // Embedded host policy can deny this API while keyboard input remains usable.
  };
  const neutral = (changed = false): GamepadFrame => ({ command: idleCommand, directions: [], actions: [], run: false, changed });
  const reset = (pad: Gamepad | null): void => {
    blockedButtons.clear(); blockedAxes.clear(); turnHeld = 0;
    previousButtons = pad?.buttons.map(button => button.pressed) ?? [];
    previousButtons.forEach((held, index) => { if (held) blockedButtons.add(index); });
    pad?.axes.forEach((value, index) => { if (Math.abs(value) > deadzone) blockedAxes.add(index); });
    system.clear(previousButtons[9] === true, previousButtons[8] === true);
  };
  return {
    clear(): void {
      const pad = read();
      selected = pad ? `${pad.index}:${pad.id}` : null;
      if (pad) seenPad = true;
      reset(pad);
    },
    poll(keyboardRun: boolean): GamepadFrame {
      const pad = read(), identity = pad ? `${pad.index}:${pad.id}` : null;
      if (identity !== selected) {
        const replacement = seenPad;
        selected = identity;
        if (pad) seenPad = true;
        if (replacement) { reset(pad); return neutral(true); }
      }
      if (!pad) return neutral();
      const rawButtons = pad.buttons.map(button => button.pressed);
      const buttons = rawButtons.map((held, index) => {
        if (!held) blockedButtons.delete(index);
        return held && !blockedButtons.has(index);
      });
      const axes = pad.axes.map((value, index) => {
        if (Math.abs(value) <= deadzone) blockedAxes.delete(index);
        return blockedAxes.has(index) ? 0 : axis(value);
      });
      const actions: InputAction[] = [];
      let fresh = false;
      buttons.forEach((held, index) => {
        if (!held || previousButtons[index]) return;
        fresh = true;
        const action = actionsByButton[index];
        if (action) actions.push(action);
      });
      if (fresh) onActivity?.();
      actions.push(...system.update(rawButtons[9] === true, rawButtons[8] === true));
      previousButtons = rawButtons;
      const run = keyboardRun || buttons[3] === true;
      const forwardSpeed = run ? 50 : 25, sideSpeed = run ? 40 : 24;
      const digitalX = Number(buttons[15] === true) - Number(buttons[14] === true);
      const digitalY = Number(buttons[13] === true) - Number(buttons[12] === true);
      const leftX = buttons[14] || buttons[15] ? 0 : axes[0] ?? 0;
      const leftY = buttons[12] || buttons[13] ? 0 : axes[1] ?? 0;
      const turnStick = pad.axes.length > 2;
      turnHeld = digitalX === 0 ? 0 : turnHeld + 1;
      const directions: Direction[] = [];
      if (buttons[12] || leftY < -0.5) directions.push('up');
      if (buttons[13] || leftY > 0.5) directions.push('down');
      if (buttons[14] || leftX < -0.5) directions.push('left');
      if (buttons[15] || leftX > 0.5) directions.push('right');
      return {
        command: {
          forwardMove: -digitalY * forwardSpeed - Math.round(leftY * forwardSpeed),
          sideMove: (Number(buttons[5] === true) - Number(buttons[4] === true)) * sideSpeed +
            (turnStick ? Math.round(leftX * sideSpeed) : 0),
          angleTurn: -digitalX * (turnHeld < 6 ? 320 : run ? 1280 : 640) -
            Math.round((turnStick ? axes[2] ?? 0 : leftX) * 1280),
          buttons: (buttons[0] ? TicButton.attack : 0) | (buttons[1] ? TicButton.use : 0),
        },
        actions, directions, run, changed: false,
      };
    },
  };
}
