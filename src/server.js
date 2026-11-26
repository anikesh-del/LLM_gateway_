import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { adminRouter } from './admin/keys.js';
import { getUsageHandler } from './admin/usage.js';
import { requireAdminAuth } from './auth/adminAuth.js';
import { requireVirtualKey } from './auth/virtualKey.js';
import { chatHandler } from './gateway/chatHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  formatters: {
    level: (label) => ({ level: label })
  }
});

export const app = express();

// Standard middleware
app.use(express.json({ limit: '2mb' }));
if (env.NODE_ENV !== 'test') {
  app.use(pinoHttp({ logger }));
}

// Static test console (public/index.html)
app.use(express.static(path.join(__dirname, '../public')));

// Admin API routes
app.use('/admin', adminRouter);

// Admin usage endpoint: GET /usage
app.get('/usage', requireAdminAuth, getUsageHandler);

// Main Gateway chat completion endpoint
app.post('/v1/chat/completions', requireVirtualKey, chatHandler);

// Test virtual key auth route (placeholder before full proxy in Phase 3)
app.get('/v1/me', requireVirtualKey, (req, res) => {
  res.json({
    authenticated: true,
    key: req.apiKey
  });
});

// Health check endpoint: liveness + DB ping
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT 1 as alive');
    if (result.rows[0]?.alive === 1) {
      return res.status(200).json({
        status: 'healthy',
        database: 'connected',
        timestamp: new Date().toISOString()
      });
    }
    return res.status(503).json({
      status: 'unhealthy',
      database: 'unexpected_result'
    });
  } catch (err) {
    logger.error({ err }, 'Health check database connection failed');
    return res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: err.message
    });
  }
});

// Generic 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'not_found',
      message: `Route ${req.method} ${req.path} not found`
    }
  });
});

// Generic error handler
app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled request error');
  res.status(500).json({
    error: {
      code: 'internal_server_error',
      message: 'An unexpected internal error occurred'
    }
  });
});

// Start server if run directly
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port = env.PORT;
  const server = app.listen(port, () => {
    logger.info(`LLM Gateway server listening on port ${port}`);
  });

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}. Gracefully shutting down...`);
    server.close(async () => {
      await pool.end();
      logger.info('Database pool closed. Exiting process.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
