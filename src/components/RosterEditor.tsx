'use client';

import { useState, useEffect, useRef } from 'react';
import {
  clearInjury,
  effectiveStats,
  emptyMeta,
  hasSim,
  setInjury,
  SIM_KEYS,
  SIM_LABELS,
  type Hand,
  type InjurySeverity,
  type PlayerMeta,
  type PlayerMetaStore,
  type SimStats,
} from '../lib/playerMeta';
import { getLatestDelta, getOvrSeries, recordSnapshot } from '../lib/statHistory';
import { STANDALONE_TALENTS } from '../lib/talentClassify';
import type { PitchTalent } from '../lib/playerMeta';
import type { Player, Team } from '../lib/types';
import { PitchTalentEditor } from './PitchTalentEditor';
import { Sparkline } from './Sparkline';
import { TalentPicker } from './TalentPicker';
import { ZoneCoverage } from './ZoneCoverage';

interface Props {
  team: Team;
  metaStore: PlayerMetaStore;
  onChange: (next: PlayerMetaStore) => void;
}

export function RosterEditor({ team, metaStore, onChange }: Props) {
  const updatePlayer = (uuid: string, updater: (m: PlayerMeta) => PlayerMeta) => {
    const current = metaStore[uuid] ?? emptyMeta();
    const next = { ...metaStore, [uuid]: updater(current) };
    onChange(next);
  };

  const clearAll = () => {
    if (!confirm('Clear all sim stats and talents? This cannot be undone.')) return;
    onChange({});
  };

  const players = [...team.players].sort((a, b) => {
    const ax = a.bench ? 1 : 0;
    const bx = b.bench ? 1 : 0;
    if (ax !== bx) return ax - bx;
    return (a.battingOrder ?? 99) - (b.battingOrder ?? 99);
  });

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
          Roster
        </h2>
        <span className="text-[10px] text-slate-500">
          {Object.keys(metaStore).length}/{players.filter((p) => p.uuid).length} players tracked
        </span>
      </div>

      <p className="mb-4 text-xs text-slate-500">
        Sim stats and talents aren't in the public feed — enter them here as players level up.
        Data saves automatically to your browser.
      </p>

      <div className="space-y-2">
        {players.map((player) => {
          if (!player.uuid) return null;
          const meta = metaStore[player.uuid];
          return (
            <PlayerRow
              key={player.uuid}
              player={player}
              meta={meta ?? emptyMeta()}
              hasData={!!meta && hasSim(meta)}
              onSimChange={(key, value) => {
                updatePlayer(player.uuid!, (m) => ({
                  ...m,
                  sim: { ...m.sim, [key]: value },
                }));
              }}
              onSimBlur={() => {
                const uuid = player.uuid!;
                const sim = (metaStore[uuid] ?? emptyMeta()).sim;
                recordSnapshot(uuid, sim);
              }}
              onTalentsChange={(talents) =>
                updatePlayer(player.uuid!, (m) => ({ ...m, talents }))
              }
              onTalentLevelChange={(talent, level) =>
                updatePlayer(player.uuid!, (m) => ({
                  ...m,
                  talentLevels: { ...m.talentLevels, [talent]: level },
                }))
              }
              onPitchTalentsChange={(pitchTalents) =>
                updatePlayer(player.uuid!, (m) => ({ ...m, pitchTalents }))
              }
              onHandednessChange={(bats, throws_) =>
                updatePlayer(player.uuid!, (m) => ({ ...m, bats, throws: throws_ }))
              }
              onInjuryChange={(severity, note) => {
                updatePlayer(player.uuid!, (m) =>
                  severity ? setInjury(m, severity, note) : clearInjury(m),
                );
              }}
            />
          );
        })}
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={clearAll}
          className="rounded-md border border-red-500/30 px-2.5 py-1 text-xs text-red-400 hover:bg-red-500/10"
        >
          Clear all data
        </button>
      </div>
    </section>
  );
}

const INJURY_OPTIONS: { value: InjurySeverity; label: string; color: string }[] = [
  { value: 'minor', label: 'Minor', color: 'text-yellow-400 border-yellow-500/40 bg-yellow-500/10' },
  { value: 'major', label: 'Major', color: 'text-orange-400 border-orange-500/40 bg-orange-500/10' },
  { value: 'catastrophic', label: 'Catastrophic', color: 'text-red-400 border-red-500/40 bg-red-500/10' },
];

const INJURY_BORDER: Record<InjurySeverity, string> = {
  minor: 'border-yellow-500/40',
  major: 'border-orange-500/40',
  catastrophic: 'border-red-500/40',
};

interface RowProps {
  player: Player;
  meta: PlayerMeta;
  hasData: boolean;
  onSimChange: (key: keyof SimStats, value: number) => void;
  onSimBlur: () => void;
  onTalentsChange: (talents: string[]) => void;
  onTalentLevelChange: (talent: string, level: number) => void;
  onPitchTalentsChange: (pitchTalents: PitchTalent[]) => void;
  onHandednessChange: (bats: Hand | undefined, throws_: Hand | undefined) => void;
  onInjuryChange: (severity: InjurySeverity | undefined, note?: string) => void;
}

function PlayerRow({
  player,
  meta,
  hasData,
  onSimChange,
  onSimBlur,
  onTalentsChange,
  onTalentLevelChange,
  onPitchTalentsChange,
  onHandednessChange,
  onInjuryChange,
}: RowProps) {
  const [expanded, setExpanded] = useState(!hasData);

  const isPitcher = player.position === 'P' || player.pitching !== undefined;
  const injury = meta.injury;
  const borderClass = injury ? INJURY_BORDER[injury.severity] : 'border-slate-800';
  const ovr = hasSim(meta)
    ? Math.round(SIM_KEYS.reduce((s, k) => s + meta.sim[k], 0) / SIM_KEYS.length)
    : null;
  const effOvr = injury && hasSim(meta)
    ? Math.round(SIM_KEYS.reduce((s, k) => s + effectiveStats(meta)[k], 0) / SIM_KEYS.length)
    : null;

  return (
    <div className={`rounded-md border ${borderClass} bg-slate-950/40`}>
      {/* Header — always visible, click to expand/collapse */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-slate-800/30"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`text-[10px] font-mono w-5 text-center ${expanded ? 'text-slate-400' : 'text-slate-600'}`}
          >
            {expanded ? '▾' : '▸'}
          </span>
          <span className="text-sm font-semibold text-slate-100 truncate">{player.name}</span>
          <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
            {player.position ?? '?'}
          </span>
          {(meta.bats || meta.throws) && (
            <span className="shrink-0 font-mono text-[10px] text-slate-500">
              {meta.bats ?? '?'}/{meta.throws ?? '?'}
            </span>
          )}
          {player.bench && (
            <span className="shrink-0 text-[10px] text-amber-400">BN</span>
          )}
          {injury && (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                injury.severity === 'minor'
                  ? 'bg-yellow-500/15 text-yellow-400'
                  : injury.severity === 'major'
                    ? 'bg-orange-500/15 text-orange-400'
                    : 'bg-red-500/15 text-red-400'
              }`}
            >
              {injury.severity}{injury.note ? `: ${injury.note}` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ZoneCoverage talents={meta.talents} bats={meta.bats} />
          {player.uuid && <PlayerSparkline uuid={player.uuid} injury={injury?.severity} />}
          {ovr !== null && (
            <span className="font-mono text-xs text-slate-400">
              {ovr}
              {effOvr !== null && <span className="text-red-400/70"> ({effOvr})</span>}
            </span>
          )}
          {hasData ? (
            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">
              ✓
            </span>
          ) : (
            <span className="rounded bg-slate-700/50 px-1.5 py-0.5 text-[10px] text-slate-500">
              —
            </span>
          )}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-slate-800/60 px-3 pb-3 pt-2 space-y-3">
          {/* Injury strip */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 mr-1">Status:</span>
            <button
              type="button"
              onClick={() => onInjuryChange(undefined)}
              className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                !injury
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                  : 'border-slate-700 text-slate-500 hover:text-slate-300'
              }`}
            >
              Healthy
            </button>
            {INJURY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  injury?.severity === opt.value
                    ? onInjuryChange(undefined)
                    : onInjuryChange(opt.value, injury?.note)
                }
                className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                  injury?.severity === opt.value
                    ? opt.color
                    : 'border-slate-700 text-slate-500 hover:text-slate-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
            {injury && (
              <input
                type="text"
                placeholder="injury note..."
                value={injury.note ?? ''}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onInjuryChange(injury.severity, e.target.value || undefined)}
                className="ml-1 rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-300 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none w-32"
              />
            )}
          </div>

          {/* Handedness */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Bats:</span>
              {(['R', 'L'] as const).map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => onHandednessChange(meta.bats === h ? undefined : h, meta.throws)}
                  className={`rounded border px-2 py-0.5 text-[11px] font-mono transition-colors ${
                    meta.bats === h
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                      : 'border-slate-700 text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {h}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Throws:</span>
              {(['R', 'L'] as const).map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => onHandednessChange(meta.bats, meta.throws === h ? undefined : h)}
                  className={`rounded border px-2 py-0.5 text-[11px] font-mono transition-colors ${
                    meta.throws === h
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                      : 'border-slate-700 text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {h}
                </button>
              ))}
            </div>
          </div>

          {/* Sim stats grid */}
          <div>
            <div className="grid grid-cols-7 gap-1.5">
              {SIM_KEYS.map((k) => {
                const eff = injury ? effectiveStats(meta)[k] : null;
                return (
                  <label key={k} className="flex flex-col text-center">
                    <span className="text-[10px] uppercase tracking-wider text-slate-500">
                      {SIM_LABELS[k]}
                    </span>
                    <SimStatInput
                      value={meta.sim[k]}
                      onCommit={(value) => {
                        onSimChange(k, value);
                        onSimBlur();
                      }}
                    />
                    {eff !== null && eff !== meta.sim[k] && (
                      <span className="mt-0.5 font-mono text-[10px] text-red-400/70">
                        eff: {eff}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          {/* Talents */}
          {isPitcher ? (
            <>
              <TalentPicker
                selected={meta.talents}
                levels={meta.talentLevels}
                onChange={onTalentsChange}
                onLevelChange={onTalentLevelChange}
                availableTalents={STANDALONE_TALENTS}
                label="Talents (general)"
              />
              <PitchTalentEditor
                pitchTalents={meta.pitchTalents ?? []}
                onChange={onPitchTalentsChange}
              />
            </>
          ) : (
            <TalentPicker
              selected={meta.talents}
              levels={meta.talentLevels}
              onChange={onTalentsChange}
              onLevelChange={onTalentLevelChange}
            />
          )}

          {!hasSim(meta) && (
            <p className="text-[11px] text-amber-300/80">
              No sim stats entered — insights for this player will be limited until you fill them in.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SimStatInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const prevValue = useRef(value);

  useEffect(() => {
    if (!editing && value !== prevValue.current) {
      setDraft(String(value));
      prevValue.current = value;
    }
  }, [value, editing]);

  return (
    <input
      type="number"
      min={0}
      max={99}
      value={editing ? draft : value}
      onFocus={() => {
        setDraft(String(value));
        setEditing(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const clamped = clamp(Number(draft));
        setDraft(String(clamped));
        if (clamped !== value) {
          onCommit(clamped);
        }
        prevValue.current = clamped;
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className="mt-0.5 rounded border border-slate-700 bg-slate-950 px-1 py-1 text-center font-mono text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
    />
  );
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 99) return 99;
  return Math.round(n);
}

function PlayerSparkline({ uuid, injury }: { uuid: string; injury?: InjurySeverity }) {
  const series = getOvrSeries(uuid);
  const delta = getLatestDelta(uuid);

  if (series.length < 2 && !injury) return null;

  const dotColor = injury
    ? injury === 'minor'
      ? 'bg-yellow-400'
      : injury === 'major'
        ? 'bg-orange-400'
        : 'bg-red-400'
    : undefined;

  return (
    <div className="flex items-center gap-1.5">
      {dotColor && <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />}
      {series.length >= 2 && <Sparkline values={series.map((s) => s.ovr)} />}
      {delta && (
        <span
          className={
            'font-mono text-[10px] ' +
            (delta.ovrDiff > 0
              ? 'text-emerald-400'
              : delta.ovrDiff < 0
                ? 'text-red-400'
                : 'text-slate-500')
          }
        >
          {delta.ovrDiff > 0 ? '+' : ''}{delta.ovrDiff}
        </span>
      )}
    </div>
  );
}
