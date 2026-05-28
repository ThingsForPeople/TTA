import { useMemo, useState } from 'react';
import { ALL_STAT_KEYS, computeExtremes, formatStat, type StatKey } from '../lib/analysis';
import type { Player, Team } from '../lib/types';

interface Props {
  team: Team;
}

type SortKey = 'name' | 'position' | StatKey;
type SortDir = 'asc' | 'desc';

const COLUMN_LABELS: Record<StatKey, string> = {
  avg: 'AVG',
  obp: 'OBP',
  slg: 'SLG',
  ops: 'OPS',
  ab: 'AB',
  runs: 'R',
  h: 'H',
  hr: 'HR',
  rbi: 'RBI',
  bb: 'BB',
  k: 'K',
};

const isNumericKey = (k: SortKey): k is StatKey => k !== 'name' && k !== 'position';

function getSortValue(p: Player, key: SortKey, pgMode: boolean): string | number | undefined {
  if (key === 'name') return p.name;
  if (key === 'position') return p.position;
  const v = p.batting?.[key];
  if (pgMode && COUNTING_KEYS.has(key)) return perGame(v, p.batting?.games);
  return v;
}

const COUNTING_KEYS = new Set<StatKey>(['ab', 'runs', 'h', 'hr', 'rbi', 'bb', 'k']);

function perGame(v: number | undefined, games: number | undefined): number | undefined {
  if (v === undefined || !games) return undefined;
  return v / games;
}

function formatPerGame(v: number | undefined): string {
  if (v === undefined) return '—';
  return v.toFixed(1);
}

export function StatsTable({ team }: Props) {
  const players = team.players;
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);
  const [perGameMode, setPerGameMode] = useState(false);

  const extremes = computeExtremes(players, perGameMode);

  const sortedPlayers = useMemo(() => {
    if (!sort) return players;
    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    return [...players].sort((a, b) => {
      const av = getSortValue(a, key, perGameMode);
      const bv = getSortValue(b, key, perGameMode);
      if (av === undefined && bv === undefined) return 0;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
      return String(av).localeCompare(String(bv)) * mul;
    });
  }, [players, sort, perGameMode]);

  const handleSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: isNumericKey(key) ? 'desc' : 'asc' };
      return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
    });
  };

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
          Batting stats
        </h2>
        <button
          type="button"
          onClick={() => setPerGameMode((v) => !v)}
          className={
            'rounded-md border px-2 py-0.5 text-xs transition-colors ' +
            (perGameMode
              ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
              : 'border-slate-700 text-slate-400 hover:text-slate-200')
          }
        >
          {perGameMode ? 'avg/game' : 'totals'}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
              <SortableHeader
                label="Player"
                sortKey="name"
                sort={sort}
                onSort={handleSort}
                align="left"
              />
              <SortableHeader
                label="Pos"
                sortKey="position"
                sort={sort}
                onSort={handleSort}
                align="left"
              />
              {ALL_STAT_KEYS.map((k) => (
                <SortableHeader
                  key={k}
                  label={COLUMN_LABELS[k]}
                  sortKey={k}
                  sort={sort}
                  onSort={handleSort}
                  align="right"
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedPlayers.map((p, idx) => (
              <Row
                key={p.uuid ?? `${p.name}-${idx}`}
                player={p}
                extremes={extremes}
                perGameMode={perGameMode}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        <span className="rounded bg-emerald-500/15 px-1 py-0.5 text-emerald-300">green</span> = team
        high; <span className="rounded bg-red-500/15 px-1 py-0.5 text-red-300">red</span> = team
        low (per column, only when ≥2 players have a value).
      </p>
    </section>
  );
}

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  align,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir } | null;
  onSort: (key: SortKey) => void;
  align: 'left' | 'right';
}) {
  const active = sort?.key === sortKey;
  const dir = active ? sort.dir : undefined;
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <th
      aria-sort={ariaSort}
      className={`px-2 py-1.5 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={
          'inline-flex w-full items-center gap-1 uppercase tracking-wider transition-colors hover:text-slate-200 ' +
          (align === 'right' ? 'justify-end' : 'justify-start') +
          (active ? ' text-slate-200' : '')
        }
      >
        <span>{label}</span>
        <span className="w-2 text-emerald-400">
          {active ? (dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
  );
}

function Row({
  player,
  extremes,
  perGameMode,
}: {
  player: Player;
  extremes: ReturnType<typeof computeExtremes>;
  perGameMode: boolean;
}) {
  return (
    <tr className="border-b border-slate-800/60 last:border-0">
      <td className="px-2 py-1.5 text-slate-100">
        {player.name}
        {player.bench ? <span className="ml-2 text-xs text-slate-500">(bench)</span> : null}
      </td>
      <td className="px-2 py-1.5 text-slate-400">{player.position ?? '—'}</td>
      {ALL_STAT_KEYS.map((k) => {
        const raw = player.batting?.[k];
        const isCounting = COUNTING_KEYS.has(k);
        const v = perGameMode && isCounting ? perGame(raw, player.batting?.games) : raw;
        const ex = extremes[k];
        const isHigh = typeof v === 'number' && ex && v === ex.high && ex.high !== ex.low;
        const isLow = typeof v === 'number' && ex && v === ex.low && ex.high !== ex.low;
        const inverted = k === 'k';
        return (
          <td
            key={k}
            className={
              'px-2 py-1.5 text-right font-mono ' +
              (isHigh
                ? inverted ? 'text-red-300' : 'text-emerald-300'
                : isLow
                  ? inverted ? 'text-emerald-300' : 'text-red-300'
                  : 'text-slate-200')
            }
          >
            {perGameMode && isCounting ? formatPerGame(v) : formatStat(k, raw)}
          </td>
        );
      })}
    </tr>
  );
}
