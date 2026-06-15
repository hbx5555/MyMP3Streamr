import crypto from 'node:crypto';
import { sha256Hex, sha1Hex } from '../utils/crypto.js';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = sha256Hex(`${salt}:${password}`);
  return `sha256:${salt}:${hash}`;
}

export function verifyPassword(storedHash: string, password: string): boolean {
  const [scheme, salt, hash] = storedHash.split(':');
  if (scheme !== 'sha256' || !salt || !hash) return false;
  return sha256Hex(`${salt}:${password}`) === hash;
}

export function subsonicToken(password: string, salt: string): string {
  return sha1Hex(`${password}${salt}`);
}
