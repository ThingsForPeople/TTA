'use client';

import { useState, useEffect, useRef } from 'react';
import {
  ARCHETYPES,
  clearInjury,
  effectiveStats,
  emptyMeta,
  hasSim,
  isPitcherArchetype,
  normalizeArchetype,
  setInjury,
  SIM_KEYS,
  SIM_LABELS,
  type Hand,
  type InjurySeverity,
  type PlayerMeta,
  type PlayerMetaStore,
  type SimStats,
} from '../lib/playerMeta';
import {
  getAllPlayerHistories,
  getLatestDelta,
  getOvrSeries,
  recordSnapshot,
  updateSnapshot,
  deleteSnapshot,
  updateSnapshotApi,
  deleteSnapshotApi,
  computeOvr,
} from '../lib/statHistory';
import { StatHistoryEditor } from './StatHistoryEditor';
import { STANDALONE_TALENTS } from '../lib/talentClassify';
import type { PitchTalent } from '../lib/playerMeta';
import type { Player, Team } from '../lib/types';
import { PitchTalentEditor } from './PitchTalentEditor';
import { Sparkline } from './Sparkline';
import { TalentPicker } from './TalentPicker';
import { ZoneCoverage } from './ZoneCoverage';

interface Props {
  team: Team;
  teamUuid: string;
  metaStore: PlayerMetaStore;
  onChange: (next: PlayerMetaStore) => void;
  // Fired after any stat-snapshot write (record/edit/delete) so the parent can
  // tell the Training panel to re-read localStorage. Without it, the chart and
  // "latest changes" table only update on a full page refresh.
  onHistoryChange?: () => void;
}

// Order-insensitive signature of a player's talent bundle, so "detect" only
// rewrites players whose talents actually changed (avoids churn / API writes).
function talentSig(
  talents: string[],
  levels: Record<string, number> | undefined,
  pitch: PitchTalent[] | undefined,
): string {
  const lv = Object.entries(levels ?? {}).filter(([, v]) => v > 1).sort();
  const pt = (pitch ?? [])
    .map((p) => [p.pitch, p.level, [...p.sub].map((s) => [s.name, s.level]).sort()])
    .sort();
  return JSON.stringify([[...talents].sort(), lv, pt]);
}

export function RosterEditor({ team, teamUuid, metaStore, onChange, onHistoryChange }: Props) {
  const [editingHistory, setEditingHistory] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);

  const detectTalents = async () => {
    setDetecting(true);
    setDetectMsg(null);
    try {
      const res = await fetch(`/api/team/${teamUuid}/talents`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      const detected = (json.players ?? {}) as Record<
        string,
        { name: string; talents: string[]; talentLevels: Record<string, number>; pitchTalents: PitchTalent[] }
      >;
      const next: PlayerMetaStore = { ...metaStore };
      let changed = 0;
      for (const [uuid, d] of Object.entries(detected)) {
        const cur = metaStore[uuid] ?? emptyMeta();
        if (talentSig(cur.talents, cur.talentLevels, cur.pitchTalents) ===
            talentSig(d.talents, d.talentLevels, d.pitchTalents)) {
          continue; // already matches the replay — leave the object reference
        }
        next[uuid] = { ...cur, talents: d.talents, talentLevels: d.talentLevels, pitchTalents: d.pitchTalents };
        changed++;
      }
      const found = Object.keys(detected).length;
      if (changed > 0) onChange(next);
      setDetectMsg(
        changed > 0
          ? `Updated ${changed} of ${found} player${found === 1 ? '' : 's'} from the latest game.`
          : `No changes — all ${found} players already match the latest replay.`,
      );
    } catch (e) {
      setDetectMsg(e instanceof Error ? e.message : 'Detection failed');
    } finally {
      setDetecting(false);
    }
  };

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
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500">
            {Object.keys(metaStore).length}/{players.filter((p) => p.uuid).length} players tracked
          </span>
          <button
            type="button"
            onClick={detectTalents}
            disabled={detecting}
            title="Pull talents + pitch talents from the team's latest game replay (overwrites the players who played)"
            className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 transition-colors hover:border-emerald-500 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {detecting ? 'Detecting…' : 'Detect talents from replay'}
          </button>
        </div>
      </div>

      <p className="mb-1 text-xs text-slate-500">
        Sim stats and talents aren't in the public feed — enter them here as players level up.
        Data saves automatically to your browser. <span className="text-slate-400">Detect talents from replay</span> auto-fills
        talents + pitch talents from the latest game (overwrites the 9 who played; run after games to cover more of the roster).
      </p>
      {detectMsg && <p className="mb-3 text-xs text-emerald-300/90">{detectMsg}</p>}
      {!detectMsg && <div className="mb-3" />}

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
                onHistoryChange?.();
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
              onArchetypeChange={(archetype) =>
                updatePlayer(player.uuid!, (m) => ({ ...m, archetype }))
              }
              onAgeChange={(age) =>
                updatePlayer(player.uuid!, (m) => ({ ...m, age }))
              }
              onInjuryChange={(severity, note) => {
                updatePlayer(player.uuid!, (m) =>
                  severity ? setInjury(m, severity, note) : clearInjury(m),
                );
              }}
              onEditHistory={() => setEditingHistory(player.uuid!)}
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

      {editingHistory && (() => {
        const histories = getAllPlayerHistories();
        const snaps = histories[editingHistory];
        const player = team.players.find((p) => p.uuid === editingHistory);
        if (!snaps?.length || !player) return null;
        return (
          <StatHistoryEditor
            player={player}
            snapshots={snaps}
            onClose={() => setEditingHistory(null)}
            onUpdate={(snap, sim) => {
              updateSnapshot(editingHistory, snap.timestamp, sim);
              if (snap.id) updateSnapshotApi(snap.id, sim, computeOvr(sim));
              setHistoryVersion((v) => v + 1);
              onHistoryChange?.();
            }}
            onDelete={(snap) => {
              deleteSnapshot(editingHistory, snap.timestamp);
              if (snap.id) deleteSnapshotApi(snap.id);
              setHistoryVersion((v) => v + 1);
              onHistoryChange?.();
            }}
          />
        );
      })()}
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
  onArchetypeChange: (archetype: string | undefined) => void;
  onAgeChange: (age: number | undefined) => void;
  onInjuryChange: (severity: InjurySeverity | undefined, note?: string) => void;
  onEditHistory: () => void;
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
  onArchetypeChange,
  onAgeChange,
  onInjuryChange,
  onEditHistory,
}: RowProps) {
  const [expanded, setExpanded] = useState(!hasData);

  // Manual archetype override wins; otherwise fall back to the scraped one
  // (which arrives lowercase, so normalize it to the canonical title-case form).
  const effectiveArchetype = meta.archetype ?? normalizeArchetype(player.archetype);
  const isPitcher = player.position === 'P' || player.pitching !== undefined;
  // Pitcher archetypes (Ace/Gunner/Weaver/Two Way) can carry pitch talents even
  // when they aren't currently listed at P.
  const canPitch = isPitcher || isPitcherArchetype(effectiveArchetype);
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
          {player.uuid && <PlayerSparkline uuid={player.uuid} />}
          {player.uuid && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onEditHistory(); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onEditHistory(); } }}
              className="rounded p-0.5 text-slate-600 hover:text-slate-300"
              aria-label={`Edit history for ${player.name}`}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492ZM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0Z" />
                <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.902 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319Zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291a1.873 1.873 0 0 0-1.116-2.693l-.318-.094c-.835-.246-.835-1.428 0-1.674l.319-.094a1.873 1.873 0 0 0 1.115-2.692l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.116l.094-.318Z" />
              </svg>
            </span>
          )}
          {ovr !== null && (
            <span className="font-mono text-xs text-slate-400">
              {effOvr !== null ? (
                <span className="text-red-400/70">{effOvr}</span>
              ) : (
                ovr
              )}
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
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Archetype:</span>
              <select
                value={effectiveArchetype ?? ''}
                onChange={(e) => onArchetypeChange(e.target.value || undefined)}
                title="Pitcher archetypes (Ace, Gunner, Weaver, Two Way) unlock pitch talents below"
                className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-[11px] text-slate-300 focus:border-emerald-500 focus:outline-none"
              >
                <option value="">—</option>
                {ARCHETYPES.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Age:</span>
              <input
                type="number"
                min={16}
                max={45}
                value={meta.age ?? ''}
                placeholder="—"
                title="Not in the game feed — enter manually. Powers retirement/succession advice (players retire ~30)."
                onChange={(e) => {
                  const v = e.target.value.trim();
                  onAgeChange(v === '' ? undefined : Math.max(0, Math.round(Number(v))) || undefined);
                }}
                className="w-14 rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-[11px] text-slate-300 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
              />
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

          {/* Talents — pitchers and pitcher archetypes can add pitch talents */}
          {canPitch ? (
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

function PlayerSparkline({ uuid }: { uuid: string }) {
  const series = getOvrSeries(uuid);
  const delta = getLatestDelta(uuid);

  if (series.length < 2) return null;

  return (
    <div className="flex items-center gap-1.5">
      <Sparkline values={series.map((s) => s.ovr)} />
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
