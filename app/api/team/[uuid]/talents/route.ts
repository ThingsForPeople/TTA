// Detect a team's player talents from a replay. The team-search scrape carries
// NO talents — only replay rosters do — so this fetches one game's replay,
// extracts our side's per-player talents (batting + pitch), and returns them in
// the playerMeta shape. The client overwrites meta.talents from the result.
//
// Public data, all tiers (no auth / no DB). One ~2.5 MB replay fetch per call;
// button-driven, so no caching needed. Defaults to the most-recent game; pass
// ?gameId= to target a specific one (e.g. to capture a player only in older
// lineups). One replay = the 9 players who played it.
import { extractRosterTalents } from '@/lib/parseReplay';

const GAMES_BASE = 'https://www.tiny-teams.com/api/team-search/teams';
const REPLAY_BASE = 'https://www.tiny-teams.com/api/replay';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await params;
  let gameId = new URL(req.url).searchParams.get('gameId') ?? undefined;
  let opponentName: string | undefined;

  // Resolve the most-recent game id if one wasn't supplied.
  if (!gameId) {
    const gRes = await fetch(`${GAMES_BASE}/${uuid}/games?offset=0`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!gRes.ok) {
      return Response.json({ error: `Games lookup failed (${gRes.status})` }, { status: gRes.status });
    }
    const gJson: { results?: Array<{ game_id: string; opponent_name?: string }> } = await gRes.json();
    const first = gJson.results?.[0];
    if (!first) return Response.json({ error: 'No games found for this team.' }, { status: 404 });
    gameId = first.game_id;
    opponentName = first.opponent_name ?? undefined;
  }

  const rRes = await fetch(`${REPLAY_BASE}/${gameId}`, { headers: { Accept: 'application/json' } });
  if (!rRes.ok) {
    const msg = rRes.status === 429
      ? 'Upstream rate-limited — wait a moment and try again.'
      : `Replay fetch failed (${rRes.status})`;
    return Response.json({ error: msg }, { status: rRes.status });
  }

  const raw = await rRes.json();
  const { matched, players } = extractRosterTalents(raw, uuid);
  if (!matched) {
    return Response.json({ error: 'That replay does not include this team.' }, { status: 422 });
  }

  return Response.json({ gameId, opponentName, players });
}
