import type { RawPlayer } from './parseTeam';
import type { ParsedTeam } from './types';

export class ScrapeError extends Error {
  constructor(
    public status: number,
    public url: string,
    message: string,
  ) {
    super(`${status} ${url}: ${message}`);
  }
}

export async function fetchTeamData(teamUuid: string): Promise<ParsedTeam> {
  const url = `/api/team/${teamUuid}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new ScrapeError(res.status, url, 'team fetch failed');
  }
  return (await res.json()) as ParsedTeam;
}

export type TimeFilter =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'l7'
  | 'l30'
  | 'g1'
  | 'g5'
  | 'g10'
  | 'g25'
  | 'g50'
  | 'g100';

export type ModeFilter = 'all' | 'quick_play' | 'challenge' | 'season';

export const TIME_OPTIONS: { value: TimeFilter; label: string }[] = [
  { value: 'all', label: 'All-time' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'l7', label: 'Last 7 days' },
  { value: 'l30', label: 'Last 30 days' },
  { value: 'g1', label: 'Last 1 game' },
  { value: 'g5', label: 'Last 5 games' },
  { value: 'g10', label: 'Last 10 games' },
  { value: 'g25', label: 'Last 25 games' },
  { value: 'g50', label: 'Last 50 games' },
  { value: 'g100', label: 'Last 100 games' },
];

export const MODE_OPTIONS: { value: ModeFilter; label: string }[] = [
  { value: 'all', label: 'All modes' },
  { value: 'quick_play', label: 'Quickplay' },
  { value: 'challenge', label: 'Challenge' },
  { value: 'season', label: 'Season' },
];

const LAST_N_GAMES: Partial<Record<TimeFilter, number>> = {
  g1: 1,
  g5: 5,
  g10: 10,
  g25: 25,
  g50: 50,
  g100: 100,
};

function resolveTimeParams(time: TimeFilter): {
  since?: string;
  until?: string;
  lastNGames?: number;
} {
  const lastN = LAST_N_GAMES[time];
  if (lastN !== undefined) return { lastNGames: lastN };

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (time) {
    case 'today':
      return { since: startOfToday.toISOString() };
    case 'yesterday': {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 1);
      return { since: start.toISOString(), until: startOfToday.toISOString() };
    }
    case 'l7': {
      const since = new Date(now);
      since.setUTCDate(since.getUTCDate() - 7);
      return { since: since.toISOString() };
    }
    case 'l30': {
      const since = new Date(now);
      since.setUTCDate(since.getUTCDate() - 30);
      return { since: since.toISOString() };
    }
    case 'all':
    default:
      return {};
  }
}

interface RosterStatsResponse {
  roster: RawPlayer[];
}

export async function fetchRosterStatsJson(
  teamUuid: string,
  filters: { time: TimeFilter; mode: ModeFilter },
): Promise<RawPlayer[]> {
  const params = new URLSearchParams();
  if (filters.mode !== 'all') params.set('mode', filters.mode);
  const { since, until, lastNGames } = resolveTimeParams(filters.time);
  if (lastNGames !== undefined) {
    params.set('last_n_games', String(lastNGames));
  } else {
    if (since) params.set('since', since);
    if (until) params.set('until', until);
  }
  const qs = params.toString();
  const url = `/api/team/${teamUuid}/roster-stats${qs ? `?${qs}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new ScrapeError(res.status, url, 'roster-stats fetch failed');
  }
  const json = (await res.json()) as RosterStatsResponse | { error: string };
  if ('error' in json) {
    throw new ScrapeError(res.status, url, json.error);
  }
  return json.roster;
}
