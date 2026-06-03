// Lists a team's games (metadata only) for the Matchups tab — proxies the
// public upstream games endpoint, newest-first. Public data, works in all tiers
// (no auth / no DB). Deep per-game stats come from /games/[gameId]/replay.
//
// Overhead control (the upstream paginates 10/page and THROTTLES concurrency, so
// parallel fetching doesn't help — measured):
//  - cap to the most-recent LIMIT games so a cold load is a bounded page count;
//  - cache each upstream page server-side (revalidate);
//  - set Cache-Control so the CDN serves repeat loads without re-hitting upstream
//    (the games list barely changes). The client also memoizes per session.
const GAMES_BASE = 'https://www.tiny-teams.com/api/team-search/teams';
const PAGE_SIZE = 10;
const LIMIT = 150; // most-recent N — recency is what matchup scouting needs
const MAX_PAGES = Math.ceil(LIMIT / PAGE_SIZE);
const REVALIDATE = 300; // seconds — cache upstream pages + the response

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
  _req: Request,
  { params }: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await params;
  const games: GameListRow[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(`${GAMES_BASE}/${uuid}/games?offset=${page * PAGE_SIZE}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: REVALIDATE },
    });
    if (!res.ok) {
      if (page === 0) return Response.json({ error: `Upstream returned ${res.status}` }, { status: res.status });
      break;
    }
    const json: { results?: unknown[]; has_more?: boolean } = await res.json();
    for (const r of json.results ?? []) games.push(mapRow(r));
    if (!json.has_more || games.length >= LIMIT) break;
  }

  games.sort((a, b) => (b.completedAt ? Date.parse(b.completedAt) : 0) - (a.completedAt ? Date.parse(a.completedAt) : 0));

  return Response.json(
    { games: games.slice(0, LIMIT) },
    { headers: { 'Cache-Control': `public, s-maxage=${REVALIDATE}, stale-while-revalidate=${REVALIDATE * 2}` } },
  );
}
