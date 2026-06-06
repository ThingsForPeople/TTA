'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { CollapsiblePanel } from './CollapsiblePanel';
import type { AggregatedPlayer, PositionImportance, PlayerPositionSplit } from '../lib/parseReplay';
import { DEFAULT_POSITION_IMPORTANCE, DEFAULT_STAT_WEIGHTS, type StatWeights } from '../lib/rosterOptimizer';
import { maxAssignment } from '../lib/assign';

interface Props {
  teamUuid: string;
  // Fired after a sync or after writing position-importance weights, so the
  // parent can tell the Overview-tab optimizer to re-fetch. Without it, synced
  // fielding metrics and applied weights only show after a full page refresh.
  onDataChange?: () => void;
}

const SYNC_BATCH = 3; // must match the server's MAX_BATCH
const POS_LABEL: Record<number, string> = { 1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF' };
const FIELDING_POS_ORDER = ['C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF'] as const;

// Effective importance multiplier for a position. impRecommended is the blend
// of skill-leverage + workload (catcher floored to its default) the server now
// computes; fall back to the older fields, then the hand-tuned default.
function effImp(pi: PositionImportance): number {
  if (typeof pi.impRecommended === 'number') return pi.impRecommended;
  if (pi.impLeverage != null) return pi.impLeverage;
  if (pi.xOuts >= 1) return pi.impXouts;
  return DEFAULT_POSITION_IMPORTANCE[pi.position] ?? 1;
}

type View = 'fielding' | 'batting' | 'positions' | 'alignment' | 'heatmap';
const VIEW_LABEL: Record<View, string> = { fielding: 'fielding', batting: 'batting', positions: 'by position', alignment: 'best alignment', heatmap: 'heat map' };

// Fielded-ball heat bin (mirrors the route's HeatBin). x,y are integer field
// coords (origin = home plate, +x = RF side, −y = deeper).
interface HeatBin { x: number; y: number; pos: string; outs: number; hits: number }
// Opponent spray bin — where balls were HIT against us (no position dimension).
interface SprayBin { x: number; y: number; outs: number; hits: number }

// Canonical fielding position order, as scorekeeping numbers (C,1B,2B,SS,3B,LF,CF,RF).
const POS_NUM_ORDER = [2, 3, 4, 6, 5, 7, 8, 9];

// Position-centric comparison: for each position, every player who's fielded
// there, ranked by PAE/game (the visible-set fit is mean-0 per position, so it's
// a fair "who's best here" read). Complements the per-player breakdown.
function PositionComparison({ players }: { players: AggregatedPlayer[] }) {
  const byPos = new Map<number, { name: string; s: PlayerPositionSplit }[]>();
  for (const p of players) {
    for (const s of p.byPosition ?? []) {
      if (s.chances <= 0 && s.plays <= 0 && s.stealAttempts <= 0) continue;
      (byPos.get(s.position) ?? byPos.set(s.position, []).get(s.position)!).push({ name: p.name, s });
    }
  }
  const present = POS_NUM_ORDER.filter((n) => byPos.has(n));
  if (present.length === 0) return <p className="text-sm text-slate-400">No fielding data yet.</p>;
  return (
    <div className="space-y-4">
      {present.map((n) => (
        <div key={n}>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            {POS_LABEL[n] ?? n} <span className="text-slate-600">({byPos.get(n)!.length})</span>
          </h4>
          {n === 2
            ? <CatcherCompare rows={byPos.get(n)!} />
            : <FielderCompare rows={byPos.get(n)!} />}
        </div>
      ))}
      <p className="text-[10px] text-slate-600">
        Fielders ranked by PAE/game at each position (fit to the visible set, so an average fielder ≈ 0; positive = better); catchers ranked by steal-prevention (CS%). ★ = best with enough sample; <span className="text-slate-500">~</span> = low sample.
      </p>
    </div>
  );
}

function FielderCompare({ rows }: { rows: { name: string; s: PlayerPositionSplit }[] }) {
  const sorted = rows.slice().sort((a, b) => b.s.paePerGame - a.s.paePerGame);
  const rankable = sorted.filter((r) => r.s.games >= MIN_SPLIT_GAMES && r.s.chances >= MIN_SPLIT_CHANCES);
  const best = rankable.length ? Math.max(...rankable.map((r) => r.s.paePerGame)) : null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
            <th className="px-2 py-1 text-left">Player</th>
            <th className="px-1.5 py-1 text-right">G</th>
            <th className="px-1.5 py-1 text-right">Ch</th>
            <th className="px-1.5 py-1 text-right" title="Plays above expected per game (position-relative)">PAE/g</th>
            <th className="px-1.5 py-1 text-right">Fld%</th>
            <th className="px-1.5 py-1 text-right">Range</th>
            <th className="px-1.5 py-1 text-right">Arm</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(({ name, s }) => {
            const low = s.games < MIN_SPLIT_GAMES || s.chances < MIN_SPLIT_CHANCES;
            const isBest = best != null && s.paePerGame === best && !low;
            return (
              <tr key={name} className={'border-b border-slate-800/60 last:border-0 ' + (isBest ? 'text-emerald-300' : low ? 'text-slate-500' : 'text-slate-300')}>
                <td className="px-2 py-1 whitespace-nowrap">
                  {name}{isBest && <span title="Best PAE/game here (enough sample)"> ★</span>}{low && <span title="Low sample — treat as rough"> ~</span>}
                </td>
                <td className="px-1.5 py-1 text-right font-mono">{s.games}</td>
                <td className="px-1.5 py-1 text-right font-mono">{s.chances}</td>
                <td className="px-1.5 py-1 text-right font-mono">{signed1(s.paePerGame)}</td>
                <td className="px-1.5 py-1 text-right font-mono">{rate3(s.fieldPct)}</td>
                <td className="px-1.5 py-1 text-right font-mono">{num1(s.rangeAvg)}</td>
                <td className="px-1.5 py-1 text-right font-mono">{num1(s.armAvg)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const MIN_STEAL_ATT = 5; // enough opponent steal attempts to trust a CS%

// Catcher comparison is steal-defense (CS%), not batted-ball PAE.
function CatcherCompare({ rows }: { rows: { name: string; s: PlayerPositionSplit }[] }) {
  const withCs = rows.map((r) => ({ ...r, cs: r.s.stealAttempts > 0 ? r.s.caughtStealing / r.s.stealAttempts : null }));
  withCs.sort((a, b) => (b.cs ?? -1) - (a.cs ?? -1));
  const rankable = withCs.filter((r) => r.s.stealAttempts >= MIN_STEAL_ATT && r.cs != null);
  const best = rankable.length ? Math.max(...rankable.map((r) => r.cs!)) : null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
            <th className="px-2 py-1 text-left">Player</th>
            <th className="px-1.5 py-1 text-right">G</th>
            <th className="px-1.5 py-1 text-right" title="Opponent steal attempts faced">SB att</th>
            <th className="px-1.5 py-1 text-right" title="Runners caught stealing">CS</th>
            <th className="px-1.5 py-1 text-right" title="Steal prevention: caught / attempts">CS%</th>
          </tr>
        </thead>
        <tbody>
          {withCs.map(({ name, s, cs }) => {
            const low = s.stealAttempts < MIN_STEAL_ATT;
            const isBest = best != null && cs === best && !low;
            return (
              <tr key={name} className={'border-b border-slate-800/60 last:border-0 ' + (isBest ? 'text-emerald-300' : low ? 'text-slate-500' : 'text-slate-300')}>
                <td className="px-2 py-1 whitespace-nowrap">
                  {name}{isBest && <span title="Best steal prevention (enough attempts)"> ★</span>}{low && <span title="Few attempts — treat as rough"> ~</span>}
                </td>
                <td className="px-1.5 py-1 text-right font-mono">{s.games}</td>
                <td className="px-1.5 py-1 text-right font-mono">{s.stealAttempts || '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono">{s.caughtStealing || '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono">{cs == null ? '·' : Math.round(cs * 100) + '%'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Best alignment ───────────────────────────────────────────────────
// Optimal player→position assignment over the context-corrected PAE matrix:
// each fielder fills one spot, total importance-weighted value maximized. This
// is the "best overall team composition" read — unlike "best player per
// position" (which picks each column independently and can double-book a player
// who's tops at two spots). Only positions a player has actually fielded are
// eligible (PAE can't score reps that don't exist). Replay-only; the Overview
// optimizer is the sim-stat-aware counterpart that also benefits from the fix.
interface AlignSlot {
  posNum: number;
  importance: number;
  name: string | null;
  split: PlayerPositionSplit | null;
  low: boolean;
  csRate: number | null; // catcher only
}

function computeAlignment(players: AggregatedPlayer[], posImp: PositionImportance[]): { slots: AlignSlot[]; benched: string[] } {
  // Importance keyed by scorekeeping number (posImp is keyed by label string).
  const labelToNum = new Map(Object.entries(POS_LABEL).map(([n, s]) => [s, Number(n)]));
  const impByNum = new Map<number, number>();
  for (const pi of posImp) {
    const num = labelToNum.get(pi.position);
    if (num) impByNum.set(num, effImp(pi));
  }
  const imp = (posNum: number) => impByNum.get(posNum) ?? 1;

  const eligibleSplit = (s: PlayerPositionSplit) => (s.position === 2 ? s.stealAttempts > 0 : s.chances > 0);
  const candidates = players
    .map((p) => ({ p, splits: (p.byPosition ?? []).filter(eligibleSplit) }))
    .filter((c) => c.splits.length > 0);

  // Team mean CS rate, for the catcher's steal-defense value (no batted-ball PAE).
  let csCaught = 0, csAtt = 0;
  for (const c of candidates) for (const s of c.splits) {
    if (s.position === 2) { csCaught += s.caughtStealing; csAtt += s.stealAttempts; }
  }
  const meanCs = csAtt > 0 ? csCaught / csAtt : 0;

  const splitAt = (c: (typeof candidates)[number], posNum: number) => c.splits.find((s) => s.position === posNum) ?? null;
  // Per-game value in PAE-equivalent units: PAE/game for fielders; caught-
  // stealing above the team average per game for the catcher.
  const perGameValue = (s: PlayerPositionSplit): number => {
    if (s.position === 2) {
      const above = s.caughtStealing - meanCs * s.stealAttempts;
      return s.games > 0 ? above / s.games : 0;
    }
    return s.paePerGame;
  };

  // weight[positionRow][candidateCol] = importance × per-game value, null if the
  // player never fielded that spot.
  const weight: (number | null)[][] = POS_NUM_ORDER.map((posNum) =>
    candidates.map((c) => {
      const s = splitAt(c, posNum);
      return s ? imp(posNum) * perGameValue(s) : null;
    }),
  );

  const rowToCol = maxAssignment(weight);
  const assignedCols = new Set<number>();
  const slots: AlignSlot[] = POS_NUM_ORDER.map((posNum, i) => {
    const col = rowToCol[i];
    if (col == null || col < 0) return { posNum, importance: imp(posNum), name: null, split: null, low: false, csRate: null };
    assignedCols.add(col);
    const c = candidates[col];
    const s = splitAt(c, posNum)!;
    const low = posNum === 2 ? s.stealAttempts < MIN_STEAL_ATT : s.games < MIN_SPLIT_GAMES || s.chances < MIN_SPLIT_CHANCES;
    const csRate = posNum === 2 && s.stealAttempts > 0 ? s.caughtStealing / s.stealAttempts : null;
    return { posNum, importance: imp(posNum), name: c.p.name, split: s, low, csRate };
  });

  const benched = candidates.filter((_, idx) => !assignedCols.has(idx)).map((c) => c.p.name);
  return { slots, benched };
}

function BestAlignment({ players, posImp }: { players: AggregatedPlayer[]; posImp: PositionImportance[] }) {
  const { slots, benched } = useMemo(() => computeAlignment(players, posImp), [players, posImp]);
  if (!slots.some((s) => s.name)) return <p className="text-sm text-slate-400">No fielding data yet — sync replays first.</p>;
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-2 py-1 text-left">Pos</th>
              <th className="px-2 py-1 text-left">Player</th>
              <th className="px-1.5 py-1 text-right" title="Derived position importance (higher = defense matters more here)">Imp</th>
              <th className="px-1.5 py-1 text-right">G</th>
              <th className="px-1.5 py-1 text-right" title="Plays above expected per game at this spot (context-corrected), or steal-prevention for C">Value</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((s) => (
              <tr key={s.posNum} className={'border-b border-slate-800/60 last:border-0 ' + (s.name ? (s.low ? 'text-slate-500' : 'text-slate-200') : 'text-amber-400/80')}>
                <td className="px-2 py-1 font-medium text-slate-300">{POS_LABEL[s.posNum] ?? s.posNum}</td>
                <td className="px-2 py-1 whitespace-nowrap">
                  {s.name ?? '— no data'}
                  {s.low && <span title="Low sample — treat as rough"> ~</span>}
                </td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-400">{s.importance.toFixed(2)}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-400">{s.split ? s.split.games : '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">
                  {s.split == null
                    ? '·'
                    : s.posNum === 2
                      ? (s.csRate == null ? '·' : Math.round(s.csRate * 100) + '% CS')
                      : signed1(s.split.paePerGame)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {benched.length > 0 && (
        <p className="text-[11px] text-slate-500">
          Not in the optimal alignment: <span className="text-slate-400">{benched.join(', ')}</span>.
        </p>
      )}
      <p className="text-[10px] text-slate-600">
        Optimal player→position assignment (each player one spot) maximizing importance-weighted, context-corrected
        PAE/game. Only positions a player has <em>actually fielded</em> are eligible — PAE can’t score a spot with no
        reps (shown “no data”). Values are position-relative (≈0 = average fielder there); small samples are noisy
        (<span className="text-slate-500">~</span>); the catcher is ranked by steal prevention, not batted-ball PAE.
      </p>
    </div>
  );
}

interface Column {
  key: string;
  label: string;
  title?: string;
  get: (p: AggregatedPlayer) => number | null;
  fmt?: (v: number | null) => string;
}

const rate3 = (v: number | null) => (v == null ? '·' : v.toFixed(3).replace(/^0/, ''));
const num1 = (v: number | null) => (v == null ? '·' : String(Math.round(v * 10) / 10));
const int = (v: number | null) => (v == null || v === 0 ? '·' : String(v));

const signed1 = (v: number | null) => (v == null ? '·' : (v > 0 ? '+' : '') + (Math.round(v * 10) / 10));

const FIELDING_COLS: Column[] = [
  { key: 'pae', label: 'PAE', title: 'Plays Above Expected — outs made minus expected, given how far each ball was (range-calibrated). 0 = average, positive = better.', get: (p) => p.pae, fmt: signed1 },
  { key: 'expectedOuts', label: 'xOuts', title: 'Expected outs from the balls this fielder engaged', get: (p) => p.expectedOuts, fmt: num1 },
  { key: 'plays', label: 'Plays', title: 'Putouts + assists', get: (p) => p.plays, fmt: int },
  { key: 'putouts', label: 'PO', get: (p) => p.putouts, fmt: int },
  { key: 'assists', label: 'A', get: (p) => p.assists, fmt: int },
  { key: 'fieldErrors', label: 'E', title: 'Misplays', get: (p) => p.fieldErrors, fmt: int },
  { key: 'fieldPct', label: 'Fld%', title: 'Plays / (plays + errors)', get: (p) => p.fieldPct, fmt: rate3 },
  { key: 'rangeAvg', label: 'Range', title: 'Avg distance covered to field a ball (sim units)', get: (p) => p.rangeAvg, fmt: num1 },
  { key: 'armAvg', label: 'Arm', title: 'Avg throw speed', get: (p) => p.armAvg, fmt: num1 },
  { key: 'armMax', label: 'Arm↑', title: 'Max throw speed', get: (p) => p.armMax, fmt: num1 },
  { key: 'releaseAvg', label: 'Rel', title: 'Avg release time (lower = quicker)', get: (p) => p.releaseAvg, fmt: (v) => (v == null ? '·' : v.toFixed(2)) },
  { key: 'closePlays', label: 'Tough', title: 'Difficult plays converted', get: (p) => p.closePlays, fmt: int },
  { key: 'dp', label: 'DP', title: 'Double plays turned (any role: started / pivoted / finished), summed across games', get: (p) => p.dp, fmt: int },
  { key: 'caughtStealing', label: 'CS', title: 'Runners caught stealing (catcher) — attempts & rate shown in insights', get: (p) => p.caughtStealing, fmt: int },
];

const BATTING_COLS: Column[] = [
  { key: 'pa', label: 'PA', get: (p) => p.pa, fmt: int },
  { key: 'avg', label: 'AVG', get: (p) => p.avg, fmt: rate3 },
  { key: 'obp', label: 'OBP', get: (p) => p.obp, fmt: rate3 },
  { key: 'kRate', label: 'K%', get: (p) => p.kRate, fmt: (v) => (v == null ? '·' : Math.round(v * 100) + '%') },
  { key: 'bbRate', label: 'BB%', get: (p) => p.bbRate, fmt: (v) => (v == null ? '·' : Math.round(v * 100) + '%') },
  { key: 'avgEV', label: 'Avg EV', get: (p) => p.avgEV, fmt: num1 },
  { key: 'maxEV', label: 'Max EV', get: (p) => p.maxEV, fmt: num1 },
  { key: 'sweetSpotRate', label: 'Sweet%', title: 'Launch angle 8–32°', get: (p) => p.sweetSpotRate, fmt: (v) => (v == null ? '·' : Math.round(v * 100) + '%') },
  { key: 'whiffRate', label: 'Whiff%', get: (p) => p.whiffRate, fmt: (v) => (v == null ? '·' : Math.round(v * 100) + '%') },
  { key: 'chases', label: 'Chase', title: 'Swings out of zone', get: (p) => p.chases, fmt: int },
];

// A per-position split is "rankable" (eligible to be flagged best) only with
// enough sample — PAE/game is noisy below this, so a 1-game +3 doesn't win.
const MIN_SPLIT_GAMES = 5;
const MIN_SPLIT_CHANCES = 12;

// Per-player best-position breakdown: one row per fielding position played,
// most-played first, best PAE/game (among rankable splits) starred. The
// out-curves are calibrated mean-0 per position (see POS_CURVE), so PAE/game is
// comparable across a player's positions — a positive value = above the typical
// fielder at that spot.
function PositionBreakdown({ player, colSpan }: { player: AggregatedPlayer; colSpan: number }) {
  const splits = (player.byPosition ?? []).filter((s) => s.chances > 0 || s.plays > 0);
  if (splits.length === 0) return null;
  const rankable = splits.filter((s) => s.games >= MIN_SPLIT_GAMES && s.chances >= MIN_SPLIT_CHANCES);
  const bestPae = rankable.length ? Math.max(...rankable.map((s) => s.paePerGame)) : null;
  return (
    <tr className="bg-slate-950/40">
      <td colSpan={colSpan} className="px-3 py-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{player.name} — by position</div>
        <table className="text-[11px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-600">
              {['Pos', 'G', 'Ch', 'Plays', 'E', 'Fld%', 'PAE', 'PAE/g', 'Range', 'Arm'].map((h) => (
                <th key={h} className={'px-2 py-0.5 ' + (h === 'Pos' ? 'text-left' : 'text-right')}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {splits.map((s) => {
              const low = s.games < MIN_SPLIT_GAMES || s.chances < MIN_SPLIT_CHANCES;
              const isBest = bestPae != null && s.paePerGame === bestPae && !low;
              return (
                <tr key={s.position} className={'border-t border-slate-800/60 ' + (isBest ? 'text-emerald-300' : low ? 'text-slate-500' : 'text-slate-300')}>
                  <td className="px-2 py-0.5 text-left font-medium">
                    {POS_LABEL[s.position] ?? s.position}{isBest && <span title="Best PAE/game among positions with enough sample"> ★</span>}{low && <span title="Low sample — treat as rough"> ~</span>}
                  </td>
                  <td className="px-2 py-0.5 text-right font-mono">{s.games}</td>
                  <td className="px-2 py-0.5 text-right font-mono">{s.chances}</td>
                  <td className="px-2 py-0.5 text-right font-mono">{int(s.plays)}</td>
                  <td className="px-2 py-0.5 text-right font-mono">{int(s.fieldErrors)}</td>
                  <td className="px-2 py-0.5 text-right font-mono">{rate3(s.fieldPct)}</td>
                  <td className="px-2 py-0.5 text-right font-mono">{signed1(s.pae)}</td>
                  <td className="px-2 py-0.5 text-right font-mono">{signed1(s.paePerGame)}</td>
                  <td className="px-2 py-0.5 text-right font-mono">{num1(s.rangeAvg)}</td>
                  <td className="px-2 py-0.5 text-right font-mono">{num1(s.armAvg)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-1 text-[10px] text-slate-600">
          PAE/g is <em>position-relative</em> (the out-curve is calibrated so an average fielder ≈ 0 at each spot), so it’s comparable across a player’s rows — positive = above the typical fielder there. ★ = best among spots with ≥{MIN_SPLIT_GAMES}G &amp; ≥{MIN_SPLIT_CHANCES} chances; <span className="text-slate-500">~</span> = low sample. PAE only scores balls actually reached, so it can’t see range a fielder lacks.
        </p>
      </td>
    </tr>
  );
}

// Fielder home positions (scorekeeping spots), for orienting the heat map.
// Same coordinate space as the bins: origin = home plate, +x = RF side, −y deeper.
const FIELD_HOMES: { pos: string; x: number; y: number }[] = [
  { pos: 'P', x: 0, y: -19 }, { pos: 'C', x: 0, y: 3 },
  { pos: '1B', x: 19, y: -26 }, { pos: '2B', x: 9, y: -44 }, { pos: '3B', x: -19, y: -26 },
  { pos: 'SS', x: -10, y: -43 }, { pos: 'LF', x: -30, y: -59 }, { pos: 'CF', x: -1, y: -78 }, { pos: 'RF', x: 30, y: -59 },
];
// Field → SVG: x∈[−52,52]→[0,104], y∈[−100,8]→[108,0] (home at bottom, OF at top).
const HM_W = 104, HM_H = 108, HM_CELL = 4;
const fx = (x: number) => x + 52;
const fy = (y: number) => y + 100;

type Cell = { x: number; y: number; outs: number; hits: number };

// Presentational field plot: home plate bottom-center, OF up top, faint
// position markers for orientation. Cell color = out-rate (green=out, red=hit),
// brightness = volume.
function FieldHeat({ cells, label }: { cells: Cell[]; label: string }) {
  const maxN = Math.max(1, ...cells.map((c) => c.outs + c.hits));
  return (
    <svg viewBox={`0 0 ${HM_W} ${HM_H}`} className="w-full rounded-md border border-slate-800 bg-slate-950/60" role="img" aria-label={label}>
      {FIELD_HOMES.map((h) => (
        <g key={h.pos} opacity={0.5}>
          <circle cx={fx(h.x)} cy={fy(h.y)} r={1.2} fill="none" stroke="#475569" strokeWidth={0.4} />
          <text x={fx(h.x)} y={fy(h.y) - 2} fill="#64748b" fontSize={3} textAnchor="middle">{h.pos}</text>
        </g>
      ))}
      {cells.map((c, i) => {
        const n = c.outs + c.hits;
        const outRate = n ? c.outs / n : 0;
        const r = Math.round(220 * (1 - outRate) + 40 * outRate);
        const g = Math.round(60 * (1 - outRate) + 200 * outRate);
        return (
          <rect
            key={i}
            x={fx(c.x) - HM_CELL / 2}
            y={fy(c.y) - HM_CELL / 2}
            width={HM_CELL}
            height={HM_CELL}
            rx={0.6}
            fill={`rgb(${r},${g},70)`}
            opacity={0.2 + 0.8 * (n / maxN)}
          >
            <title>{`${c.outs} out / ${c.hits} hit`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function HeatMaps({ heatBins, sprayBins }: { heatBins: HeatBin[]; sprayBins: SprayBin[] }) {
  const [pos, setPos] = useState<string>('all');
  const present = useMemo(
    () => FIELDING_POS_ORDER.filter((p) => heatBins.some((b) => b.pos === p)),
    [heatBins],
  );
  const activePos = pos !== 'all' && !present.includes(pos as (typeof present)[number]) ? 'all' : pos;

  // Fielding cells: filter to one position, or merge per-position cells at the
  // same location for "all".
  const fieldingCells = useMemo<Cell[]>(() => {
    if (activePos !== 'all') return heatBins.filter((b) => b.pos === activePos);
    const m = new Map<string, Cell>();
    for (const b of heatBins) {
      const k = `${b.x}|${b.y}`;
      const e = m.get(k) ?? { x: b.x, y: b.y, outs: 0, hits: 0 };
      e.outs += b.outs; e.hits += b.hits;
      m.set(k, e);
    }
    return [...m.values()];
  }, [heatBins, activePos]);

  if (heatBins.length === 0 && sprayBins.length === 0) {
    return <p className="text-sm text-slate-400">No ball-location data yet — run <span className="text-emerald-300">Clear &amp; re-sync</span> to backfill engagement + spray coordinates into stored games.</p>;
  }

  const tally = (cells: Cell[]) => cells.reduce((a, c) => ({ o: a.o + c.outs, h: a.h + c.hits }), { o: 0, h: 0 });
  const spray = tally(sprayBins);
  const field = tally(fieldingCells);

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Where balls were HIT against us (true spray) */}
        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
            <h4 className="font-semibold text-slate-300">Where balls were hit (vs us)</h4>
            <span className="text-slate-500">{spray.o + spray.h} · {spray.o} out / {spray.h} hit</span>
          </div>
          {sprayBins.length > 0
            ? <FieldHeat cells={sprayBins} label="Opponent batted-ball spray" />
            : <p className="text-[11px] text-slate-500">No spray yet — re-sync to backfill.</p>}
        </div>

        {/* Where WE fielded them */}
        <div>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <h4 className="font-semibold text-slate-300">Where we fielded them</h4>
            <select
              value={activePos}
              onChange={(e) => setPos(e.target.value)}
              className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-slate-300"
            >
              <option value="all">All positions</option>
              {present.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          {heatBins.length > 0
            ? <FieldHeat cells={fieldingCells} label="Fielded-ball heat map" />
            : <p className="text-[11px] text-slate-500">No engagement data yet — re-sync to backfill.</p>}
          <p className="mt-0.5 text-right text-[10px] text-slate-500">{field.o + field.h} fielded · {field.o} out / {field.h} hit</p>
        </div>
      </div>

      <p className="mt-2 text-[10px] text-slate-600">
        Color = out-rate (<span className="text-emerald-400">green</span> = we got the out, <span className="text-red-400">red</span> = hit);
        brightness = volume. Home plate bottom-center, outfield up top. <strong>Left</strong> is a true spray (where the ball was hit, from
        contact angle+depth — includes balls that got through, so red clusters reveal gaps). <strong>Right</strong> is where our fielders
        actually engaged them; a ball that gets through is logged wherever the next fielder picked it up, so its gaps don’t mean “no ball went there.”
      </p>
    </div>
  );
}

export function AdvancedStatsPanel({ teamUuid, onDataChange }: Props) {
  const [players, setPlayers] = useState<AggregatedPlayer[]>([]);
  const [posImp, setPosImp] = useState<PositionImportance[]>([]);
  const [derivedStatWeights, setDerivedStatWeights] = useState<StatWeights>({});
  const [heatBins, setHeatBins] = useState<HeatBin[]>([]);
  const [sprayBins, setSprayBins] = useState<SprayBin[]>([]);
  const [applyState, setApplyState] = useState<'idle' | 'applying' | 'done'>('idle');
  const [totalGames, setTotalGames] = useState(0);
  const [hasDb, setHasDb] = useState(true);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('fielding');
  const [mode, setMode] = useState('');
  const [lastN, setLastN] = useState(50);
  const [sortKey, setSortKey] = useState('pae');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (mode) qs.set('mode', mode);
    if (lastN) qs.set('games', String(lastN));
    try {
      const res = await fetch(`/api/team/${teamUuid}/replay-metrics?${qs}`);
      if (!res.ok) {
        // 401 (signed out) etc. — show empty state rather than a scary error.
        setPlayers([]);
        setTotalGames(0);
        return;
      }
      const json = await res.json();
      setHasDb(json.hasDb !== false);
      setPlayers(json.players ?? []);
      setPosImp(json.positionImportance ?? []);
      setDerivedStatWeights(json.statWeights ?? {});
      setHeatBins(json.heatBins ?? []);
      setSprayBins(json.sprayBins ?? []);
      setTotalGames(json.totalGames ?? 0);
    } catch {
      setError('Failed to load metrics');
    } finally {
      setLoading(false);
    }
  }, [teamUuid, mode, lastN]);

  useEffect(() => { loadMetrics(); }, [loadMetrics]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      let prevRemaining = Infinity;
      // Re-enumerate each round so transiently-failed games get retried until
      // none remain or we stop making progress (resilient to rate limiting).
      for (let round = 0; round < 15; round++) {
        const list = await fetch(`/api/team/${teamUuid}/replay-sync`).then((r) => r.json());
        if (!list.hasDb) { setHasDb(false); break; }
        const synced = new Set<string>(list.syncedGameIds);
        const total: number = (list.games ?? []).length;
        const todo = (list.games ?? []).filter((g: { gameId: string }) => !synced.has(g.gameId));
        setProgress({ done: total - todo.length, total });
        if (todo.length === 0) break;
        if (todo.length >= prevRemaining) {
          // No progress this round — stop and report the stragglers.
          setError(`${todo.length} game(s) couldn’t be synced (upstream errors). Try Sync again later.`);
          break;
        }
        prevRemaining = todo.length;

        let done = total - todo.length;
        for (let i = 0; i < todo.length; i += SYNC_BATCH) {
          if (i > 0) await new Promise((r) => setTimeout(r, 1200)); // space out batches
          const batch = todo.slice(i, i + SYNC_BATCH);
          try {
            await fetch(`/api/team/${teamUuid}/replay-sync`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ games: batch }),
            });
          } catch {
            // swallow — these games stay unsynced and get retried next round
          }
          done = Math.min(done + batch.length, total);
          setProgress({ done, total });
        }
      }
      await loadMetrics();
      onDataChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
      setProgress(null);
    }
  }, [teamUuid, loadMetrics, onDataChange]);

  const clearAndResync = useCallback(async () => {
    if (typeof window !== 'undefined' && !window.confirm(
      'Clear stored fielding data for this team and re-sync the most-recent 100 games? This refreshes every metric (and backfills new ones).',
    )) return;
    try { await fetch(`/api/team/${teamUuid}/replay-sync`, { method: 'DELETE' }); } catch { /* fall through to sync */ }
    await runSync();
  }, [teamUuid, runSync]);

  const applyImportance = useCallback(async () => {
    if (posImp.length === 0) return;
    setApplyState('applying');
    const weights: Record<string, number> = { ...DEFAULT_POSITION_IMPORTANCE };
    for (const pi of posImp) weights[pi.position] = Math.min(2, Math.max(0, effImp(pi)));
    // Apply the data-derived FLD/ARM/SPD weights alongside importance (falling
    // back to the hand-tuned defaults for any position we couldn't derive).
    const statWeights: StatWeights = { ...DEFAULT_STAT_WEIGHTS, ...derivedStatWeights };
    try {
      await fetch('/api/position-weights', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamUuid, weights, statWeights }),
      });
      setApplyState('done');
      onDataChange?.();
    } catch {
      setApplyState('idle');
    }
  }, [posImp, teamUuid, onDataChange, derivedStatWeights]);

  const cols = view === 'fielding' ? FIELDING_COLS : BATTING_COLS;

  const sorted = useMemo(() => {
    const col = cols.find((c) => c.key === sortKey);
    const rows = [...players];
    rows.sort((a, b) => {
      if (sortKey === 'name') return sortDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      const av = col?.get(a) ?? -Infinity;
      const bv = col?.get(b) ?? -Infinity;
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return rows;
  }, [players, cols, sortKey, sortDir]);

  const insights = useMemo(() => {
    const fielders = players.filter((p) => p.chances >= 10);
    if (fielders.length === 0) return [];
    const out: string[] = [];
    const pos = (p: AggregatedPlayer) => (p.position != null ? POS_LABEL[p.position] ?? '' : '');
    const byPae = [...fielders].sort((a, b) => b.pae - a.pae);
    const best = byPae[0];
    const worst = byPae[byPae.length - 1];
    if (best && best.pae >= 3) out.push(`Best glove: ${best.name} (${pos(best)}) — +${best.pae} plays above expected over ${best.games} games.`);
    if (worst && worst.pae <= -3) out.push(`Defensive liability: ${worst.name} (${pos(worst)}) at ${worst.pae} below expected — the optimizer now weighs this when recommending positions.`);
    const sloppy = fielders.filter((p) => p.fieldPct != null && p.fieldErrors >= 5).sort((a, b) => (a.fieldPct ?? 1) - (b.fieldPct ?? 1))[0];
    if (sloppy && (sloppy.fieldPct ?? 1) < 0.92) out.push(`Shakiest hands: ${sloppy.name} (${pos(sloppy)}) — ${sloppy.fieldErrors} misplays, ${sloppy.fieldPct?.toFixed(3).replace(/^0/, '')} clean rate.`);
    const cannon = fielders.filter((p) => p.armAvg != null && p.position !== 1).sort((a, b) => (b.armAvg ?? 0) - (a.armAvg ?? 0))[0];
    if (cannon) out.push(`Strongest arm: ${cannon.name} (${pos(cannon)}) at ${cannon.armAvg} avg throw speed.`);
    const catcher = players.find((p) => p.position === 2 && p.stealAttempts >= 5);
    if (catcher && catcher.csRate != null) {
      out.push(`Catcher ${catcher.name} threw out ${catcher.caughtStealing} of ${catcher.stealAttempts} stealers (${Math.round(catcher.csRate * 100)}% caught).`);
    }
    return out;
  }, [players]);

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc'); }
  };
  const toggleExpand = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // keep sort valid when switching views
  useEffect(() => {
    if (sortKey !== 'name' && !cols.some((c) => c.key === sortKey)) setSortKey(cols[0].key);
  }, [view, cols, sortKey]);

  const arrow = (key: string) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <CollapsiblePanel
      title="Advanced stats"
      subtitle="Fielding & contact metrics derived from game replays — not exposed by the public stat API. Sync processes the most-recent 100 games (older stored games are pruned)."
      headerAction={
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); clearAndResync(); }}
            disabled={syncing || !hasDb}
            title="Wipe stored data and re-sync the most-recent 100 games"
            className="rounded border border-slate-600 px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
          >
            Clear &amp; re-sync
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); runSync(); }}
            disabled={syncing || !hasDb}
            className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Sync replays'}
          </button>
        </div>
      }
    >
      {!hasDb ? (
        <p className="text-sm text-slate-400">
          Advanced stats require the database tier (a <code className="text-slate-300">DATABASE_URL</code>). They’re computed from replays and stored per user.
        </p>
      ) : (
        <>
          {error && <div className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-200">{error}</div>}

          {syncing && progress && (
            <div className="mb-3">
              <div className="mb-1 flex justify-between text-[11px] text-slate-400">
                <span>Syncing replays…</span>
                <span>{progress.done}/{progress.total}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-slate-800">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <div className="flex rounded border border-slate-700">
              {(['fielding', 'batting', 'positions', 'alignment', 'heatmap'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={'px-2 py-0.5 capitalize transition-colors ' + (view === v ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200')}
                >
                  {VIEW_LABEL[v]}
                </button>
              ))}
            </div>
            <select value={mode} onChange={(e) => setMode(e.target.value)} className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-slate-300">
              <option value="">All modes</option>
              <option value="season">Season</option>
              <option value="quick_play">Quickplay</option>
              <option value="challenge">Challenge</option>
            </select>
            <label className="flex items-center gap-1 text-slate-400">
              Last
              <select
                value={lastN}
                onChange={(e) => setLastN(Number(e.target.value))}
                className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-slate-300"
              >
                {[5, 10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              games
            </label>
            <span className="text-slate-500">{totalGames} game{totalGames === 1 ? '' : 's'} in view</span>
          </div>

          {insights.length > 0 && (
            <ul className="mb-3 space-y-1 rounded-md border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300">
              {insights.map((n, i) => (
                <li key={i} className="flex gap-2"><span className="text-emerald-400">›</span><span>{n}</span></li>
              ))}
            </ul>
          )}

          {posImp.length > 0 && (
            <div className="mb-3 rounded-md border border-slate-800 bg-slate-950/40 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Position importance — derived from {totalGames} game{totalGames === 1 ? '' : 's'}
                </h4>
                <button
                  type="button"
                  onClick={applyImportance}
                  disabled={applyState !== 'idle'}
                  title="Write the derived position importance AND the derived FLD/ARM/SPD stat weights below as the optimizer's weights (applied to the Overview tab right away)"
                  className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300 hover:bg-sky-500/20 disabled:opacity-60"
                >
                  {applyState === 'done' ? 'Applied ✓' : applyState === 'applying' ? 'Applying…' : 'Use derived weights'}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {posImp.map((pi) => {
                  const cur = DEFAULT_POSITION_IMPORTANCE[pi.position] ?? 1;
                  const val = effImp(pi);
                  const delta = val - cur;
                  return (
                    <span
                      key={pi.position}
                      title={`${pi.chances} chances · ${pi.xOuts} expected outs${pi.impLeverage != null ? ` · leverage-share ×${pi.impLeverage.toFixed(2)}` : ''} · workload-share ×${pi.impXouts.toFixed(2)} → recommended ×${effImp(pi).toFixed(2)}`}
                      className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px]"
                    >
                      <span className="font-medium text-slate-300">{pi.position}</span>{' '}
                      <span className="font-mono text-emerald-300">{val.toFixed(2)}</span>
                      <span className="font-mono text-slate-600"> / {cur.toFixed(2)}</span>
                      <span className={'ml-0.5 ' + (delta > 0.05 ? 'text-emerald-500/70' : delta < -0.05 ? 'text-red-500/70' : 'text-slate-600')}>
                        {Math.abs(delta) < 0.05 ? '' : delta > 0 ? '▲' : '▼'}
                      </span>
                    </span>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10px] text-slate-600">
                Multiplier = a blend of skill-leverage (outs genuinely in doubt — where a good vs. replacement glove swings the most)
                and workload (expected outs handled), normalized to mean 1.0, vs the current default. Blending damps small-sample
                noise; the catcher is floored to its default since its only leverage signal is caught-stealing.
              </p>
            </div>
          )}

          {Object.keys(derivedStatWeights).length > 0 && (
            <div className="mb-3 rounded-md border border-slate-800 bg-slate-950/40 p-3">
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Stat weights (FLD / ARM / SPD) — derived from {totalGames} game{totalGames === 1 ? '' : 's'}
              </h4>
              <div className="overflow-x-auto">
                <table className="text-[11px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                      <th className="px-1.5 py-0.5 text-left">Pos</th>
                      {(['fld', 'arm', 'spd'] as const).map((s) => (
                        <th key={s} className="px-2 py-0.5 text-right">{s}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {FIELDING_POS_ORDER.filter((p) => derivedStatWeights[p]).map((p) => {
                      const dw = derivedStatWeights[p];
                      const def = DEFAULT_STAT_WEIGHTS[p] ?? {};
                      return (
                        <tr key={p} className="border-t border-slate-800/60">
                          <td className="px-1.5 py-0.5 font-medium text-slate-300">{p}</td>
                          {(['fld', 'arm', 'spd'] as const).map((s) => {
                            const val = dw[s] ?? 0;
                            const cur = def[s] ?? 0;
                            const delta = val - cur;
                            return (
                              <td key={s} className="px-2 py-0.5 text-right font-mono">
                                <span className="text-emerald-300">{val.toFixed(2)}</span>
                                <span className="text-slate-600"> / {cur.toFixed(2)}</span>
                                <span className={'ml-0.5 ' + (delta > 0.03 ? 'text-emerald-500/70' : delta < -0.03 ? 'text-red-500/70' : 'text-slate-600')}>
                                  {Math.abs(delta) < 0.03 ? '' : delta > 0 ? '▲' : '▼'}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-1.5 text-[10px] text-slate-600">
                SPD weight ← how far fielders actually range to make plays; ARM ← how much throwing matters (throw-rate × throw speed —
                throws, not assists, so outfielder arms aren’t zeroed); FLD is a constant catch/exchange baseline (the log can’t isolate
                receiving/scooping skill). Each row sums to 1.0. The data profile is then blended <em>toward the hand-tuned prior</em>
                (prior-dominant), because the signals that matter most — DP/relay value (infield arm) and runner deterrence (outfield arm) —
                never appear in the log; the prior encodes them (arm-led infields, speed-led outfields) and the data nudges the magnitudes.
              </p>
            </div>
          )}

          {loading ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : players.length === 0 ? (
            <p className="text-sm text-slate-400">
              No metrics yet. Click <span className="text-emerald-300">Sync replays</span> to process this team’s most-recent 100 games (only ones we haven’t stored are fetched).
            </p>
          ) : view === 'positions' ? (
            <PositionComparison players={players} />
          ) : view === 'alignment' ? (
            <BestAlignment players={players} posImp={posImp} />
          ) : view === 'heatmap' ? (
            <HeatMaps heatBins={heatBins} sprayBins={sprayBins} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="cursor-pointer select-none px-2 py-1 text-left hover:text-slate-300" onClick={() => toggleSort('name')}>Player{arrow('name')}</th>
                    <th className="px-1.5 py-1 text-left">Pos</th>
                    <th className="px-1.5 py-1 text-right">G</th>
                    {cols.map((c) => (
                      <th key={c.key} title={c.title} className="cursor-pointer select-none px-1.5 py-1 text-right hover:text-slate-300" onClick={() => toggleSort(c.key)}>
                        {c.label}{arrow(c.key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((p) => {
                    const fieldingSpots = (p.byPosition ?? []).filter((s) => s.chances > 0 || s.plays > 0);
                    const canExpand = view === 'fielding' && fieldingSpots.length >= 2;
                    const isOpen = expanded.has(p.playerId);
                    return (
                      <Fragment key={p.playerId}>
                        <tr className="border-b border-slate-800/60 last:border-0">
                          <td className="px-2 py-1 text-slate-200 whitespace-nowrap">
                            {canExpand && (
                              <button
                                type="button"
                                onClick={() => toggleExpand(p.playerId)}
                                title={`Per-position breakdown (${fieldingSpots.length} positions played)`}
                                className="mr-1 text-slate-500 hover:text-slate-200"
                              >
                                {isOpen ? '▾' : '▸'}
                              </button>
                            )}
                            {p.name}
                          </td>
                          <td className="px-1.5 py-1 text-slate-400">{p.position != null ? POS_LABEL[p.position] ?? p.position : '·'}</td>
                          <td className="px-1.5 py-1 text-right font-mono text-slate-500">{p.games}</td>
                          {cols.map((c) => (
                            <td key={c.key} className="px-1.5 py-1 text-right font-mono text-slate-300">
                              {(c.fmt ?? int)(c.get(p))}
                            </td>
                          ))}
                        </tr>
                        {canExpand && isOpen && <PositionBreakdown player={p} colSpan={3 + cols.length} />}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-2 text-[10px] text-slate-600">
            EV / range / arm are sim-internal units for comparison, not real mph/feet. Fielding attribution verified against box-score batting & out totals.
          </p>
        </>
      )}
    </CollapsiblePanel>
  );
}
