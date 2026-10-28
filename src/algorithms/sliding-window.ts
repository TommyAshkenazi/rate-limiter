import { ceilMs, EPSILON, type AlgorithmDecision, type BucketState, type RateLimitAlgorithm } from './types';

/*
 * ============================================================================
 *  Sliding window counter — the idea in short
 * ============================================================================
 *
 *  "At most N requests in any X seconds" — without the fixed-window problem.
 *
 *  The problem with a fixed window (why we don't use it):
 *    Time is cut into round windows (0-10, 10-20, ...) and each is counted separately.
 *    With a limit of 5 per window, send 5 at 9.9 and 5 more at 10.1 -> 10 requests
 *    within 0.2 seconds, all "legal", because they fall in two different windows.
 *
 *  The solution here: keep only two counters —
 *    previous  = requests in the previous window
 *    current   = requests in the current window
 *  and ESTIMATE how many requests happened in "the last X seconds":
 *
 *      estimate = previous x (how much of the previous window is still "inside" the range) + current
 *
 *  As we move through the current window, the previous window slides out gradually.
 *    At the start of the current window:  count 100% of previous.
 *    In the middle:                        count 50% of previous.
 *    At the end:                           count 0% of previous.
 *
 *  This is an estimate, not an exact count: it assumes the previous window's requests
 *  were spread evenly. The price is a small error. The gain is two numbers per key
 *  instead of a list with the timestamp of every request.
 *
 *  There is no "refill rate" here — only a capacity and a window size. (Fits "100 per minute".)
 * ============================================================================
 */

/**
 * The state of one key: two counters and "which window are we in".
 */
export class SlidingWindowState implements BucketState {
  constructor(
    /** Number of the current window: time / window size, rounded down. With a 10 s window: seconds 0-9.99 = window 0, 10-19.99 = window 1, and so on. */
    public windowIndex: number,
    /** Requests accepted in the current window. */
    public current: number,
    /** Requests accepted in the previous window. */
    public previous: number,
    /** These two belong to the bucket store (memory management), not to the algorithm. */
    public lastSeenAt: number,
    public recentlySeen: boolean,
  ) {}
}

export class SlidingWindowCounter implements RateLimitAlgorithm<SlidingWindowState> {
  readonly name = 'sliding-window' as const;
  /** After this long without use the state can be deleted without losing information. */
  readonly idleTtlMs: number;
  readonly stateBytes = 72;
  /** Window size in milliseconds. */
  private readonly windowMs: number;

  constructor(
    readonly capacity: number,
    readonly windowSeconds: number,
  ) {
    this.windowMs = windowSeconds * 1000;

    // A request is "alive" for two windows: first in `current`, then in `previous` (while sliding out).
    // After two whole windows with no activity both counters are zero and the state equals a new one.
    this.idleTtlMs = 2 * this.windowMs;
  }

  /** New key: starts in the current window with both counters at zero. */
  createState(nowMs: number): SlidingWindowState {
    return new SlidingWindowState(Math.floor(nowMs / this.windowMs), 0, 0, nowMs, false);
  }

  /**
   * Window rollover: if we moved into a new window, shift the counters.
   *
   * Example (10 s window):
   *   We were in window 0 with current=5. Now it is second 12 -> window 1.
   *   Exactly one window passed -> previous = 5, current = 0.
   *
   * If two or more windows passed with no requests, the previous window is already empty -> previous = 0.
   */
  private rotate(state: SlidingWindowState, nowMs: number): void {
    const index = Math.floor(nowMs / this.windowMs);
    if (index === state.windowIndex) return; // still the same window, nothing to shift

    state.previous = index === state.windowIndex + 1 ? state.current : 0;
    state.current = 0;
    state.windowIndex = index;
  }

  /**
   * Check: "can this request pass?" — without counting it yet.
   *
   * @param reserve how much of the capacity is kept for higher priorities (critical request: 0).
   */
  check(state: SlidingWindowState, nowMs: number, cost: number, reserve: number): AlgorithmDecision {
    // Step 1: if we crossed into a new window, shift the counters.
    this.rotate(state, nowMs);

    // Step 2: time elapsed since the start of the current window. (A window starts at windowIndex x window size.)
    const w = this.windowMs;
    const elapsed = nowMs - state.windowIndex * w;

    // Step 3: the estimate — the heart of the algorithm.
    //   (1 - elapsed / w) = how much of the previous window is still "inside" the range.
    //   Example: 10 s window, 2 s elapsed -> (1 - 0.2) = 0.8 -> count 80% of previous.
    //   With previous=5 and current=0: estimate = 5 x 0.8 + 0 = 4.
    const estimate = state.previous * (1 - elapsed / w) + state.current;

    // Step 4: the effective ceiling (minus the part reserved for higher priorities).
    const limit = this.capacity - reserve;

    // Step 5: if we add this request, do we stay within the ceiling?
    //   EPSILON = tiny tolerance for floating-point error.
    const allowed = estimate + cost <= limit + EPSILON;

    // How much would be "used" after the request (reporting only — nothing is counted yet).
    const used = allowed ? estimate + cost : estimate;
    const currentAfter = allowed ? state.current + cost : state.current;

    // Step 6: if rejected, when can the client retry?
    let retryAfterMs = 0;
    if (!allowed) {
      retryAfterMs = Math.max(1, ceilMs(this.timeUntilFits(state, elapsed, cost, limit)));
    }

    // Step 7: how long until "everything resets" (all requests have slid out):
    //   requests in the current window -> they slide out only after the next window ends (2 windows minus what elapsed).
    //   only in the previous window    -> until the end of the current window.
    let resetInMs = 0;
    if (currentAfter > 0) resetInMs = 2 * w - elapsed;
    else if (state.previous > 0) resetInMs = w - elapsed;

    return {
      allowed,
      // Requests left, as a whole number (rounded down), never negative.
      remaining: Math.max(0, Math.floor(limit - used + EPSILON)),
      retryAfterMs,
      resetInMs,
    };
  }

  /**
   * "How long until the request fits?" — solve the equation:
   *     estimate(t) + cost <= limit
   * for the smallest t, assuming no further traffic arrives.
   *
   * There are three cases:
   */
  private timeUntilFits(state: SlidingWindowState, elapsed: number, cost: number, limit: number): number {
    const w = this.windowMs;

    // A. The request is larger than the ceiling itself — it can never fit. Return the time until
    //    everything resets (so the answer is a finite number, not "infinity").
    if (cost > limit) return 2 * w - elapsed; // never fits; point at full reset

    // B. Inside the current window: `current` will not go down, but the previous window
    //    slides out gradually. Wait until enough of it has slid out.
    //    Example (ceiling 5, 10 s window, previous=5, current=0, 0 s elapsed):
    //      room in current window = 5 - 0 - 1 = 4.
    //      The previous window may contribute at most 4 of 5 -> 80% -> 20% of it must slide out.
    //      That is second 2 of 10 -> wait 2 seconds.
    const roomInCurrent = limit - state.current - cost;
    if (roomInCurrent >= 0 && state.previous > 0) {
      const fraction = 1 - roomInCurrent / state.previous;
      return Math.max(0, fraction * w - elapsed);
    }

    // C. The current window itself is full — sliding out the previous one will not help.
    //    Wait for the next window, where today's `current` becomes `previous` and starts sliding out.
    //    Example (ceiling 5, current=5, 3 seconds elapsed):
    //      Until the next window: 7 seconds (10 - 3).
    //      In the next window those 5 become `previous` and may contribute at most 4 of 5,
    //      i.e. 20% of them must slide out -> another 0.2 x 10 = 2 seconds.
    //      Total 7 + 2 = 9 seconds. (See example 1 below.)
    const untilNext = w - elapsed;
    if (state.current === 0) return untilNext;
    const fractionNext = Math.max(0, 1 - (limit - cost) / state.current);
    return untilNext + fractionNext * w;
  }

  /**
   * Consume: count the request in the current window.
   * Called only after `check` allowed it, and only if all the request's other policies allowed too.
   */
  consume(state: SlidingWindowState, nowMs: number, cost: number): void {
    this.rotate(state, nowMs);
    state.current += cost;
  }
}

/*
 * ============================================================================
 *  Two full examples (capacity 5, 10-second window)
 *  Every number was actually run against this code.
 * ============================================================================
 *
 *  Example 1 — the current window fills up
 *  ---------------------------------------
 *  t = 2      Five requests pass. current=5. (0 left)
 *  t = 3      Sixth request: previous=0 -> estimate = 5. After the request 6 > 5 -> rejected.
 *             "Retry in 9 seconds" (7 until the next window + 2 for sliding, as in case C above).
 *  t = 12     Window 1, 2 seconds elapsed. previous=5, current=0.
 *             estimate = 5 x 0.8 = 4. After the request: 5 <= 5 -> passes. OK
 *
 *  Example 2 — why this is not a fixed window (the boundary between windows)
 *  -------------------------------------------------------------------------
 *  t = 9.9    Five requests pass (end of window 0). current=5.
 *  t = 10     New window! A fixed window would "reset" and allow 5 more.
 *             Here: previous=5, 0 seconds elapsed -> count 100% of previous -> estimate = 5 -> rejected.
 *             "Retry in 2 seconds" (case B above).
 *  t = 11.999 Still rejected (one millisecond short).
 *  t = 12     estimate = 5 x 0.8 = 4, after the request 5 <= 5 -> passes. OK
 *
 *  In the tests: tests/algorithms.test.ts, "eliminates the fixed-window boundary burst".
 * ============================================================================
 */
