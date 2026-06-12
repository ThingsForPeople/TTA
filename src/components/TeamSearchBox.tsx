'use client';

import { useEffect, useState } from 'react';

interface TeamSearchRow {
  teamId: string;
  teamName: string;
  managerName: string | null;
  wins: number | null;
  losses: number | null;
  teamLevel: number | null;
}

// Debounced team-name search over tiny-teams (via our /api/team-search proxy).
// One cheap upstream call per (debounced) query; results pick a team by id + name.
// Shared by the Matchups opponent picker and the TeamLookup "find my team" flow.
export function TeamSearchBox({
  onPick,
  placeholder = 'Search team by name…',
  inputClassName = 'w-60 max-w-full',
  autoFocus,
}: {
  onPick: (t: { id: string; name: string }) => void;
  placeholder?: string;
  // Width/layout classes for the input; visual styling is fixed.
  inputClassName?: string;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<TeamSearchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setResults([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/team-search?query=${encodeURIComponent(query)}`);
        const json = await res.json().catch(() => ({}));
        if (!cancelled) setResults((json.results ?? []) as TeamSearchRow[]);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  const showMenu = open && q.trim().length >= 2;

  return (
    <div className="relative text-xs">
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={
          inputClassName +
          ' rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none'
        }
      />
      {showMenu && (
        <div className="absolute z-20 mt-1 max-h-64 w-72 max-w-[calc(100vw-2rem)] overflow-auto rounded border border-slate-700 bg-slate-950 shadow-lg">
          {searching && results.length === 0 ? (
            <div className="px-2 py-1.5 text-slate-500">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-2 py-1.5 text-slate-500">No teams found</div>
          ) : (
            results.map((t) => (
              <button
                key={t.teamId}
                type="button"
                // onMouseDown + preventDefault so the pick lands before the input's
                // blur can tear the menu down (the classic combobox click-vs-blur race).
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick({ id: t.teamId, name: t.teamName });
                  setQ(t.teamName); // show the picked team in the box, not an empty field
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-slate-800"
              >
                <span className="min-w-0 truncate text-slate-200">{t.teamName}</span>
                <span className="shrink-0 text-[10px] text-slate-500">
                  {t.wins != null && t.losses != null ? `${t.wins}-${t.losses}` : ''}
                  {t.teamLevel != null ? ` · L${t.teamLevel}` : ''}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
