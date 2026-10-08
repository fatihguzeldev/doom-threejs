import { describe, expect, it } from 'vitest';
import { advanceClock, createClock } from '../../src/simulation/clock';

describe('35 Hz simulation clock', () => {
  it('accumulates display frames without changing the simulation rate', () => {
    const clock = createClock(0);
    let ticks = 0;
    for (let frame = 1; frame <= 240; frame++) {
      ticks += advanceClock(clock, frame * 1000 / 240).ticks;
    }
    expect(ticks).toBe(35);
    expect(clock.accumulatedMs).toBeCloseTo(0);
  });

  it('retains unfinished tics for smooth rendering interpolation', () => {
    const clock = createClock(0);
    const frame = advanceClock(clock, 1000 / 35 * 1.5);
    expect(frame.ticks).toBe(1);
    expect(frame.interpolation).toBeCloseTo(0.5);
  });

  it('retains a stalled frame backlog while bounding work per frame', () => {
    const clock = createClock(0);
    const first = advanceClock(clock, 1000, 8);
    expect(first).toEqual({ ticks: 8, interpolation: 1 });
    let ticks = first.ticks;
    while (clock.accumulatedMs >= 1000 / 35) {
      ticks += advanceClock(clock, 1000, 8).ticks;
    }
    expect(ticks).toBe(35);
    expect(clock.accumulatedMs).toBeCloseTo(0);
  });

  it('rejects invalid times without corrupting accumulated state', () => {
    const clock = createClock(20);
    expect(() => advanceClock(clock, 19)).toThrow(/monotonic/i);
    expect(() => advanceClock(clock, Number.NaN)).toThrow(/finite/i);
    expect(clock).toEqual({ previousTime: 20, accumulatedMs: 0 });
  });

  it('requires a positive integer catch-up limit', () => {
    const clock = createClock(0);
    expect(() => advanceClock(clock, 100, 0)).toThrow(/limit/i);
    expect(() => advanceClock(clock, 100, 2.5)).toThrow(/limit/i);
    expect(clock.previousTime).toBe(0);
  });
});
