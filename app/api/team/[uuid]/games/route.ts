// Lists a team's games (metadata only) for the Matchups tab — proxies the
// public upstream games endpoint, newest-first. Public data, works in all tiers
// (no auth / no DB). Deep per-game stats come from /games/[gameId]/replay.
//
// Capped to the most-recent LIMIT games (= MAX_PAGES upstream pages). Walking a
// team's full history was tried and reverted: a heavy account has 600+ games, the
// upstream THROTTLES concurrency (parallel doesn't help — measured) and 429s on
// bursts, so a full sequential walk turned into a backoff storm that never
// finished and the tab stopped loading. A small bounded fetch loads fast and
// reliably. Tradeoff: sparse season games beyond the window won't all appear in
// the Matchups dropdown — recency is what this view optimizes for.
//
// Speed/overhead control:
//  - small page count → fast cold load, no artificial pacing needed;
//  - cache each upstream page server-side (revalidate) so warm loads skip upstream;
//  - light 429/5xx backoff per page as a safety net (rarely trips at this size);
//  - Cache-Control so the CDN serves repeat loads. The client also memoizes per session.
const GAMES_BASE = 'https://www.tiny-teams.com/api/team-search/teams';
const PAGE_SIZE = 10;
const LIMIT = 100; // most-recent N games — recency is what matchup scouting needs
const MAX_PAGES = Math.ceil(LIMIT / PAGE_SIZE);
const REVALIDATE = 300; // seconds — cache upstream pages + the response

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch one games page with retry/backoff — the upstream rate-limits bursts, and
// a transient 429 must not silently truncate the list. Honors Retry-After.
// Returns the parsed page, or null after exhausting retries.
async function fetchPage(
  uuid: string,
  page: number,
  fresh: boolean,
): Promise<{ results?: unknown[]; has_more?: boolean } | null> {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${GAMES_BASE}/${uuid}/games?offset=${page * PAGE_SIZE}`, {
      headers: { Accept: 'application/json' },
      ...(fresh ? { cache: 'no-store' as const } : { next: { revalidate: REVALIDATE } }),
    });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 600 * (i + 1));
      continue;
    }
    return null; // 4xx (other than 429) — page won't succeed on retry
  }
  return null;
}

export interface GameListRow {
  gameId: string;
  completedAt: string | null;
  gameMode: string | null;
  opponentTeamId: string | null;
  opponentName: string | null;
  ourScore: number | null;
  opponentScore: number | null;
  won: boolean | null;
  wasHome: boolean | null;
}

function mapRow(r: unknown): GameListRow {
  const g = r as Record<string, unknown>;
  return {
    gameId: String(g.game_id),
    completedAt: typeof g.completed_at === 'string' ? g.completed_at : null,
    gameMode: typeof g.game_mode === 'string' ? g.game_mode : null,
    opponentTeamId: typeof g.opponent_team_id === 'string' ? g.opponent_team_id : null,
    opponentName: typeof g.opponent_name === 'string' ? g.opponent_name : null,
    ourScore: typeof g.our_score === 'number' ? g.our_score : null,
    opponentScore: typeof g.opponent_score === 'number' ? g.opponent_score : null,
    won: typeof g.won === 'boolean' ? g.won : null,
    wasHome: typeof g.was_home === 'boolean' ? g.was_home : null,
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await params;
  // ?fresh=1 (the Matchups "Refresh" button) bypasses both cache layers so
  // newly-played games show up immediately: skip the upstream-page cache and
  // tell the CDN/browser not to serve a stale copy.
  const fresh = new URL(req.url).searchParams.get('fresh') === '1';
  const games: GameListRow[] = [];

  // Fetch the most-recent LIMIT games, newest-first. Sequential (upstream
  // throttles concurrency) but only MAX_PAGES pages, so it's quick; caching
  // makes warm loads skip upstream entirely.
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchPage(uuid, page, fresh);
    if (!json) {
      // First page failing is a hard error; a later page failing after retries
      // returns the partial list rather than nothing.
      if (page === 0) return Response.json({ error: 'Upstream games fetch failed' }, { status: 502 });
      break;
    }
    for (const r of json.results ?? []) games.push(mapRow(r));
    if (!json.has_more || games.length >= LIMIT) break;
  }

  games.sort((a, b) => (b.completedAt ? Date.parse(b.completedAt) : 0) - (a.completedAt ? Date.parse(a.completedAt) : 0));

  return Response.json(
    { games: games.slice(0, LIMIT) },
    {
      headers: {
        'Cache-Control': fresh
          ? 'no-store'
          : `public, s-maxage=${REVALIDATE}, stale-while-revalidate=${REVALIDATE * 2}`,
      },
    },
  );
}
