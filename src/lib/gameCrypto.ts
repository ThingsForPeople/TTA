import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// AES-256-GCM encryption for stored game-account refresh tokens. The key is
// derived (scrypt) from the GAME_TOKEN_KEY env var, so any string works as a
// passphrase — set it to a long random value in production. Ciphertext is
// stored as base64 of iv(12) ++ authTag(16) ++ payload.

const FIXED_SALT = 'tiny-teams-game-token'; // per-deployment key is the secret; salt need not be

export function hasTokenKey(): boolean {
  return !!process.env.GAME_TOKEN_KEY;
}

function key(): Buffer {
  const secret = process.env.GAME_TOKEN_KEY;
  if (!secret) throw new Error('GAME_TOKEN_KEY is not set — cannot store game credentials.');
  return scryptSync(secret, FIXED_SALT, 32);
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptToken(stored: string): string {
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
