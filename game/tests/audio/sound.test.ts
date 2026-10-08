import { describe, expect, it } from 'vitest';
import { soundDefinitions, soundParameters, selectSoundChannel, soundPitch, soundStereo } from '../../src/audio/sound';
import { SfxId } from '../../src/simulation/data/actors';
import { FRAC_UNIT as FRACUNIT } from '../../src/simulation/fixed';

const listener = { actor: 0, x: 0, y: 0, angle: 0 };
const position = (x: number, y = 0) => ({ x: x * FRACUNIT, y: y * FRACUNIT });

describe('native Doom sound rules', () => {
  it('keeps original stable SFX priorities and the chaingun pistol link', () => {
    expect(soundDefinitions).toHaveLength(SfxId.NUMSFX);
    expect(soundDefinitions[SfxId.sfx_stnmov]).toMatchObject({ priority: 119, name: 'stnmov' });
    expect(soundDefinitions[SfxId.sfx_telept]?.priority).toBe(32);
    expect(soundDefinitions[SfxId.sfx_chgun]).toMatchObject({ name: 'pistol', pitch: 150, priority: 64 });
  });

  it('centers global, player and coincident sounds and clips distant sources', () => {
    expect(soundParameters(listener, null, 1)).toEqual({ volume: 127, separation: 128 });
    expect(soundParameters(listener, position(0), 1)).toEqual({ volume: 127, separation: 128 });
    expect(soundParameters(listener, position(1201), 1)).toBeNull();
    expect(soundParameters(listener, position(1200), 1)).toBeNull();
  });

  it('uses integer Doom attenuation and approximate diagonal distance', () => {
    expect(soundParameters(listener, position(160), 1)?.volume).toBe(127);
    expect(soundParameters(listener, position(680), 1)?.volume).toBe(63);
    expect(soundParameters(listener, position(400, 400), 1)?.volume).toBe(73);
    expect(soundParameters(listener, position(2000), 8)?.volume).toBe(15);
  });

  it('pans north to the left and south to the right relative to view angle', () => {
    expect(soundParameters(listener, position(0, 100), 1)?.separation).toBe(33);
    expect(soundParameters(listener, position(0, -100), 1)?.separation).toBe(224);
    expect(soundParameters({ ...listener, angle: 0x40000000 }, position(100), 1)?.separation).toBe(224);
  });

  it('uses the native integer quadratic stereo mixer curve', () => {
    expect(soundStereo({ volume: 127, separation: 128 })).toEqual([95 / 127, 96 / 127]);
    expect(soundStereo({ volume: 127, separation: 33 })).toEqual([125 / 127, 31 / 127]);
    expect(soundStereo({ volume: 63, separation: 224 })).toEqual([15 / 127, 63 / 127]);
  });

  it('selects the first empty channel and preempts the first lower-priority sound', () => {
    const channels = [null, { priority: 32 }, null];
    expect(selectSoundChannel(channels, 64)).toBe(0);
    expect(selectSoundChannel([{ priority: 32 }, { priority: 118 }, { priority: 100 }], 64)).toBe(1);
    expect(selectSoundChannel([{ priority: 32 }, { priority: 32 }], 64)).toBe(-1);
    expect(selectSoundChannel([{ priority: 64 }], 64)).toBe(0);
  });

  it('uses the original separate menu RNG pitch exceptions and ranges', () => {
    let calls = 0; const random = () => { calls++; return 31; };
    expect(soundPitch(SfxId.sfx_itemup, random)).toBe(128);
    expect(soundPitch(SfxId.sfx_tink, random)).toBe(128);
    expect(calls).toBe(0);
    expect(soundPitch(SfxId.sfx_sawup, random)).toBe(121);
    expect(soundPitch(SfxId.sfx_pistol, random)).toBe(113);
    expect(soundPitch(SfxId.sfx_chgun, random)).toBe(135);
    expect(calls).toBe(3);
  });
});
