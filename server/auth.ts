import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** Identidade simples: apelido público + senha (scrypt). Sessões por token Bearer. */

const SCRYPT_KEYLEN = 64;
const SESSION_DAYS = 60;

export interface User {
  id: number;
  nickname: string;
}

export function nicknameKey(n: string): string {
  return n.normalize('NFC').trim().toLowerCase();
}

export function validateNickname(n: unknown): string | null {
  if (typeof n !== 'string') return 'Informe um apelido.';
  const t = n.normalize('NFC').trim();
  if (t.length < 3 || t.length > 20) return 'O apelido deve ter de 3 a 20 caracteres.';
  if (!/^[\p{L}\p{N}_.\- ]+$/u.test(t)) return 'Use só letras, números, espaço, ponto, hífen ou sublinhado.';
  return null;
}

export function validatePassword(p: unknown): string | null {
  if (typeof p !== 'string') return 'Informe uma senha.';
  if (p.length < 6) return 'A senha deve ter pelo menos 6 caracteres.';
  if (p.length > 200) return 'Senha longa demais.';
  return null;
}

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return { salt: salt.toString('base64'), hash: key.toString('base64') };
}

export async function verifyPassword(password: string, salt: string, hash: string): Promise<boolean> {
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'));
  const expected = Buffer.from(hash, 'base64');
  return expected.length === key.length && timingSafeEqual(expected, key);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db: DatabaseSync, userId: number): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), userId, now, now + SESSION_DAYS * 86400_000);
  return token;
}

export function userFromToken(db: DatabaseSync, header: string | undefined): User | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token || token.length > 200) return null;
  const row = db
    .prepare('SELECT u.id, u.nickname, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
    .get(tokenHash(token)) as { id: number; nickname: string; expires_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    return null;
  }
  return { id: row.id, nickname: row.nickname };
}

export function deleteSession(db: DatabaseSync, header: string | undefined): void {
  if (!header || !header.startsWith('Bearer ')) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(header.slice(7).trim()));
}
