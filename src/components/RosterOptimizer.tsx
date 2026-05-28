'use client';

import { useMemo, useState, useEffect, useCallback } from 'react';
import { CollapsiblePanel } from './CollapsiblePanel';
import { PositionWeightsEditor } from './PositionWeightsEditor';
import { POSITION_GUIDANCE } from '../lib/simData';
import type { PlayerMetaStore } from '../lib/playerMeta';
import type { Team } from '../lib/types';
import {
  optimizeRoster,
  DEFAULT_POSITION_IMPORTANCE,
  DEFAULT_STAT_WEIGHTS,
  type RosterAssignment,
  type RosterOptimization,
  type StatWeights,
  type StatBreakdown,
} from '../lib/rosterOptimizer';
import { getSlotTalents, recommendBattingOrder, recommendSynergyBattingOrder, type BattingSlotRole } from '../lib/analysis';
import { TALENT_BY_NAME } from '../lib/talents';

function talentTooltip(label: string): string | undefined {
  const name = label.replace(/ Lv\d+$/, '').replace(/ \(.*\)$/, '');
  return TALENT_BY_NAME[name]?.description;
}

interface Props {
  team: Team;
  metaStore: PlayerMetaStore;
}

function useOptimization(
  team: Team,
  metaStore: PlayerMetaStore,
  positionImportance?: Record<string, number>,
  statWeights?: StatWeights,
): RosterOptimization {
  return useMemo(
    () => optimizeRoster(team, metaStore, positionImportance, statWeights),
    [team, metaStore, positionImportance, statWeights],
  );
}

// ── Shared sub-components ────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 120 ? 'text-emerald-400' :
    score >= 80 ? 'text-sky-400' :
    score >= 40 ? 'text-amber-400' :
    'text-slate-500';
  const label =
    score >= 120 ? 'Great' :
    score >= 80 ? 'Good' :
    score >= 40 ? 'OK' :
    'Weak';
  return (
    <span className={`font-mono font-bold ${color}`} title={`${score} — ${label} fit`}>
      {score}
      <span className="ml-1 text-xs font-normal opacity-70">{label}</span>
    </span>
  );
}

function PositionBadge({ position, moved }: { position: string; moved: boolean }) {
  return (
    <span
      className={
        'inline-block min-w-[2.5rem] rounded px-1.5 py-0.5 text-center text-xs font-bold uppercase ' +
        (moved
          ? 'bg-amber-500/20 text-amber-300'
          : 'bg-slate-700/60 text-slate-300')
      }
    >
      {position}
    </span>
  );
}

const ROLE_LABEL: Record<BattingSlotRole, string> = {
  leadoff: 'Leadoff',
  quality: 'Quality AB',
  best: 'Best hitter',
  cleanup: 'Power',
  protection: 'Protection',
  lower: 'Lower',
};

const ROLE_CHIP: Record<BattingSlotRole, string> = {
  leadoff: 'bg-emerald-500/15 text-emerald-300',
  quality: 'bg-sky-500/15 text-sky-300',
  best: 'bg-indigo-500/15 text-indigo-300',
  cleanup: 'bg-red-500/15 text-red-300',
  protection: 'bg-orange-500/15 text-orange-300',
  lower: 'bg-slate-700/40 text-slate-400',
};

function MovementBadge({ currentSlot, newSlot }: { currentSlot?: number; newSlot: number }) {
  if (currentSlot === undefined || currentSlot === newSlot) return null;
  const diff = currentSlot - newSlot;
  const isUp = diff > 0;
  return (
    <span
      className={
        'rounded px-1.5 py-0.5 text-xs font-medium ' +
        (isUp ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400')
      }
      title={`Was #${currentSlot}`}
    >
      {isUp ? '▲' : '▼'} {Math.abs(diff)}
    </span>
  );
}

// ── Field Positions Panel ────────────────────────────────────────────

function statPillStyle(value: number): string {
  if (value >= 70) return 'bg-emerald-500/20 text-emerald-300';
  if (value >= 50) return 'bg-sky-500/20 text-sky-300';
  if (value >= 30) return 'bg-amber-500/20 text-amber-300';
  return 'bg-red-500/20 text-red-300';
}

function fpctPillStyle(pct: number): string {
  if (pct >= 990) return 'bg-emerald-500/20 text-emerald-300';
  if (pct >= 975) return 'bg-sky-500/20 text-sky-300';
  if (pct >= 960) return 'bg-amber-500/20 text-amber-300';
  return 'bg-red-500/20 text-red-300';
}

function StatFitChips({ breakdown }: { breakdown: StatBreakdown[] }) {
  if (breakdown.length === 0) return null;
  const simStats = breakdown.filter((b) => b.stat !== 'fpct');
  const fpct = breakdown.find((b) => b.stat === 'fpct');
  const sorted = [...simStats].sort((a, b) => b.weight - a.weight);
  return (
    <div className="flex gap-1">
      {sorted.map((b, i) => (
        <span
          key={b.stat}
          title={`${b.label} ${b.value} × ${b.weight} wt = ${Math.round(b.contribution)} pts`}
          className={`inline-block rounded px-2 py-0.5 font-mono text-xs font-bold ${statPillStyle(b.value)} ${i > 0 ? 'opacity-70' : ''}`}
        >
          {b.label}&nbsp;{b.value}
        </span>
      ))}
      {fpct && (
        <span
          title={`Fielding % .${fpct.value} → ${fpct.contribution > 0 ? '+' : ''}${Math.round(fpct.contribution)} pts`}
          className={`inline-block rounded px-2 py-0.5 font-mono text-xs font-bold ${fpctPillStyle(fpct.value)}`}
        >
          F%&nbsp;.{fpct.value}
        </span>
      )}
    </div>
  );
}

function AssignmentRow({ a }: { a: RosterAssignment }) {
  return (
    <tr className="border-b border-slate-800/60 last:border-0">
      <td className="px-2 py-1.5">
        <PositionBadge position={a.position} moved={a.moved} />
      </td>
      <td className="px-2 py-1.5">
        <span className={a.injured ? 'text-red-400 line-through' : 'text-slate-200'}>
          {a.player.name}
        </span>
        {a.injured && <span className="ml-1 text-xs text-red-400">INJ</span>}
      </td>
      <td className="px-2 py-1.5">
        {a.moved && a.currentPosition ? (
          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-300">
            {a.currentPosition} → {a.position}
          </span>
        ) : (
          <span className="text-xs text-slate-600">—</span>
        )}
      </td>
      <td className="px-2 py-1.5 text-right">
        {a.moved && a.currentPositionScore !== undefined ? (
          <span className="inline-flex items-center gap-1">
            <span className="text-[11px] text-slate-500">now</span>
            <ScoreBadge score={a.currentPositionScore} />
            <span className="text-xs text-slate-500">→</span>
            <span className="text-[11px] text-slate-500">new</span>
            <ScoreBadge score={a.positionScore} />
          </span>
        ) : (
          <ScoreBadge score={a.positionScore} />
        )}
      </td>
      <td className="hidden whitespace-nowrap py-1.5 pl-2 pr-1 sm:table-cell">
        <StatFitChips breakdown={a.breakdown} />
      </td>
      <td className="hidden py-1.5 pl-1 pr-2 md:table-cell">
        {a.talentSynergies.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {a.talentSynergies.map((s) => (
              <span
                key={s}
                title={talentTooltip(s)}
                className="rounded bg-purple-500/20 px-1.5 py-0.5 text-xs text-purple-300 cursor-help"
              >
                {s}
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

interface FieldPositionsPanelProps extends Props {
  teamUuid: string;
  onNavigateToRoster?: () => void;
}

export function FieldPositionsPanel({ team, metaStore, teamUuid, onNavigateToRoster }: FieldPositionsPanelProps) {
  const [positionImportance, setPositionImportance] = useState<Record<string, number>>(
    () => ({ ...DEFAULT_POSITION_IMPORTANCE }),
  );
  const [statWeights, setStatWeights] = useState<StatWeights>(
    () => JSON.parse(JSON.stringify(DEFAULT_STAT_WEIGHTS)),
  );
  const [weightsLoaded, setWeightsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/position-weights?teamUuid=${encodeURIComponent(teamUuid)}`)
      .then((r) => r.json())
      .then((data: { weights: Record<string, number>; statWeights: StatWeights }) => {
        if (!cancelled) {
          setPositionImportance(data.weights);
          if (data.statWeights) setStatWeights(data.statWeights);
          setWeightsLoaded(true);
        }
      })
      .catch(() => setWeightsLoaded(true));
    return () => { cancelled = true; };
  }, [teamUuid]);

  const handleWeightsChange = useCallback((w: Record<string, number>, sw: StatWeights) => {
    setPositionImportance(w);
    setStatWeights(sw);
  }, []);

  const { assignments, bench, benchUpgrades, warnings } = useOptimization(
    team,
    metaStore,
    weightsLoaded ? positionImportance : undefined,
    weightsLoaded ? statWeights : undefined,
  );

  const totalCurrent = assignments.reduce((sum, a) => sum + (a.currentPositionScore ?? a.positionScore), 0);
  const totalOptimal = assignments.reduce((sum, a) => sum + a.positionScore, 0);
  const diff = totalOptimal - totalCurrent;

  return (
    <CollapsiblePanel
      title="Optimal field positions"
      subtitle="Defense-critical positions filled first. Fit score = weighted sim stats for that position (120+ great, 80+ good, 40+ OK)."
      headerAction={
        <PositionWeightsEditor
          teamUuid={teamUuid}
          weights={positionImportance}
          statWeights={statWeights}
          onWeightsChange={handleWeightsChange}
        />
      }
    >
      {warnings.map((w) => (
        <div
          key={w}
          className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200"
        >
          {w}
          {w.includes('no sim stats') && onNavigateToRoster && (
            <>
              {' '}
              <button
                type="button"
                onClick={onNavigateToRoster}
                className="underline underline-offset-2 hover:text-amber-100"
              >
                Set them up in the Roster tab →
              </button>
            </>
          )}
        </div>
      ))}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
              <th className="px-2 py-1 text-left">Pos</th>
              <th className="px-2 py-1 text-left">Player</th>
              <th className="px-2 py-1 text-left">Move</th>
              <th className="px-2 py-1 text-right" title="Position fit score based on sim stats (higher = better match). Shows current → optimal for moved players.">Fit (now → new)</th>
              <th className="hidden px-2 py-1 text-left sm:table-cell">Stat fit</th>
              <th className="hidden px-2 py-1 text-left md:table-cell">Synergies</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => (
              <AssignmentRow key={a.player.uuid ?? a.player.name} a={a} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex items-center justify-end gap-3 border-t border-slate-800 pt-2 text-xs">
        <span className="text-slate-500">Team fit</span>
        <span className="font-mono text-slate-400">{totalCurrent}</span>
        {diff !== 0 && (
          <>
            <span className="text-slate-600">→</span>
            <span className="font-mono text-slate-200">{totalOptimal}</span>
            <span className={`font-medium ${diff > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {diff > 0 ? '+' : ''}{diff}
            </span>
          </>
        )}
        {diff === 0 && (
          <span className="text-xs text-slate-600">optimal</span>
        )}
      </div>

      {bench.length > 0 && (
        <div className="mt-3 border-t border-slate-800 pt-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Bench
          </h3>
          <div className="flex flex-wrap gap-2">
            {bench.map((b) => (
              <span
                key={b.player.uuid ?? b.player.name}
                className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-400"
              >
                {b.player.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {benchUpgrades.length > 0 && (
        <div className="mt-3 border-t border-slate-800 pt-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Potential bench call-ups
          </h3>
          <div className="space-y-1.5">
            {benchUpgrades.slice(0, 5).map((u) => (
              <div
                key={`${u.benchPlayer.uuid}-${u.position}`}
                className="flex items-center gap-2 text-xs text-slate-400"
              >
                <span className="font-medium text-emerald-400">{u.benchPlayer.name}</span>
                <span className="text-slate-600">→</span>
                <span className="font-mono text-slate-500">{u.position}</span>
                <span className="text-slate-600">(replacing {u.replacesPlayer.name})</span>
                <span className="ml-auto text-xs">
                  <span className="text-slate-600">{u.starterScore}</span>
                  <span className="text-slate-600"> → </span>
                  <span className="text-emerald-400">{u.benchScore}</span>
                  <span className="ml-1 text-emerald-500/70">+{u.gain}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </CollapsiblePanel>
  );
}

// ── Batting Order Panel ──────────────────────────────────────────────

export function OptimalBattingOrder({ team, metaStore }: Props) {
  const { battingOrder } = useOptimization(team, metaStore);
  const [synergy, setSynergy] = useState(false);
  const synergyOrder = useMemo(
    () => synergy ? recommendSynergyBattingOrder(team, metaStore) : null,
    [synergy, team, metaStore],
  );
  const displayOrder = synergyOrder ?? battingOrder;

  return (
    <CollapsiblePanel
      title="Recommended batting order"
      subtitle={synergy
        ? 'wOBA + role scoring + adjacent talent chain optimization.'
        : 'wOBA + role-based slot scoring. ▲ moved up · ▼ moved down from current slot.'}
    >
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setSynergy(false)}
          className={`rounded border px-2 py-0.5 text-xs transition-colors ${
            !synergy
              ? 'border-sky-500/40 bg-sky-500/10 text-sky-400'
              : 'border-slate-700 text-slate-500 hover:text-slate-300'
          }`}
        >
          Stats-first
        </button>
        <button
          type="button"
          onClick={() => setSynergy(true)}
          className={`rounded border px-2 py-0.5 text-xs transition-colors ${
            synergy
              ? 'border-purple-500/40 bg-purple-500/10 text-purple-400'
              : 'border-slate-700 text-slate-500 hover:text-slate-300'
          }`}
        >
          Talent chains
        </button>
      </div>
      {displayOrder.recommended.length === 0 ? (
        <p className="text-sm text-slate-400">No active players found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                <th className="px-2 py-1 text-right w-8">#</th>
                <th className="px-2 py-1 text-left">Player</th>
                <th className="px-2 py-1 text-left">Role</th>
                <th className="px-2 py-1 text-center">Move</th>
                <th className="px-2 py-1 text-right">OPS</th>
                <th className="hidden px-2 py-1 text-left sm:table-cell">Reason</th>
                <th className="hidden px-2 py-1 text-left md:table-cell">Synergies</th>
              </tr>
            </thead>
            <tbody>
              {displayOrder.recommended.map((slot) => {
                const ops = slot.player.batting?.ops;
                const talents = getSlotTalents(slot.player.uuid, metaStore, slot.role);
                return (
                  <tr key={`${slot.slot}-${slot.player.name}`} className="border-b border-slate-800/60 last:border-0">
                    <td className="px-2 py-1.5 text-right font-mono text-slate-500">{slot.slot}</td>
                    <td className="px-2 py-1.5 text-slate-200">{slot.player.name}</td>
                    <td className="px-2 py-1.5">
                      <span
                        className={
                          'rounded px-1.5 py-0.5 text-xs font-medium uppercase tracking-wider ' +
                          ROLE_CHIP[slot.role]
                        }
                      >
                        {ROLE_LABEL[slot.role]}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <MovementBadge currentSlot={slot.currentSlot} newSlot={slot.slot} />
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-400">
                      {typeof ops === 'number' ? ops.toFixed(3).replace(/^0/, '') : '—'}
                    </td>
                    <td className="hidden px-2 py-1.5 text-xs text-slate-400 sm:table-cell">
                      {slot.reason}
                    </td>
                    <td className="hidden px-2 py-1.5 md:table-cell">
                      {talents.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {talents.map((t) => (
                            <span
                              key={t}
                              title={talentTooltip(t)}
                              className="rounded bg-purple-500/20 px-1.5 py-0.5 text-xs text-purple-300 cursor-help"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </CollapsiblePanel>
  );
}

// ── Position Guidance (stays in Tools) ───────────────────────────────

export function PositionGuidancePanel() {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">
        Position guidance
      </h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {Object.entries(POSITION_GUIDANCE).map(([pos, desc]) => (
          <div key={pos} className="flex items-start gap-2 text-xs">
            <span className="inline-block min-w-[2.5rem] rounded bg-slate-700/60 px-1.5 py-0.5 text-center text-xs font-bold text-slate-300">
              {pos}
            </span>
            <span className="text-slate-400">{desc}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
