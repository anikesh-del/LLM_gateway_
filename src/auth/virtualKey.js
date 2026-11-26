import crypto from 'node:crypto';
import { pool } from '../db/pool.js';

/**
 * Generate a new virtual API key: gw_<randomHex>
 * Returns the raw key, prefix, and sha256 hash.
 */
export function generateVirtualKey() {
  const randomPart = crypto.randomBytes(24).toString('hex');
  const fullKey = `gw_${randomPart}`;
  const keyPrefix = fullKey.slice(0, 8); // e.g. "gw_12345"
  const keyHash = hashKey(fullKey);
  return { fullKey, keyPrefix, keyHash };
}

/**
 * Hash a key with sha256
 * @param {string} key
 * @returns {string} hex hash
 */
export function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Middleware to authenticate requests using virtual API keys.
 * Looks up active (unrevoked) key in api_keys table via sha256(key).
 * Attaches req.apiKey = { id, name, key_prefix, budget_paise, spent_paise }
 */
export async function requireVirtualKey(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Virtual API key required in Authorization header (Bearer gw_...)'
      }
    });
  }

  let rawKey = authHeader.slice(7).trim();
  // Strip any accidental extra "Bearer " prefix if client pasted it twice
  if (rawKey.toLowerCase().startsWith('bearer ')) {
    rawKey = rawKey.slice(7).trim();
  }

  if (!rawKey.startsWith('gw_')) {
    return res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Invalid virtual API key format (must start with gw_)'
      }
    });
  }

  const keyHash = hashKey(rawKey);

  try {
    const result = await pool.query(
      `SELECT id, name, key_prefix, budget_paise, spent_paise, revoked_at
       FROM api_keys
       WHERE key_hash = $1`,
      [keyHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'Unknown API key'
        }
      });
    }

    const keyRow = result.rows[0];

    if (keyRow.revoked_at !== null) {
      return res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'API key has been revoked'
        }
      });
    }

    // Attach key details to request (BigInt numbers coerced to Number for paise math)
    req.apiKey = {
      id: keyRow.id,
      name: keyRow.name,
      key_prefix: keyRow.key_prefix,
      budget_paise: Number(keyRow.budget_paise),
      spent_paise: Number(keyRow.spent_paise)
    };

    next();
  } catch (err) {
    req.log?.error({ err }, 'Error checking virtual API key');
    return res.status(500).json({
      error: {
        code: 'internal_server_error',
        message: 'Error verifying API key'
      }
    });
  }
}
