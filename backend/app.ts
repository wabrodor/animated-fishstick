import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import rateLimit from 'express-rate-limit';
import { allowedOrigins, env } from './config.js';
import { requireAuth } from './auth.js';
import { isKnownValidationError, protectedRouter, publicRouter } from './routes.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY);
app.use(helmet({ contentSecurityPolicy: false }));
app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)), methods: ['GET', 'POST', 'PATCH'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '8mb', strict: true }));

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts. Try again later.' } },
});
app.use(pinoHttp({ redact: ['req.headers.authorization', 'req.body.password'] }));

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
app.use('/api/v1/auth/login', authRateLimit);
app.use('/api/v1/auth/register-organization', authRateLimit);
app.use('/api/v1', publicRouter);
app.use('/api/v1', requireAuth, protectedRouter);

app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (isKnownValidationError(error)) { res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.', details: error.flatten() } }); return; }
  if (env.NODE_ENV !== 'test') console.error(error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
});
