import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20, // reasonable default for concurrent requests
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// Log pool errors on idle clients
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

/**
 * Helper to query PostgreSQL pool
 * @param {string} text SQL query
 * @param {any[]} [params] Query parameters
 */
export async function query(text, params) {
  return pool.query(text, params);
}
