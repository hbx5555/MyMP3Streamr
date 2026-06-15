import { Pool, type QueryResultRow } from 'pg';
import { databaseConfig } from './database-config.js';

export const pool = new Pool({
  connectionString: databaseConfig.DATABASE_URL
});

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params);
}
