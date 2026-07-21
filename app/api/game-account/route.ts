import { getUser } from '@/lib/auth';
import { and, eq } from 'drizzle-orm';
import { db, hasDb } from '@/db';
import { gameAccounts, users } from '@/db/schema';
import { login, GameAuthError } from '@/lib/gameApi';
import { encryptToken, hasTokenKey } from '@/lib/gameCrypto';
import { isGameSyncAllowed } from '@/lib/gameSyncAccess';

// GET — list this user's connected game accounts (no secrets). `enabled` tells
// the client whether to show the feature at all (allowlist gate).
export async function GET() {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const enabled = await isGameSyncAllowed();
  if (!enabled) return Response.json({ enabled: false, accounts: [], canStore: false });
  if (!hasDb()) return Response.json({ enabled: true, accounts: [], canStore: hasTokenKey() });

  const rows = await db.query.gameAccounts.findMany({ where: eq(gameAccounts.userId, userId) });
  return Response.json({
    enabled: true,
    canStore: hasTokenKey(),
    accounts: rows.map((r) => ({ id: r.id, label: r.label, lastSyncedAt: r.lastSyncedAt, createdAt: r.createdAt })),
  });
}

// POST — connect an account: log in, store the encrypted refresh token.
export async function POST(req: Request) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!(await isGameSyncAllowed())) return new Response('Forbidden', { status: 403 });
  if (!hasDb()) return Response.json({ error: 'Database not configured.' }, { status: 400 });
  if (!hasTokenKey()) {
    return Response.json(
      { error: 'Set GAME_TOKEN_KEY in the environment to store game logins securely.' },
      { status: 400 },
    );
  }

  const { email, password, label } = (await req.json()) as { email?: string; password?: string; label?: string };
  if (!email || !password) return Response.json({ error: 'Email and password are required.' }, { status: 400 });

  let tokens;
  try {
    tokens = await login(email, password);
  } catch (e) {
    const msg = e instanceof GameAuthError ? e.message : 'Login failed.';
    return Response.json({ error: msg }, { status: 401 });
  }

  await db.insert(users).values({ id: userId }).onConflictDoNothing();
  const [row] = await db
    .insert(gameAccounts)
    .values({ userId, label: label?.trim() || email, refreshTokenEnc: encryptToken(tokens.refreshToken) })
    .returning({ id: gameAccounts.id, label: gameAccounts.label });

  return Response.json({ account: { id: row.id, label: row.label } });
}

// DELETE ?id= — disconnect an account.
export async function DELETE(req: Request) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!(await isGameSyncAllowed())) return new Response('Forbidden', { status: 403 });
  if (!hasDb()) return Response.json({ ok: true });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'Missing id.' }, { status: 400 });
  await db.delete(gameAccounts).where(and(eq(gameAccounts.userId, userId), eq(gameAccounts.id, id)));
  return Response.json({ ok: true });
}
