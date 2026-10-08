import { describe, expect, it, vi } from 'vitest';
import { createBrowserInput, type BrowserInputOptions } from '../../src/input/browser';
import { idleCommand, TicButton } from '../../src/simulation/command';

function pad(index = 0, axes = [0, 0, 0, 0]) {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
  return { index, id: `controller-${index}`, connected: true, buttons, axes,
    press(button: number, pressed = true): void {
      const value = buttons[button];
      if (!value) throw new Error('Invalid fixture button');
      value.pressed = pressed;
    } };
}
type TestPad = ReturnType<typeof pad>;

function surface(options: BrowserInputOptions = {}, initialPad: TestPad | null = null) {
  let current = initialPad;
  const navigator = { getGamepads: (): (TestPad | null)[] => [current] };
  const window = Object.assign(new EventTarget(), { navigator });
  const owner = Object.assign(new EventTarget(), { defaultView: window, hidden: false,
    pointerLockElement: null as object | null, activeElement: null as object | null, hasFocus: () => true });
  const element = Object.assign(new EventTarget(), { ownerDocument: owner,
    contains(node: object | null): boolean { return node === element; } });
  owner.activeElement = element;
  const input = createBrowserInput(element as unknown as HTMLElement, options);
  return { input, owner, window, navigator, element,
    setPad(value: TestPad | null): void { current = value; },
    key(code: string, key = code, repeat = false): Event {
      const event = Object.assign(new Event('keydown', { cancelable: true }), { code, key, repeat });
      window.dispatchEvent(event); return event;
    },
    release(code: string): void { window.dispatchEvent(Object.assign(new Event('keyup'), { code })); },
  };
}

describe('generic gamepad controls', () => {
  it('moves and turns with held D-pad buttons, including diagonal input', () => {
    const controller = pad(), state = surface({}, controller);
    controller.press(12); controller.press(14);
    expect(state.input.command()).toEqual({ ...idleCommand, forwardMove: 25, angleTurn: 320 });
    for (let tic = 0; tic < 5; tic++) state.input.command();
    expect(state.input.command()).toMatchObject({ forwardMove: 25, angleTurn: 640 });
    controller.press(12, false); controller.press(14, false);
    controller.press(13); controller.press(15);
    expect(state.input.command()).toMatchObject({ forwardMove: -25, angleTurn: -640 });
    state.input.dispose();
  });

  it('uses dual-stick axes for movement/strafe and turn, and a two-axis D-pad for forward and turn', () => {
    const dual = pad(0, [1, -1, -1, 0]), state = surface({}, dual);
    expect(state.input.command()).toMatchObject({ forwardMove: 25, sideMove: 24, angleTurn: 1280 });
    const single = pad(1, [-1, -1]); state.setPad(single); state.input.command();
    single.axes.fill(0); state.input.command();
    single.axes[0] = -1; single.axes[1] = -1;
    expect(state.input.command()).toMatchObject({ forwardMove: 25, sideMove: 0, angleTurn: 1280 });
    state.input.dispose();
  });

  it('does not double D-pad direction when the same hat is also reported as axes', () => {
    const controller = pad(0, [-1, -1]), state = surface({}, controller);
    controller.press(12); controller.press(14);
    expect(state.input.command()).toEqual({ ...idleCommand, forwardMove: 25, angleTurn: 320 });
    state.input.dispose();
  });

  it('maps face buttons, shoulders, triggers and running by their positions', () => {
    const controller = pad(), state = surface({}, controller);
    controller.press(0); controller.press(1); controller.press(2); controller.press(3); controller.press(4); controller.press(12);
    expect(state.input.command()).toMatchObject({ forwardMove: 50, sideMove: -40, buttons: TicButton.attack | TicButton.use });
    expect(state.input.actions()).toEqual(['back', 'confirm', 'nextWeapon', 'up']);
    controller.press(4, false); controller.press(5); controller.press(6); controller.press(7);
    expect(state.input.command()).toMatchObject({ sideMove: 40 });
    expect(state.input.actions()).toEqual(['previousWeapon', 'nextWeapon']);
    state.input.dispose();
  });

  it('suppresses staggered Start+Select chords until both buttons are released', () => {
    const controller = pad(), state = surface({}, controller);
    controller.press(9); state.input.command(); expect(state.input.actions()).toEqual([]);
    controller.press(8); state.input.command(); expect(state.input.actions()).toEqual([]);
    controller.press(9, false); state.input.command(); expect(state.input.actions()).toEqual([]);
    controller.press(8, false); state.input.command(); expect(state.input.actions()).toEqual([]);
    controller.press(9); state.input.command(); controller.press(9, false); state.input.command();
    expect(state.input.actions()).toEqual(['menu']);
    controller.press(8); state.input.command(); controller.press(8, false); state.input.command();
    expect(state.input.actions()).toEqual(['automap']);
    state.input.dispose();
  });

  it('repeats held menu direction after twelve tics, then every four tics', () => {
    const controller = pad(), state = surface({}, controller);
    state.input.setContext('menu'); controller.press(12);
    expect(state.input.command()).toEqual(idleCommand);
    expect(state.input.actions()).toEqual(['up']);
    for (let tic = 0; tic < 10; tic++) state.input.command();
    expect(state.input.actions()).toEqual([]);
    state.input.command(); expect(state.input.actions()).toEqual(['up']);
    for (let tic = 0; tic < 3; tic++) state.input.command();
    expect(state.input.actions()).toEqual([]);
    state.input.command(); expect(state.input.actions()).toEqual(['up']);
    state.input.dispose();
  });

  it('does not carry held menu-confirm/use or analog motion through a context change', () => {
    const controller = pad(), state = surface({}, controller);
    state.input.setContext('menu'); controller.press(1); controller.axes[1] = -1;
    expect(state.input.command()).toEqual(idleCommand);
    expect(state.input.actions()).toContain('confirm');
    state.input.setContext('game');
    expect(state.input.command()).toEqual(idleCommand); expect(state.input.actions()).toEqual([]);
    controller.press(1, false); controller.axes[1] = 0; state.input.command();
    controller.press(1); controller.axes[1] = -1;
    expect(state.input.command()).toMatchObject({ forwardMove: 25, buttons: TicButton.use });
    state.input.dispose();
  });

  it('clears old input on disconnect and guards a replacement pad already holding buttons', () => {
    const first = pad(), state = surface({}, first);
    first.press(0); expect(state.input.command().buttons).toBe(TicButton.attack); state.input.actions();
    state.setPad(null); expect(state.input.command()).toEqual(idleCommand); expect(state.input.actions()).toEqual([]);
    const replacement = pad(1); replacement.press(0); state.setPad(replacement);
    expect(state.input.command()).toEqual(idleCommand); expect(state.input.actions()).toEqual([]);
    replacement.press(0, false); state.input.command(); replacement.press(0);
    expect(state.input.command().buttons).toBe(TicButton.attack); expect(state.input.actions()).toEqual(['back']);
    state.input.dispose();
  });

  it('handles a disconnect/reconnect event between polls without replaying held buttons', () => {
    const controller = pad(), state = surface({}, controller);
    controller.press(0); state.input.command(); state.input.actions();
    state.window.dispatchEvent(new Event('gamepaddisconnected'));
    expect(state.input.command()).toEqual(idleCommand);
    expect(state.input.actions()).toEqual([]);
    controller.press(0, false); state.input.command(); controller.press(0);
    expect(state.input.command().buttons).toBe(TicButton.attack);
    state.input.dispose();
  });

  it('accepts a first physical pad without DOM focus but suppresses hidden/unfocused documents', () => {
    const controller = pad(), state = surface({}, controller);
    state.owner.activeElement = null; controller.press(1);
    expect(state.input.command().buttons).toBe(TicButton.use); state.input.actions();
    state.owner.hidden = true; expect(state.input.command()).toEqual(idleCommand); expect(state.input.actions()).toEqual([]);
    state.owner.hidden = false; expect(state.input.command()).toEqual(idleCommand);
    controller.press(1, false); state.input.command(); controller.press(1);
    state.window.dispatchEvent(new Event('blur'));
    expect(state.input.command()).toEqual(idleCommand);
    state.window.dispatchEvent(new Event('focus')); expect(state.input.command()).toEqual(idleCommand);
    state.input.dispose();
  });
});

describe('generic button keyboard profile', () => {
  it('maps arrows, face actions, running and shoulders without desktop letter movement', () => {
    const state = surface({ keyboardProfile: 'buttons' });
    state.key('ArrowUp'); state.key('ArrowLeft'); state.key('KeyX', 'x'); state.key('KeyZ', 'z');
    state.key('KeyS', 's'); state.key('KeyA', 'a'); state.key('KeyQ', 'q');
    expect(state.input.command()).toMatchObject({ forwardMove: 50, sideMove: -40, angleTurn: 320, buttons: 3 });
    expect(state.input.actions()).toEqual(['up', 'left', 'confirm', 'back', 'nextWeapon']);
    state.release('KeyQ'); state.key('KeyW', 'w');
    expect(state.input.command()).toMatchObject({ forwardMove: 50, sideMove: 40 });
    state.input.dispose();
  });

  it('uses Enter/Shift on release and suppresses their chord without changing desktop bindings', () => {
    const state = surface({ keyboardProfile: 'buttons' });
    state.key('Enter'); state.key('ShiftLeft'); state.release('Enter'); state.release('ShiftLeft');
    expect(state.input.actions()).toEqual([]);
    state.key('Enter'); expect(state.input.actions()).toEqual([]); state.release('Enter');
    expect(state.input.actions()).toEqual(['menu']);
    state.key('ShiftLeft'); state.release('ShiftLeft'); expect(state.input.actions()).toEqual(['automap']);
    const desktop = surface(); desktop.key('ShiftLeft'); desktop.key('Enter'); desktop.key('KeyW', 'w');
    expect(desktop.input.actions()).toEqual(['confirm']); expect(desktop.input.command().forwardMove).toBe(50);
    state.input.dispose(); desktop.input.dispose();
  });

  it('clears held keys without replaying repeat keydown, and rearms after release', () => {
    const state = surface({ keyboardProfile: 'buttons' });
    state.key('KeyX', 'x'); expect(state.input.command().buttons).toBe(TicButton.use);
    state.input.clear(); state.key('KeyX', 'x', true);
    expect(state.input.command()).toEqual(idleCommand); expect(state.input.actions()).toEqual([]);
    state.release('KeyX'); state.key('KeyX', 'x');
    expect(state.input.command().buttons).toBe(TicButton.use); expect(state.input.actions()).toEqual(['confirm']);
    state.input.dispose();
  });

  it('accepts a fresh system-button press after blur lost the old keyup', () => {
    const state = surface({ keyboardProfile: 'buttons' });
    state.key('Enter'); state.window.dispatchEvent(new Event('blur'));
    state.window.dispatchEvent(new Event('focus'));
    state.key('Enter'); state.release('Enter');
    expect(state.input.actions()).toEqual(['menu']);
    state.input.dispose();
  });
});

describe('desktop compatibility and activity', () => {
  it('retains desktop WASD, arrows, shift, mouse, space/control and number weapons', () => {
    const state = surface(); state.owner.pointerLockElement = state.element;
    state.key('KeyW', 'w'); state.key('KeyA', 'a'); state.key('ArrowLeft'); state.key('ShiftLeft');
    state.key('ControlLeft'); state.key('Space', ' '); state.key('Digit3', '3');
    state.window.dispatchEvent(Object.assign(new Event('mousemove'), { movementX: 7 }));
    expect(state.input.command()).toEqual({ forwardMove: 50, sideMove: -40, angleTurn: 264, buttons: 23 });
    state.input.dispose();
  });

  it('keeps keyboard input available when Gamepad API is missing', () => {
    const state = surface(); Reflect.deleteProperty(state.navigator, 'getGamepads');
    state.key('KeyW', 'w'); expect(state.input.command().forwardMove).toBe(25);
    state.input.dispose();
  });

  it('keeps keyboard input available when host policy rejects gamepad access', () => {
    const state = surface();
    state.navigator.getGamepads = () => { throw new DOMException('Blocked by host policy', 'SecurityError'); };
    state.key('KeyW', 'w'); expect(state.input.command().forwardMove).toBe(25);
    state.input.dispose();
  });

  it('calls activity synchronously for active fresh keyboard/mouse presses and fresh gamepad buttons', () => {
    const onActivity = vi.fn(), controller = pad(), state = surface({ onActivity }, controller);
    state.key('Space', ' '); expect(onActivity).toHaveBeenCalledTimes(1);
    state.key('Space', ' ', true); expect(onActivity).toHaveBeenCalledTimes(1);
    state.owner.pointerLockElement = state.element;
    state.window.dispatchEvent(Object.assign(new Event('mousedown'), { button: 0 }));
    expect(onActivity).toHaveBeenCalledTimes(2);
    controller.press(1); state.input.command(); expect(onActivity).toHaveBeenCalledTimes(3);
    state.input.command(); expect(onActivity).toHaveBeenCalledTimes(3);
    state.input.dispose();
  });

  it('reports an unbound host gesture synchronously and ignores events outside the stage', () => {
    const onActivity = vi.fn(), state = surface({ onActivity });
    state.key('F13', 'F13');
    expect(onActivity).toHaveBeenCalledTimes(1);
    expect(state.input.actions()).toEqual([]);
    expect(state.input.command()).toEqual(idleCommand);
    state.owner.activeElement = null; state.key('F14', 'F14');
    expect(onActivity).toHaveBeenCalledTimes(1);
    state.input.dispose();
  });

  it('preserves short keyboard and mouse taps between simulation tics', () => {
    const state = surface();
    state.key('Space', ' '); state.release('Space');
    expect(state.input.command().buttons).toBe(TicButton.use);
    expect(state.input.command()).toEqual(idleCommand);
    state.window.dispatchEvent(Object.assign(new Event('mousedown'), { button: 0 }));
    state.window.dispatchEvent(Object.assign(new Event('mouseup'), { button: 0 }));
    expect(state.input.command().buttons).toBe(TicButton.attack);
    expect(state.input.command()).toEqual(idleCommand);
    state.input.dispose();
  });
});
