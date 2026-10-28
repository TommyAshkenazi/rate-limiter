/**
 * Plug-and-play usage of the Express middleware.
 *
 *   npm run example:express                         # in-process engine
 *   RATE_LIMITER_URL=http://localhost:3000 npm run example:express   # remote service (docker compose up)
 *
 *   curl -i localhost:4000/api/items
 *   for i in $(seq 1 7); do curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:4000/auth/login; done
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import type { PolicyFile } from '../src/config';
import { RateLimiterEngine } from '../src/engine/rate-limiter';
import { ClientIpResolver } from '../src/extractors/client-ip-resolver';
import { expressRateLimit, type RateLimiterBackend } from '../src/middleware/express';
import { RemoteRateLimiterClient } from '../src/middleware/remote-client';

let limiter: RateLimiterBackend;
if (process.env.RATE_LIMITER_URL) {
  limiter = new RemoteRateLimiterClient(process.env.RATE_LIMITER_URL, 50);
} else {
  const engine = new RateLimiterEngine();
  const config = JSON.parse(readFileSync('config/policies.json', 'utf8')) as PolicyFile;
  for (const t of config.tenants) engine.setTenantPolicies(t.tenantId, t.policies);
  engine.start();
  limiter = engine;
}

const app = express();

app.use(
  expressRateLimit({
    limiter,
    tenantId: 'org-acme-prod',
    // Whatever your auth middleware established; here a demo header.
    userId: (req) => req.header('x-demo-user'),
    priority: (req) => (req.path.startsWith('/internal/reports') ? 'background' : 'standard'),
    // Trust only our own load balancer network; XFF from anyone else is ignored.
    ipResolver: new ClientIpResolver({ trustedProxies: ['127.0.0.0/8', '::1/128', '10.0.0.0/8'] }),
    failMode: 'open',
    onError: (err) => console.warn('rate limiter degraded:', (err as Error).message),
  }),
);

app.get('/api/items', (_req, res) => {
  res.json({ items: [1, 2, 3] });
});
app.post('/auth/login', (_req, res) => {
  res.json({ token: 'demo' });
});

app.listen(4000, () => console.log('example app on http://localhost:4000'));
