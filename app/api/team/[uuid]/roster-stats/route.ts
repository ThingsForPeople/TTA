import type { RawPlayer } from '@/lib/parseTeam';

const UPSTREAM = 'https://www.tiny-teams.com/api/team-search/teams';

// "All modes" = quick_play + season + challenge merged. The upstream has no
// way to express "everything except gauntlet" (mode=gauntlet is silently
// ignored and returns the unfiltered default), and gauntlet's non-representative
// roster + inflated scoring pollute every aggregate — so the no-mode view is
// built by summing the three real modes and recomputing the rate stats
// (verified: avg/obp/slg/era/whip/fielding_pct reproduce upstream's own
// formulas exactly on single-mode responses).
const MERGE_MODES = ['quick_play', 'season', 'challenge'];

const SUM_FIELDS = [
  'games_played', 'at_bats', 'hits', 'singles', 'doubles', 'triples',
  'home_runs', 'rbis', 'walks', 'strikeouts', 'runs',
  'pitches_thrown', 'pitching_walks', 'pitching_hits', 'pitching_strikeouts',
  'innings_pitched', 'runs_allowed', 'putouts', 'assists', 'errors',
] as const;

async function fetchUpstream(uuid: string, searchParams: URLSearchParams, mode?: string) {
  const upstream = new URL(`${UPSTREAM}/${uuid}/roster-stats`);
  for (const [key, value] of searchParams.entries()) {
    if (key === 'mode') continue;
    upstream.searchParams.set(key, value);
  }
  if (mode) upstream.searchParams.set('mode', mode);
  return fetch(upstream.toString(), { headers: { Accept: 'application/json' } });
}

function mergeRosters(rosters: RawPlayer[][]): RawPlayer[] {
  const byId = new Map<string, RawPlayer>();
  for (const roster of rosters) {
    for (const p of roster) {
      const acc = byId.get(p.player_id);
      if (!acc) {
        byId.set(p.player_id, { ...p });
        continue;
      }
      for (const f of SUM_FIELDS) {
        const v = p[f];
        if (v != null) acc[f] = (acc[f] ?? 0) + v;
      }
    }
  }
  for (const p of byId.values()) {
    const ab = p.at_bats ?? 0, h = p.hits ?? 0, bb = p.walks ?? 0;
    p.batting_avg = ab > 0 ? h / ab : null;
    p.on_base_pct = ab + bb > 0 ? (h + bb) / (ab + bb) : null;
    p.slugging_pct = ab > 0
      ? ((p.singles ?? 0) + 2 * (p.doubles ?? 0) + 3 * (p.triples ?? 0) + 4 * (p.home_runs ?? 0)) / ab
      : null;
    p.ops = p.on_base_pct != null && p.slugging_pct != null ? p.on_base_pct + p.slugging_pct : null;
    const ip = p.innings_pitched ?? 0;
    p.era = ip > 0 ? (9 * (p.runs_allowed ?? 0)) / ip : null;
    p.whip = ip > 0 ? ((p.pitching_walks ?? 0) + (p.pitching_hits ?? 0)) / ip : null;
    const po = (p.putouts ?? 0) + (p.assists ?? 0);
    const ch = po + (p.errors ?? 0);
    p.fielding_pct = ch > 0 ? po / ch : null;
  }
  return [...byId.values()];
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ uuid: string }> },
) {
  const { uuid } = await params;
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode');

  // Explicit single mode — plain passthrough.
  if (mode) {
    const res = await fetchUpstream(uuid, searchParams, mode);
    if (!res.ok) {
      return Response.json({ error: `Upstream returned ${res.status}` }, { status: res.status });
    }
    return Response.json(await res.json());
  }

  // No mode = "all modes (no gauntlet)": merge the three real modes.
  const results = await Promise.all(MERGE_MODES.map((m) => fetchUpstream(uuid, searchParams, m)));
  const failed = results.find((r) => !r.ok);
  if (failed) {
    return Response.json({ error: `Upstream returned ${failed.status}` }, { status: failed.status });
  }
  const rosters = await Promise.all(
    results.map(async (r) => ((await r.json()) as { roster?: RawPlayer[] }).roster ?? []),
  );
  return Response.json({ roster: mergeRosters(rosters) });
}
