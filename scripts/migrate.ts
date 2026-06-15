import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');

async function ensureSchemaTable() {
  await pool.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function getAppliedMigrations() {
  const result = await pool.query<{ id: string }>('select id from schema_migrations order by id');
  return new Set(result.rows.map((row: { id: string }) => row.id));
}

async function main() {
  await ensureSchemaTable();
  const applied = await getAppliedMigrations();
  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await pool.query('begin');
    try {
      await pool.query(sql);
      await pool.query('insert into schema_migrations (id) values ($1)', [file]);
      await pool.query('commit');
      console.log(`applied ${file}`);
    } catch (error) {
      await pool.query('rollback');
      throw error;
    }
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
