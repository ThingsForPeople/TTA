import { useCallback, useEffect, useMemo, useState } from 'react';
import { SIM_KEYS, SIM_LABELS, type SimStats } from '../lib/playerMeta';
import { computeOvr, type StatSnapshot } from '../lib/statHistory';
import type { Player } from '../lib/types';

interface Props {
  player: Player;
  snapshots: StatSnapshot[];
  onClose: () => void;
  onUpdate: (snapshot: StatSnapshot, sim: SimStats) => void;
  onDelete: (snapshot: StatSnapshot) => void;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(99, Math.round(v) || 0));
}

function formatFullDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function StatHistoryEditor({ player, snapshots, onClose, onUpdate, onDelete }: Props) {
  const sorted = useMemo(
    () => [...snapshots].sort((a, b) => a.timestamp - b.timestamp),
    [snapshots],
  );

  const [currentIndex, setCurrentIndex] = useState(sorted.length - 1);
  const [editingSim, setEditingSim] = useState<SimStats | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (currentIndex >= sorted.length) {
      setCurrentIndex(Math.max(0, sorted.length - 1));
    }
  }, [sorted.length, currentIndex]);

  const snap = sorted[currentIndex];
  if (!snap) return null;

  const prev = currentIndex > 0 ? sorted[currentIndex - 1] : null;
  const displaySim = editingSim ?? snap.sim;
  const displayOvr = computeOvr(displaySim);

  const handleEdit = () => setEditingSim({ ...snap.sim });
  const handleCancel = () => setEditingSim(null);
  const handleSave = () => {
    if (!editingSim) return;
    onUpdate(snap, editingSim);
    setEditingSim(null);
  };

  const handleDelete = () => {
    if (!window.confirm('Delete this snapshot? This cannot be undone.')) return;
    onDelete(snap);
    if (sorted.length <= 1) {
      onClose();
    } else if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  };

  const handleStatChange = (key: keyof SimStats, value: string) => {
    if (!editingSim) return;
    setEditingSim({ ...editingSim, [key]: clamp(Number(value)) });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">
            {player.name}
            <span className="ml-2 text-xs font-normal text-slate-500">Edit History</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="space-y-4 p-4">
          {/* Date navigation */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              disabled={currentIndex === 0}
              onClick={() => { setEditingSim(null); setCurrentIndex(currentIndex - 1); }}
              className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="Previous day"
            >
              ◀
            </button>
            <div className="text-center">
              <div className="text-sm font-medium text-slate-200">{formatFullDate(snap.timestamp)}</div>
              <div className="text-[10px] text-slate-500">
                Day {currentIndex + 1} of {sorted.length}
              </div>
            </div>
            <button
              type="button"
              disabled={currentIndex === sorted.length - 1}
              onClick={() => { setEditingSim(null); setCurrentIndex(currentIndex + 1); }}
              className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="Next day"
            >
              ▶
            </button>
          </div>

          {/* Stat grid */}
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
            {SIM_KEYS.map((k) => {
              const diff = prev ? displaySim[k] - prev.sim[k] : null;
              return (
                <div key={k} className="flex min-w-0 flex-col items-center">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">
                    {SIM_LABELS[k]}
                  </span>
                  {editingSim ? (
                    <input
                      type="number"
                      min={0}
                      max={99}
                      value={editingSim[k]}
                      onChange={(e) => handleStatChange(k, e.target.value)}
                      className="mt-0.5 w-full rounded border border-slate-600 bg-slate-800 px-1 py-0.5 text-center font-mono text-sm text-slate-100 focus:border-emerald-500 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  ) : (
                    <span className="mt-0.5 font-mono text-sm text-slate-100">{displaySim[k]}</span>
                  )}
                  {diff !== null && (
                    <span
                      className={
                        'mt-0.5 font-mono text-[10px] ' +
                        (diff > 0 ? 'text-emerald-400' : diff < 0 ? 'text-red-400' : 'text-slate-600')
                      }
                    >
                      {diff > 0 ? '+' : ''}{diff || '·'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* OVR */}
          <div className="text-center">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">OVR</span>
            <span className="ml-2 font-mono text-sm font-bold text-slate-100">{displayOvr}</span>
            {prev && (
              <span
                className={
                  'ml-1 font-mono text-[10px] ' +
                  (displayOvr - prev.ovr > 0
                    ? 'text-emerald-400'
                    : displayOvr - prev.ovr < 0
                      ? 'text-red-400'
                      : 'text-slate-600')
                }
              >
                {displayOvr - prev.ovr > 0 ? '+' : ''}{displayOvr - prev.ovr || '·'}
              </span>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between border-t border-slate-800 pt-3">
            {editingSim ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleEdit}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
              >
                Edit
              </button>
            )}
            <button
              type="button"
              onClick={handleDelete}
              className="rounded-md px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
