'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CollapsiblePanel } from './CollapsiblePanel';
import type { AggregatedPlayer } from '../lib/parseReplay';

// Replay-derived batting (contact quality) for the Stats → Batting section.
// Read-only: it reads the same /replay-metrics aggregate the Defense section
// syncs, so there's no sync control here — if it's empty, the Defense section's
// "Sync replays" is what populates it. `dataVersion` bumps when a sync there
// finishes, so this refetches without a page reload.

interface Props {
  teamUuid: string;
  dataVersion?: number;
}

const POS_LABEL: Record<number, string> = { 1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF' };

const rate3 = (v: number | null) => (v == null ? '·' : v.toFixed(3).replace(/^0/, ''));
const num1 = (v: number | null) => (v == null ? '·' : String(Math.round(v * 10) / 10));
const int = (v: number | null) => (v == null || v === 0 ? '·' : String(v));
const pctFmt = (v: number | null) => (v == null ? '·' : Math.round(v * 100) + '%');

interface Column {
  key: string;
  label: string;
  title?: string;
  get: (p: AggregatedPlayer) => number | null;
  fmt?: (v: number | null) => string;
}

const BATTING_COLS: Column[] = [
  { key: 'pa', label: 'PA', get: (p) => p.pa, fmt: int },
  { key: 'avg', label: 'AVG', get: (p) => p.avg, fmt: rate3 },
  { key: 'obp', label: 'OBP', get: (p) => p.obp, fmt: rate3 },
  { key: 'kRate', label: 'K%', get: (p) => p.kRate, fmt: pctFmt },
  { key: 'bbRate', label: 'BB%', get: (p) => p.bbRate, fmt: pctFmt },
  { key: 'avgEV', label: 'Avg EV', get: (p) => p.avgEV, fmt: num1 },
  { key: 'maxEV', label: 'Max EV', get: (p) => p.maxEV, fmt: num1 },
  { key: 'wobaCon', label: 'wOBAc', title: 'Actual wOBA on contact (balls in play)', get: (p) => p.wobaCon, fmt: rate3 },
  { key: 'xwobaCon', label: 'xwOBAc', title: 'Expected wOBA on contact from exit velo + launch angle — the hitter’s deserved contact quality, stripped of defense/luck. Above actual ⇒ unlucky; below ⇒ over-performing.', get: (p) => p.xwobaCon, fmt: rate3 },
  { key: 'sweetSpotRate', label: 'Sweet%', title: 'Launch angle 8–32°', get: (p) => p.sweetSpotRate, fmt: pctFmt },
  { key: 'whiffRate', label: 'Whiff%', get: (p) => p.whiffRate, fmt: pctFmt },
  { key: 'chases', label: 'Chase', title: 'Swings out of zone', get: (p) => p.chases, fmt: int },
  { key: 'avgVsL', label: 'AVG vL', title: 'Batting average vs left-handed pitchers (from matchup sims). Platoon read — pair with handedness talents and start/sit calls. Re-sync to populate; small samples are noisy.', get: (p) => p.avgVsL, fmt: rate3 },
  { key: 'avgVsR', label: 'AVG vR', title: 'Batting average vs right-handed pitchers (from matchup sims). Re-sync to populate.', get: (p) => p.avgVsR, fmt: rate3 },
  { key: 'veloFacedAvg', label: 'Velo', title: 'Avg pitch velocity faced. With mph-over-85 exposure, this is the input for valuing the Extinguisher talent (contact per mph above 85).', get: (p) => p.veloFacedAvg, fmt: num1 },
];

export function AdvancedBattingPanel({ teamUuid, dataVersion = 0 }: Props) {
  const [players, setPlayers] = useState<AggregatedPlayer[]>([]);
  const [totalGames, setTotalGames] = useState(0);
  const [hasDb, setHasDb] = useState(true);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('');
  const [lastN, setLastN] = useState(50);
  const [sortKey, setSortKey] = useState('pa');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (mode) qs.set('mode', mode);
    if (lastN) qs.set('games', String(lastN));
    try {
      const res = await fetch(`/api/team/${teamUuid}/replay-metrics?${qs}`);
      if (!res.ok) { setPlayers([]); setTotalGames(0); return; }
      const json = await res.json();
      setHasDb(json.hasDb !== false);
      setPlayers(json.players ?? []);
      setTotalGames(json.totalGames ?? 0);
    } catch {
      setPlayers([]);
    } finally {
      setLoading(false);
    }
  }, [teamUuid, mode, lastN]);

  // Refetch on filter change and whenever a Defense-section sync bumps dataVersion.
  useEffect(() => { load(); }, [load, dataVersion]);

  const sorted = useMemo(() => {
    const col = BATTING_COLS.find((c) => c.key === sortKey);
    const rows = [...players].filter((p) => p.pa > 0);
    rows.sort((a, b) => {
      if (sortKey === 'name') return sortDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      const av = col?.get(a) ?? -Infinity;
      const bv = col?.get(b) ?? -Infinity;
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return rows;
  }, [players, sortKey, sortDir]);

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc'); }
  };
  const arrow = (key: string) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <CollapsiblePanel
      title="Advanced batting"
      subtitle="Contact quality from game replays (exit velo, sweet-spot %, plate discipline) — not in the public stat API."
      defaultOpen={false}
    >
      {!hasDb ? (
        <p className="text-sm text-slate-400">
          Advanced batting requires the database tier (a <code className="text-slate-300">DATABASE_URL</code>).
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <select value={mode} onChange={(e) => setMode(e.target.value)} className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-slate-300">
              <option value="">All (excl. gauntlet)</option>
              <option value="season">Season</option>
              <option value="quick_play">Quickplay</option>
              <option value="challenge">Challenge</option>
              <option value="gauntlet">Gauntlet</option>
            </select>
            <label className="flex items-center gap-1 text-slate-400">
              Last
              <select value={lastN} onChange={(e) => setLastN(Number(e.target.value))} className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-slate-300">
                {[5, 10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              games
            </label>
            <span className="text-slate-500">{totalGames} game{totalGames === 1 ? '' : 's'} in view</span>
          </div>

          {loading ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-slate-400">
              No replay batting yet. Use <span className="text-emerald-300">Sync replays</span> in the Defense section below to populate it.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="cursor-pointer select-none px-2 py-1 text-left hover:text-slate-300" onClick={() => toggleSort('name')}>Player{arrow('name')}</th>
                    <th className="px-1.5 py-1 text-left">Pos</th>
                    <th className="px-1.5 py-1 text-right">G</th>
                    {BATTING_COLS.map((c) => (
                      <th key={c.key} title={c.title} className="cursor-pointer select-none px-1.5 py-1 text-right hover:text-slate-300" onClick={() => toggleSort(c.key)}>
                        {c.label}{arrow(c.key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((p) => (
                    <tr key={p.playerId} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-2 py-1 text-slate-200 whitespace-nowrap">{p.name}</td>
                      <td className="px-1.5 py-1 text-slate-400">{p.position != null ? POS_LABEL[p.position] ?? p.position : '·'}</td>
                      <td className="px-1.5 py-1 text-right font-mono text-slate-500">{p.games}</td>
                      {BATTING_COLS.map((c) => (
                        <td key={c.key} className="px-1.5 py-1 text-right font-mono text-slate-300">{(c.fmt ?? int)(c.get(p))}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-2 text-[10px] text-slate-600">
            EV is a sim-internal unit for comparison, not real mph. <strong>xwOBAc</strong> is the wOBA-on-contact a hitter’s exit-velo/launch-angle mix “deserves” (from a league model); comparing it to actual <strong>wOBAc</strong> separates real contact quality from luck/defense. Derived from replays, verified against box-score batting totals. (Re-sync to populate xwOBAc on older games.)
          </p>
        </>
      )}
    </CollapsiblePanel>
  );
}
