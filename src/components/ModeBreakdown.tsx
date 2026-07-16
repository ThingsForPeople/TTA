'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { CollapsiblePanel } from './CollapsiblePanel';
import { fetchRosterStatsJson, type ModeFilter, type TimeFilter } from '../lib/api';
import { mapPlayer } from '../lib/parseTeam';
import type { BattingStats, Player } from '../lib/types';

interface Props {
  teamUuid: string;
  time: TimeFilter;
}

type CompareStat = 'avg' | 'obp' | 'slg' | 'ops' | 'hr' | 'rbi' | 'k' | 'bb';

const STAT_OPTIONS: { value: CompareStat; label: string }[] = [
  { value: 'avg', label: 'AVG' },
  { value: 'obp', label: 'OBP' },
  { value: 'slg', label: 'SLG' },
  { value: 'ops', label: 'OPS' },
  { value: 'hr', label: 'HR' },
  { value: 'rbi', label: 'RBI' },
  { value: 'k', label: 'K' },
  { value: 'bb', label: 'BB' },
];

// No gauntlet row: the upstream silently ignores mode=gauntlet, so the old
// Gauntlet column was actually showing unfiltered all-mode stats mislabeled.
const MODES: { key: ModeFilter; label: string; color: string }[] = [
  { key: 'quick_play', label: 'Quickplay', color: '#34d399' },
  { key: 'challenge', label: 'Challenge', color: '#60a5fa' },
  { key: 'season', label: 'Season', color: '#f59e0b' },
];

const RATE_STATS = new Set<CompareStat>(['avg', 'obp', 'slg', 'ops']);
const MIN_AB = 5;

function formatStatValue(stat: CompareStat, v: number | undefined): string {
  if (v === undefined) return '—';
  if (RATE_STATS.has(stat)) {
    return v >= 1 ? v.toFixed(3) : v.toFixed(3).replace(/^0/, '');
  }
  return String(Math.round(v));
}

interface ModeData {
  mode: ModeFilter;
  label: string;
  players: Player[];
}

function ModeTooltip({
  active,
  payload,
  label,
  stat,
}: {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number }>;
  label?: string;
  stat: CompareStat;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 shadow-xl">
      <p className="mb-1 text-[10px] font-medium text-slate-400">{label}</p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-2 text-xs">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-slate-300">{entry.name}</span>
          <span className="ml-auto font-mono font-semibold text-white">
            {formatStatValue(stat, entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ModeBreakdown({ teamUuid, time }: Props) {
  const [stat, setStat] = useState<CompareStat>('ops');
  const [modeData, setModeData] = useState<ModeData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const results = await Promise.all(
        MODES.map(async ({ key, label }) => {
          const raw = await fetchRosterStatsJson(teamUuid, { time, mode: key });
          const players = raw.map(mapPlayer);
          return { mode: key, label, players };
        }),
      );
      setModeData(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [teamUuid, time]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const chartData = useMemo(() => {
    const playerNames = new Set<string>();
    for (const md of modeData) {
      for (const p of md.players) {
        if (!p.bench && (p.batting?.ab ?? 0) >= MIN_AB) {
          playerNames.add(p.name);
        }
      }
    }

    return Array.from(playerNames)
      .sort()
      .map((name) => {
        const row: Record<string, string | number | undefined> = { name };
        for (const md of modeData) {
          const p = md.players.find((pl) => pl.name === name);
          if (p && (p.batting?.ab ?? 0) >= MIN_AB) {
            row[md.label] = p.batting?.[stat as keyof BattingStats];
          }
        }
        return row;
      })
      .filter((row) => MODES.some((m) => row[m.label] !== undefined));
  }, [modeData, stat]);

  const yDomain = useMemo(() => {
    if (!RATE_STATS.has(stat)) return undefined;
    let max = 0;
    for (const row of chartData) {
      for (const m of MODES) {
        const v = row[m.label];
        if (typeof v === 'number' && v > max) max = v;
      }
    }
    return [0, Math.min(Math.ceil(max * 10) / 10 + 0.1, 2)] as [number, number];
  }, [chartData, stat]);

  return (
    <CollapsiblePanel title="Mode breakdown" defaultOpen={false}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={stat}
          onChange={(e) => setStat(e.target.value as CompareStat)}
          className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
        >
          {STAT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={fetchAll}
          disabled={loading}
          className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p className="mb-3 text-xs text-red-400">{error}</p>
      )}

      {!loading && chartData.length === 0 && !error && (
        <p className="text-sm text-slate-500">
          No data available — players need at least {MIN_AB} AB in a mode to appear.
        </p>
      )}

      {chartData.length > 0 && (
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 8, right: 12, bottom: 4, left: -8 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis
                dataKey="name"
                stroke="#475569"
                tick={{ fill: '#94a3b8', fontSize: 10 }}
                angle={-35}
                textAnchor="end"
                height={60}
                interval={0}
              />
              <YAxis
                stroke="#475569"
                tick={{ fill: '#64748b', fontSize: 11 }}
                tickFormatter={(v: number) => formatStatValue(stat, v)}
                domain={yDomain}
              />
              <Tooltip content={<ModeTooltip stat={stat} />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {MODES.map(({ label, color }) => (
                <Bar
                  key={label}
                  dataKey={label}
                  fill={color}
                  radius={[2, 2, 0, 0]}
                  maxBarSize={24}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {!loading && modeData.length > 0 && (
        <ModeComparisonTable modeData={modeData} stat={stat} />
      )}
    </CollapsiblePanel>
  );
}

function ModeComparisonTable({
  modeData,
  stat,
}: {
  modeData: ModeData[];
  stat: CompareStat;
}) {
  const rows = useMemo(() => {
    const playerNames = new Set<string>();
    for (const md of modeData) {
      for (const p of md.players) {
        if (!p.bench && (p.batting?.ab ?? 0) >= MIN_AB) {
          playerNames.add(p.name);
        }
      }
    }

    return Array.from(playerNames)
      .map((name) => {
        const values: Record<string, { stat: number | undefined; ab: number }> = {};
        let bestMode = '';
        let bestVal = -Infinity;
        for (const md of modeData) {
          const p = md.players.find((pl) => pl.name === name);
          const val = p?.batting?.[stat as keyof BattingStats] as number | undefined;
          const ab = p?.batting?.ab ?? 0;
          values[md.label] = { stat: ab >= MIN_AB ? val : undefined, ab };
          if (val !== undefined && ab >= MIN_AB && val > bestVal) {
            bestVal = val;
            bestMode = md.label;
          }
        }
        return { name, values, bestMode };
      })
      .filter((r) => MODES.some((m) => r.values[m.label]?.stat !== undefined));
  }, [modeData, stat]);

  if (rows.length === 0) return null;

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
            <th className="px-2 py-1 text-left">Player</th>
            {MODES.map((m) => (
              <th key={m.key} className="px-2 py-1 text-right" style={{ color: m.color }}>
                {m.label}
              </th>
            ))}
            <th className="px-2 py-1 text-right">Best</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="border-b border-slate-800/60 last:border-0">
              <td className="px-2 py-1 text-slate-200">{row.name}</td>
              {MODES.map((m) => {
                const v = row.values[m.label]?.stat;
                const isBest = m.label === row.bestMode;
                return (
                  <td
                    key={m.key}
                    className={
                      'px-2 py-1 text-right font-mono ' +
                      (isBest ? 'font-bold text-emerald-400' : 'text-slate-300')
                    }
                  >
                    {formatStatValue(stat, v)}
                  </td>
                );
              })}
              <td className="px-2 py-1 text-right text-[10px] text-slate-400">
                {row.bestMode}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
