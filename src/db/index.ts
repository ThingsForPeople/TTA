import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

let _db: PostgresJsDatabase<typeof schema> | null = null;
let _initialized = false;

function initDb(): PostgresJsDatabase<typeof schema> | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = postgres(url);
  return drizzle(sql, { schema });
}

export function hasDb(): boolean {
  if (!_initialized) {
    _db = initDb();
    _initialized = true;
  }
  return _db !== null;
}

export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_target, prop) {
    if (!_initialized) {
      _db = initDb();
      _initialized = true;
    }
    if (!_db) throw new Error('DATABASE_URL is not set');
    return (_db as unknown as Record<string | symbol, unknown>)[prop];
  },
});
