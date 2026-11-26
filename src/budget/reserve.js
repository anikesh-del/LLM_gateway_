import { pool } from '../db/pool.js';

/**
 * Reserve budget atomically in PostgreSQL using integer paise.
 * No read-then-write; uses single atomic UPDATE ... WHERE condition.
 * 
 * Row-level locking in PostgreSQL guarantees concurrent requests serialize.
 * If 0 rows are returned, key is exhausted, missing, or revoked -> budget exceeded.
 * 
 * @param {string} keyId UUID of the API key
 * @param {number} reservePaise Amount to reserve in paise
 * @returns {Promise<{ success: boolean, spent_paise?: number, budget_paise?: number }>}
 */
export async function reserveBudget(keyId, reservePaise) {
  if (reservePaise <= 0) {
    return { success: true };
  }

  const query = `
    UPDATE api_keys
    SET spent_paise = spent_paise + $1
    WHERE id = $2
      AND revoked_at IS NULL
      AND spent_paise + $1 <= budget_paise
    RETURNING spent_paise, budget_paise;
  `;

  const result = await pool.query(query, [reservePaise, keyId]);

  if (result.rows.length === 0) {
    return { success: false };
  }

  return {
    success: true,
    spent_paise: Number(result.rows[0].spent_paise),
    budget_paise: Number(result.rows[0].budget_paise)
  };
}
