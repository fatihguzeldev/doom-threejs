export const TIC_RATE = 35;
const TIC_MS = 1000 / TIC_RATE;
const ROUNDING_EPSILON_MS = 1e-7;

export interface TicClock {
  previousTime: number;
  accumulatedMs: number;
}

export interface FrameTics {
  readonly ticks: number;
  readonly interpolation: number;
}

export function createClock(now: number): TicClock {
  if (!Number.isFinite(now)) throw new Error('Clock time must be finite');
  return { previousTime: now, accumulatedMs: 0 };
}

export function advanceClock(clock: TicClock, now: number, limit = 8): FrameTics {
  if (!Number.isFinite(now)) throw new Error('Clock time must be finite');
  if (now < clock.previousTime) throw new Error('Clock time must be monotonic');
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Tic limit must be a positive integer');
  }

  clock.accumulatedMs += now - clock.previousTime;
  clock.previousTime = now;
  // A display frame can land a fraction below an exact tic after rounding.
  const available = Math.floor((clock.accumulatedMs + ROUNDING_EPSILON_MS) / TIC_MS);
  const ticks = Math.min(available, limit);
  clock.accumulatedMs = Math.max(0, clock.accumulatedMs - ticks * TIC_MS);
  return { ticks, interpolation: Math.min(1, clock.accumulatedMs / TIC_MS) };
}
