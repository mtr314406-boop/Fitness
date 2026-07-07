// pg pool + query helper. Everything talks to the DB through here.

import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env');
}

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** Run a query, get rows back. */
export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

/** Run a query, get the first row or null. */
export async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}
