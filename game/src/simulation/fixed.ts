// Copyright (C) 1993-1996 id Software, Inc.
// Native TypeScript port of m_fixed.c, distributed under GPL-2.0-only.
// See ../../LICENSE.
export const FRAC_BITS = 16;
export const FRAC_UNIT = 1 << FRAC_BITS;

export function fixedMul(a: number, b: number): number {
  // Split the product into 16-bit limbs: a JavaScript double cannot represent
  // every 64-bit integer, while each partial product here remains exact.
  const aLow = a & 0xffff;
  const bLow = b & 0xffff;
  const aHigh = a >> FRAC_BITS;
  const bHigh = b >> FRAC_BITS;
  return ((Math.imul(aHigh, bHigh) << FRAC_BITS) +
    Math.imul(aHigh, bLow) + Math.imul(aLow, bHigh) +
    ((aLow * bLow) >>> FRAC_BITS)) | 0;
}

export function fixedDiv(a: number, b: number): number {
  if (Math.floor(Math.abs(a) / 16384) >= Math.abs(b)) {
    return (a ^ b) < 0 ? -0x80000000 : 0x7fffffff;
  }
  return Math.trunc(a / b * FRAC_UNIT) | 0;
}
