import express from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAdminAuth } from '../auth/adminAuth.js';
import { generateVirtualKey } from '../auth/virtualKey.js';

export const adminRouter = express.Router();

// Apply admin authentication to all admin endpoints
adminRouter.use(requireAdminAuth);

const createKeySchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  budget_paise: z.coerce.number().int().positive('budget_paise must be a positive integer')
});

/**
 * POST /admin/keys
 * Create a new virtual key with a budget in paise.
 * Returns the raw key ONCE.
 */
adminRouter.post('/keys', async (req, res) => {
  const parsed = createKeySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: 'invalid_request',
        message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
      }
    });
  }

  const { name, budget_paise } = parsed.data;
  const { fullKey, keyPrefix, keyHash } = generateVirtualKey();

  try {
    const result = await pool.query(
      `INSERT INTO api_keys (name, key_prefix, key_hash, budget_paise, spent_paise)
       VALUES ($1, $2, $3, $4, 0)
       RETURNING id, name, key_prefix, budget_paise, created_at`,
      [name, keyPrefix, keyHash, budget_paise]
    );

    const created = result.rows[0];

    return res.status(201).json({
      id: created.id,
      name: created.name,
      key_prefix: created.key_prefix,
      key: fullKey, // Returned ONCE to client
      budget_paise: Number(created.budget_paise),
      created_at: created.created_at
    });
  } catch (err) {
    req.log?.error({ err }, 'Failed to create virtual API key');
    return res.status(500).json({
      error: {
        code: 'internal_server_error',
        message: 'Could not create API key'
      }
    });
  }
});

/**
 * POST /admin/keys/:id/revoke
 * Revoke an existing virtual key by ID.
 */
adminRouter.post('/keys/:id/revoke', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE api_keys
       SET revoked_at = now()
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING id, name, key_prefix, revoked_at`,
      [id]
    );

    if (result.rows.length === 0) {
      // Check if it exists or was already revoked
      const check = await pool.query('SELECT id, revoked_at FROM api_keys WHERE id = $1', [id]);
      if (check.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'not_found',
            message: 'API key not found'
          }
        });
      }
      return res.status(400).json({
        error: {
          code: 'already_revoked',
          message: 'API key is already revoked'
        }
      });
    }

    return res.status(200).json({
      message: 'API key revoked successfully',
      key: result.rows[0]
    });
  } catch (err) {
    req.log?.error({ err }, 'Failed to revoke API key');
    return res.status(500).json({
      error: {
        code: 'internal_server_error',
        message: 'Could not revoke API key'
      }
    });
  }
});
