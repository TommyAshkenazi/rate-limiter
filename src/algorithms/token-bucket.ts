import { ceilMs, EPSILON, type AlgorithmDecision, type BucketState, type RateLimitAlgorithm } from './types';

/*
 * ============================================================================
 *  Token bucket — the idea in short
 * ============================================================================
 *
 *  Every key (user / IP) has a bucket of tokens.
 *  - Each request takes a token (or more, depending on its cost).
 *  - Not enough tokens: the request is rejected.
 *  - The bucket refills at a constant rate, but never beyond its capacity.
 *
 *  Two parameters:
 *  - capacity          = how many requests can be sent "at once" (the burst).
 *  - ratePerSecond     = how many requests per second are allowed over time.
 *
 *  Running example for this whole file: capacity 10, rate 2 per second.
 *  - A new user can send 10 requests immediately (the bucket starts full).
 *  - After that, only 2 per second, because that is the refill rate.
 *  - After 5 idle seconds the bucket is full again (5 x 2 = 10).
 *
 *  The key trick: there is NO timer adding tokens ("lazy refill").
 *  We only store "how many tokens there were" and "when we last looked".
 *  When a request arrives we compute how much time passed and how many tokens
 *  should have been added meanwhile. A million buckets cost no timers, and
 *  there is no timer drift.
 * ============================================================================
 */

/**
 * The state of ONE bucket (one key). This is all that is kept in memory per user / IP.
 */
export class TokenBucketState implements BucketState {
  constructor(
    /** Tokens currently in the bucket. May be fractional (e.g. 3.4) because refill is continuous. */
    public tokens: number,
    /** When (ms, monotonic clock) the refill was last computed. */
    public lastRefillMs: number,
    /** These two belong to the bucket store (memory management), not to the algorithm. Ignore them here. */
    public lastSeenAt: number,
    public recentlySeen: boolean,
  ) {}
}

export class TokenBucket implements RateLimitAlgorithm<TokenBucketState> {
  readonly name = 'token-bucket' as const;
  /** "Window" reported in response headers: seconds needed to fill an empty bucket. */
  readonly windowSeconds: number;
  /** After this long without use the bucket is surely full, so it can be deleted from memory losslessly. */
  readonly idleTtlMs: number;
  /** Estimated size of one state in memory, in bytes (for metrics). */
  readonly stateBytes = 64;
  /** Rate in tokens per millisecond. Example: 2 per second = 0.002 per ms. */
  private readonly ratePerMs: number;

  constructor(
    readonly capacity: number,
    ratePerSecond: number,
  ) {
    // Everything is computed in milliseconds because the clock returns milliseconds.
    // 2 per second -> 0.002 per ms.
    this.ratePerMs = ratePerSecond / 1000;

    // Seconds to fill an empty bucket: 10 / 2 = 5 seconds. (At least 1, so the header makes sense.)
    this.windowSeconds = Math.max(1, Math.ceil(capacity / ratePerSecond));

    // Same thing in ms: 10 / 0.002 = 5,000.
    // A bucket untouched for 5 seconds is surely full, i.e. identical to a new one, so it may be deleted.
    this.idleTtlMs = Math.ceil(capacity / this.ratePerMs);
  }

  /**
   * A bucket for a key we have never seen: starts FULL,
   * so a new user can immediately send a burst of up to `capacity` requests.
   */
  createState(nowMs: number): TokenBucketState {
    return new TokenBucketState(this.capacity, nowMs, nowMs, false);
  }

  /**
   * Lazy refill: add the tokens that should have accumulated since the last check.
   *
   * Example: there were 3 tokens and 1,500 ms passed.
   *   Added: 1,500 x 0.002 = 3 tokens -> now 6.
   * If there were 9 and 5 seconds passed: 9 + 10 = 19, but the cap is 10 -> now 10.
   */
  private refill(state: TokenBucketState, nowMs: number): void {
    // Time since the previous computation.
    const elapsed = nowMs - state.lastRefillMs;

    // No time passed (or the clock somehow went backwards): nothing to add.
    if (elapsed > 0) {
      // Add by elapsed time, but never beyond capacity.
      state.tokens = Math.min(this.capacity, state.tokens + elapsed * this.ratePerMs);

      // Remember that we computed up to now. The next call counts only from this point.
      // Each computation starts from an absolute timestamp, so rounding errors never accumulate.
      state.lastRefillMs = nowMs;
    }
  }

  /**
   * Check: "can this request pass?" — WITHOUT removing tokens.
   *
   * Why not remove them here? A request usually has several policies (user, IP, tenant).
   * The engine checks all of them first and consumes from all only if all allowed
   * (see src/engine/evaluation).
   *
   * @param cost    how many tokens the request costs (usually 1).
   * @param reserve how many tokens must remain in the bucket afterwards, kept for higher priorities.
   *                0 for a critical request. For a background request in a pool of 100 it is 10
   *                (i.e. it may only use up to 90%).
   */
  check(state: TokenBucketState, nowMs: number, cost: number, reserve: number): AlgorithmDecision {
    // Step 1: bring the bucket up to date (add whatever accumulated).
    this.refill(state, nowMs);

    // Step 2: how many tokens must be in the bucket to allow this?
    //   The request's cost plus whatever must stay reserved.
    //   Example: a normal request (cost 1, reserve 0) needs at least 1 token.
    const needed = cost + reserve;

    // Step 3: is there enough?
    //   EPSILON = tiny tolerance for floating-point error.
    //   Without it a bucket holding 0.9999999999 (really 1) would wrongly reject a valid request.
    const allowed = state.tokens + EPSILON >= needed;

    // Step 4: how many tokens would remain after the request (for reporting only; nothing is removed yet).
    const after = allowed ? state.tokens - cost : state.tokens;

    // Step 5: if rejected, how long until there are enough tokens?
    let retryAfterMs = 0;
    if (!allowed) {
      // Missing = needed - available. Time = missing / rate.
      // Example: have 0.4, need 1 -> missing 0.6 -> 0.6 / 0.002 = 300 ms.
      //
      // Edge case: a request that can never fit (needs more than capacity). Instead of
      // "infinity" we report the time until the bucket is full, so the header is always finite.
      const target = Math.min(needed, this.capacity);

      // ceilMs = round UP to whole ms after removing floating-point noise.
      // Rounding up means the client never retries too early and gets rejected again.
      // At least 1 ms, so we never say "wait 0".
      retryAfterMs = Math.max(1, ceilMs((target - state.tokens) / this.ratePerMs));
    }

    return {
      allowed,

      // Requests this client has left — for the "remaining" header.
      // A whole number (3.7 tokens = 3 requests), never negative,
      // and excluding the reserved part (a background request does not "see" tokens kept for critical ones).
      remaining: Math.max(0, Math.floor(after - reserve + EPSILON)),

      retryAfterMs,

      // Time until the bucket is completely full — for the "reset" header.
      // Example: 4 of 10 left after the request -> missing 6 -> 6 / 0.002 = 3,000 ms.
      resetInMs: Math.max(0, ceilMs((this.capacity - after) / this.ratePerMs)),
    };
  }

  /**
   * Consume: actually remove the tokens.
   * Called only after `check` allowed it, and only if all the request's other policies allowed too.
   * Check and consume run inside one synchronous engine call, so no other request
   * can slip in between and take the token before us.
   */
  consume(state: TokenBucketState, nowMs: number, cost: number): void {
    // Update to the current moment again. (If `check` already did so at this same instant, nothing
    // happens, because no time has passed.)
    this.refill(state, nowMs);
    state.tokens -= cost;
  }
}

/*
 * ============================================================================
 *  Full walkthrough (capacity 10, rate 2 per second)
 * ============================================================================
 *
 *  t = 0      New user. A full bucket is created: 10 tokens.
 *  t = 0      Sends 10 requests in a row -> all pass. 0 left.
 *  t = 0      Request 11 -> has 0, needs 1 -> rejected. "Retry in 500 ms"
 *             (missing 1 / 0.002 = 500).
 *  t = 0.3    Tries again. Refill: 300 x 0.002 = 0.6 -> has 0.6 -> still rejected,
 *             "retry in 200 ms". (The rejected request removed nothing!)
 *  t = 0.5    Refill: another 0.4 -> has 1.0 -> passes. 0 left.
 *  t = 10     Sent nothing for 9.5 seconds. Refill: 19 -> capped at 10 -> has 10.
 *             Can send a burst of 10 again.
 *
 *  See it in the tests: tests/algorithms.test.ts (token bucket section)
 *  and tests/enforcement.test.ts (the refill section).
 * ============================================================================
 */
