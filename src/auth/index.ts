import type { FastifyRequest } from 'fastify';
import { getUserByEmail } from '../db/repositories.js';
import { verifyPassword, subsonicToken } from './password.js';
import { getUserByToken } from './session.js';
import type { UserRow } from '../types.js';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function authenticateRequest(request: FastifyRequest, adminPassword?: string): Promise<UserRow> {
  const q = request.query as Record<string, string | undefined>;
  const username = q.u;
  if (!username) {
    throw new AuthError('Missing username');
  }

  const user = await getUserByEmail(username);
  if (!user) {
    throw new AuthError('Invalid credentials');
  }

  if (q.t && q.s) {
    const expected = subsonicToken(adminPassword ?? '', q.s);
    if (q.t !== expected) {
      throw new AuthError('Invalid token');
    }
    return user;
  }

  if (q.p) {
    if (!verifyPassword(user.password_hash, q.p)) {
      throw new AuthError('Invalid password');
    }
    return user;
  }

  if (q.t && !q.s) {
    const tokenUser = await getUserByToken(q.t);
    if (!tokenUser) {
      throw new AuthError('Invalid session token');
    }
    return tokenUser;
  }

  throw new AuthError('Missing auth material');
}
