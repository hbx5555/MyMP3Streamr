import { query } from '../db/pool.js';
import type { UserRow } from '../types.js';

export async function getUserByToken(token: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `select u.id, u.email, u.password_hash, u.role
     from auth_tokens t
     join users u on u.id = t.user_id
     where t.token_hash = $1 and t.revoked_at is null and t.expires_at > now()
     limit 1`,
    [token]
  );
  return result.rows[0] ?? null;
}

export async function storeToken(userId: string, tokenHash: string, expiresAt: Date) {
  await query(
    'insert into auth_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)',
    [userId, tokenHash, expiresAt]
  );
}
