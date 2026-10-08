import { describe, expect, it } from 'vitest';
import { createBrowserInput } from '../../src/input/browser';

function surface() {
  const window = Object.assign(new EventTarget(), { navigator: { getGamepads: () => [] } });
  const owner = Object.assign(new EventTarget(), { defaultView: window, pointerLockElement: null as object | null,
    activeElement: null as object | null });
  const element = Object.assign(new EventTarget(), { ownerDocument: owner,
    contains(node: object | null): boolean { return node === element; } });
  owner.activeElement = element;
  const input = createBrowserInput(element as unknown as HTMLElement);
  return { input, window, owner, element,
    key(code: string, key: string, repeat = false) {
      window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code, key, repeat }));
    },
    release(code: string) { window.dispatchEvent(Object.assign(new Event('keyup'), { code })); },
  };
}

describe('printable cheat input queue', () => {
  it('collects ASCII letters/digits in order exactly once per press and drains separately from commands', () => {
    const state = surface();
    state.key('KeyI', 'i'); state.key('KeyI', 'i', true); state.key('KeyD', 'D'); state.key('Digit9', '9');
    expect(state.input.characters()).toBe('id9'); expect(state.input.characters()).toBe('');
    state.release('KeyI'); state.key('KeyI', 'i'); expect(state.input.characters()).toBe('i');
    state.input.dispose();
  });

  it('ignores punctuation, modifiers and keys outside the game surface', () => {
    const state = surface();
    state.key('Space', ' '); state.key('ShiftLeft', 'Shift'); state.key('Period', '.');
    state.key('KeyI', 'ı'); expect(state.input.characters()).toBe('');
    state.owner.activeElement = null; state.key('KeyD', 'd'); expect(state.input.characters()).toBe('');
    state.input.dispose();
  });

  it('preserves pending mouse and number-weapon input when characters are drained', () => {
    const state = surface(); state.owner.pointerLockElement = state.element;
    state.key('Digit3', '3');
    state.window.dispatchEvent(Object.assign(new Event('mousemove'), { movementX: 7 }));
    expect(state.input.characters()).toBe('3');
    const command = state.input.command(); expect(command.angleTurn).toBe(-56); expect(command.buttons).toBe(20);
    expect(state.input.command().angleTurn).toBe(0); state.input.dispose();
  });

  it('clears characters on blur, explicit clear and disposal', () => {
    const state = surface(); state.key('KeyI', 'i'); state.window.dispatchEvent(new Event('blur'));
    expect(state.input.characters()).toBe(''); state.key('KeyD', 'd'); state.input.clear();
    expect(state.input.characters()).toBe(''); state.key('KeyQ', 'q'); state.input.dispose();
    expect(state.input.characters()).toBe(''); state.key('KeyD', 'd'); expect(state.input.characters()).toBe('');
  });

  it('keeps letter cheat sequences free of pause/fullscreen actions with Pause and F11 bindings', () => {
    const state = surface();
    state.key('KeyP', 'p'); state.key('KeyF', 'f');
    expect(state.input.actions()).toEqual([]); expect(state.input.characters()).toBe('pf');
    state.key('Pause', 'Pause'); state.key('F11', 'F11');
    expect(state.input.actions()).toEqual(['pause', 'fullscreen']);
    expect(state.input.characters()).toBe(''); state.input.dispose();
  });
});
