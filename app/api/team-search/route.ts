// Proxies tiny-teams' team search for the Matchups opponent picker. Public, DB-
// independent, and CHEAP — one upstream call per query, cached briefly. Lets the
// user search any team by name rather than only opponents in their game history.
const SEARCH_URL = 'https://www.tiny-teams.com/api/team-search/teams';
const MAX_RESULTS = 12;

export interface TeamSearchRow {
  teamId: string;
  teamName: string;
  managerName: string | null;
  wins: number | null;
  losses: number | null;
  teamLevel: number | null;
}

export async function GET(req: Request) {
  const query = (new URL(req.url).searchParams.get('query') ?? '').trim();
  // Require a couple chars so we don't spam upstream on every keystroke.
  if (query.length < 2) return Response.json({ results: [] });

  // Upstream's name filter is `q` — `query`/`name`/`search` are ignored and
  // return a default unfiltered list, so the param name matters here.
  const res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}`, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 120 }, // identical queries are cheap + cacheable
  });
  if (!res.ok) {
    return Response.json({ error: `Upstream ${res.status}`, results: [] }, { status: res.status });
  }

  const json = (await res.json().catch(() => ({}))) as { results?: Record<string, unknown>[] };
  const results: TeamSearchRow[] = (json.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
    teamId: String(r.team_id),
    teamName: typeof r.team_name === 'string' ? r.team_name : '(unknown)',
    managerName: typeof r.manager_name === 'string' ? r.manager_name : null,
    wins: typeof r.wins === 'number' ? r.wins : null,
    losses: typeof r.losses === 'number' ? r.losses : null,
    teamLevel: typeof r.team_level === 'number' ? r.team_level : null,
  }));

  return Response.json(
    { results },
    { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=240' } },
  );
}
