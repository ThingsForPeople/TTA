import { useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { CollapsiblePanel } from './CollapsiblePanel';
import { SIM_KEYS, SIM_LABELS, type SimStats, type PlayerMetaStore, type InjuryRecord, type InjurySeverity, injuryPenalty } from '../lib/playerMeta';
import {
  getAllPlayerHistories,
  getLatestDelta,
  trainingDayKey,
  type StatSnapshot,
} from '../lib/statHistory';
import type { Player, Team } from '../lib/types';

const INJURY_DOT_COLORS: Record<string, string> = {
  minor: '#facc15',
  major: '#fb923c',
  catastrophic: '#ef4444',
};

interface Props {
  team: Team;
  metaStore: PlayerMetaStore;
  // Bumped by the parent when stat snapshots are written/edited elsewhere
  // (RosterEditor). statHistory lives in localStorage, not React state, so we
  // re-read it whenever this changes — otherwise the chart and delta table stay
  // stale until a full page refresh.
  historyVersion?: number;
}

type ViewStat = 'ovr' | keyof SimStats;

const VIEW_OPTIONS: { value: ViewStat; label: string }[] = [
  { value: 'ovr', label: 'OVR' },
  ...SIM_KEYS.map((k) => ({ value: k as ViewStat, label: SIM_LABELS[k] })),
];

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function statValue(snap: StatSnapshot, stat: ViewStat): number {
  return stat === 'ovr' ? snap.ovr : snap.sim[stat];
}

export function TrainingPanel({ team, metaStore, historyVersion = 0 }: Props) {
  const [viewStat, setViewStat] = useState<ViewStat>('ovr');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // getAllPlayerHistories reads localStorage (not a real dep): team and
  // historyVersion are intentional re-read triggers, not values it consumes.
  const histories = useMemo(() => getAllPlayerHistories(), [team, historyVersion]);

  const playersWithHistory = useMemo(() => {
    return team.players
      .filter((p) => p.uuid && histories[p.uuid] && histories[p.uuid].length >= 2)
      .map((p) => ({ player: p, snapshots: histories[p.uuid!] }));
  }, [team.players, histories]);

  const togglePlayer = (uuid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(playersWithHistory.map((p) => p.player.uuid!)));
  };

  const chartPlayers = useMemo(() => {
    if (selected.size === 0) return playersWithHistory;
    return playersWithHistory.filter((p) => selected.has(p.player.uuid!));
  }, [playersWithHistory, selected]);

  // Stable color per player (keyed by full-roster index) so a player keeps the
  // same hue in the chart and the Latest-changes table, regardless of which
  // subset is currently selected for the chart.
  const colorByUuid = useMemo(() => {
    const m: Record<string, string> = {};
    playersWithHistory.forEach(({ player }, i) => {
      if (player.uuid) m[player.uuid] = PLAYER_COLORS[i % PLAYER_COLORS.length];
    });
    return m;
  }, [playersWithHistory]);

  return (
    <CollapsiblePanel title="Training progress" defaultOpen={playersWithHistory.length > 0}>
      <div className="space-y-6">
          {playersWithHistory.length === 0 ? (
            <p className="text-sm text-slate-500">
              No history yet — stat snapshots are recorded automatically when you edit sim stats in the roster editor.
              You need at least two snapshots per player to see trends.
            </p>
          ) : (
            <>
              {/* Controls */}
              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={viewStat}
                  onChange={(e) => setViewStat(e.target.value as ViewStat)}
                  className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
                >
                  {VIEW_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>

                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-slate-200"
                  >
                    all
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-slate-200"
                  >
                    none
                  </button>
                  {playersWithHistory.map(({ player }) => {
                    const active = selected.size === 0 || selected.has(player.uuid!);
                    return (
                      <button
                        key={player.uuid}
                        type="button"
                        onClick={() => togglePlayer(player.uuid!)}
                        className={
                          'rounded px-1.5 py-0.5 text-[10px] transition-colors ' +
                          (active
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'bg-slate-800 text-slate-500')
                        }
                      >
                        {player.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Chart */}
              <Chart players={chartPlayers} stat={viewStat} metaStore={metaStore} colorByUuid={colorByUuid} />

              <div className="flex items-center gap-4 text-[10px] text-slate-500">
                <span className="text-slate-600">Injuries:</span>
                {(['minor', 'major', 'catastrophic'] as const).map((s) => (
                  <span key={s} className="flex items-center gap-1">
                    <svg width="10" height="10" viewBox="0 0 10 10">
                      <polygon points="5,0 10,5 5,10 0,5" fill={INJURY_DOT_COLORS[s]} stroke="#0f172a" strokeWidth="1" />
                    </svg>
                    <span style={{ color: INJURY_DOT_COLORS[s] }}>{s}</span>
                  </span>
                ))}
              </div>

              {/* Delta table */}
              <DeltaTable players={playersWithHistory} colorByUuid={colorByUuid} />
            </>
          )}
        </div>
    </CollapsiblePanel>
  );
}

const PLAYER_COLORS = [
  '#34d399', '#60a5fa', '#f59e0b', '#f87171', '#a78bfa',
  '#fb923c', '#2dd4bf', '#e879f9', '#84cc16', '#38bdf8',
];

function ChartTooltip({ active, payload, label, injuryTimelines = {}, players = [] }: {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number }>;
  label?: number;
  injuryTimelines?: Record<string, InjuryAtTime>;
  players?: { player: Player }[];
}) {
  if (!active || !payload?.length || !label) return null;
  const injuryByName: Record<string, string> = {};
  for (const { player } of players) {
    if (!player.uuid) continue;
    const severity = injuryTimelines[player.uuid]?.get(label);
    if (severity) injuryByName[player.name] = severity;
  }
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 shadow-xl">
      <p className="mb-1 text-[10px] font-medium text-slate-400">{formatDate(label)}</p>
      {payload.map((entry) => {
        const severity = injuryByName[entry.name];
        const injColor = severity
          ? (INJURY_DOT_COLORS[severity] ?? INJURY_DOT_COLORS.minor)
          : undefined;
        const displayValue = severity
          ? Math.round(entry.value * injuryPenalty(severity as InjurySeverity))
          : entry.value;
        return (
          <div key={entry.name} className="flex items-center gap-2 text-xs">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span style={injColor ? { color: injColor } : undefined} className={injColor ? undefined : 'text-slate-300'}>
              {entry.name}
            </span>
            <span
              className="ml-auto font-mono font-semibold"
              style={injColor ? { color: injColor } : { color: 'white' }}
            >
              {displayValue}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type InjuryAtTime = Map<number, string>;

function buildInjuryTimeline(
  playerUuid: string,
  metaStore: PlayerMetaStore,
): InjuryAtTime {
  const map: InjuryAtTime = new Map();
  const meta = metaStore[playerUuid];
  if (!meta) return map;

  for (const rec of meta.injuryHistory ?? []) {
    const start = trainingDayKey(rec.date);
    const end = rec.resolvedDate ? trainingDayKey(rec.resolvedDate) : start;
    for (let t = start; t <= end; t += 86_400_000) {
      const existing = map.get(t);
      if (!existing || severityRank(rec.severity) > severityRank(existing)) {
        map.set(t, rec.severity);
      }
    }
  }

  if (meta.injury) {
    const start = trainingDayKey(meta.injury.date);
    const end = trainingDayKey(Date.now());
    for (let t = start; t <= end; t += 86_400_000) {
      const existing = map.get(t);
      if (!existing || severityRank(meta.injury.severity) > severityRank(existing)) {
        map.set(t, meta.injury.severity);
      }
    }
  }

  return map;
}

function severityRank(s: string): number {
  if (s === 'catastrophic') return 3;
  if (s === 'major') return 2;
  return 1;
}

// Least-squares slope of value vs. time, expressed per day.
function slopePerDay(points: { t: number; v: number }[]): number {
  if (points.length < 2) return 0;
  const dayMs = 86_400_000;
  const xs = points.map((p) => p.t / dayMs);
  const ys = points.map((p) => p.v);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function Chart({
  players,
  stat,
  metaStore,
  colorByUuid,
}: {
  players: { player: Player; snapshots: StatSnapshot[] }[];
  stat: ViewStat;
  metaStore: PlayerMetaStore;
  colorByUuid: Record<string, string>;
}) {
  const { data, domain } = useMemo(() => {
    const timeMap = new Map<number, Record<string, number>>();
    let vMin = Infinity, vMax = -Infinity;

    for (const { player, snapshots } of players) {
      const byDay = new Map<number, StatSnapshot>();
      for (const s of snapshots) {
        const dayKey = trainingDayKey(s.timestamp);
        const prev = byDay.get(dayKey);
        if (!prev || s.timestamp > prev.timestamp) byDay.set(dayKey, s);
      }

      for (const [dayKey, s] of byDay) {
        const v = statValue(s, stat);
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
        const existing = timeMap.get(dayKey) ?? {};
        existing[player.name] = v;
        timeMap.set(dayKey, existing);
      }
    }

    const sorted = Array.from(timeMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([ts, values]) => ({ timestamp: ts, ...values }));

    const vPad = Math.max(1, Math.ceil((vMax - vMin) * 0.1));
    return {
      data: sorted,
      domain: [Math.max(0, vMin - vPad), Math.min(99, vMax + vPad)] as [number, number],
    };
  }, [players, stat]);

  const injuryTimelines = useMemo(() => {
    const map: Record<string, InjuryAtTime> = {};
    for (const { player } of players) {
      if (player.uuid) map[player.uuid] = buildInjuryTimeline(player.uuid, metaStore);
    }
    return map;
  }, [players, metaStore]);

  return (
    <div className="h-[250px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis
            dataKey="timestamp"
            tickFormatter={formatDate}
            stroke="#475569"
            tick={{ fill: '#64748b', fontSize: 11 }}
            type="number"
            domain={['dataMin', 'dataMax']}
            scale="time"
          />
          <YAxis
            domain={domain}
            stroke="#475569"
            tick={{ fill: '#64748b', fontSize: 11 }}
          />
          <Tooltip content={<ChartTooltip injuryTimelines={injuryTimelines} players={players} />} />
          <Legend
            wrapperStyle={{ fontSize: 11, color: '#94a3b8' }}
          />
          {players.map(({ player }, idx) => {
            const timeline = player.uuid ? injuryTimelines[player.uuid] : undefined;
            const color = (player.uuid && colorByUuid[player.uuid]) || PLAYER_COLORS[idx % PLAYER_COLORS.length];
            return (
              <Line
                key={player.uuid}
                type="monotone"
                dataKey={player.name}
                stroke={color}
                strokeWidth={2}
                dot={(props: Record<string, unknown>) => {
                  const payload = props.payload && typeof props.payload === 'object' ? props.payload as Record<string, unknown> : undefined;
                  const ts = (payload?.timestamp as number) ?? 0;
                  const cx = props.cx as number;
                  const cy = props.cy as number;
                  // Skip days where this player has no snapshot — otherwise Recharts
                  // draws a stray dot at the top of the plot (cy≈0) for the gap.
                  if (payload?.[player.name] == null || cx == null || cy == null || Number.isNaN(cy)) {
                    return <g key={`${player.uuid}-${ts}-empty`} />;
                  }
                  const severity = timeline?.get(ts);
                  if (severity) {
                    const fill = INJURY_DOT_COLORS[severity] ?? INJURY_DOT_COLORS.minor;
                    const s = 5;
                    return (
                      <polygon
                        key={`${player.uuid}-${ts}`}
                        points={`${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`}
                        fill={fill}
                        stroke="#0f172a"
                        strokeWidth={1.5}
                      />
                    );
                  }
                  return (
                    <circle
                      key={`${player.uuid}-${ts}`}
                      cx={cx}
                      cy={cy}
                      r={3}
                      fill={color}
                      stroke="none"
                      strokeWidth={0}
                    />
                  );
                }}
                activeDot={{ r: 5, strokeWidth: 2, stroke: '#0f172a' }}
                connectNulls
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

type DeltaSortKey = 'name' | keyof SimStats | 'total' | 'perWeek';

function DeltaTable({
  players,
  colorByUuid,
}: {
  players: { player: Player; snapshots: StatSnapshot[] }[];
  colorByUuid: Record<string, string>;
}) {
  const [sortKey, setSortKey] = useState<DeltaSortKey>('total');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const baseRows = useMemo(
    () =>
      players
        .map(({ player: p, snapshots }) => {
          if (!p.uuid) return null;
          const delta = getLatestDelta(p.uuid);
          if (!delta) return null;
          const totalDiff = delta.deltas.reduce((sum, d) => sum + d.diff, 0);
          const byStat = {} as Record<keyof SimStats, number>;
          for (const d of delta.deltas) byStat[d.stat] = d.diff;
          // OVR growth rate per week — least-squares slope over the full
          // history (one point per training day, latest snapshot wins).
          const byDay = new Map<number, StatSnapshot>();
          for (const s of snapshots) {
            const k = trainingDayKey(s.timestamp);
            const prev = byDay.get(k);
            if (!prev || s.timestamp > prev.timestamp) byDay.set(k, s);
          }
          const points = Array.from(byDay.entries())
            .map(([t, s]) => ({ t, v: s.ovr }))
            .sort((a, b) => a.t - b.t);
          const perWeek = Math.round(slopePerDay(points) * 7 * 10) / 10;
          return { player: p, byStat, ovrDiff: delta.ovrDiff, totalDiff, perWeek };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null),
    [players],
  );

  const rows = useMemo(() => {
    const sorted = [...baseRows];
    sorted.sort((a, b) => {
      let av: number | string, bv: number | string;
      if (sortKey === 'name') {
        av = a.player.name.toLowerCase();
        bv = b.player.name.toLowerCase();
      } else if (sortKey === 'total') {
        av = a.totalDiff;
        bv = b.totalDiff;
      } else if (sortKey === 'perWeek') {
        av = a.perWeek;
        bv = b.perWeek;
      } else {
        av = a.byStat[sortKey] ?? 0;
        bv = b.byStat[sortKey] ?? 0;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [baseRows, sortKey, sortDir]);

  const toggleSort = (key: DeltaSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  if (baseRows.length === 0) return null;

  const sortArrow = (key: DeltaSortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const diffClass = (n: number) =>
    n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-slate-600';

  const fmt = (n: number) => `${n > 0 ? '+' : ''}${n}`;

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Latest changes
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
              <th
                className="cursor-pointer select-none px-2 py-1 text-left hover:text-slate-300"
                onClick={() => toggleSort('name')}
              >
                Player{sortArrow('name')}
              </th>
              {SIM_KEYS.map((k) => (
                <th
                  key={k}
                  className="cursor-pointer select-none px-2 py-1 text-right hover:text-slate-300"
                  onClick={() => toggleSort(k)}
                >
                  {SIM_LABELS[k]}{sortArrow(k)}
                </th>
              ))}
              <th
                className="cursor-pointer select-none px-2 py-1 text-right hover:text-slate-300"
                title="Total sim-stat increase (OVR change)"
                onClick={() => toggleSort('total')}
              >
                Δ (OVR){sortArrow('total')}
              </th>
              <th
                className="cursor-pointer select-none px-2 py-1 text-right hover:text-slate-300"
                title="OVR growth rate per week (least-squares slope over full history)"
                onClick={() => toggleSort('perWeek')}
              >
                OVR/wk{sortArrow('perWeek')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.player.uuid} className="border-b border-slate-800/60 last:border-0">
                <td className="px-2 py-1 text-slate-200">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: (row.player.uuid && colorByUuid[row.player.uuid]) || '#64748b' }}
                    />
                    {row.player.name}
                  </span>
                </td>
                {SIM_KEYS.map((k) => {
                  const diff = row.byStat[k] ?? 0;
                  return (
                    <td key={k} className={'px-2 py-1 text-right font-mono ' + diffClass(diff)}>
                      {diff > 0 ? '+' : ''}{diff || '·'}
                    </td>
                  );
                })}
                <td className={'px-2 py-1 text-right font-mono font-bold ' + diffClass(row.totalDiff)}>
                  {fmt(row.totalDiff)} <span className="font-normal text-slate-500">({fmt(row.ovrDiff)})</span>
                </td>
                <td className={'whitespace-nowrap px-2 py-1 text-right font-mono ' + diffClass(row.perWeek)}>
                  {fmt(row.perWeek)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
