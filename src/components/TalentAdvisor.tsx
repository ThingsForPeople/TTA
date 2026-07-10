import { useCallback, useEffect, useRef, useState } from 'react';
import { ALL_TALENTS, CATEGORY_COLORS, type TalentDef } from '../lib/talents';
import { talentMagnitude, talentMagnitudeAtTier } from '../lib/talentIndex';
import { isPitchSubTalent } from '../lib/talentClassify';
import { Markdown } from './Markdown';
import { RateLimitBadge } from './RateLimitBadge';
import { readRateLimitBody, readRateLimitHeaders, useRateLimit } from '../hooks/useRateLimit';
import { useDropdownPosition } from '../hooks/useDropdownPosition';
import { MAX_TALENT_LEVEL, type PlayerMetaStore } from '../lib/playerMeta';
import type { Player } from '../lib/types';

interface Props {
  players: Player[];
  metaStore: PlayerMetaStore;
  buildContext: () => string;
  buildCompactContext: () => string;
  teamUuid?: string;
}

interface TalentOptionValue {
  name: string;
  forPitch?: string;
}

const EMPTY_OPT: TalentOptionValue = { name: '' };

function TalentOption({
  index,
  value,
  pitchTypes,
  onChange,
}: {
  index: number;
  value: TalentOptionValue;
  pitchTypes: string[];
  onChange: (val: TalentOptionValue) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropPos = useDropdownPosition(inputRef, open && !value.name, 288);

  const lower = query.toLowerCase();
  const filtered = query
    ? ALL_TALENTS.filter((t) => t.name.toLowerCase().includes(lower))
    : ALL_TALENTS;

  const selectedDef = value.name ? ALL_TALENTS.find((t) => t.name === value.name) : undefined;
  const needsPitch = value.name && isPitchSubTalent(value.name) && pitchTypes.length > 0;

  const select = (name: string) => {
    onChange({ name });
    setQuery('');
    setOpen(false);
  };

  const clear = () => {
    onChange({ name: '' });
    setQuery('');
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <div className="mb-0.5 text-[10px] uppercase tracking-wider text-slate-500">
        Option {index + 1}
      </div>
      {value.name ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2 rounded border border-slate-700 bg-slate-950 px-2 py-1.5">
            <span className={'text-xs ' + (selectedDef ? CATEGORY_COLORS[selectedDef.category] : 'text-slate-200')}>
              {value.name}
            </span>
            {selectedDef && (
              <span className="text-[10px] text-slate-500 truncate" title={talentMagnitude(selectedDef.id) ?? selectedDef.description}>
                {selectedDef.description}
                {talentMagnitude(selectedDef.id) && (
                  <span className="ml-1 text-emerald-400/80">{talentMagnitude(selectedDef.id)!.split('\n')[0]}</span>
                )}
              </span>
            )}
            <button
              type="button"
              onClick={clear}
              className="ml-auto text-slate-500 hover:text-red-300 text-xs shrink-0"
            >
              ×
            </button>
          </div>
          {needsPitch && (
            <select
              value={value.forPitch ?? ''}
              onChange={(e) => onChange({ ...value, forPitch: e.target.value || undefined })}
              className="w-full rounded border border-amber-500/30 bg-slate-950 px-2 py-1 text-[11px] text-amber-300 focus:border-amber-500 focus:outline-none"
            >
              <option value="">for which pitch?</option>
              {pitchTypes.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}
        </div>
      ) : (
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlightIdx(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlightIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (filtered[highlightIdx]) select(filtered[highlightIdx].name);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder="search talents..."
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
        />
      )}

      {open && !value.name && filtered.length > 0 && dropPos && (
        <ul
          className="fixed z-[100] max-h-48 overflow-y-auto rounded border border-slate-700 bg-slate-900 shadow-lg"
          style={{ top: dropPos.top, left: dropPos.left, width: dropPos.width }}
        >
          {filtered.slice(0, 30).map((t, i) => (
            <li
              key={t.name}
              role="option"
              aria-selected={i === highlightIdx}
              onMouseDown={(e) => { e.preventDefault(); select(t.name); }}
              onMouseEnter={() => setHighlightIdx(i)}
              className={'cursor-pointer px-2 py-1.5 ' + (i === highlightIdx ? 'bg-emerald-500/15' : 'hover:bg-slate-800')}
            >
              <div className="flex items-center justify-between">
                <span className={'text-xs ' + (i === highlightIdx ? 'text-slate-100' : 'text-slate-300')}>{t.name}</span>
                <span className={'text-[10px] ' + CATEGORY_COLORS[t.category]}>{t.category}</span>
              </div>
              <p className="mt-0.5 text-[10px] leading-tight text-slate-500">{t.description}</p>
              {talentMagnitude(t.id) && (
                <p className="mt-0.5 text-[10px] leading-tight text-emerald-400/80" title="Official per-tier numbers (Tier 1/2/3/4) from the game's Talent Index">
                  {talentMagnitude(t.id)!.split('\n')[0]}
                </p>
              )}
            </li>
          ))}
          {filtered.length > 30 && (
            <li className="px-2 py-1 text-[10px] text-slate-500">
              {filtered.length - 30} more — keep typing
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export function TalentAdvisor({ players, metaStore, buildContext, buildCompactContext, teamUuid }: Props) {
  const [selectedPlayer, setSelectedPlayer] = useState('');
  const [options, setOptions] = useState<[TalentOptionValue, TalentOptionValue, TalentOptionValue]>([
    { ...EMPTY_OPT }, { ...EMPTY_OPT }, { ...EMPTY_OPT },
  ]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const [rateLimit, updateRateLimit] = useRateLimit();

  // Per-player replay talent usage (Fires/g + contact when fired), keyed by
  // player uuid, so the advice can weigh how the player's current talents
  // actually perform. Empty until replays are synced.
  const [talentUsage, setTalentUsage] = useState<Record<string, { name: string; perPA: number | null; firedSwings: number; firedContact: number; activeSwings: number; activeContact: number }[]>>({});
  useEffect(() => {
    if (!teamUuid) return;
    let cancelled = false;
    fetch(`/api/team/${teamUuid}/replay-metrics`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json?.players) return;
        const map: Record<string, { name: string; perPA: number | null; firedSwings: number; firedContact: number; activeSwings: number; activeContact: number }[]> = {};
        // Normalize per plate appearance, not per game — per-game is confounded by
        // lineup slot (leadoff gets more PAs than the 9-hole).
        for (const p of json.players) {
          if (!p.talents?.length) continue;
          map[p.playerId] = p.talents.map((t: { name: string; acts: number; firedSwings: number; firedContact: number; activeSwings?: number; activeContact?: number }) => ({
            name: t.name, perPA: p.pa > 0 ? t.acts / p.pa : null, firedSwings: t.firedSwings, firedContact: t.firedContact,
            activeSwings: t.activeSwings ?? 0, activeContact: t.activeContact ?? 0,
          }));
        }
        setTalentUsage(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [teamUuid]);

  const player = players.find((p) => p.uuid === selectedPlayer);
  const meta = selectedPlayer ? metaStore[selectedPlayer] : undefined;
  const pitchTypes = meta?.pitchTalents?.map((pt) => pt.pitch) ?? [];
  const filledOptions = options.filter((o) => o.name);
  const canAnalyze = !!player && filledOptions.length >= 2;

  const setOption = (idx: number, val: TalentOptionValue) => {
    setOptions((prev) => {
      const next = [...prev] as [TalentOptionValue, TalentOptionValue, TalentOptionValue];
      next[idx] = val;
      return next;
    });
  };

  const buildPrompt = useCallback(() => {
    if (!player) return '';
    const lines = [
      `I need to choose a talent for **${player.name}** (${player.position ?? '?'}, ${player.archetype ?? '?'}).`,
    ];
    if (meta) {
      const s = meta.sim;
      lines.push(`Sim stats: CON=${s.con} POW=${s.pow} SPD=${s.spd} FLD=${s.fld} ARM=${s.arm} PIT=${s.pit} STA=${s.sta}`);
      if (meta.talents.length) {
        const existing = meta.talents.map((t) => {
          const lvl = meta.talentLevels?.[t] ?? 1;
          return lvl > 1 ? `${t} Lv${lvl}` : t;
        });
        lines.push(`Current talents: ${existing.join(', ')}`);
      }
      if (meta.pitchTalents && meta.pitchTalents.length > 0) {
        const pitchDescs = meta.pitchTalents.map((pt) => {
          const subs = pt.sub.length
            ? ' [' + pt.sub.map((s) => `${s.name} Lv${s.level}`).join(', ') + ']'
            : '';
          return `${pt.pitch} Lv${pt.level}${subs}`;
        });
        lines.push(`Pitch repertoire: ${pitchDescs.join('; ')}`);
      }
    }
    const usage = player.uuid ? talentUsage[player.uuid] : undefined;
    if (usage && usage.length) {
      const top = [...usage]
        .sort((a, b) => (b.perPA ?? -1) - (a.perPA ?? -1))
        .slice(0, 12)
        .map((t) => `${t.name}${t.perPA != null ? ` ${t.perPA.toFixed(2)}/PA` : ''}`
          + (t.firedSwings > 0 ? ` (${Math.round((t.firedContact / t.firedSwings) * 100)}% contact when it fired)` : '')
          + (t.activeSwings >= 10 ? ` (${Math.round((t.activeContact / t.activeSwings) * 100)}% contact on ${t.activeSwings} swings with the effect ACTIVE)` : ''));
      lines.push(`Actual usage of this player's current talents (recent synced games — triggers per plate appearance, slot-independent, and contact rate on swings where a batting talent fired): ${top.join('; ')}`);
    }
    const existingTalentLevels = new Map<string, number>();
    for (const t of meta?.talents ?? []) {
      existingTalentLevels.set(t.toLowerCase(), meta?.talentLevels?.[t] ?? 1);
    }
    for (const pt of meta?.pitchTalents ?? []) {
      existingTalentLevels.set(pt.pitch.toLowerCase(), pt.level);
    }
    const opts = filledOptions.map((opt) => {
      const def = ALL_TALENTS.find((t) => t.name === opt.name);
      const desc = def ? `(${def.category}: ${def.description})` : '';
      // Official numbers for this pick. For a NEW talent: its Tier-1 value plus
      // the full T1/2/3/4 progression. For a LEVEL-UP: current-tier vs
      // next-tier values, so the AI weighs the MARGINAL gain (e.g. +10%→+12%
      // is a +2% step) against a new talent's full Tier-1 value.
      const lvlNow = existingTalentLevels.get(opt.name.toLowerCase());
      const pickTier = Math.min((lvlNow ?? 0) + 1, MAX_TALENT_LEVEL);
      const magPick = def ? talentMagnitudeAtTier(def.id, pickTier) : null;
      const magRange = def ? talentMagnitude(def.id) : null;
      let magNote = '';
      if (magPick) {
        if (lvlNow) {
          const magNow = def ? talentMagnitudeAtTier(def.id, Math.min(lvlNow, MAX_TALENT_LEVEL)) : null;
          magNote = ` — official numbers: currently T${lvlNow} = ${magNow?.replace(/\n/g, '; ') ?? '?'}; this pick → T${pickTier} = ${magPick.replace(/\n/g, '; ')} (weigh the MARGINAL step, not the total)`;
        } else {
          magNote = ` — official numbers at Tier 1: ${magPick.replace(/\n/g, '; ')} (full progression T1/2/3/4: ${magRange?.split('\n')[0] ?? '?'})`;
        }
      }
      const pitchNote = opt.forPitch ? ` — applied to ${opt.forPitch}` : '';
      const nameLower = opt.name.toLowerCase();
      const existingLvl = existingTalentLevels.get(nameLower);
      let ownershipNote = '';
      if (existingLvl !== undefined) {
        if (existingLvl >= MAX_TALENT_LEVEL) {
          ownershipNote = ` ⚠️ ALREADY AT MAX LEVEL (Lv${MAX_TALENT_LEVEL}) — cannot level further`;
        } else {
          ownershipNote = ` ℹ️ Already owned at Lv${existingLvl} — this would LEVEL UP to Lv${existingLvl + 1}`;
        }
      }
      return `**${opt.name}** ${desc}${magNote}${pitchNote}${ownershipNote}`;
    });
    lines.push('');
    lines.push('The talent options are:');
    opts.forEach((o, i) => lines.push(`${i + 1}. ${o}`));
    lines.push('');
    lines.push(
      'Which talent should I pick? Note: options marked "LEVEL UP" upgrade an existing talent, ' +
      'while "MAX LEVEL" means the talent cannot be leveled further (not a valid pick). ' +
      'All picks cost the same — leveling up an existing talent costs no more or less than adding a new one, ' +
      'so judge purely on effect and synergy, not on whether it is a level-up vs. a new talent. ' +
      'When official numbers are shown, compare a level-up by its MARGINAL step (next tier minus current tier) ' +
      'against a new talent\'s full Tier-1 value — a +2% step on an owned talent usually loses to a fresh +6% ' +
      'unless the owned talent fires far more often or compounds (per-charge / per-pitch effects multiply the step). ' +
      'Consider: synergy with existing talents and pitch repertoire, ' +
      "how it fits the player's position and stats, and whether any option is clearly better or worse. " +
      'Give a clear recommendation with reasoning. Be concise — bullets, not paragraphs.' +
      'If no talents are genuine improvements then suggest that I pick one and reroll it.'
    );
    return lines.join('\n');
  }, [player, meta, filledOptions, talentUsage]);

  const analyze = useCallback(async () => {
    abortRef.current?.abort();
    setFeedback('');
    setStatus('streaming');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/advise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: buildContext(),
          compactContext: buildCompactContext(),
          question: buildPrompt(),
          history: [],
          teamUuid,
          actionType: 'talent-advisor',
        }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        const body = await res.json();
        const info = readRateLimitBody(body);
        if (info) updateRateLimit(info);
        setFeedback(null);
        setStatus('idle');
        return;
      }

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const rl = readRateLimitHeaders(res);
      if (rl) updateRateLimit(rl);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        setFeedback(buf);
      }
      setStatus('done');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback((prev) => (prev || '') + `\n\n[error: ${msg}]`);
      setStatus('error');
    } finally {
      abortRef.current = null;
    }
  }, [buildContext, buildPrompt, teamUuid, updateRateLimit]);

  const reset = () => {
    setSelectedPlayer('');
    setOptions([{ ...EMPTY_OPT }, { ...EMPTY_OPT }, { ...EMPTY_OPT }]);
    setFeedback(null);
    setStatus('idle');
  };

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
            Talent Advisor
          </h2>
          <RateLimitBadge state={rateLimit} />
        </div>
        {(selectedPlayer || filledOptions.length > 0) && (
          <button
            type="button"
            onClick={reset}
            className="rounded-md px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            clear
          </button>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Player</div>
          <select
            value={selectedPlayer}
            onChange={(e) => {
              setSelectedPlayer(e.target.value);
              setOptions([{ ...EMPTY_OPT }, { ...EMPTY_OPT }, { ...EMPTY_OPT }]);
              setFeedback(null);
              setStatus('idle');
            }}
            className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
          >
            <option value="">select a player...</option>
            {players.map((p) => (
              <option key={p.uuid ?? p.name} value={p.uuid ?? ''}>
                {p.name} ({p.position ?? '?'})
              </option>
            ))}
          </select>
        </div>

        {player && (
          <>
            {/* Current talent context */}
            {meta && (meta.talents.length > 0 || (meta.pitchTalents && meta.pitchTalents.length > 0)) && (
              <div className="space-y-1 text-xs text-slate-400">
                {meta.talents.length > 0 && (
                  <div>
                    Talents:{' '}
                    {meta.talents.map((t, i) => {
                      const def = ALL_TALENTS.find((d) => d.name === t);
                      const color = def ? CATEGORY_COLORS[def.category] : 'text-slate-300';
                      const lvl = meta.talentLevels?.[t] ?? 1;
                      return (
                        <span key={t}>
                          {i > 0 && ', '}
                          <span className={color}>{t}{lvl > 1 ? ` Lv${lvl}` : ''}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
                {meta.pitchTalents && meta.pitchTalents.length > 0 && (
                  <div>
                    Pitches:{' '}
                    {meta.pitchTalents.map((pt, i) => (
                      <span key={pt.pitch}>
                        {i > 0 && ' · '}
                        <span className="text-amber-300">
                          {pt.pitch} Lv{pt.level}
                        </span>
                        {pt.sub.length > 0 && (
                          <span className="text-slate-500">
                            {' '}[{pt.sub.map((s) => `${s.name} Lv${s.level}`).join(', ')}]
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-3">
              {options.map((opt, i) => (
                <TalentOption
                  key={i}
                  index={i}
                  value={opt}
                  pitchTypes={pitchTypes}
                  onChange={(val) => setOption(i, val)}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={analyze}
              disabled={!canAnalyze || status === 'streaming' || (rateLimit.remaining === 0 && !!rateLimit.countdown)}
              className={
                'w-full rounded-md px-3 py-2 text-sm font-medium transition-colors ' +
                (!canAnalyze || status === 'streaming' || (rateLimit.remaining === 0 && !!rateLimit.countdown)
                  ? 'cursor-not-allowed bg-slate-800 text-slate-500'
                  : 'bg-emerald-600 text-white hover:bg-emerald-500')
              }
            >
              {status === 'streaming'
                ? 'analyzing...'
                : feedback !== null
                  ? 're-analyze'
                  : 'get recommendation'}
            </button>
          </>
        )}

        {feedback !== null && (
          <div className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2">
            <Markdown
              content={feedback || (status === 'streaming' ? 'thinking...' : '')}
              className="text-sm leading-relaxed text-slate-200"
            />
          </div>
        )}

        {!player && !feedback && (
          <p className="text-sm text-slate-500">
            Choose a player and enter 2-3 talent options to get an AI recommendation on which to pick.
          </p>
        )}
      </div>
    </section>
  );
}
