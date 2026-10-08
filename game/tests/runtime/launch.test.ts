import { describe, expect, it } from 'vitest';
import { playerOptions } from '../../src/runtime/launch';

describe('standalone player options', () => {
  it('starts with a button keyboard, original render resolution and no browser fullscreen request', () => {
    expect(playerOptions('')).toEqual({
      input: { keyboardProfile: 'buttons' }, resolution: 320,
      screenMode: 'fullscreen', touchControls: true, allowQuit: false,
    });
  });

  it('disables touch UI on a button-only host and accepts explicit desktop controls', () => {
    expect(playerOptions('?handheld&screen=720x480').touchControls).toBe(false);
    expect(playerOptions('?controls=desktop&resolution=640').input?.keyboardProfile).toBe('desktop');
    expect(playerOptions('?controls=desktop&resolution=640').resolution).toBe(640);
  });

  it('rejects unsupported resolutions and keeps unknown options at usable defaults', () => {
    expect(playerOptions('?resolution=999999&controls=unknown').resolution).toBe(320);
    expect(playerOptions('?touch=off').touchControls).toBe(false);
    expect(playerOptions('?resolution=960').resolution).toBe(960);
  });
});
