'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RecentGame } from '../lib/types';
import type { ReplayEvaluation } from '../lib/parseReplay';
import { buildGamesContext } from '../lib/gameSummary';
import { GameAiAnalysis } from './GameAiAnalysis';
import { BoxScoreModal } from './BoxScoreModal';
import { TeamSearchBox } from './TeamSearchBox';

// Cap how many games the AI pass fetches replays for (each is an upstream
// ~2.8MB parse) so the subset stays gentle on the source and the context sane.
const AI_MAX_GAMES = 10;

interface GameRow {
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

type TimeFilter = 'today' | 'yesterday' | '7d' | '30d' | 'all';
const TIME_FILTERS: { value: TimeFilter; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All' },
];

const MATCHUP_PROMPT =
  'These are my team’s games against ONE opponent (most recent first). Analyze the matchup as a whole — look for patterns ACROSS games, not just one:\n\n' +
  '1. HOW WE FARE — the overall pattern vs this opponent (winning/losing, by how much, trending which way).\n' +
  '2. WHAT THEY DO TO US — recurring problems across these games (their pitching gives our bats trouble? they tee off on our pitching? a repeating inning/situation?).\n' +
  '3. WHAT WORKS FOR US — what has gone right that we should lean into.\n' +
  '4. ADJUSTMENTS — 2-3 concrete things to try next time.\n\n' +
  'CRITICAL CONSTRAINT — the ONLY two things I can change between games are (a) the BATTING ORDER ' +
  '(who hits in which of the 9 slots) and (b) FIELD POSITIONING (which player plays which defensive ' +
  'position). I CANNOT change pitch selection/usage, a pitcher’s pitch arsenal, player talents, sim ' +
  'stats, archetypes, or which pitcher starts — none of those are adjustable, so do NOT recommend them. ' +
  'Every adjustment in section 4 must be a batting-order or field-positioning move. You may still note ' +
  'observations about pitching/contact in sections 1-3 as context, but frame the actual recommendations ' +
  'purely around lineup and defensive alignment.\n\n' +
  'Small sample — don’t overstate. Be concise — bullets, not paragraphs.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Session-scoped cache of the games list per team, so switching away from the
// Matchups tab and back doesn't re-run the (cheap-but-not-free) games fetch.
const GAMES_TTL_MS = 120_000;
const gamesCache = new Map<string, { games: GameRow[]; ts: number }>();

function windowBounds(filter: TimeFilter, now: Date): { start?: number; end?: number } {
  if (filter === 'all') return {};
  if (filter === '7d') return { start: now.getTime() - 7 * 86_400_000 };
  if (filter === '30d') return { start: now.getTime() - 30 * 86_400_000 };
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (filter === 'today') return { start: midnight };
  return { start: midnight - 86_400_000, end: midnight }; // yesterday
}

// The scraped team already carries a recent-games window with every field the
// dropdown/record needs — map it to a GameRow so we can render from it with zero
// upstream calls. (recentGames has no game_mode; that column just shows '—'.)
function seedToRows(seed: RecentGame[]): GameRow[] {
  return seed.map((g) => ({
    gameId: g.gameId,
    completedAt: g.completedAt ?? null,
    gameMode: null,
    opponentTeamId: g.opponentTeamId ?? null,
    opponentName: g.opponentName ?? null,
    ourScore: g.ourScore ?? null,
    opponentScore: g.opponentScore ?? null,
    won: g.won ?? null,
    wasHome: g.wasHome ?? null,
  }));
}

export function Matchups({ teamUuid, seedGames = [] }: { teamUuid: string; seedGames?: RecentGame[] }) {
  // Seed from the already-scraped recentGames so the tab renders instantly with
  // no request — the games-list endpoint 429s hard, so we no longer fetch it on
  // mount. The Refresh button pulls a deeper (capped) window on demand.
  const [games, setGames] = useState<GameRow[]>(() => seedToRows(seedGames));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The opponent is chosen via the team search (any team), so the name no longer
  // has to come from our own game history — track both id and name.
  const [selectedOpp, setSelectedOpp] = useState<string>('');
  const [selectedOppName, setSelectedOppName] = useState<string>('');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [countN, setCountN] = useState(10); // 0 = all; default to the last 10 meetings
  const [activeGameId, setActiveGameId] = useState<string | null>(null);

  // Refresh re-pulls a fresh games window to widen head-to-head coverage beyond
  // the scrape seed. The only upstream call the tab makes on its own (the games
  // endpoint 429s on bursts), so it's an explicit, non-destructive action.
  const loadGames = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`/api/team/${teamUuid}/games?fresh=1`, { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      const rows = (json.games ?? []) as GameRow[];
      gamesCache.set(teamUuid, { games: rows, ts: Date.now() });
      setGames(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, [teamUuid]);

  // On open, reuse a deeper list already pulled this session (no network).
  useEffect(() => {
    const cached = gamesCache.get(teamUuid);
    if (cached && Date.now() - cached.ts < GAMES_TTL_MS) setGames(cached.games);
  }, [teamUuid]);

  // Opponents faced, most-recently-played first.
  const opponents = useMemo(() => {
    const m = new Map<string, { name: string; count: number; last: number }>();
    for (const g of games) {
      if (!g.opponentTeamId) continue;
      const e = m.get(g.opponentTeamId) ?? { name: g.opponentName ?? '(unknown)', count: 0, last: 0 };
      e.count++;
      const t = g.completedAt ? Date.parse(g.completedAt) : 0;
      if (t > e.last) e.last = t;
      if (g.opponentName) e.name = g.opponentName;
      m.set(g.opponentTeamId, e);
    }
    return [...m.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.last - a.last);
  }, [games]);

  // Default to the most-recently-played opponent (from the scrape) so the tab
  // isn't empty on open; the search lets you switch to any other team.
  useEffect(() => {
    if (!selectedOpp && opponents.length) {
      setSelectedOpp(opponents[0].id);
      setSelectedOppName(opponents[0].name);
    }
  }, [opponents, selectedOpp]);

  const pickOpponent = useCallback((t: { id: string; name: string }) => {
    setSelectedOpp(t.id);
    setSelectedOppName(t.name);
  }, []);

  // Prefer the explicitly-picked name; fall back to whatever our games show.
  const oppName = selectedOppName || opponents.find((o) => o.id === selectedOpp)?.name || '';

  const filtered = useMemo(() => {
    if (!selectedOpp) return [];
    const { start, end } = windowBounds(timeFilter, new Date());
    let rows = games.filter((g) => g.opponentTeamId === selectedOpp);
    if (start != null) rows = rows.filter((g) => g.completedAt && Date.parse(g.completedAt) >= start);
    if (end != null) rows = rows.filter((g) => g.completedAt && Date.parse(g.completedAt) < end);
    if (countN > 0) rows = rows.slice(0, countN); // already newest-first from the route
    return rows;
  }, [games, selectedOpp, timeFilter, countN]);

  const agg = useMemo(() => {
    let w = 0, l = 0, t = 0, rf = 0, ra = 0, homeW = 0, homeL = 0, awayW = 0, awayL = 0;
    for (const g of filtered) {
      if (g.ourScore != null && g.opponentScore != null) { rf += g.ourScore; ra += g.opponentScore; }
      const tie = g.ourScore != null && g.ourScore === g.opponentScore;
      const win = g.won === true || (g.won == null && g.ourScore != null && g.opponentScore != null && g.ourScore > g.opponentScore);
      if (tie) t++; else if (win) w++; else l++;
      if (g.wasHome === true) { if (win) homeW++; else if (!tie) homeL++; }
      else if (g.wasHome === false) { if (win) awayW++; else if (!tie) awayL++; }
    }
    const decided = w + l;
    return { w, l, t, rf, ra, count: filtered.length, winPct: decided ? w / decided : null, homeW, homeL, awayW, awayL };
  }, [filtered]);

  const prepareContext = useCallback(async () => {
    const subset = filtered.slice(0, AI_MAX_GAMES);
    const evals: ReplayEvaluation[] = [];
    for (const g of subset) {
      try {
        const res = await fetch(`/api/team/${teamUuid}/games/${g.gameId}/replay`);
        if (res.ok) evals.push(await res.json());
      } catch { /* skip a failed game */ }
      await sleep(500); // gentle on the rate-limited upstream
    }
    return buildGamesContext(evals, oppName);
  }, [filtered, teamUuid, oppName]);

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">Matchups</h2>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500">{games.length} games</span>
          <button
            type="button"
            onClick={() => loadGames()}
            disabled={refreshing}
            title="Pull a fresh games window from the server to widen head-to-head coverage"
            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 transition-colors hover:border-emerald-500 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Search for any team to see your head-to-head record and games against them.
      </p>

      {/* A Refresh failure (often a 429) is non-destructive: surface it inline
          but keep the current view rather than blanking the tab. */}
      {error && (
        <p className="mb-3 text-xs text-amber-300/90">Couldn’t refresh games: {error}. Showing what we have.</p>
      )}

      {/* Controls: opponent search + filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <TeamSearchBox
          placeholder={oppName ? `vs ${oppName} — search to change…` : 'Search opponent team…'}
          onPick={pickOpponent}
        />
        <div className="flex rounded border border-slate-700">
          {TIME_FILTERS.map((tf) => (
            <button
              key={tf.value}
              type="button"
              onClick={() => setTimeFilter(tf.value)}
              className={'px-2 py-1 transition-colors ' + (timeFilter === tf.value ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200')}
            >
              {tf.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-slate-400">
          Last
          <input
            type="number"
            min={1}
            value={countN || ''}
            placeholder="all"
            onChange={(e) => setCountN(Math.max(0, Number(e.target.value) || 0))}
            className="w-16 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-slate-300"
          />
          games
        </label>
      </div>

      {selectedOpp && (
        <div className="mb-2 text-sm text-slate-300">
          Head-to-head vs <span className="font-semibold text-emerald-300">{oppName}</span>
        </div>
      )}

      {!selectedOpp ? (
        <p className="text-sm text-slate-400">Search for an opponent above to see your head-to-head.</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-slate-400">
          No games vs {oppName} in this window. You may not have faced them recently — try “Refresh” to pull a wider window.
        </p>
      ) : (
        <>
              {/* Aggregate */}
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Record" value={`${agg.w}-${agg.l}${agg.t ? `-${agg.t}` : ''}`} sub={agg.winPct != null ? `${Math.round(agg.winPct * 100)}% win` : undefined} />
                <Stat label="Runs for / against" value={`${agg.rf} – ${agg.ra}`} sub={`${agg.rf - agg.ra >= 0 ? '+' : ''}${agg.rf - agg.ra} diff`} />
                <Stat label="Avg margin" value={agg.count ? `${((agg.rf - agg.ra) / agg.count >= 0 ? '+' : '')}${((agg.rf - agg.ra) / agg.count).toFixed(1)}` : '—'} sub={`${agg.count} games`} />
                <Stat label="Home / Away" value={`${agg.homeW}-${agg.homeL} / ${agg.awayW}-${agg.awayL}`} />
              </div>

              {/* Game list */}
              <div className="mb-3 overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
                      <th className="px-2 py-1 text-left">Date</th>
                      <th className="px-1.5 py-1 text-left">Mode</th>
                      <th className="px-1.5 py-1 text-center">H/A</th>
                      <th className="px-1.5 py-1 text-right">Result</th>
                      <th className="px-1.5 py-1 text-right">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((g) => {
                      const tie = g.ourScore != null && g.ourScore === g.opponentScore;
                      const win = g.won === true || (g.won == null && g.ourScore != null && g.opponentScore != null && g.ourScore > g.opponentScore);
                      return (
                        <tr
                          key={g.gameId}
                          onClick={() => setActiveGameId(g.gameId)}
                          className="cursor-pointer border-b border-slate-800/60 last:border-0 hover:bg-slate-800/30"
                        >
                          <td className="px-2 py-1 text-slate-300 whitespace-nowrap">{g.completedAt ? new Date(g.completedAt).toLocaleDateString() : '—'}</td>
                          <td className="px-1.5 py-1 text-slate-500">{(g.gameMode ?? '').replace('_', ' ') || '—'}</td>
                          <td className="px-1.5 py-1 text-center text-slate-500">{g.wasHome === true ? 'H' : g.wasHome === false ? 'A' : '·'}</td>
                          <td className={'px-1.5 py-1 text-right font-semibold ' + (tie ? 'text-slate-400' : win ? 'text-emerald-400' : 'text-red-400')}>{tie ? 'T' : win ? 'W' : 'L'}</td>
                          <td className="px-1.5 py-1 text-right font-mono text-slate-300">{g.ourScore ?? '?'}–{g.opponentScore ?? '?'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* AI matchup analysis (rate-limited via /api/advise) */}
              <GameAiAnalysis
                prepareContext={prepareContext}
                teamUuid={teamUuid}
                prompt={MATCHUP_PROMPT}
                actionType="matchup-analysis"
                title={`AI matchup analysis${oppName ? ` vs ${oppName}` : ''}`}
                hint={`Fetch the ${Math.min(filtered.length, AI_MAX_GAMES)} most-recent of these ${filtered.length} game(s) and analyze the matchup${filtered.length > AI_MAX_GAMES ? ` (capped at ${AI_MAX_GAMES})` : ''}.`}
              />
            </>
          )}

      {activeGameId && (
        <BoxScoreModal teamUuid={teamUuid} gameId={activeGameId} onClose={() => setActiveGameId(null)} />
      )}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="font-mono text-sm text-slate-100">{value}</div>
      {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}

