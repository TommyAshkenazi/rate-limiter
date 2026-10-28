import { ceilMs, EPSILON, type AlgorithmDecision, type BucketState, type RateLimitAlgorithm } from './types';

/*
 * ============================================================================
 *  Leaky bucket — the idea in short
 * ============================================================================
 *
 *  Picture: a bucket with a hole in the bottom. Water (requests) pours in from the top
 *  and drips out at a constant rate. If the bucket is full, the next request overflows
 *  and is rejected.
 *
 *    Each request   = adds "water" to the bucket.
 *    The bucket     = drains by itself at a constant rate.
 *    No room?       = rejected.
 *
 *  The form implemented here (called GCRA): instead of tracking "how much water there is",
 *  we keep a SINGLE number — *when the bucket will be empty* if no more traffic arrives.
 *  It is called the TAT (theoretical arrival time).
 *
 *      how full the bucket is now  =  TAT - now     (in milliseconds)
 *      if the TAT is already in the past  ->  the bucket is empty.
 *
 *  Each request pushes the TAT forward by "one interval" (the time one unit takes to drip out).
 *
 *  Running example: capacity 5, rate 5 per second.
 *    One interval = 1000 / 5 = 200 ms.
 *    The bucket is full when the TAT is 5 x 200 = 1000 ms ahead of "now".
 *
 *  An honest note: in this form (a meter, with no queue that delays requests) the behaviour
 *  is almost identical to a token bucket with the same capacity and rate. The difference is
 *  mostly in the representation: one number instead of two. A "real" leaky bucket is a queue:
 *  requests are not rejected but wait and are released at a constant rate — we did not implement that.
 * ============================================================================
 */

/**
 * The state of one key: a single number.
 */
export class LeakyBucketState implements BucketState {
  constructor(
    /** TAT: when (ms) the bucket will be empty if no more traffic arrives. */
    public tat: number,
    /** These two belong to the bucket store (memory management), not to the algorithm. */
    public lastSeenAt: number,
    public recentlySeen: boolean,
  ) {}
}

export class LeakyBucket implements RateLimitAlgorithm<LeakyBucketState> {
  readonly name = 'leaky-bucket' as const;
  /** "Window" reported in response headers: seconds for a full bucket to drain. */
  readonly windowSeconds: number;
  /** After this long without use the bucket is surely empty, so it can be deleted without losing information. */
  readonly idleTtlMs: number;
  readonly stateBytes = 48;
  /** Milliseconds for one unit to drip out. Example: 1000 / 5 = 200. */
  private readonly intervalMs: number;

  constructor(
    readonly capacity: number,
    ratePerSecond: number,
  ) {
    // Rate 5 per second -> one unit every 200 ms.
    this.intervalMs = 1000 / ratePerSecond;

    // Seconds for a full bucket to drain: 5 / 5 = 1 second. (At least 1.)
    this.windowSeconds = Math.max(1, Math.ceil(capacity / ratePerSecond));

    // Same thing in ms: 5 x 200 = 1000. A bucket untouched for a second is empty, like a new one.
    this.idleTtlMs = Math.ceil(capacity * this.intervalMs);
  }

  /**
   * New key: TAT = now, i.e. the bucket is empty (a burst of up to `capacity` requests is possible).
   */
  createState(nowMs: number): LeakyBucketState {
    return new LeakyBucketState(nowMs, nowMs, false);
  }

  /**
   * Check: "can this request pass?" — without updating the TAT yet.
   *
   * @param reserve how much of the capacity is kept for higher priorities (critical request: 0).
   */
  check(state: LeakyBucketState, nowMs: number, cost: number, reserve: number): AlgorithmDecision {
    // Step 1: where do we count from? If the TAT is already in the past the bucket is empty, so start from "now".
    const base = Math.max(state.tat, nowMs);

    // Step 2: how full the bucket is now (in milliseconds of "water").
    //   Example: TAT = 1000, now = 100 -> 900 -> the bucket is almost full (full = 1000).
    const levelMs = base - nowMs;

    // Step 3: how full it would be after the request: add one interval per unit of cost.
    const newLevelMs = levelMs + cost * this.intervalMs;

    // Step 4: the ceiling: capacity x interval (minus the reserved part). Example: 5 x 200 = 1000.
    const limitMs = (this.capacity - reserve) * this.intervalMs;

    // Step 5: does it fit? (With a tiny tolerance for floating-point error.)
    const allowed = newLevelMs <= limitMs + EPSILON;

    // How full the bucket is after the decision (for reporting only).
    const afterMs = allowed ? newLevelMs : levelMs;

    return {
      allowed,

      // How many more requests fit: the remaining room / interval, as a whole number (rounded down).
      remaining: Math.max(0, Math.floor((limitMs - afterMs) / this.intervalMs + EPSILON)),

      // If rejected: how much must drip out for the request to fit = the overflow = newLevel - limit.
      //   Example: 1200 - 1000 = 200 ms.
      // Rounded up, at least 1, and never more than the time for the bucket to drain completely.
      retryAfterMs: allowed ? 0 : Math.max(1, ceilMs(Math.min(newLevelMs - limitMs, this.idleTtlMs))),

      // Time until the bucket is completely empty = how full it is after the decision.
      resetInMs: ceilMs(afterMs),
    };
  }

  /**
   * Consume: push the TAT forward by "one interval" per unit of cost.
   * Called only after `check` allowed it, and only if all the request's other policies allowed too.
   *
   * Note the max: if the bucket was empty (TAT in the past) we start from "now", not from the past —
   * otherwise old idle time would be "saved up" and allow an oversized burst.
   */
  consume(state: LeakyBucketState, nowMs: number, cost: number): void {
    state.tat = Math.max(state.tat, nowMs) + cost * this.intervalMs;
  }
}

/*
 * ============================================================================
 *  Full example (capacity 5, rate 5 per second -> interval 200 ms, ceiling 1000 ms)
 *  Every number was actually run against this code.
 * ============================================================================
 *
 *  t = 1.0    New bucket: TAT=1000 (empty).
 *             Request 1: level 0 -> 200   <= 1000 -> passes.   TAT=1200
 *             Request 2: level 200 -> 400  -> passes.          TAT=1400
 *             Request 3: level 400 -> 600  -> passes.          TAT=1600
 *             Request 4: level 600 -> 800  -> passes.          TAT=1800
 *             Request 5: level 800 -> 1000 -> passes (exactly on the limit). TAT=2000
 *  t = 1.0    Request 6: level 1000 -> 1200 > 1000 -> rejected.
 *             "Retry in 200 ms" (1200 - 1000). The TAT does not move!
 *  t = 1.1    level = 2000 - 1100 = 900. Add 200 -> 1100 > 1000 -> rejected.
 *             "Retry in 100 ms".
 *  t = 1.2    level = 2000 - 1200 = 800. Add 200 -> 1000 <= 1000 -> passes. OK
 *
 *  Note: this is exactly the same behaviour as the token bucket example (capacity 5, rate 5):
 *  rejected at 1.1, passes at 1.2.
 *
 *  In the tests: tests/algorithms.test.ts, "LeakyBucket (GCRA)".
 * ============================================================================
 */
