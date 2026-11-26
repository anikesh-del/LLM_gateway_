import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Middleware to authenticate admin requests using constant-time comparison.
 * Requires: Authorization: Bearer <ADMIN_SECRET> or x-admin-secret: <ADMIN_SECRET>
 */
export function requireAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  let providedSecret = '';

  if (authHeader && authHeader.startsWith('Bearer ')) {
    providedSecret = authHeader.slice(7).trim();
  } else if (req.headers['x-admin-secret']) {
    providedSecret = String(req.headers['x-admin-secret']).trim();
  }

  if (!providedSecret) {
    return res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Admin authentication required'
      }
    });
  }

  // Constant-time comparison to prevent timing attacks
  const expectedBuffer = Buffer.from(env.ADMIN_SECRET);
  const providedBuffer = Buffer.from(providedSecret);

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Invalid admin secret'
      }
    });
  }

  next();
}
