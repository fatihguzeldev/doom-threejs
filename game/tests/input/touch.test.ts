import { describe, expect, it } from 'vitest';
import { createTouchInput } from '../../src/input/touch';
import { TicButton } from '../../src/simulation/command';

describe('touch input commands', () => {
  it('preserves a fire/use tap for one command after the pointer is released', () => {
    const input = createTouchInput();
    input.press(1, 'fire'); input.release(1);
    input.press(2, 'use'); input.release(2);
    expect(input.command()).toEqual({ forwardMove: 0, sideMove: 0, angleTurn: 0, buttons: TicButton.attack | TicButton.use });
    expect(input.command()).toBeNull();
  });

  it('holds movement, turn and attack until release with normal and running speeds', () => {
    const input = createTouchInput();
    input.press(1, 'forward'); input.press(2, 'left'); input.press(3, 'strafeRight'); input.press(4, 'fire');
    const walking = { forwardMove: 25, sideMove: 24, angleTurn: 640, buttons: TicButton.attack };
    expect(input.command()).toEqual(walking); expect(input.command()).toEqual(walking);
    input.press(5, 'run');
    expect(input.command()).toEqual({ forwardMove: 50, sideMove: 40, angleTurn: 1280, buttons: TicButton.attack });
    for (let pointer = 1; pointer <= 5; pointer++) input.release(pointer);
    expect(input.command()).toBeNull();
  });

  it('keeps a control held when only one of its two pointers is released', () => {
    const input = createTouchInput();
    input.press(1, 'forward'); input.press(2, 'forward'); input.command();
    input.release(1); expect(input.command()?.forwardMove).toBe(25);
    input.release(2); expect(input.command()).toBeNull();
  });

  it('clears both held controls and unconsumed taps during a context change', () => {
    const input = createTouchInput();
    input.press(1, 'fire'); input.release(1); input.press(2, 'forward');
    input.clear(); expect(input.command()).toBeNull();
    input.release(2); expect(input.command()).toBeNull();
    input.press(3, 'use'); expect(input.command()?.buttons).toBe(TicButton.use);
  });

  it('supports backward, right turn and left strafe and cancels opposing directions', () => {
    const input = createTouchInput();
    input.press(1, 'back'); input.press(2, 'right'); input.press(3, 'strafeLeft');
    expect(input.command()).toEqual({ forwardMove: -25, sideMove: -24, angleTurn: -640, buttons: 0 });
    input.press(4, 'forward'); input.press(5, 'left'); input.press(6, 'strafeRight');
    expect(input.command()).toBeNull();
  });

  it('returns neutral for no input or a run modifier alone', () => {
    const input = createTouchInput();
    expect(input.command()).toBeNull(); input.release(99);
    input.press(1, 'run'); expect(input.command()).toBeNull();
  });
});
