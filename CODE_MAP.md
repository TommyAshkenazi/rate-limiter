# Code Map

Every source file does one thing. Most are under 60 lines; the largest (`bucket-store.ts`) is one class with long comments.

## How a request flows through the code

```
HTTP  POST /v1/rate-limit/check
  │   http/routes/check.ts            validate body, call the engine, write headers + status
  ▼
engine/rate-limiter.ts                RateLimiterEngine.evaluate()  — wires the steps below
  │
  ├─ engine/tenants/tenant-registry.ts      1. find the tenant (or create it from the template)
  │
  ├─ engine/evaluation/check-phase.ts       2. PHASE 1: for every policy of the tenant…
  │     ├─ engine/policies/policy-match.ts        does the policy apply to this method/route?
  │     ├─ extractors/key-builder.ts              build the key, e.g. "ip=2001:db8::/64|route=POST /login"
  │     ├─ engine/policies/priority.ts            how much to reserve for higher priorities
  │     └─ algorithms/*.ts → check()              would this policy allow it?  (nothing consumed yet)
  │
  ├─ all allowed?  engine/evaluation/allow-phase.ts   3a. consume from EVERY policy → 200
  │   otherwise    engine/evaluation/deny-phase.ts    3b. consume from NONE        → 429
  │                engine/evaluation/deny-reason.ts       which reason to report
  │
  └─ engine/tenants/tenant-runtime.ts       4. count allowed / blocked
  ▼
engine/output/headers.ts              X-RateLimit-* / RateLimit-* / Retry-After
```

## Suggested reading order

1. `types/` — the data shapes (policy, request, result).
2. `algorithms/types.ts` → `algorithms/token-bucket.ts` — the core math, one algorithm.
3. `engine/rate-limiter.ts` — the big picture in ~100 lines.
4. `engine/evaluation/` — `check-phase` → `allow-phase` → `deny-phase` → `deny-reason`.
5. `extractors/key-builder.ts` → `extraction-context.ts` → `client-ip-key.ts` — how keys are made.
6. `engine/storage/bucket-store.ts` — memory: where buckets live and how they're evicted.
7. `extractors/client-ip-resolver.ts` — X-Forwarded-For and trusted proxies.
8. `http/app.ts` → `http/routes/check.ts` — the HTTP side.

## All files

### Entry points
| File | What it does |
|---|---|
| `server.ts` | Starts the service: load config, create engine, listen, shut down cleanly. |
| `config.ts` | Reads environment variables and `config/policies.json`. |
| `clock.ts` | Monotonic clock for bucket math, wall clock for timestamps; `ManualClock` for tests. |
| `index.ts` | Public exports of the library. |

### `types/` — data shapes only, no logic
| File | What it does |
|---|---|
| `policy.ts` | `RateLimitPolicy`, `TenantConfig`, algorithm / dimension / priority / scope names. |
| `request.ts` | `RequestContext` — what the caller tells us about a request. |
| `result.ts` | `RateLimitResult`, `EvaluationResult`, `DenyReason`. |
| `metrics.ts` | `TenantMetrics` — body of the metrics endpoint. |
| `fail-mode.ts` | `FailMode` — open or closed when the limiter itself fails. |

### `algorithms/` — the rate-limit math (no keys, no tenants, no HTTP)
| File | What it does |
|---|---|
| `types.ts` | The common interface: `createState`, `check` (decide), `consume` (apply). |
| `token-bucket.ts` | Burst up to capacity, refill at a fixed rate. |
| `sliding-window.ts` | N per rolling window, two counters, no boundary spike. |
| `leaky-bucket.ts` | Constant outflow (GCRA), one timestamp of state. |
| `index.ts` | `createAlgorithm(policy)` — picks the class and validates its parameters. |

### `extractors/` — turning a request into keys
| File | What it does |
|---|---|
| `key-builder.ts` | Builds the composite key for one policy from its dimensions. |
| `extraction-context.ts` | Per-request cache so the IP / user are parsed once for all policies. |
| `key-value-escape.ts` | Escapes `\|` and hashes huge values before they go into a key. |
| `identity.ts` | User identity: `userId`, else hashed Bearer token / API key. |
| `route.ts` | Normalises paths (`/AUTH//login?x` → `/auth/login`) and matches `/users/:id`, `/admin/*`. |
| `headers.ts` | Case-insensitive header lookup. |
| `client-ip-resolver.ts` | Real client IP from socket + `X-Forwarded-For`, trusting only known proxies. |
| `ip-parse.ts` | IP text → numbers (IPv4, IPv6, `::`, mapped IPv4, zones, ports). |
| `ip-mask.ts` | Keep the first N bits (the `/64` grouping). |
| `ip-format.ts` | Numbers → canonical IP text. |
| `client-ip-key.ts` | parse + mask + format = the IP part of a key. |
| `cidr.ts` | "Is this address inside 10.0.0.0/8?" |
| `ip.ts` | Re-exports the five IP files above. |

### `engine/` — the rate limiter itself
| File | What it does |
|---|---|
| `rate-limiter.ts` | `RateLimiterEngine`: public API, connects the folders below. |
| `engine-options.ts` | Constructor options and their defaults. |
| `errors.ts` | `UnknownTenantError`. |
| **`tenants/`** | |
| `tenant-registry.ts` | All tenants; policy updates; auto-creating unknown tenants (capped). |
| `tenant-runtime.ts` | One tenant's policies and allowed/blocked counters. |
| `isolation-tracker.ts` | Counts "noisy neighbour" episodes (a key getting contained). |
| **`policies/`** | |
| `compile-policy.ts` | Config policy → ready-to-run `CompiledPolicy`. |
| `compiled-policy.ts` | The `CompiledPolicy` shape. |
| `validate-policy.ts` | Rejects invalid key strategies. |
| `policy-match.ts` | Does a policy apply to this method + route? |
| `priority.ts` | Priority weights and the reserved headroom per priority. |
| **`evaluation/`** | |
| `check-phase.ts` | Phase 1: check every applicable policy, consume nothing. |
| `allow-phase.ts` | Phase 2a: everything allowed → consume everywhere. |
| `deny-phase.ts` | Phase 2b: something denied → consume nothing, build the 429 result. |
| `deny-reason.ts` | Picks `CLIENT_KEY_EXCEEDED` / `TENANT_QUOTA_EXCEEDED` / `NOISY_NEIGHBOR_THROTTLED`. |
| `pending-check.ts` | The shape of one policy's phase-1 result. |
| **`storage/`** | |
| `bucket-store.ts` | One policy's key → bucket map: cap, lossless TTL expiry, second-chance LRU. |
| `store-options.ts` | Store settings and the full-store behaviour (`evict-lru` / `reject-new`). |
| `memory-model.ts` | Bytes-per-entry constants and the key-flattening trick. |
| **`admin/`** | |
| `reset.ts` | Admin reset of buckets by tenant / policy / ip / user / route. |
| `tenant-metrics.ts` | Builds the metrics body and the Prometheus snapshot. |
| **`maintenance/`** | |
| `sweeper.ts` | Background timer that deletes expired buckets, bounded per tick. |
| **`output/`** | |
| `headers.ts` | Result → HTTP headers. |
| `prometheus.ts` | All tenants → Prometheus text format. |

### `http/` — the Express service
| File | What it does |
|---|---|
| `app.ts` | Assembles the Express app from the pieces below. |
| `logger.ts` | Tiny JSON error logger. |
| `routes/check.ts` | `POST /v1/rate-limit/check`, incl. fail-open / fail-closed. |
| `routes/reset.ts` | `POST /v1/rate-limit/reset` (admin). |
| `routes/policies.ts` | `GET` / `PUT /v1/tenants/:id/policies`. |
| `routes/tenant-metrics.ts` | `GET /v1/tenants/:id/metrics`. |
| `routes/prometheus.ts` | `GET /metrics`. |
| `routes/health.ts` | `GET /healthz`. |
| `middleware/require-admin.ts` | Bearer-token check for admin routes. |
| `middleware/error-handler.ts` | Bad JSON / unexpected errors → JSON error response. |
| `validation/check-body.ts` | Validates the check request body. |
| `validation/reset-body.ts` | Validates the reset request body. |
| `validation/policies-body.ts` | Validates the policies update body. |
| `validation/primitives.ts` | Shared type guards. |
| `responses/check-response.ts` | Result → JSON body of the check endpoint. |
| `responses/send-error.ts` | One shape for every error response. |

### `middleware/` — using the limiter inside another Express app
| File | What it does |
|---|---|
| `express.ts` | `expressRateLimit()` — plug-and-play middleware. |
| `remote-client.ts` | Calls this service over HTTP instead of an in-process engine. |
| `with-timeout.ts` | Gives up on a slow limiter after N ms (then fail-open / fail-closed applies). |
