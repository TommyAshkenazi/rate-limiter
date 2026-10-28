import express, { type Express } from 'express';
import { systemClock, type Clock } from '../clock';
import type { RateLimiterEngine } from '../engine/rate-limiter';
import type { FailMode } from '../types';
import { createLogger } from './logger';
import { errorHandler } from './middleware/error-handler';
import { requireAdmin } from './middleware/require-admin';
import { checkRoutes } from './routes/check';
import { healthRoutes } from './routes/health';
import { policyRoutes } from './routes/policies';
import { prometheusRoutes } from './routes/prometheus';
import { resetRoutes } from './routes/reset';
import { tenantMetricsRoutes } from './routes/tenant-metrics';

export interface AppOptions {
  engine: RateLimiterEngine;
  failMode: FailMode;
  adminToken?: string;
  clock?: Clock;
  logger?: boolean;
}

/**
 * Builds the Express app. This file only assembles the pieces;
 * every endpoint lives in its own file under routes/.
 */
export function buildApp(options: AppOptions): Express {
  const { engine, failMode } = options;
  const clock = options.clock ?? systemClock;
  const logger = createLogger(options.logger ?? false);
  const adminOnly = requireAdmin(options.adminToken);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use(healthRoutes());
  app.use(checkRoutes({ engine, failMode, clock, logger }));
  app.use(resetRoutes(engine, adminOnly));
  app.use(policyRoutes(engine, adminOnly));
  app.use(tenantMetricsRoutes(engine));
  app.use(prometheusRoutes(engine));

  app.use(errorHandler(logger));
  return app;
}
