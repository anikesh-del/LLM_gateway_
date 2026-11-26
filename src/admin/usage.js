import { pool } from '../db/pool.js';

/**
 * Handle GET /usage?key_id=...
 * Requires Admin Secret authentication.
 * Returns:
 * - Total spend in paise and INR
 * - Total remaining budget
 * - Total request count
 * - Breakdown by model and status
 * - Recent 20 usage rows
 */
export async function getUsageHandler(req, res) {
  const { key_id } = req.query;

  // Validate key_id is a valid UUID if provided
  if (key_id) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(key_id)) {
      return res.status(400).json({
        error: {
          code: 'invalid_request',
          message: 'key_id must be a valid UUID'
        }
      });
    }
  }

  try {
    let keyFilter = '';
    let params = [];

    if (key_id) {
      // Verify key exists
      const keyCheck = await pool.query(
        'SELECT id, name, key_prefix, budget_paise, spent_paise, revoked_at, created_at FROM api_keys WHERE id = $1',
        [key_id]
      );

      if (keyCheck.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'not_found',
            message: 'API key not found'
          }
        });
      }

      keyFilter = 'WHERE api_key_id = $1';
      params = [key_id];
    }

    // 1. Spend, requests, tokens aggregates
    const summaryQuery = `
      SELECT 
        COUNT(*)::integer AS total_requests,
        COALESCE(SUM(cost_paise), 0)::bigint AS total_spent_paise,
        COALESCE(SUM(tokens_in), 0)::integer AS total_tokens_in,
        COALESCE(SUM(tokens_out), 0)::integer AS total_tokens_out
      FROM usage_logs
      ${keyFilter};
    `;
    const summaryRes = await pool.query(summaryQuery, params);
    const summary = summaryRes.rows[0];

    // 2. Breakdown per model
    const modelBreakdownQuery = `
      SELECT 
        model,
        COUNT(*)::integer AS requests,
        COALESCE(SUM(cost_paise), 0)::bigint AS cost_paise,
        COALESCE(SUM(tokens_in), 0)::integer AS tokens_in,
        COALESCE(SUM(tokens_out), 0)::integer AS tokens_out
      FROM usage_logs
      ${keyFilter}
      GROUP BY model
      ORDER BY cost_paise DESC;
    `;
    const modelRes = await pool.query(modelBreakdownQuery, params);

    // 3. Status breakdown
    const statusBreakdownQuery = `
      SELECT 
        status,
        COUNT(*)::integer AS count
      FROM usage_logs
      ${keyFilter}
      GROUP BY status;
    `;
    const statusRes = await pool.query(statusBreakdownQuery, params);

    // 4. Recent logs (up to 20)
    const recentLogsQuery = `
      SELECT 
        id, request_id, api_key_id, provider, model, route_reason,
        tokens_in, tokens_out, cost_paise, status, latency_ms, error_code, created_at
      FROM usage_logs
      ${keyFilter}
      ORDER BY created_at DESC
      LIMIT 20;
    `;
    const recentRes = await pool.query(recentLogsQuery, params);

    // Format response
    const totalSpentPaise = Number(summary.total_spent_paise);

    let keyDetails = null;
    if (key_id) {
      const keyRow = (await pool.query('SELECT * FROM api_keys WHERE id = $1', [key_id])).rows[0];
      const budgetPaise = Number(keyRow.budget_paise);
      const spentPaise = Number(keyRow.spent_paise);
      keyDetails = {
        id: keyRow.id,
        name: keyRow.name,
        key_prefix: keyRow.key_prefix,
        budget_paise: budgetPaise,
        spent_paise: spentPaise,
        remaining_paise: Math.max(0, budgetPaise - spentPaise),
        revoked: keyRow.revoked_at !== null
      };
    }

    return res.status(200).json({
      key: keyDetails,
      summary: {
        total_requests: summary.total_requests,
        total_spent_paise: totalSpentPaise,
        total_spent_inr: (totalSpentPaise / 100).toFixed(2),
        total_tokens_in: summary.total_tokens_in,
        total_tokens_out: summary.total_tokens_out
      },
      models: modelRes.rows.map(m => ({
        model: m.model,
        requests: m.requests,
        cost_paise: Number(m.cost_paise),
        cost_inr: (Number(m.cost_paise) / 100).toFixed(2),
        tokens_in: m.tokens_in,
        tokens_out: m.tokens_out
      })),
      statuses: Object.fromEntries(statusRes.rows.map(s => [s.status, s.count])),
      recent_logs: recentRes.rows.map(l => ({
        ...l,
        cost_paise: Number(l.cost_paise),
        cost_inr: (Number(l.cost_paise) / 100).toFixed(2)
      }))
    });
  } catch (err) {
    req.log?.error({ err }, 'Error retrieving usage statistics');
    return res.status(500).json({
      error: {
        code: 'internal_server_error',
        message: 'Could not fetch usage metrics'
      }
    });
  }
}
