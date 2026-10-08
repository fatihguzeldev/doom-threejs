import { describe, expect, it } from 'vitest';
import { FRAC_UNIT, fixedDiv, fixedMul } from '../../src/simulation/fixed';

describe('signed 16.16 arithmetic', () => {
  it('multiplies fractions and rounds negative products toward negative infinity', () => {
    expect(fixedMul(FRAC_UNIT / 2, FRAC_UNIT / 2)).toBe(FRAC_UNIT / 4);
    expect(fixedMul(-1, 1)).toBe(-1);
  });

  it('matches a signed 64-bit product across wrapped 32-bit results', () => {
    const samples = [0, 1, -1, 65535, 65536, -65536, 0x7fffffff, -0x80000000];
    let seed = 729;
    for (let index = 0; index < 1000; index++) {
      seed = Math.imul(seed, 1664525) + 1013904223 | 0;
      samples.push(seed);
    }
    for (let index = 0; index < samples.length; index++) {
      const a = samples[index] ?? 0;
      const b = samples[(index * 3 + 1) % samples.length] ?? 0;
      const expected = Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 16n));
      expect(fixedMul(a, b)).toBe(expected);
    }
  });

  it('truncates division toward zero and saturates overflow with the correct sign', () => {
    expect(fixedDiv(3 * FRAC_UNIT, 2 * FRAC_UNIT)).toBe(1.5 * FRAC_UNIT);
    expect(fixedDiv(-1, 3)).toBe(-21845);
    expect(fixedDiv(1, 0)).toBe(0x7fffffff);
    expect(fixedDiv(-1, 0)).toBe(-0x80000000);
    expect(fixedDiv(0x7fffffff, -1)).toBe(-0x80000000);
  });
});
