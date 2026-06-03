import { evaluateReplay, extractPlayerMetrics, fieldingLinesFromMetrics } from '@/lib/parseReplay';

// Fetches the raw replay for a game, evaluates it server-side (the raw file is
// ~2.8 MB), and returns only the compact, team-oriented summary.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ uuid: string; gameId: string }> },
) {
  const { uuid, gameId } = await params;

  const url = `https://www.tiny-teams.com/api/replay/${gameId}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    return Response.json({ error: 'Failed to reach replay service' }, { status: 502 });
  }

  if (!res.ok) {
    return Response.json(
      { error: res.status === 404 ? 'No replay available for this game' : `Upstream returned ${res.status}` },
      { status: res.status },
    );
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return Response.json({ error: 'Replay payload was not valid JSON' }, { status: 502 });
  }

  try {
    const evaluation = evaluateReplay(raw, uuid);
    const fielding = fieldingLinesFromMetrics(extractPlayerMetrics(raw, uuid));
    return Response.json({ ...evaluation, fielding }, {
      // Replays are immutable once a game completes — cache aggressively.
      headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=86400' },
    });
  } catch {
    return Response.json({ error: 'Could not evaluate replay (unexpected format)' }, { status: 500 });
  }
}
