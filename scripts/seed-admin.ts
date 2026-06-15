import 'dotenv/config';
import { z } from 'zod';
import { ensureAdminUser } from '../src/db/repositories.js';
import { hashPassword } from '../src/auth/password.js';
import { pool } from '../src/db/pool.js';

const seedEnvSchema = z.object({
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(8)
});

async function main() {
  const env = seedEnvSchema.parse(process.env);
  await ensureAdminUser(env.ADMIN_EMAIL, hashPassword(env.ADMIN_PASSWORD));
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
