# Multi-Tenant Rate Limiting Service

An in-memory, multi-tenant rate limiter and traffic shaper for Node.js 20+ / TypeScript 5 (strict).

- **3 interchangeable algorithms** behind one interface: Token Bucket, Sliding Window Counter, Leaky Bucket (GCRA).
- **Generic key extraction**: client IP (IPv4, IPv6 grouped to `/64`), user id / bearer token / API key, route + method, any header — combined freely into composite keys.
- **Hierarchical limits**: per-client sub-quotas inside a tenant-wide pool, evaluated with a two-phase *check-all-then-consume* so a blocked client never drains its tenant's pool (noisy-neighbour isolation).
- **Priority classes**: `background` traffic is shed when a tenant's pool passes 90%, `standard` at 95%, `critical` may use 100%.
- **Networking realism**: trusted-proxy `X-Forwarded-For` parsing, IPv4-mapped IPv6 normalisation, route normalisation that defeats `/AUTH//login?x` style bypasses.
- **Bounded memory**: lossless TTL expiry + per-policy key caps with second-chance LRU; ~110–135 bytes per tracked key (measured).
- **~1.18M evaluations/sec** on a single thread (engine benchmark).
- HTTP API (Express 5), Express middleware, Prometheus `/metrics`, fail-open / fail-closed switch, Docker.

Design rationale, memory math and trade-offs are in **[DECISIONS.md](DECISIONS.md)**. AI usage is described in **[AI_USAGE.md](AI_USAGE.md)**.

---

## Quick start

```bash
npm install
npm test            # 59 tests (vitest)
npm run build       # tsc -> dist/
npm start           # node dist/server.js on :3000
# or, for development with reload:
npm run dev
```

### Docker

```bash
docker compose up --build            # service on http://localhost:3000
docker compose run --rm tests        # run the test suite in a container
```

### Benchmarks

```bash
npm run bench              # engine throughput, single thread (default 2M evaluations)
npm run bench:memory       # real heap bytes per tracked key vs. the engine's estimate
```

Reference results (Apple Silicon laptop, Node 24):

| | |
|---|---|
| Throughput | ~1,180,000 evaluations/s (0.85 µs mean) with 6 policies per request |
| Memory | 109–134 B/key measured, 1M keys ≈ 105–128 MiB |

---

## API

### `POST /v1/rate-limit/check` — evaluate and consume

```bash
curl -i -X POST localhost:3000/v1/rate-limit/check \
  -H 'content-type: application/json' \
  -d '{
    "tenantId": "org-acme-prod",
    "clientIp": "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    "userId": "usr_99812",
    "route": "/api/v1/payments",
    "method": "POST",
    "priority": "critical"
  }'
```

```
HTTP/1.1 200 OK
x-ratelimit-limit: 100
x-ratelimit-remaining: 99
x-ratelimit-reset: 1793120108        # epoch seconds
ratelimit-limit: 100                 # IETF draft-style headers
ratelimit-remaining: 99
ratelimit-reset: 120                 # delta seconds
ratelimit-policy: 100;w=60

{"allowed":true,"limit":100,"remaining":99,"resetAt":1793120108,"policyId":"payments"}
```

When blocked:

```
HTTP/1.1 429 Too Many Requests
x-ratelimit-limit: 5
x-ratelimit-remaining: 0
x-ratelimit-reset: 1793120060
retry-after: 71

{"allowed":false,"limit":5,"remaining":0,"resetAt":1793120060,"retryAfterSeconds":71,"reason":"CLIENT_KEY_EXCEEDED","policyId":"login"}
```

Body fields: `tenantId`, `clientIp`, `route`, `method` (required); `userId`, `headers`, `priority` (`critical|standard|background`), `cost` (default 1).

`reason` is one of:

| reason | meaning |
|---|---|
| `CLIENT_KEY_EXCEEDED` | this client's own sub-quota (user / IP / route…) is exhausted |
| `TENANT_QUOTA_EXCEEDED` | the tenant's shared pool is empty |
| `NOISY_NEIGHBOR_THROTTLED` | the pool still has room, but it is reserved for higher-priority traffic |

Try the brute-force guard (5 login attempts / minute / IP, any spelling of the path):

```bash
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "%{http_code} " -X POST localhost:3000/v1/rate-limit/check \
    -H 'content-type: application/json' \
    -d '{"tenantId":"org-acme-prod","clientIp":"203.0.113.9","route":"/AUTH//login?next=/","method":"POST"}'
done
# 200 200 200 200 200 429
```

IPv6 addresses in the same `/64` share a bucket:

```bash
for ip in 2001:db8:1:2::1 2001:db8:1:2:aaaa::5 2001:db8:1:2:ffff:ffff:ffff:ffff; do
  curl -s -X POST localhost:3000/v1/rate-limit/check -H 'content-type: application/json' \
    -d "{\"tenantId\":\"org-acme-prod\",\"clientIp\":\"$ip\",\"route\":\"/auth/login\",\"method\":\"POST\"}"; echo
done   # remaining: 4, 3, 2
```

### `GET /v1/tenants/{tenantId}/metrics`

```bash
curl -s localhost:3000/v1/tenants/org-acme-prod/metrics
```

```json
{"tenantId":"org-acme-prod","activeTrackedKeys":6,"totalEvaluations":8,"allowedCount":6,"blockedCount":2,"noisyNeighborsIsolated":1,"currentMemoryEstimatedBytes":1073}
```

### `POST /v1/rate-limit/reset` — admin (Bearer `ADMIN_TOKEN`)

```bash
# Clear one user's buckets in every policy of the tenant
curl -s -X POST localhost:3000/v1/rate-limit/reset -H 'authorization: Bearer change-me' \
  -H 'content-type: application/json' -d '{"tenantId":"org-acme-prod","dimensions":{"userId":"usr_99812"}}'

# Clear an IP (raw address; it is masked per policy, so any address in the /64 works)
curl -s -X POST localhost:3000/v1/rate-limit/reset -H 'authorization: Bearer change-me' \
  -H 'content-type: application/json' -d '{"tenantId":"org-acme-prod","dimensions":{"ip":"203.0.113.9"}}'

# Clear a whole tenant, or one policy of it
curl -s -X POST localhost:3000/v1/rate-limit/reset -H 'authorization: Bearer change-me' \
  -H 'content-type: application/json' -d '{"tenantId":"org-acme-prod","policyId":"login"}'
```

### `GET|PUT /v1/tenants/{tenantId}/policies` — dynamic rules

`PUT` (admin) atomically replaces a tenant's policy set. Invalid sets are rejected as a whole; buckets of policies whose id and algorithm are unchanged survive the update.

```bash
curl -s -X PUT localhost:3000/v1/tenants/org-new/policies -H 'authorization: Bearer change-me' \
  -H 'content-type: application/json' -d '{"policies":[
    {"id":"pool","name":"pool","algorithm":"token-bucket","capacity":1000,"refillRatePerSecond":1000,"keyStrategy":{"dimensions":[]}},
    {"id":"per-user","name":"per user","algorithm":"sliding-window","capacity":60,"windowSizeSeconds":60,"keyStrategy":{"dimensions":["userId"]}}
  ]}'
```

### Other

- `GET /metrics` — Prometheus text format (decisions by tenant/reason, tracked keys, evictions, memory).
- `GET /healthz`

---

## Configuring policies

Policies are loaded from `config/policies.json` (`POLICY_FILE`). A policy is the spec's `RateLimitPolicy` plus a few optional fields:

```jsonc
{
  "id": "login",
  "name": "Brute-force guard",
  "algorithm": "sliding-window",          // token-bucket | sliding-window | leaky-bucket
  "capacity": 5,
  "windowSizeSeconds": 60,                // sliding-window; buckets use refillRatePerSecond (or capacity/window)
  "keyStrategy": {
    "dimensions": ["ip", "route"],        // [] = one shared pool for the tenant
    "ipv6SubnetMask": 64,                 // default 64
    "ipv4SubnetMask": 32                  // default 32 (e.g. 24 to group a corporate range)
  },
  "scope": "client",                      // default: "tenant" if dimensions is empty, else "client"
  "match": { "methods": ["POST"], "routes": ["/auth/login", "/users/:id", "/admin/*"] },
  "priorityWeights": { "critical": 1, "standard": 0.95, "background": 0.9 },
  "maxTrackedKeys": 1000000
}
```

Every policy whose `match` fits the request is evaluated; a request is allowed only if **all** of them allow it. `defaultTenantPolicies` (optional) is a template instantiated for unknown tenants, up to `MAX_DYNAMIC_TENANTS`; without it, unknown tenants get `404`.

### Environment variables

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `POLICY_FILE` | `config/policies.json` | |
| `FAIL_MODE` | `open` | `open`: internal errors allow traffic; `closed`: they return 503 |
| `ON_STORE_FULL` | `evict-lru` (`reject-new` when fail-closed) | behaviour when a policy hits its key cap |
| `MAX_TRACKED_KEYS_PER_POLICY` | `1000000` | memory bound per policy |
| `MAX_DYNAMIC_TENANTS` | `1000` | cap on auto-provisioned tenants |
| `SWEEP_INTERVAL_MS` | `5000` | expiry sweeper period |
| `ADMIN_TOKEN` | unset (admin open) | Bearer token for reset / policy updates |

---

## Express middleware

```ts
import express from 'express';
import { RateLimiterEngine, expressRateLimit, ClientIpResolver } from './src';

const engine = new RateLimiterEngine();
engine.setTenantPolicies('org-acme-prod', policies);
engine.start(); // background expiry sweeper (unref'd timer)

app.use(expressRateLimit({
  limiter: engine,                                  // or new RemoteRateLimiterClient('http://limiter:3000')
  tenantId: 'org-acme-prod',                        // or (req) => req.tenant
  userId: (req) => req.user?.id,
  priority: (req) => (req.path.startsWith('/reports') ? 'background' : 'standard'),
  ipResolver: new ClientIpResolver({ trustedProxies: ['10.0.0.0/8'] }),
  failMode: 'open',                                 // what to do if the limiter errors / times out
  timeoutMs: 50,
}));
```

A runnable example: `npm run example:express` (in-process) or `RATE_LIMITER_URL=http://localhost:3000 npm run example:express` (calling the Docker service).

---

## Project layout

```
src/
├── types/          data shapes only (policy, request, result, metrics)
├── algorithms/     token bucket, sliding window, leaky bucket (GCRA) + common interface
├── extractors/     request -> keys: IP parse/mask/format, CIDR, trusted proxies, identity, routes
├── engine/
│   ├── rate-limiter.ts   public API, wires the folders below
│   ├── tenants/          tenant registry, per-tenant state, noisy-neighbour tracker
│   ├── policies/         compile / validate / match policies, priority reserves
│   ├── evaluation/       phase 1 (check all) and phase 2 (consume all / none)
│   ├── storage/          bounded bucket store with lossless expiry + second-chance LRU
│   ├── admin/            reset, metrics
│   ├── maintenance/      background sweeper
│   └── output/           HTTP headers, Prometheus format
├── http/           Express service: routes/, middleware/, validation/, responses/
├── middleware/     Express middleware for other apps + remote client
└── server.ts       entry point
tests/              59 tests
scripts/            bench.ts (throughput), memory.ts (bytes per key)
examples/           express-app.ts
```

**[CODE_MAP.md](CODE_MAP.md)** lists every file with a one-line description, the request flow, and a suggested reading order.

### Test map (required scenarios)

| # | Requirement | Test |
|---|---|---|
| 1 | Allow until limit, then 429 | `tests/enforcement.test.ts` → `[1] basic enforcement` |
| 2 | Accurate refill / window reset | `tests/enforcement.test.ts` → `[2] accurate refill`, `tests/algorithms.test.ts` |
| 3 | Noisy neighbour isolation | `tests/noisy-neighbor.test.ts` → `[3] …` |
| 4 | IPv6 `/64` shares a pool | `tests/networking.test.ts` → `[4] IPv6 /64 subnet masking` |
| 5 | User vs. IP limits | `tests/multi-dimension.test.ts` → `[5] …` |
| 6 | Eviction under key churn | `tests/eviction.test.ts` → `[6] …` |
