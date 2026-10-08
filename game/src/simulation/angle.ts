// Copyright (C) 1993-1996 id Software, Inc. GPL-2.0-only.
// Native port of r_main.c and tables.c. See ../../LICENSE.
import { fineSine, tangentToAngle } from './data/math';

export const ANG45 = 0x20000000;
export const ANG90 = 0x40000000;
export const ANG180 = 0x80000000;
export const ANG270 = 0xc0000000;

export function fineSin(angle: number): number {
  return fineSine[(angle >>> 19) & 8191] as number;
}

export function fineCos(angle: number): number {
  return fineSine[((angle >>> 19) & 8191) + 2048] as number;
}

function slopeAngle(numerator: number, denominator: number): number {
  const slope = denominator < 512 ? 2048 :
    Math.min(2048, Math.floor(((numerator << 3) >>> 0) / (denominator >>> 8)));
  return tangentToAngle[slope] as number;
}

export function pointToAngle(x1: number, y1: number, x2: number, y2: number): number {
  let x = (x2 - x1) | 0;
  let y = (y2 - y1) | 0;
  if (x === 0 && y === 0) return 0;

  if (x >= 0) {
    if (y >= 0) {
      return (x > y ? slopeAngle(y, x) : ANG90 - 1 - slopeAngle(x, y)) >>> 0;
    }
    y = -y;
    return (x > y ? -slopeAngle(y, x) : ANG270 + slopeAngle(x, y)) >>> 0;
  }
  x = -x;
  if (y >= 0) {
    return (x > y ? ANG180 - 1 - slopeAngle(y, x) : ANG90 + slopeAngle(x, y)) >>> 0;
  }
  y = -y;
  return (x > y ? ANG180 + slopeAngle(y, x) : ANG270 - 1 - slopeAngle(x, y)) >>> 0;
}

export function angleToRadians(angle: number): number {
  return (angle >>> 0) / 0x100000000 * Math.PI * 2;
}
