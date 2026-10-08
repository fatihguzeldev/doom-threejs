import { describe, expect, it } from 'vitest';
import { ANG90, ANG180, ANG270, fineCos, fineSin, pointToAngle } from '../../src/simulation/angle';
import { createRandom, gameRandom, menuRandom } from '../../src/simulation/random';
import { fineSine, fineTangent, tangentToAngle, randomBytes } from '../../src/simulation/data/math';
import { FRAC_UNIT } from '../../src/simulation/fixed';

describe('original numeric lookup data', () => {
  it('preserves all table entries and Doom’s half-step sine sampling', () => {
    expect(fineSine.length).toBe(10240);
    expect(fineTangent.length).toBe(4096);
    expect(tangentToAngle.length).toBe(2049);
    expect(randomBytes.length).toBe(256);
    expect(fineSin(0)).toBe(25);
    expect(fineCos(0)).toBe(65535);
    expect(fineSin(ANG90)).toBe(65535);
    expect(fineSin(ANG180)).toBe(-25);
  });

  it.each([
    [1, 0, 0], [0, 1, ANG90 - 1], [-1, 0, ANG180 - 1], [0, -1, ANG270],
    [1, 1, 0x20000000 - 1], [-1, 1, 0x60000000],
    [-1, -1, 0xa0000000 - 1], [1, -1, 0xe0000000],
  ])('retains octant boundary behavior for (%i,%i)', (x, y, expected) => {
    expect(pointToAngle(0, 0, x * FRAC_UNIT, y * FRAC_UNIT)).toBe(expected);
  });

  it('returns zero for coincident points and wraps angles into unsigned BAM values', () => {
    expect(pointToAngle(20, 30, 20, 30)).toBe(0);
    const angle = pointToAngle(0, 0, 3 * FRAC_UNIT, -FRAC_UNIT);
    expect(angle).toBeGreaterThan(ANG270);
    expect(angle).toBeLessThan(0x100000000);
  });
});

describe('original independent random streams', () => {
  it('starts at the second table entry and keeps menu calls out of gameplay', () => {
    const random = createRandom();
    expect(gameRandom(random)).toBe(8);
    expect(menuRandom(random)).toBe(8);
    expect(menuRandom(random)).toBe(109);
    expect(gameRandom(random)).toBe(109);
    expect(random).toEqual({ gameIndex: 2, menuIndex: 2 });
  });

  it('wraps after 256 values and resumes from saved indices', () => {
    const random = createRandom();
    for (let index = 0; index < 255; index++) gameRandom(random);
    expect(gameRandom(random)).toBe(0);
    expect(random.gameIndex).toBe(0);
    const restored = { gameIndex: 2, menuIndex: 1 };
    expect(gameRandom(restored)).toBe(220);
    expect(menuRandom(restored)).toBe(109);
  });
});
