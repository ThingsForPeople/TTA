'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  DEFAULT_POSITION_IMPORTANCE,
  DEFAULT_STAT_WEIGHTS,
  type StatWeights,
} from '../lib/rosterOptimizer';

const POSITIONS = ['SS', 'CF', '2B', '3B', 'RF', 'LF', 'C', '1B'] as const;
const STATS = ['fld', 'arm', 'spd'] as const;
const STAT_LABELS: Record<string, string> = { fld: 'FLD', arm: 'ARM', spd: 'SPD' };

interface Props {
  teamUuid: string;
  weights: Record<string, number>;
  statWeights: StatWeights;
  onWeightsChange: (weights: Record<string, number>, statWeights: StatWeights) => void;
}

function isDefaultImportance(w: Record<string, number>) {
  return POSITIONS.every(
    (p) => Math.abs((w[p] ?? 1) - (DEFAULT_POSITION_IMPORTANCE[p] ?? 1)) < 0.001,
  );
}

function isDefaultStatWeights(sw: StatWeights) {
  return POSITIONS.every((p) =>
    STATS.every(
      (s) => Math.abs((sw[p]?.[s] ?? 0) - (DEFAULT_STAT_WEIGHTS[p]?.[s] ?? 0)) < 0.001,
    ),
  );
}

export function PositionWeightsEditor({ teamUuid, weights, statWeights, onWeightsChange }: Props) {
  const [open, setOpen] = useState(false);
  const [localW, setLocalW] = useState<Record<string, number>>({ ...weights });
  const [localSW, setLocalSW] = useState<StatWeights>(() =>
    JSON.parse(JSON.stringify(statWeights)),
  );
  const [saving, setSaving] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLocalW({ ...weights });
    setLocalSW(JSON.parse(JSON.stringify(statWeights)));
  }, [weights, statWeights]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const isDefault = isDefaultImportance(localW) && isDefaultStatWeights(localSW);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/position-weights', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamUuid, weights: localW, statWeights: localSW }),
      });
      if (res.ok) {
        onWeightsChange(localW, localSW);
        setOpen(false);
      }
    } finally {
      setSaving(false);
    }
  }, [teamUuid, localW, localSW, onWeightsChange]);

  const reset = useCallback(async () => {
    const dw = { ...DEFAULT_POSITION_IMPORTANCE };
    const dsw: StatWeights = JSON.parse(JSON.stringify(DEFAULT_STAT_WEIGHTS));
    setLocalW(dw);
    setLocalSW(dsw);
    setSaving(true);
    try {
      await fetch(`/api/position-weights?teamUuid=${encodeURIComponent(teamUuid)}`, {
        method: 'DELETE',
      });
      onWeightsChange(dw, dsw);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }, [teamUuid, onWeightsChange]);

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
        title="Configure position weights"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[24rem] rounded-lg border border-slate-700 bg-slate-900 p-3 shadow-xl">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Position weights
          </h3>
          <p className="mb-2 text-[11px] text-slate-600">
            Importance = how much the optimizer values this position. Stat weights = how FLD/ARM/SPD contribute to fit score.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-500">
                  <th className="px-1 py-1 text-left font-medium">Pos</th>
                  <th className="px-1 py-1 text-center font-medium" title="Position importance multiplier">Imp</th>
                  {STATS.map((s) => (
                    <th key={s} className="px-1 py-1 text-center font-medium">{STAT_LABELS[s]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {POSITIONS.map((pos) => (
                  <tr key={pos} className="border-b border-slate-800/40">
                    <td className="px-1 py-1 font-mono font-bold text-slate-400">{pos}</td>
                    <td className="px-1 py-1">
                      <input
                        type="number"
                        step="0.05"
                        min="0"
                        max="2"
                        value={localW[pos] ?? 1}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) setLocalW((p) => ({ ...p, [pos]: Math.round(val * 100) / 100 }));
                        }}
                        className="w-14 rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-center font-mono text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
                      />
                    </td>
                    {STATS.map((stat) => (
                      <td key={stat} className="px-1 py-1">
                        <input
                          type="number"
                          step="0.05"
                          min="0"
                          max="1"
                          value={localSW[pos]?.[stat] ?? 0}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            if (!isNaN(val)) {
                              setLocalSW((prev) => ({
                                ...prev,
                                [pos]: { ...(prev[pos] ?? {}), [stat]: Math.round(val * 100) / 100 },
                              }));
                            }
                          }}
                          className="w-14 rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-center font-mono text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={saving || isDefault}
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-500 transition-colors hover:text-slate-300 disabled:opacity-40"
            >
              Reset defaults
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
