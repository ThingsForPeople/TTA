import { getUser } from '@/lib/auth';
import { and, eq, inArray } from 'drizzle-orm';
import { db, hasDb } from '@/db';
import { gameAccounts, playerMeta, users } from '@/db/schema';
import { fetchRoster, refresh, mapSimStats, GameAuthError, type GameRoster } from '@/lib/gameApi';
import { decryptToken, encryptToken } from '@/lib/gameCrypto';
import { isGameSyncAllowed } from '@/lib/gameSyncAccess';

const norm = (h: unknown): 'R' | 'L' | null => (h === 'R' || h === 'L' ? h : null);

// POST { teamUuid } — pull exact attributes for an owned team from the game API
// and write them into playerMeta. Tries each connected account until one owns
// the team (manager-scoped tokens), preserving hand-curated talents/injuries.
export async function POST(req: Request) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  if (!(await isGameSyncAllowed())) return new Response('Forbidden', { status: 403 });
  if (!hasDb()) return Response.json({ error: 'Database not configured.' }, { status: 400 });

  const { teamUuid } = (await req.json()) as { teamUuid?: string };
  if (!teamUuid) return Response.json({ error: 'Missing teamUuid.' }, { status: 400 });

  const accounts = await db.query.gameAccounts.findMany({ where: eq(gameAccounts.userId, userId) });
  if (accounts.length === 0) {
    return Response.json({ error: 'No connected game account. Connect one first.' }, { status: 400 });
  }

  // Try each account: refresh its token (rotating the stored one), then attempt
  // the roster. The account that owns this team returns a roster; others 403.
  let roster: GameRoster | null = null;
  let ownerLabel = '';
  const expired: string[] = [];
  for (const acct of accounts) {
    let tokens;
    try {
      tokens = await refresh(decryptToken(acct.refreshTokenEnc));
    } catch {
      expired.push(acct.label);
      continue;
    }
    // Persist the rotated refresh token so the next sync still works.
    await db
      .update(gameAccounts)
      .set({ refreshTokenEnc: encryptToken(tokens.refreshToken), updatedAt: new Date() })
      .where(eq(gameAccounts.id, acct.id));

    let r: GameRoster | null;
    try {
      r = await fetchRoster(tokens.accessToken, teamUuid);
    } catch (e) {
      return Response.json({ error: e instanceof GameAuthError ? e.message : 'Roster fetch failed.' }, { status: 502 });
    }
    if (r) {
      roster = r;
      ownerLabel = acct.label;
      await db.update(gameAccounts).set({ lastSyncedAt: new Date() }).where(eq(gameAccounts.id, acct.id));
      break;
    }
  }

  if (!roster) {
    const detail = expired.length ? ` (session expired for: ${expired.join(', ')} — reconnect).` : '';
    return Response.json(
      { error: `None of your connected accounts own this team${detail || '.'}` },
      { status: 403 },
    );
  }

  // Preserve existing per-player curation (talents, injuries) — only overwrite
  // the sim stats and the scalar attributes the game is authoritative for.
  await db.insert(users).values({ id: userId }).onConflictDoNothing();
  const ids = roster.players.map((p) => p.playerId);
  const existing = ids.length
    ? await db.query.playerMeta.findMany({
        where: and(eq(playerMeta.userId, userId), inArray(playerMeta.playerUuid, ids)),
      })
    : [];
  const prior = new Map(existing.map((r) => [r.playerUuid, r]));

  let synced = 0;
  const updates: { playerUuid: string; sim: ReturnType<typeof mapSimStats>; bats: 'R' | 'L' | null; throws: 'R' | 'L' | null; archetype: string | null; age: number | null }[] = [];
  for (const p of roster.players) {
    const sim = mapSimStats(p.attributes);
    const was = prior.get(p.playerId);
    const values = {
      userId,
      playerUuid: p.playerId,
      sim,
      talents: was?.talents ?? [],
      talentLevels: was?.talentLevels ?? {},
      injury: was?.injury ?? null,
      injuryHistory: was?.injuryHistory ?? [],
      pitchTalents: was?.pitchTalents ?? [],
      bats: norm(p.batHand),
      throws: norm(p.throwHand),
      archetype: p.archetype ?? was?.archetype ?? null,
      age: typeof p.age === 'number' ? p.age : (was?.age ?? null),
    };
    await db
      .insert(playerMeta)
      .values(values)
      .onConflictDoUpdate({
        target: [playerMeta.userId, playerMeta.playerUuid],
        set: {
          sim: values.sim,
          bats: values.bats,
          throws: values.throws,
          archetype: values.archetype,
          age: values.age,
          updatedAt: new Date(),
        },
      });
    updates.push({ playerUuid: p.playerId, sim: values.sim, bats: values.bats, throws: values.throws, archetype: values.archetype, age: values.age });
    synced++;
  }

  return Response.json({ synced, account: ownerLabel, teamName: roster.teamName, updates });
}
