import { TicButton, WEAPON_SHIFT, type TicCommand } from '../simulation/command';

export type InputAction = 'menu' | 'automap' | 'pause' | 'save' | 'load' | 'fullscreen' |
  'confirm' | 'up' | 'down' | 'left' | 'right' | 'previousWeapon' | 'nextWeapon';

export interface BrowserInput {
  command(): TicCommand;
  actions(): InputAction[];
  characters(): string;
  clear(): void;
  dispose(): void;
}

const actionsByCode: Readonly<Partial<Record<string, InputAction>>> = {
  Escape: 'menu', Tab: 'automap', Pause: 'pause', F5: 'save', F9: 'load',
  F11: 'fullscreen', Enter: 'confirm', ArrowUp: 'up', ArrowDown: 'down',
  ArrowLeft: 'left', ArrowRight: 'right', BracketLeft: 'previousWeapon', BracketRight: 'nextWeapon',
};

export function createBrowserInput(target: HTMLElement): BrowserInput {
  const keys = new Set<string>(), pending: InputAction[] = [];
  const pendingCharacters: string[] = [];
  let mouseX = 0, attack = false, turnHeld = 0, selectedWeapon: number | null = null;
  let previousButtons: readonly boolean[] = [], disposed = false;
  const owner = target.ownerDocument, window = owner.defaultView;
  if (!window) throw new Error('Game input requires a browser window');
  const active = (): boolean => owner.pointerLockElement === target || target.contains(owner.activeElement);
  const keyDown = (event: KeyboardEvent): void => {
    if (!active()) return;
    if (event.code === 'Tab' || event.code.startsWith('Arrow') || event.code === 'Space' || /^F[0-9]+$/.test(event.code)) event.preventDefault();
    keys.add(event.code);
    if (event.repeat) return;
    if (/^[a-z0-9]$/i.test(event.key)) pendingCharacters.push(event.key.toLowerCase());
    const action = actionsByCode[event.code];
    if (action) pending.push(action);
    if (/^Digit[1-7]$/.test(event.code)) selectedWeapon = Number(event.code.slice(-1)) - 1;
  };
  const keyUp = (event: KeyboardEvent): void => { keys.delete(event.code); };
  const mouseMove = (event: MouseEvent): void => { if (owner.pointerLockElement === target) mouseX += event.movementX; };
  const mouseDown = (event: MouseEvent): void => { if (active() && event.button === 0) attack = true; };
  const mouseUp = (event: MouseEvent): void => { if (event.button === 0) attack = false; };
  const wheel = (event: WheelEvent): void => {
    if (!active()) return;
    event.preventDefault();
    pending.push(event.deltaY > 0 ? 'nextWeapon' : 'previousWeapon');
  };
  const clear = (): void => {
    keys.clear(); mouseX = 0; attack = false; turnHeld = 0; selectedWeapon = null;
    pending.length = 0; pendingCharacters.length = 0;
  };
  const lockChange = (): void => { if (owner.pointerLockElement !== target) clear(); };
  window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp);
  window.addEventListener('mousemove', mouseMove); window.addEventListener('mousedown', mouseDown); window.addEventListener('mouseup', mouseUp);
  window.addEventListener('blur', clear); owner.addEventListener('pointerlockchange', lockChange);
  target.addEventListener('wheel', wheel, { passive: false });
  const pressed = (...codes: string[]): boolean => codes.some(code => keys.has(code));
  const axis = (value: number): number => Math.abs(value) < 0.18 ? 0 : Math.sign(value) * (Math.abs(value) - 0.18) / 0.82;
  return {
    command(): TicCommand {
      if (disposed) throw new Error('Game input is disposed');
      const pad = [...window.navigator.getGamepads()].find(value => value?.connected) ?? null;
      const buttons = pad?.buttons.map(button => button.pressed) ?? [];
      const padActions: Readonly<Partial<Record<number, InputAction>>> = {
        4: 'previousWeapon', 5: 'nextWeapon', 8: 'automap', 9: 'menu', 12: 'up', 13: 'down', 14: 'left', 15: 'right',
      };
      for (const [index, held] of buttons.entries()) {
        const action = padActions[index];
        if (held && !previousButtons[index] && action) pending.push(action);
        if (index === 0 && held && !previousButtons[index]) pending.push('confirm');
      }
      previousButtons = buttons;
      const run = pressed('ShiftLeft', 'ShiftRight') || buttons[3] === true;
      const strafe = pressed('AltLeft', 'AltRight');
      const forwardSpeed = run ? 50 : 25, sideSpeed = run ? 40 : 24;
      let forwardMove = (Number(pressed('KeyW', 'ArrowUp')) - Number(pressed('KeyS', 'ArrowDown'))) * forwardSpeed;
      let sideMove = (Number(pressed('KeyD')) - Number(pressed('KeyA'))) * sideSpeed;
      const turn = Number(pressed('ArrowLeft')) - Number(pressed('ArrowRight'));
      turnHeld = turn === 0 ? 0 : turnHeld + 1;
      let angleTurn = strafe ? 0 : turn * (turnHeld < 6 ? 320 : run ? 1280 : 640);
      if (strafe) sideMove -= turn * sideSpeed;
      angleTurn -= Math.round(mouseX * 8); mouseX = 0;
      if (pad) {
        forwardMove -= Math.round(axis(pad.axes[1] ?? 0) * forwardSpeed);
        sideMove += Math.round(axis(pad.axes[0] ?? 0) * sideSpeed);
        angleTurn -= Math.round(axis(pad.axes[2] ?? 0) * 1280);
      }
      let commandButtons = attack || pressed('ControlLeft', 'ControlRight') || buttons[0] ? TicButton.attack : 0;
      if (pressed('Space', 'KeyE') || buttons[1]) commandButtons |= TicButton.use;
      if (selectedWeapon !== null) { commandButtons |= TicButton.changeWeapon | selectedWeapon << WEAPON_SHIFT; selectedWeapon = null; }
      return {
        forwardMove: Math.max(-50, Math.min(50, forwardMove)), sideMove: Math.max(-50, Math.min(50, sideMove)),
        angleTurn: ((angleTurn << 16) >> 16), buttons: commandButtons,
      };
    },
    actions(): InputAction[] { return pending.splice(0); },
    characters(): string { return pendingCharacters.splice(0).join(''); },
    clear,
    dispose(): void {
      if (disposed) return;
      disposed = true; clear();
      window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp);
      window.removeEventListener('mousemove', mouseMove); window.removeEventListener('mousedown', mouseDown); window.removeEventListener('mouseup', mouseUp);
      window.removeEventListener('blur', clear); owner.removeEventListener('pointerlockchange', lockChange);
      target.removeEventListener('wheel', wheel);
    },
  };
}
