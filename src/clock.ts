import { performance } from 'node:perf_hooks';

/**
 * Two clocks on purpose:
 * - `nowMs()` is monotonic and drives all bucket math. It never jumps backwards
 *   when NTP adjusts the wall clock, so refill/window calculations can't go negative
 *   or hand out a burst of free tokens.
 * - `wallMs()` is only used to turn "reset in N ms" into the epoch timestamps that
 *   clients see in X-RateLimit-Reset / resetAt.
 */
export interface Clock {
  nowMs(): number;
  wallMs(): number;
}

export const systemClock: Clock = {
  nowMs: () => performance.now(),
  wallMs: () => Date.now(),
};

/** Deterministic clock for tests and benchmarks. */
export class ManualClock implements Clock {
  private mono: number;
  private wall: number;

  constructor(startWallMs = 1_774_348_800_000) {
    this.mono = 1_000; // arbitrary non-zero monotonic origin
    this.wall = startWallMs;
  }

  nowMs(): number {
    return this.mono;
  }

  wallMs(): number {
    return this.wall;
  }

  advance(ms: number): void {
    this.mono += ms;
    this.wall += ms;
  }
}

/**
 * "N ms from now" as a Unix timestamp in seconds (rounded up), for resetAt.
 * The delay comes from monotonic math; only "now" comes from the wall clock.
 */
export function epochSecondsAfter(clock: Clock, inMs: number): number {
  return Math.ceil((clock.wallMs() + inMs) / 1000);
}
