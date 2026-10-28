# AI Tool Usage

## Tools Used

- **Claude Code** (Anthropic, Claude Opus 5.5) in VS Code — used as a pair programmer for the implementation, tests, benchmarks and the first drafts of the documentation.
- Node's built-in CPU profiler (`--cpu-prof`) and small micro-benchmarks to verify performance claims instead of trusting them.

The workflow: requirements → design (two-phase check/consume, per-policy stores, lazy refill) → implementation in small modules → tests for every requirement → benchmark and memory measurement → fix what the numbers revealed → documentation from the final code.

## What Helped Most

1. **Scaffolding the breadth quickly.** Three algorithms behind one interface, an IPv6 parser / CIDR matcher, a trusted-proxy resolver, Express routes with hand-written request validation, Express middleware, a Prometheus exporter, Docker files — the boilerplate-heavy parts were produced fast, which left time for the parts that needed thought (hierarchy semantics, eviction, profiling).
2. **Test-first edge cases.** Asking for tests of tricky cases surfaced real bugs immediately: fixed-window boundary bursts, "retry exactly at `Retry-After` must succeed, 1 ms earlier must fail", IPv4-mapped IPv6, `X-Forwarded-For` spoofing, `/AUTH//login?x` route bypasses, keys that differ only in IPv6 notation.

## What I Had to Fix

Bugs that made it into a first version and were caught by tests, profiling or review:

1. **Blocked abusers could be evicted out of their block.** The first LRU only refreshed a key's recency on *successful* requests. A key being denied therefore aged toward the head of the LRU, and a flood of fresh IPs would evict it — handing the attacker a brand-new quota. Caught by a test written for exactly that scenario. Fix: denied requests also mark the key as used.
2. **The "obvious" LRU destroyed throughput.** Moving each key to the Map's tail on every request (`delete` + `set`) looked O(1) and was fine in micro-benchmarks, but the full benchmark ran at 114k evals/s with 78% of CPU in `Map.set` (~10 µs per re-insert of a freshly built key into a large map, only with mixed IPv4/IPv6 traffic). Replaced with a second-chance (CLOCK) scheme where an access is a single field write → **1.18M evals/s**. The first replacement then compared timestamps (`lastSeenAt > positionedAt`) to detect reuse, which silently fails when two events share a timestamp; switched to an explicit flag.
3. **Floating-point timestamps.** `retryAfterMs` came out as `999.9999999999998`; naïve `Math.ceil` turns noise like that into an extra second, and truncation retries too early. Fix: round to whole ms after discarding float noise, then always round seconds up. A second rounding bug: `RateLimit-Reset` (delta, derived from the rounded epoch) said 72 s while `Retry-After` said 71 s for the same response — fixed by carrying the delta from the same millisecond value.
4. **Hidden memory cost of string keys.** Measured retained heap per key: IPv6 keys used 237 B, nearly double the estimate. Concatenated keys are V8 *ConsStrings* (ropes) and the Map kept every piece alive. Flattening the key once on insert brought it down to ~120 B.
5. **Ordering invariant broken by design drift.** Each algorithm initially set its own expiry time; with different expiry formulas the store's "oldest first" order no longer matched expiry order, so the sweeper's early exit could skip expired entries. Expiry was moved into the store with one TTL per policy.
6. **Unbounded side structures.** The noisy-neighbour episode tracker was capped at 100k entries per tenant — with 1,000 auto-provisioned tenants that is ~15 GB worst case. Lowered to 10k.

## What AI Struggled With

- **Explaining performance, not just predicting it.** The AI's first model of `Map` reinsertion cost ("O(1), ~100 ns") was correct in isolation and wrong in context. It took bisecting the real workload (policy set × address family × key freshness) to locate the problem; the exact V8 mechanism was never fully pinned down — the fix was to remove the pattern rather than to explain it.
- **Security-flavoured semantics.** Generic rate-limiter code tends to: trust the left-most `X-Forwarded-For` entry, decode a JWT's `sub` without verification and key on it (letting anyone burn a victim's quota), count rejected requests against the client (lockout spirals), and use one global LRU across tenants (one tenant's key flood resets everyone). Each needed an explicit decision.
- **Choosing semantics where the spec is open** — e.g. which policy's numbers to put in the headers when several apply, what `NOISY_NEIGHBOR_THROTTLED` should mean vs. `TENANT_QUOTA_EXCEEDED`, or whether a policy update should reset buckets. The AI offers a plausible default; deciding (and documenting why) is the engineer's job.
