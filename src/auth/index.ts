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

function decodeSubsonicPassword(password: string): string {
  if (!password.startsWith('enc:')) {
    return password;
  }

  try {
    return Buffer.from(password.slice(4), 'hex').toString('utf8');
  } catch {
    throw new AuthError('Invalid encoded password');
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
    if (q.t.toLowerCase() !== expected.toLowerCase()) {
      throw new AuthError('Invalid token');
    }
    return user;
  }

  if (q.p) {
    if (!verifyPassword(user.password_hash, decodeSubsonicPassword(q.p))) {
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
