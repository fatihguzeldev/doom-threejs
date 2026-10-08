import { idleCommand, TicButton, WEAPON_SHIFT, type TicCommand } from '../simulation/command';
import { createGamepadInput, type Direction } from './gamepad';
import { createSystemButtons } from './system-buttons';

export type InputAction = 'menu' | 'automap' | 'pause' | 'save' | 'load' | 'fullscreen' |
  'confirm' | 'back' | 'up' | 'down' | 'left' | 'right' | 'previousWeapon' | 'nextWeapon';
export interface BrowserInputOptions {
  readonly keyboardProfile?: 'desktop' | 'buttons';
  readonly onActivity?: () => void;
}
export interface BrowserInput {
  command(): TicCommand;
  actions(): InputAction[];
  characters(): string;
  setContext(context: 'game' | 'menu'): void;
  clear(): void;
  dispose(): void;
}

const commonActions: Readonly<Partial<Record<string, InputAction>>> = {
  Escape: 'menu', Tab: 'automap', Pause: 'pause', F5: 'save', F9: 'load', F11: 'fullscreen',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};
const desktopActions: Readonly<Partial<Record<string, InputAction>>> = {
  Enter: 'confirm', BracketLeft: 'previousWeapon', BracketRight: 'nextWeapon',
};
const buttonActions: Readonly<Partial<Record<string, InputAction>>> = {
  KeyX: 'confirm', KeyZ: 'back', KeyS: 'nextWeapon',
};
const directionCodes: Readonly<Record<Direction, string>> = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
};
const directions: readonly Direction[] = ['up', 'down', 'left', 'right'];

export function createBrowserInput(target: HTMLElement, options: BrowserInputOptions = {}): BrowserInput {
  const keys = new Set<string>(), pulses = new Set<string>(), blockedKeys = new Set<string>();
  const pending: InputAction[] = [], pendingCharacters: string[] = [];
  const directionTicks = new Map<Direction, number>(), primedDirections = new Set<Direction>();
  let mouseX = 0, attack = false, attackPulse = false, blockedAttack = false;
  let turnHeld = 0, selectedWeapon: number | null = null, disposed = false, focused = true;
  let context: 'game' | 'menu' = 'game';
  const owner = target.ownerDocument, window = owner.defaultView;
  if (!window) throw new Error('Game input requires a browser window');
  const buttonsProfile = options.keyboardProfile === 'buttons';
  const system = createSystemButtons(), gamepad = createGamepadInput(window, options.onActivity);
  const hasFocus = (): boolean => focused && !owner.hidden && owner.hasFocus?.() !== false;
  const active = (): boolean => hasFocus() &&
    (owner.pointerLockElement === target || target.contains(owner.activeElement));
  const shiftHeld = (): boolean => keys.has('ShiftLeft') || keys.has('ShiftRight');
  const clearKeyboard = (): void => {
    keys.forEach(code => blockedKeys.add(code));
    pulses.clear(); mouseX = 0; attackPulse = false; blockedAttack = attack;
    turnHeld = 0; selectedWeapon = null; pending.length = 0; pendingCharacters.length = 0;
    directionTicks.clear(); primedDirections.clear();
    system.clear(keys.has('Enter'), shiftHeld());
  };
  const clear = (): void => { clearKeyboard(); gamepad.clear(); };
  const keyDown = (event: KeyboardEvent): void => {
    if (!active()) return;
    if (event.code === 'Tab' || event.code.startsWith('Arrow') || event.code === 'Space' || /^F[0-9]+$/.test(event.code)) event.preventDefault();
    if (event.repeat || keys.has(event.code)) return;
    // Some hosts send an otherwise unbound trusted key solely to unlock audio.
    options.onActivity?.();
    blockedKeys.delete(event.code); keys.add(event.code); pulses.add(event.code);
    if (/^[a-z0-9]$/i.test(event.key)) pendingCharacters.push(event.key.toLowerCase());
    if (buttonsProfile && (event.code === 'Enter' || event.code.startsWith('Shift'))) {
      pending.push(...system.update(keys.has('Enter'), shiftHeld()));
      return;
    }
    const action = commonActions[event.code] ?? (buttonsProfile ? buttonActions : desktopActions)[event.code];
    if (action) {
      pending.push(action);
      if (directions.some(direction => direction === action)) primedDirections.add(action as Direction);
    }
    if (/^Digit[1-7]$/.test(event.code)) selectedWeapon = Number(event.code.slice(-1)) - 1;
  };
  const keyUp = (event: KeyboardEvent): void => {
    keys.delete(event.code); blockedKeys.delete(event.code);
    if (buttonsProfile && (event.code === 'Enter' || event.code.startsWith('Shift'))) {
      const actions = system.update(keys.has('Enter'), shiftHeld());
      if (active()) pending.push(...actions);
    }
  };
  const mouseMove = (event: MouseEvent): void => {
    if (hasFocus() && owner.pointerLockElement === target) mouseX += event.movementX;
  };
  const mouseDown = (event: MouseEvent): void => {
    if (!active()) return;
    options.onActivity?.();
    if (event.button === 0) { attack = true; attackPulse = true; blockedAttack = false; }
  };
  const mouseUp = (event: MouseEvent): void => {
    if (event.button === 0) { attack = false; blockedAttack = false; }
  };
  const wheel = (event: WheelEvent): void => {
    if (!active()) return;
    event.preventDefault(); pending.push(event.deltaY > 0 ? 'nextWeapon' : 'previousWeapon');
  };
  const lockChange = (): void => { if (owner.pointerLockElement !== target) clear(); };
  const blur = (): void => {
    focused = false; clear(); keys.clear(); attack = false;
    // A fresh non-repeat keydown after focus recovers keyups lost outside the window.
    system.clear(false, false);
  };
  const focus = (): void => { focused = true; };
  const focusIn = (): void => { if (!active()) clear(); };
  const visibility = (): void => { if (owner.hidden) clear(); };
  window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp);
  window.addEventListener('mousemove', mouseMove); window.addEventListener('mousedown', mouseDown); window.addEventListener('mouseup', mouseUp);
  window.addEventListener('blur', blur); window.addEventListener('focus', focus);
  window.addEventListener('gamepaddisconnected', clear);
  owner.addEventListener('pointerlockchange', lockChange); owner.addEventListener('focusin', focusIn);
  owner.addEventListener('visibilitychange', visibility);
  target.addEventListener('wheel', wheel, { passive: false });
  const pressed = (...codes: string[]): boolean => codes.some(code =>
    (keys.has(code) || pulses.has(code)) && !blockedKeys.has(code));
  const repeatDirections = (held: ReadonlySet<Direction>): void => {
    for (const direction of directions) {
      if (!held.has(direction)) { directionTicks.delete(direction); continue; }
      const tics = (directionTicks.get(direction) ?? 0) + 1;
      directionTicks.set(direction, tics);
      if ((tics === 1 && !primedDirections.has(direction)) ||
        (context === 'menu' && tics >= 12 && (tics - 12) % 4 === 0)) pending.push(direction);
    }
    primedDirections.clear();
  };
  return {
    command(): TicCommand {
      if (disposed) throw new Error('Game input is disposed');
      if (!hasFocus()) { clear(); return idleCommand; }
      const keyboardRun = buttonsProfile ? pressed('KeyA') : pressed('ShiftLeft', 'ShiftRight');
      const pad = gamepad.poll(keyboardRun);
      if (pad.changed) clearKeyboard();
      pending.push(...pad.actions);
      const heldDirections = new Set(pad.directions);
      for (const direction of directions) if (pressed(directionCodes[direction])) heldDirections.add(direction);
      repeatDirections(heldDirections);
      const run = keyboardRun || pad.run;
      const forwardSpeed = run ? 50 : 25, sideSpeed = run ? 40 : 24;
      const strafe = !buttonsProfile && pressed('AltLeft', 'AltRight');
      const forward = Number(pressed('ArrowUp') || (!buttonsProfile && pressed('KeyW')));
      const backward = Number(pressed('ArrowDown') || (!buttonsProfile && pressed('KeyS')));
      let forwardMove = (forward - backward) * forwardSpeed + pad.command.forwardMove;
      let sideMove = (Number(pressed(buttonsProfile ? 'KeyW' : 'KeyD')) -
        Number(pressed(buttonsProfile ? 'KeyQ' : 'KeyA'))) * sideSpeed + pad.command.sideMove;
      const turn = Number(pressed('ArrowLeft')) - Number(pressed('ArrowRight'));
      turnHeld = turn === 0 ? 0 : turnHeld + 1;
      let angleTurn = strafe ? 0 : turn * (turnHeld < 6 ? 320 : run ? 1280 : 640);
      if (strafe) sideMove -= turn * sideSpeed;
      angleTurn += pad.command.angleTurn - Math.round(mouseX * 8); mouseX = 0;
      const keyboardAttack = buttonsProfile ? pressed('KeyZ') : pressed('ControlLeft', 'ControlRight');
      let commandButtons = pad.command.buttons | ((keyboardAttack || ((!blockedAttack && attack) || attackPulse)) ? TicButton.attack : 0);
      if (buttonsProfile ? pressed('KeyX') : pressed('Space', 'KeyE')) commandButtons |= TicButton.use;
      if (selectedWeapon !== null) { commandButtons |= TicButton.changeWeapon | selectedWeapon << WEAPON_SHIFT; selectedWeapon = null; }
      pulses.clear(); attackPulse = false;
      if (context === 'menu') return idleCommand;
      forwardMove = Math.max(-50, Math.min(50, forwardMove));
      return { forwardMove, sideMove: Math.max(-50, Math.min(50, sideMove)), angleTurn: ((angleTurn << 16) >> 16), buttons: commandButtons };
    },
    actions(): InputAction[] { return pending.splice(0); },
    characters(): string { return pendingCharacters.splice(0).join(''); },
    setContext(next: 'game' | 'menu'): void {
      if (context === next) return;
      context = next; clear();
    },
    clear,
    dispose(): void {
      if (disposed) return;
      disposed = true; clear();
      window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp);
      window.removeEventListener('mousemove', mouseMove); window.removeEventListener('mousedown', mouseDown); window.removeEventListener('mouseup', mouseUp);
      window.removeEventListener('blur', blur); window.removeEventListener('focus', focus);
      window.removeEventListener('gamepaddisconnected', clear);
      owner.removeEventListener('pointerlockchange', lockChange); owner.removeEventListener('focusin', focusIn);
      owner.removeEventListener('visibilitychange', visibility); target.removeEventListener('wheel', wheel);
    },
  };
}
