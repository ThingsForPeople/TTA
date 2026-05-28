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

export function TrainingPanel({ team, metaStore }: Props) {
  const [viewStat, setViewStat] = useState<ViewStat>('ovr');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const histories = useMemo(() => getAllPlayerHistories(), [team]);

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
              <Chart players={chartPlayers} stat={viewStat} metaStore={metaStore} />

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
              <DeltaTable players={playersWithHistory.map((p) => p.player)} />
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

function Chart({
  players,
  stat,
  metaStore,
}: {
  players: { player: Player; snapshots: StatSnapshot[] }[];
  stat: ViewStat;
  metaStore: PlayerMetaStore;
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
            return (
              <Line
                key={player.uuid}
                type="monotone"
                dataKey={player.name}
                stroke={PLAYER_COLORS[idx % PLAYER_COLORS.length]}
                strokeWidth={2}
                dot={(props: Record<string, unknown>) => {
                  const ts = props.payload && typeof props.payload === 'object' ? (props.payload as Record<string, unknown>).timestamp as number : 0;
                  const cx = props.cx as number;
                  const cy = props.cy as number;
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
                      fill={PLAYER_COLORS[idx % PLAYER_COLORS.length]}
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

function DeltaTable({ players }: { players: Player[] }) {
  const rows = players
    .map((p) => {
      if (!p.uuid) return null;
      const delta = getLatestDelta(p.uuid);
      if (!delta) return null;
      const totalDiff = delta.deltas.reduce((sum, d) => sum + d.diff, 0);
      return { player: p, ...delta, totalDiff };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.totalDiff - a.totalDiff);

  if (rows.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Latest changes
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-2 py-1 text-left">Player</th>
              {SIM_KEYS.map((k) => (
                <th key={k} className="px-2 py-1 text-right">{SIM_LABELS[k]}</th>
              ))}
              <th className="px-2 py-1 text-right">OVR</th>
              <th className="px-2 py-1 text-right">Days</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.player.uuid} className="border-b border-slate-800/60 last:border-0">
                <td className="px-2 py-1 text-slate-200">{row.player.name}</td>
                {row.deltas.map((d) => (
                  <td
                    key={d.stat}
                    className={
                      'px-2 py-1 text-right font-mono ' +
                      (d.diff > 0
                        ? 'text-emerald-400'
                        : d.diff < 0
                          ? 'text-red-400'
                          : 'text-slate-600')
                    }
                  >
                    {d.diff > 0 ? '+' : ''}{d.diff || '·'}
                  </td>
                ))}
                <td
                  className={
                    'px-2 py-1 text-right font-mono font-bold ' +
                    (row.ovrDiff > 0
                      ? 'text-emerald-400'
                      : row.ovrDiff < 0
                        ? 'text-red-400'
                        : 'text-slate-600')
                  }
                >
                  {row.ovrDiff > 0 ? '+' : ''}{row.ovrDiff}
                </td>
                <td className="px-2 py-1 text-right text-slate-500">
                  {row.daysBetween}d
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
