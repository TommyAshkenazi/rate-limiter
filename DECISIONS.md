# Design Decisions

## 0. Request pipeline at a glance

```
RequestContext
  │
  ├─ Tenant resolver ──── known tenant? else default template (capped) / 404
  │
  ├─ normalise once ───── method upper-case, route canonicalised (§3)
  │
  ├─ for each policy whose match{} fits:
  │     key  = buildKey(dimensions)          e.g. "ip=2001:db8:85a3::/64|route=POST /auth/login"
  │     state = store.get(key) ?? createState()   (NOT inserted yet)
  │     decision = algorithm.check(state, now, cost, priorityReserve)     ← no mutation of quota
  │
  ├─ all allowed?  ── yes ─► algorithm.consume() + store.insert/touch on EVERY policy → 200
  │                └─ no ──► consume NOTHING; classify reason; record isolation  → 429
  │
  └─ headers from the most restrictive policy (lowest remaining / longest wait)
```

Everything from "for each policy" to the response object is one synchronous function call (§5).

---

## 1. Algorithm Selection & Trade-offs

**Algorithms implemented:** Token Bucket, Sliding Window Counter, Leaky Bucket (as a meter, in GCRA form). All three implement one interface:

```ts
interface RateLimitAlgorithm<S> {
  createState(now): S;
  check(state, now, cost, reserve): { allowed, remaining, retryAfterMs, resetInMs }; // decides, never consumes
  consume(state, now, cost): void;                                                  // applies
  idleTtlMs: number;   // after this long unused, state == fresh state
}
```

The `check` / `consume` split is the important design choice: it is what makes the hierarchical evaluation in §2 possible without rollback logic.

**Why chosen:**

| | Token Bucket | Sliding Window Counter | Leaky Bucket (GCRA) |
|---|---|---|---|
| State per key | 2 numbers | 3 numbers | 1 number (TAT) |
| Bursts | up to `capacity`, then sustained `rate` | none beyond `capacity` per rolling window | none; constant outflow |
| Boundary spike | n/a | eliminated (weighted previous window) | n/a |
| Used for (in `config/policies.json`) | tenant pools, per-user quotas | per-IP, login brute-force, payments | strict pacing of `POST /checkout` |

- **Token bucket** is the right model for "X/sec sustained with some burst" — e.g. a tenant's 5,000 req/s pool or a user who loads a dashboard (20 requests at once) then idles. Refill is computed lazily from elapsed time (`tokens = min(cap, tokens + Δt·rate)`), so there are no timers.
- **Sliding window counter** gives "N per minute" semantics that users understand, without the fixed-window flaw where `N` requests at 0:59 plus `N` at 1:00 = `2N` in two seconds. `estimate = prev·(1 − elapsed/window) + current`. It assumes the previous window's requests were evenly spread — a small, bounded approximation error, in exchange for O(1) memory.
- **Leaky bucket / GCRA** stores a single *theoretical arrival time*. It's the strictest pacing (no burst beyond the bucket depth) and the cheapest state (~109 B/key all-in).
- **Not implemented — sliding window *log*:** exact, but O(limit) memory per key. A 1,000/min limit is up to 1,000 timestamps × 8 B = 8 KB per key; at 1M keys that's 8 GB. Not acceptable for per-IP limits.

**Numerical details** (the subtle parts):
- Refill is always computed from absolute timestamps (`now − lastRefill`), never accumulated per tick, so rounding error cannot drift over time. A test does 1,000 × 1 ms steps and checks it equals one 1,000 ms step.
- Comparisons use an `EPSILON` of 1e-9 so `0.1 + 0.2`-style float noise can't deny a request that has exactly enough tokens.
- `retryAfterMs` is rounded **up** to whole ms after discarding float noise (`999.9999999999998 → 1000`, not `1001`). `Retry-After` / `RateLimit-Reset` are then rounded up to whole seconds — a client that obeys them never retries early. Tests assert "retrying exactly at Retry-After succeeds, 1 ms earlier fails".
- All algorithm math is in **milliseconds**; conversion to seconds happens only when building the result. The engine returns both `resetAt` (epoch) and the delta from the *same* millisecond value, to avoid the double-rounding bug where `RateLimit-Reset` said 72 while `Retry-After` said 71.

---

## 2. Noisy Neighbor & Multi-Tenant Fairness Strategy

**Hierarchy model:** every tenant has a list of policies with a scope:

- `tenant` scope — one shared pool (e.g. 5,000 req/s for all of `org-acme-prod`).
- `client` scope — one bucket per key inside the tenant (per user, per IP, per user+route…).

All policies that match a request are evaluated with **two-phase check-then-consume**:

1. *Check* every applicable policy (client and tenant) without consuming anything.
2. If **all** allow → consume from all. If **any** denies → consume from **none**.

Consequences, each covered by a test:
- An abusive user exhausts their own sub-quota and gets `CLIENT_KEY_EXCEEDED`; their 190 rejected requests cost the tenant pool **nothing**, so users B and C are unaffected (`tests/noisy-neighbor.test.ts`).
- Conversely, a request rejected because the *tenant* pool is empty doesn't charge the user's personal bucket either — the user isn't punished for their neighbours.
- No rollback code, no partial state, no window where one layer is decremented and the other isn't.

**Fairness guarantee:**
- *No lockout spiral:* denied requests consume nothing, so a client that keeps retrying while blocked doesn't extend its own block — it recovers at exactly the configured rate. (Contrast: counting rejected requests in a sliding window can lock an aggressive retrier out forever.)
- *No starvation of important traffic:* tenant pools reserve headroom per priority via `priorityWeights` (default `background 0.9, standard 0.95, critical 1.0`). Background jobs can't push the pool past 90%; standard traffic can't take the last 5%. A test floods 5,000 background requests and then verifies 50 critical requests all pass. A request shed this way gets `NOISY_NEIGHBOR_THROTTLED` (the pool had room, but not for this priority), which is different from `TENANT_QUOTA_EXCEEDED` (the pool is empty).
- *Cross-tenant isolation:* every policy has its own store with its own key cap, so a key flood against tenant A evicts only tenant A's buckets — never tenant B's (a shared global LRU would let one tenant's attack reset everyone's limits).
- *Isolation metric:* `noisyNeighborsIsolated` counts **episodes** (a key going from served to contained), not 429s — an abuser sending 10,000 blocked requests counts once.

**Known limitation:** per-client quotas can sum to more than the tenant pool. If *many* moderate users saturate the pool together, the pool is first-come-first-served (with priority reserves). A max-min fair share (dynamic per-key limit = pool / active keys) would be the next step; see §6.

---

## 3. Networking & Key Extraction Realities

**IPv6 handling:** an ISP gives each subscriber at least a `/64` (often `/56` or `/48`), and SLAAC privacy extensions (RFC 4941) rotate the lower 64 bits routinely. So one attacker legitimately owns 2^64 addresses — a per-address limit is useless. Every IPv6 address is parsed (including `::` compression, embedded IPv4, zone ids `%eth0`, brackets `[..]:port`), masked to the policy's prefix (default `/64`) with bitwise math on the eight 16-bit groups, and re-serialised in RFC 5952 canonical form (`2001:db8:85a3::/64`). So `2001:0db8:85a3:0000:…`, `2001:DB8:85a3::dead:beef` and every other spelling inside the same `/64` land in one bucket. The prefix is configurable per policy (`/56` for stricter grouping of residential prefixes, `/128` to disable).

IPv4-mapped IPv6 (`::ffff:203.0.113.5`, what a dual-stack socket reports) is unwrapped to plain IPv4 first; otherwise the same client gets two buckets depending on which socket accepted it.

Unparseable addresses map to one shared `invalid` bucket (in the HTTP API they're rejected with 400). Garbage input must never become a way to get a fresh bucket.

**Proxy & NAT strategy:**

- *Real client IP:* `X-Forwarded-For` is a list each proxy **appends** to, so only the right-hand entries were written by our infrastructure; anything on the left may come from the client. `ClientIpResolver`:
  1. If the TCP peer (an L4 fact, unspoofable after the handshake) is **not** a configured trusted proxy, all forwarding headers are ignored.
  2. Otherwise walk XFF from right to left, skipping trusted proxies; the first untrusted hop is the client. A client sending `X-Forwarded-For: 1.2.3.4` only adds an entry on the left that we never reach.
  3. A malformed hop in the trusted part stops the walk (don't trust anything beyond something we can't verify).
  4. A single-value header from a CDN (`CF-Connecting-IP`, `True-Client-IP`) is honoured only when the peer is in the trusted CIDRs (e.g. Cloudflare's published ranges).
  - ALB / NGINX: configure their subnets as `trustedProxies`; they append to XFF and the right-to-left walk handles any number of layers.
- *Service mode:* in `POST /v1/rate-limit/check` the caller (an API gateway) has already resolved `clientIp`. The service trusts its callers; it should only be reachable on the internal network (or behind mTLS).
- *CGNAT / corporate NAT:* an IPv4 address is a weak identity — 10,000 employees can share one. The design never relies on IP alone for authenticated traffic:
  - per-IP limits are **generous** coarse flood protection (`per-ip`: 3,000/min);
  - the meaningful limit for logged-in traffic is per **user / token / API key** (`per-user`: 50/s), so one noisy employee doesn't block the office;
  - anonymous sensitive endpoints (login) use a strict IP+route limit, which can hurt a large NAT. The mitigation is an additional policy keyed on the login identifier (e.g. a `header` dimension carrying the username), letting IP limits be looser. `ipv4SubnetMask` (e.g. `/24`) lets you go the other way and group a known corporate range.
- *Route keys:* paths are canonicalised before matching and keying — lower-cased, `%`-decoded, dot-segments resolved, duplicate/trailing slashes and query strings removed. Without this, a limit on `/auth/login` is bypassed by `/AUTH/login`, `/auth//login`, `/auth/./login` or `/auth/%6Cogin`. We prefer to merge paths (stricter) over splitting them. Routes with parameters are keyed by their **pattern** (`/users/:id`), not the raw path, so ids in URLs don't create a bucket per id.
- *Identity:* `userId` comes from the caller if authenticated; otherwise from a hashed Bearer token / `X-Api-Key`. Deliberately **not** from an unverified JWT `sub`: anyone can mint a token claiming a victim's `sub` and burn the victim's quota. Header values longer than 128 chars are hashed so a huge header can't inflate key memory.

---

## 4. In-Memory Storage & Memory Management

**Data structures used:**
- One `Map<string, State>` per policy (`BucketStore`). State objects are small classes with a fixed shape (V8 keeps them monomorphic, no dictionary mode), and the store's bookkeeping lives *in* the state object (`lastSeenAt`, `recentlySeen`), so there is no wrapper object per entry.
- The Map's insertion order doubles as the LRU list — no separate linked list.

**Memory footprint (measured with `npm run bench:memory`, 1M keys, Node 24 / V8, 64-bit):**

| Algorithm | IPv4 keys | IPv6 `/64` keys | Engine estimate |
|---|---|---|---|
| Token bucket | 118 B | 126 B | 142–151 B |
| Sliding window | 127 B | 134 B | 150–159 B |
| Leaky bucket | 109 B | 118 B | 126–135 B |

Breakdown ≈ key string (24 B header + length) + Map slot (~3 pointers + bucket share) + state object (header + 3–5 fields). The estimate used for `currentMemoryEstimatedBytes` is deliberately ~15% conservative.

Sizing: `Σ maxTrackedKeys × ~130 B`. The default 1M keys per policy ≈ 130 MB per IP-keyed policy. `docker-compose.yml` caps V8 old space at 1 GB (`--max-old-space-size`), so the key caps — not the OOM killer — are what bound memory. Note that V8 Maps have a hard limit of 2^24 (~16.7M) entries; per-policy caps must stay below it.

One V8-specific fix: keys are built by concatenation, which V8 stores as a *ConsString* (a rope). Kept as a Map key, the rope and its pieces stay alive — IPv6 keys measured 237 B/key. Forcing a flatten on insert (`key | 0`) lets the GC drop the rope: ~118 B/key in the same setup (126 B after adding the LRU bookkeeping field).

**Pruning / Eviction** — three layers:

1. **Lossless TTL expiry.** Each algorithm declares `idleTtlMs` = time after which unused state is *indistinguishable from a fresh one* (token bucket: time to refill from empty; sliding window: 2 windows; GCRA: bucket drain time). Deleting it then changes no decision — a test checks this for all three algorithms. A background sweeper (`setInterval`, `unref`'d so it never keeps the process alive) removes expired entries every 5 s, with a **budget** per tick (50k entries) so it can never stall the event loop.
2. **Hard cap per policy with second-chance (CLOCK) LRU.** When a store is at `maxTrackedKeys`, the head of the Map order is examined: expired → removed; *seen since it was positioned* → moved to the tail and spared (up to 64 times); otherwise evicted. This is the approximated-LRU idea Redis uses. It matters for security: a key that is currently being **blocked** is "in use" (denied requests also mark it). Otherwise an attacker floods fresh IPs, pushes their own blocked bucket to the head, gets it evicted, and receives a brand-new quota. There's a test for exactly this.
3. **Fail-closed alternative (`ON_STORE_FULL=reject-new`).** Instead of evicting live state, refuse to track new keys: new clients get 429, existing clients keep accurate limits. That's the right choice when a forgotten bucket is worse than a refused newcomer (login protection). It's the default when `FAIL_MODE=closed`.

Other bounds:
- A request that is denied by any layer **allocates no buckets** — state is created speculatively and only inserted on consume. A random-IP flood against an exhausted tenant pool grows memory by zero (tested).
- Unknown `tenantId`s (caller-controlled) are only auto-provisioned up to `MAX_DYNAMIC_TENANTS`; the noisy-neighbour episode tracker is capped at 10k entries per tenant.

Why not a hot-path LRU? My first version moved every accessed key to the tail of the Map (`delete` + `set`). The profiler showed 78% of CPU in `Map.set`. In the full benchmark, with mixed IPv4/IPv6 traffic, each re-insert of a freshly built key string into a large Map cost ~10 µs (I could reproduce it but didn't pin down the V8 internals — most likely GC interaction from writing young strings into a big old-generation table). Switching to lazy second-chance (touch = one field write; reposition only when the sweeper/evictor reaches the entry) took throughput from **114k to 1.18M evaluations/s**.

---

## 5. Concurrency & Node.js Event Loop

**Atomicity approach:** `RateLimiterEngine.evaluate()` is **fully synchronous** — no `await`, no callbacks, no I/O between reading a bucket and writing it. Node runs JavaScript on one thread and never pre-empts a running function, so check + consume across *all* policies of a request is atomic without locks or CAS loops. The HTTP handler awaits only body parsing *before* calling `evaluate`, never in the middle.

The price is that `evaluate` must be cheap enough not to block the loop: it is O(number of matching policies) with no I/O; the main per-request costs are IP parsing and key building — ~0.85 µs per evaluation against a 6-policy tenant. Background work (sweeping) is budgeted per tick for the same reason.

What would break this model, and the answer:
- **Async storage (Redis):** check and consume would be separated by I/O and other requests would interleave. The fix is to move the whole check-and-consume into a single atomic server-side operation (Redis Lua script / `EVALSHA`, or `MULTI` with `WATCH`). See §6.
- **Worker threads / cluster mode:** each process would have its own counters (effective limit × N). Either shard keys to processes (consistent hashing by tenant/IP) or use a shared store.

**Precise timestamps without drift:**
- No per-bucket timers anywhere. All refill/window math is lazy, computed from elapsed time on access — there is nothing that can drift or pile up.
- Bucket math uses the **monotonic** clock (`performance.now()`); `Date.now()` can jump backwards or forwards on NTP adjustment, which would produce negative refills or free bursts. The wall clock is used for exactly one thing: converting "reset in N ms" to the epoch timestamp in `resetAt` / `X-RateLimit-Reset`.
- `Clock` is injected, so tests use a `ManualClock` and are fully deterministic (no `sleep`, no flaky timing).

---

## 6. What I Would Do Differently With More Time

**Distributed state.** Today each instance limits independently. For a fleet:
- Redis with one Lua script per algorithm doing read-refill-check-consume-write atomically, using Redis `TIME` as the single clock (no clock skew between app servers), and `PEXPIRE` = the same lossless `idleTtlMs` for eviction. The hierarchical two-phase check becomes one script over several keys — with Redis Cluster, a hash tag like `{tenantId}` puts a tenant's keys in one slot so the script stays atomic.
- To avoid a network round-trip per request: a **hybrid local + global** design — each node leases a slice of the quota (e.g. 100 tokens) from Redis and spends it locally, refilling asynchronously. That trades a small, bounded over-admission for removing Redis from the hot path.
- **Partition behaviour:** when Redis is unreachable, fall back to the local in-memory limiter with `limit / expected_node_count` per node rather than pure fail-open; alert. The fail-open/closed switch and timeout in the middleware are the hooks for this.

**Fairness.** Max-min fair sharing of a tenant pool among currently active keys (instead of first-come-first-served once per-key quotas sum above the pool), and a *defer* mode for background traffic (queue with a deadline using the GCRA's computed delay) instead of only rejecting.

**Memory.** A global memory budget across all stores (today each policy is capped independently, so the worst case is the sum of caps), adaptive key caps driven by heap usage, and a Count-Min Sketch / heavy-hitter detector in front of the exact buckets so millions of one-off IPs are never materialised.

**Operations.** Hot-reload of the policy file, policy versioning with audit log, latency histograms in Prometheus, HTTP-level load tests (`autocannon`) — the benchmark here measures the engine, not Express + JSON parsing — and mTLS / auth on the check endpoint.

**Testing.** Property-based tests (fast-check) comparing each algorithm against a brute-force reference over random request schedules.

---

## Appendix: "what-if" scenarios

| Scenario | What happens |
|---|---|
| **Flash crowd** (10× legit users) | New keys are cheap (~130 B, inserted only on allowed requests). Tenant pools are token buckets, so short spikes are absorbed by burst capacity. If the pool saturates, background traffic is shed first, then standard; critical keeps the last 5%. Memory stays capped by `maxTrackedKeys`; under pressure the second-chance LRU evicts idle keys first. |
| **Random IPv6 flood** | `/64` grouping collapses it to one bucket per subscriber prefix. If the attacker owns many prefixes: denied requests allocate nothing; allowed ones are bounded by the per-policy cap; with `reject-new`, existing clients keep exact limits. |
| **Spoofed `X-Forwarded-For`** | Ignored unless the TCP peer is a trusted proxy; even then only hops to the right of the first untrusted address count. |
| **Tenant-id flood** | Unknown tenants: 404, or at most `MAX_DYNAMIC_TENANTS` auto-provisioned. |
| **Limiter crashes / throws** | `FAIL_MODE=open` → allow with `X-RateLimit-Degraded: fail-open` (availability first); `closed` → 503 + `Retry-After: 1` (protection first). Same switch + timeout in the Express middleware for a remote limiter. |
| **Redis partition** (distributed version) | See §6: degrade to local per-node quotas, never block requests on an unreachable store; the middleware timeout (50 ms default) bounds added latency. |
| **Memory exhaustion** | Per-policy caps × ~130 B is the upper bound; V8 heap capped below the container limit; `ratelimit_memory_estimated_bytes` and `ratelimit_evictions_total{cause="capacity"}` show pressure before it becomes an outage. |
| **Clock jumps (NTP)** | No effect on limits — the monotonic clock drives bucket math. |
