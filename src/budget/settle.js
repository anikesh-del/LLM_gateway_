import { pool } from '../db/pool.js';

/**
 * Settle budget and persist usage log in a single PostgreSQL transaction.
 * 
 * Formula: spent_paise = GREATEST(spent_paise - reserved + actual, 0)
 * On failure/refund: actual = 0.
 * 
 * @param {Object} params
 * @param {string} params.keyId
 * @param {number} params.reservedPaise
 * @param {number} params.actualCostPaise
 * @param {Object} params.usageLog
 * @returns {Promise<{ settled: boolean, newSpentPaise?: number }>}
 */
export async function settleBudget({
  keyId,
  reservedPaise,
  actualCostPaise,
  usageLog
}) {
  const executeTransaction = async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let newSpentPaise = null;
      if (reservedPaise > 0 || actualCostPaise > 0) {
        const updateResult = await client.query(
          `UPDATE api_keys
           SET spent_paise = GREATEST(spent_paise - $1 + $2, 0)
           WHERE id = $3
           RETURNING spent_paise`,
          [reservedPaise, actualCostPaise, keyId]
        );
        if (updateResult.rows.length > 0) {
          newSpentPaise = Number(updateResult.rows[0].spent_paise);
        }
      }

      if (usageLog) {
        await client.query(
          `INSERT INTO usage_logs (
            request_id, api_key_id, provider, model, route_reason,
            tokens_in, tokens_out, cost_paise, status, attempts, latency_ms, error_code
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            usageLog.requestId,
            keyId,
            usageLog.provider,
            usageLog.model,
            usageLog.routeReason,
            usageLog.tokensIn || 0,
            usageLog.tokensOut || 0,
            actualCostPaise,
            usageLog.status,
            usageLog.attempts || 1,
            usageLog.latencyMs || 0,
            usageLog.errorCode || null
          ]
        );
      }

      await client.query('COMMIT');
      return { settled: true, newSpentPaise };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };

  try {
    return await executeTransaction();
  } catch (err) {
    console.error('First settlement attempt failed, retrying once...', err);
    try {
      return await executeTransaction();
    } catch (retryErr) {
      console.error('CRITICAL: Budget settlement failed after retry. Leaked reservation potential:', retryErr);
      throw retryErr;
    }
  }
}
