import { getUser } from '@/lib/auth';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import { db, hasDb } from '@/db';
import { replayMetrics, replaySyncs, users } from '@/db/schema';
import { extractPlayerMetrics } from '@/lib/parseReplay';

const GAMES_PAGE = 'https://www.tiny-teams.com/api/team-search/teams';
const REPLAY_BASE = 'https://www.tiny-teams.com/api/replay';
const SYNC_LIMIT = 100; // only sync the most-recent N games (recency matters most)
const RETENTION_GAMES = 100; // rolling DB window — prune metrics/syncs beyond this
// Enough pages to fill SYNC_LIMIT even when a large share of the recent log is
// gauntlet games (skipped during enumeration — some teams run ~50% gauntlet).
const MAX_PAGES = Math.ceil(SYNC_LIMIT / 10) * 2 + 2;
const MAX_BATCH = 3; // games processed per POST (timeout-safe + gentle on upstream)
const INTER_FETCH_MS = 900; // spacing between replay fetches within a batch

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch a replay with retry/exponential backoff — the upstream rate-limits
// bursts of these large (~2.8 MB) payloads, and a transient failure shouldn't
// drop a game. Honors Retry-After when present.
async function fetchReplay(gameId: string): Promise<Response | 'notfound' | null> {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`${REPLAY_BASE}/${gameId}`, { headers: { Accept: 'application/json' } });
      if (res.status === 404) return 'notfound';
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 1200 * (i + 1));
        continue;
      }
      return res;
    } catch {
      await sleep(1200 * (i + 1));
    }
  }
  return null;
}

interface GameRow {
  gameId: string;
  completedAt: string | null;
  gameMode: string | null;
  opponentName: string | null;
}

// Fetch one games-list page with retry/backoff. The upstream rate-limits under
// load (the same overload that 504s replay fetches), and these list pages are
// fetched no-store (see below), so without retrying a single transient 429 on
// page 0 truncates the whole sync list to empty. Time-boxed per attempt.
async function fetchGamesPage(uuid: string, page: number): Promise<Response | null> {
  for (let i = 0; i < 3; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(`${GAMES_PAGE}/${uuid}/games?offset=${page * 10}`, {
        headers: { Accept: 'application/json' },
        // No cache: sync is a deliberate user action and must see games played
        // moments ago. A cached page 0 (where newest games live) is exactly why
        // sync used to need two presses — the first served a stale list and only
        // warmed the cache; the second acted on it.
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 800 * (i + 1));
        continue;
      }
      return res;
    } catch {
      await sleep(800 * (i + 1)); // aborted (timeout) or network error
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Returns the recency-windowed games list and whether the upstream failed while
// enumerating (so the caller can distinguish "no games" from "couldn't reach the
// source" and surface a clear retry message instead of silently syncing nothing).
async function enumerateGames(uuid: string): Promise<{ games: GameRow[]; upstreamError: boolean }> {
  const games: GameRow[] = [];
  let upstreamError = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchGamesPage(uuid, page);
    if (!res || !res.ok) { upstreamError = true; break; } // keep what we have; flag the blip
    const json: any = await res.json();
    for (const g of json.results ?? []) {
      // Never sync gauntlet games: non-representative roster + inflated
      // scoring, and they'd eat the recency window (the query route already
      // excludes any previously-synced gauntlet rows).
      if (g.game_mode === 'gauntlet') continue;
      games.push({
        gameId: g.game_id,
        completedAt: g.completed_at ?? null,
        gameMode: g.game_mode ?? null,
        opponentName: g.opponent_name ?? null,
      });
    }
    // Upstream is newest-first; stop once we have the recency window (don't walk
    // every page of a 600-game history just to slice the most-recent SYNC_LIMIT).
    if (!json.has_more || games.length >= SYNC_LIMIT) break;
  }
  // Keep only the most-recent SYNC_LIMIT games (recency matters most).
  const windowed = games
    .sort((a, b) => (b.completedAt ? Date.parse(b.completedAt) : 0) - (a.completedAt ? Date.parse(a.completedAt) : 0))
    .slice(0, SYNC_LIMIT);
  return { games: windowed, upstreamError };
}

// GET — list every game for the team plus the set already synced, so the
// client can compute what's left and drive the batched POST sync.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ uuid: string }> },
) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const { uuid } = await params;

  if (!hasDb()) {
    return Response.json({ hasDb: false, games: [], syncedGameIds: [] });
  }

  const { games, upstreamError } = await enumerateGames(uuid);
  const syncedRows = await db
    .select({ gameId: replaySyncs.gameId })
    .from(replaySyncs)
    .where(and(eq(replaySyncs.userId, userId), eq(replaySyncs.teamUuid, uuid)));

  return Response.json({
    hasDb: true,
    games,
    upstreamError, // true if a list page failed after retries — caller can warn
    syncedGameIds: syncedRows.map((r) => r.gameId),
  });
}

// POST — process a batch of (un-synced) games: fetch each replay, derive
// per-player metrics, and store metrics + a sync marker. Idempotent.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ uuid: string }> },
) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const { uuid } = await params;
  if (!hasDb()) return Response.json({ hasDb: false, results: [] });

  const body = (await req.json().catch(() => ({}))) as { games?: GameRow[] };
  const batch = (body.games ?? []).slice(0, MAX_BATCH);
  if (batch.length === 0) return Response.json({ results: [] });

  await db.insert(users).values({ id: userId }).onConflictDoNothing();

  const results: { gameId: string; ok: boolean; players?: number; error?: string }[] = [];

  for (let gi = 0; gi < batch.length; gi++) {
    const game = batch[gi];
    if (gi > 0) await sleep(INTER_FETCH_MS); // space out upstream load
    try {
      const res = await fetchReplay(game.gameId);

      if (res === 'notfound') {
        // No replay will ever exist — mark synced so we stop retrying.
        await markSynced(userId, uuid, game);
        results.push({ gameId: game.gameId, ok: true, players: 0 });
        continue;
      }
      if (res === null || !res.ok) {
        // Transient failure — leave unsynced so the next round retries it.
        results.push({ gameId: game.gameId, ok: false, error: res ? `HTTP ${res.status}` : 'fetch failed' });
        continue;
      }

      const raw = await res.json();
      const evaluated = extractPlayerMetrics(raw, uuid);
      const completedAt = game.completedAt ? new Date(game.completedAt) : null;

      if (evaluated.matched && evaluated.players.length > 0) {
        await db
          .insert(replayMetrics)
          .values(
            evaluated.players.map((p) => ({
              userId,
              teamUuid: uuid,
              gameId: game.gameId,
              playerId: p.playerId,
              playerName: p.name,
              position: p.position ?? null,
              completedAt,
              gameMode: game.gameMode,
              metrics: p,
            })),
          )
          // Upsert so a recompute refreshes metrics (e.g. new derived fields).
          .onConflictDoUpdate({
            target: [replayMetrics.userId, replayMetrics.teamUuid, replayMetrics.gameId, replayMetrics.playerId],
            set: { metrics: sql`excluded.metrics`, playerName: sql`excluded.player_name`, position: sql`excluded.position` },
          });
      }

      await markSynced(userId, uuid, game);
      results.push({ gameId: game.gameId, ok: true, players: evaluated.matched ? evaluated.players.length : 0 });
    } catch (err) {
      results.push({ gameId: game.gameId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await prune(userId, uuid);
  return Response.json({ results });
}

// Keep the DB to a rolling window of the most-recent RETENTION_GAMES games:
// delete metrics + sync markers for anything older, so newer replays replace
// games that have aged out. No-op while under the cap. Runs after each batch
// (idempotent); by the end of a sync the stored set is trimmed.
async function prune(userId: string, teamUuid: string) {
  const keep = await db
    .select({ gameId: replaySyncs.gameId })
    .from(replaySyncs)
    .where(and(eq(replaySyncs.userId, userId), eq(replaySyncs.teamUuid, teamUuid)))
    .orderBy(desc(replaySyncs.completedAt))
    .limit(RETENTION_GAMES);
  if (keep.length < RETENTION_GAMES) return; // under the cap — nothing to prune
  const keepIds = keep.map((k) => k.gameId);
  await db.delete(replayMetrics).where(
    and(eq(replayMetrics.userId, userId), eq(replayMetrics.teamUuid, teamUuid), notInArray(replayMetrics.gameId, keepIds)),
  );
  await db.delete(replaySyncs).where(
    and(eq(replaySyncs.userId, userId), eq(replaySyncs.teamUuid, teamUuid), notInArray(replaySyncs.gameId, keepIds)),
  );
}

// DELETE — clear all stored metrics + sync markers for this team, so the next
// sync re-fetches the most-recent games from scratch (backfills new derived
// fields and drops anything that has aged out of the recency window).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ uuid: string }> },
) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const { uuid } = await params;
  if (!hasDb()) return Response.json({ ok: true });

  await db.delete(replayMetrics).where(and(eq(replayMetrics.userId, userId), eq(replayMetrics.teamUuid, uuid)));
  await db.delete(replaySyncs).where(and(eq(replaySyncs.userId, userId), eq(replaySyncs.teamUuid, uuid)));
  return Response.json({ ok: true });
}

async function markSynced(userId: string, teamUuid: string, game: GameRow) {
  await db
    .insert(replaySyncs)
    .values({
      userId,
      teamUuid,
      gameId: game.gameId,
      completedAt: game.completedAt ? new Date(game.completedAt) : null,
      gameMode: game.gameMode,
      opponentName: game.opponentName,
    })
    .onConflictDoNothing();
}
