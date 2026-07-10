import type { ParsedTeam, Player, RecentGame, Team } from './types';

// The roster-stats JSON endpoint emits explicit `null` for stats with no data
// (e.g. pitching fields on position players, or any stat with no PAs in a
// filtered window). The SSR flight uses `undefined`. Allow both at the edge
// and normalize to `undefined` in `mapPlayer`.
export interface RawPlayer {
  player_id: string;
  first_name?: string | null;
  last_name?: string | null;
  archetype?: string | null;
  batting_position?: number | null;
  fielding_position?: number | null;
  position?: string | null;
  is_starter?: boolean | null;
  roster_status?: string | null;
  games_played?: number | null;
  at_bats?: number | null;
  hits?: number | null;
  singles?: number | null;
  doubles?: number | null;
  triples?: number | null;
  batting_avg?: number | null;
  home_runs?: number | null;
  rbis?: number | null;
  walks?: number | null;
  strikeouts?: number | null;
  runs?: number | null;
  on_base_pct?: number | null;
  slugging_pct?: number | null;
  ops?: number | null;
  pitches_thrown?: number | null;
  era?: number | null;
  whip?: number | null;
  pitching_walks?: number | null;
  pitching_hits?: number | null;
  pitching_strikeouts?: number | null;
  innings_pitched?: number | null;
  runs_allowed?: number | null;
  putouts?: number | null;
  assists?: number | null;
  errors?: number | null;
  fielding_pct?: number | null;
}

interface RawRecentGame {
  game_id: string;
  completed_at: string;
  was_home: boolean;
  our_score: number;
  opponent_score: number;
  opponent_team_id: string;
  opponent_name: string;
  won: boolean;
}

interface RawFlight {
  teamName?: string;
  managerName?: string;
  teamId?: string;
  roster: RawPlayer[];
  recentGames: RawRecentGame[];
}

/**
 * Pulls Next.js RSC flight chunks out of a server-rendered HTML page.
 * They look like: <script>self.__next_f.push([1,"...escaped JSON-ish..."])</script>
 */
function extractFlight(html: string): string {
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    try {
      out.push(JSON.parse('"' + m[1] + '"'));
    } catch {
      // skip malformed chunks
    }
  }
  return out.join('');
}

/**
 * Find the JSON object that begins at `start` (must point at `{`) and return
 * the substring through its matching `}`. String-aware so braces inside strings
 * don't confuse the depth counter.
 */
function readJsonObject(s: string, start: number): string | undefined {
  if (s[start] !== '{' && s[start] !== '[') return undefined;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Pull a top-level scalar string by key search. RSC flight isn't valid JSON whole, but per-key probes work. */
function findString(s: string, key: string): string | undefined {
  const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`);
  const m = s.match(re);
  if (!m) return undefined;
  try {
    return JSON.parse('"' + m[1] + '"');
  } catch {
    return m[1];
  }
}

function findArrayJson(s: string, key: string): unknown[] | undefined {
  const idx = s.indexOf(`"${key}":[`);
  if (idx < 0) return undefined;
  const arrStart = s.indexOf('[', idx);
  const text = readJsonObject(s, arrStart);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown[];
  } catch {
    return undefined;
  }
}

export function parseFlight(html: string): RawFlight {
  const joined = extractFlight(html);
  const teamName = findString(joined, 'teamName');
  const managerName = findString(joined, 'managerName');
  const teamId = findString(joined, 'teamId');
  const roster = (findArrayJson(joined, 'roster') as RawPlayer[] | undefined) ?? [];
  const recentGames =
    (findArrayJson(joined, 'recentGames') as RawRecentGame[] | undefined) ?? [];
  return { teamName, managerName, teamId, roster, recentGames };
}

const u = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

export function mapPlayer(rp: RawPlayer): Player {
  const fullName = [rp.first_name, rp.last_name].filter(Boolean).join(' ').trim();
  // Pitching stats belong to anyone who has PITCHED, not just players listed at
  // P — a Two Way slotted at another position was silently losing ERA/WHIP/IP/K.
  const isPitcher = rp.position === 'P' || rp.position === 'SP' || (rp.innings_pitched ?? 0) > 0;
  return {
    uuid: rp.player_id,
    name: fullName,
    archetype: u(rp.archetype),
    position: u(rp.position),
    bench: rp.is_starter === false,
    battingOrder:
      typeof rp.batting_position === 'number' && rp.batting_position >= 0
        ? rp.batting_position + 1
        : undefined,
    fieldingPosition: u(rp.fielding_position),
    rosterStatus: u(rp.roster_status),
    batting: {
      avg: u(rp.batting_avg),
      obp: u(rp.on_base_pct),
      slg: u(rp.slugging_pct),
      ops: u(rp.ops),
      ab: u(rp.at_bats),
      h: u(rp.hits),
      hr: u(rp.home_runs),
      rbi: u(rp.rbis),
      bb: u(rp.walks),
      k: u(rp.strikeouts),
      singles: u(rp.singles),
      doubles: u(rp.doubles),
      triples: u(rp.triples),
      runs: u(rp.runs),
      games: u(rp.games_played),
    },
    pitching: isPitcher
      ? {
          era: u(rp.era),
          whip: u(rp.whip),
          ip: u(rp.innings_pitched),
          k: u(rp.pitching_strikeouts),
          bb: u(rp.pitching_walks),
          h: u(rp.pitching_hits),
          pitches: u(rp.pitches_thrown),
          runsAllowed: u(rp.runs_allowed),
        }
      : undefined,
    fielding:
      rp.putouts != null || rp.assists != null || rp.errors != null || rp.fielding_pct != null
        ? {
            putouts: u(rp.putouts),
            assists: u(rp.assists),
            errors: u(rp.errors),
            fieldingPct: u(rp.fielding_pct),
          }
        : undefined,
  };
}

function mapRecentGame(rg: RawRecentGame): RecentGame {
  return {
    gameId: rg.game_id,
    completedAt: rg.completed_at,
    wasHome: rg.was_home,
    ourScore: rg.our_score,
    opponentScore: rg.opponent_score,
    opponentTeamId: rg.opponent_team_id,
    opponentName: rg.opponent_name,
    won: rg.won,
  };
}

export function parseTeamHtml(html: string): ParsedTeam {
  const flight = parseFlight(html);
  const players = flight.roster.map(mapPlayer);
  const pitcher = players.find((p) => p.pitching !== undefined);

  const wins = flight.recentGames.filter((g) => g.won).length;
  const losses = flight.recentGames.length - wins;

  const team: Team = {
    uuid: flight.teamId,
    name: flight.teamName,
    manager: flight.managerName,
    recentRecord: flight.recentGames.length ? `${wins}-${losses} (last ${flight.recentGames.length})` : undefined,
    players,
    pitcher,
    recentGames: flight.recentGames.map(mapRecentGame),
  };

  return { team, raw: flight };
}
