import { evaluateReplay, extractPlayerMetrics, fieldingLinesFromMetrics } from '@/lib/parseReplay';

const REPLAY_BASE = 'https://www.tiny-teams.com/api/replay';
const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 15_000; // per-try cap so one hung upstream doesn't block forever
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch the replay with retry/backoff. The upstream rate-limits bursts of these
// large (~2.8 MB) payloads and intermittently returns 429/5xx (incl. a slow 504
// after ~20s) — without retrying, opening a box score right after a replay-heavy
// action (e.g. the matchup analyzer's 10 fetches) fails outright. Each attempt is
// time-boxed so a stalled connection is aborted and retried rather than hung.
// Mirrors fetchReplay in the replay-sync route. Returns the upstream Response,
// 'notfound' (404 — no replay will ever exist), or null (gave up after retries).
async function fetchReplay(gameId: string): Promise<Response | 'notfound' | null> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(`${REPLAY_BASE}/${gameId}`, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (res.status === 404) return 'notfound';
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * (i + 1));
        continue;
      }
      return res;
    } catch {
      // Aborted (timeout) or network error — back off and retry.
      await sleep(1000 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Fetches the raw replay for a game, evaluates it server-side (the raw file is
// ~2.8 MB), and returns only the compact, team-oriented summary.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ uuid: string; gameId: string }> },
) {
  const { uuid, gameId } = await params;

  const result = await fetchReplay(gameId);
  if (result === 'notfound') {
    return Response.json({ error: 'No replay available for this game' }, { status: 404 });
  }
  if (result === null) {
    // Exhausted retries against a rate-limited / timing-out upstream.
    return Response.json({ error: 'Replay service is busy — try again in a moment' }, { status: 504 });
  }
  if (!result.ok) {
    return Response.json({ error: `Upstream returned ${result.status}` }, { status: result.status });
  }

  let raw: unknown;
  try {
    raw = await result.json();
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
