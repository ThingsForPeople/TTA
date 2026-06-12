import { useEffect, useState } from 'react';
import { TeamSearchBox } from './TeamSearchBox';

interface Props {
  uuid: string;
  onChange: (uuid: string) => void;
  loading: boolean;
  compact?: boolean;
}

export interface RecentTeam {
  uuid: string;
  name: string;
  lastViewed: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECENT_KEY = 'tta:recentTeams';
const MAX_RECENT = 10;

export function loadRecentTeams(): RecentTeam[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RecentTeam[];
  } catch {
    return [];
  }
}

function saveRecentLocal(teams: RecentTeam[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(teams));
  } catch {}
}

export function saveRecentTeam(uuid: string, name: string): void {
  const recent = loadRecentTeams().filter((t) => t.uuid !== uuid);
  recent.unshift({ uuid, name, lastViewed: Date.now() });
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  saveRecentLocal(recent);
  fetch('/api/recent-teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid, name }),
  }).catch(() => {});
}

async function fetchRecentFromApi(): Promise<RecentTeam[]> {
  try {
    const res = await fetch('/api/recent-teams');
    if (!res.ok) return [];
    return (await res.json()) as RecentTeam[];
  } catch {
    return [];
  }
}

function mergeRecent(local: RecentTeam[], api: RecentTeam[]): RecentTeam[] {
  const map = new Map<string, RecentTeam>();
  for (const t of api) map.set(t.uuid, t);
  for (const t of local) {
    const existing = map.get(t.uuid);
    if (!existing || t.lastViewed > existing.lastViewed) map.set(t.uuid, t);
  }
  return Array.from(map.values())
    .sort((a, b) => b.lastViewed - a.lastViewed)
    .slice(0, MAX_RECENT);
}

export function TeamLookup({ uuid, onChange, loading, compact }: Props) {
  const [value, setValue] = useState(uuid);
  const [expanded, setExpanded] = useState(!uuid);
  const trimmed = value.trim();
  const valid = UUID_RE.test(trimmed);
  const dirty = trimmed !== uuid;

  const [recent, setRecent] = useState<RecentTeam[]>([]);
  useEffect(() => {
    setRecent(loadRecentTeams());
    fetchRecentFromApi().then((apiTeams) => {
      const merged = mergeRecent(loadRecentTeams(), apiTeams);
      saveRecentLocal(merged);
      setRecent(merged);
    });
  }, [uuid]);

  const handleSelect = (teamUuid: string) => {
    setValue(teamUuid);
    onChange(teamUuid);
    if (compact) setExpanded(false);
  };

  if (compact && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-xs text-slate-500 hover:text-slate-300 underline-offset-2 hover:underline"
      >
        Switch team
      </button>
    );
  }

  const search = (
    <TeamSearchBox
      placeholder="Search team by name…"
      inputClassName="min-w-[min(18rem,100%)] w-full"
      onPick={(t) => handleSelect(t.id)}
      autoFocus={compact}
    />
  );

  const form = (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          onChange(trimmed);
          if (compact) setExpanded(false);
        }
      }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="or paste a team UUID"
        className="min-w-[min(22rem,100%)] flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
        spellCheck={false}
      />
      <button
        type="submit"
        disabled={!valid || !dirty || loading}
        className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white shadow disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 hover:bg-emerald-500"
      >
        {loading ? 'Loading…' : 'Load'}
      </button>
      {compact ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-xs text-slate-500 hover:text-slate-300"
        >
          cancel
        </button>
      ) : null}
    </form>
  );

  const recentList = recent.length > 0 ? (
    <div className="flex flex-wrap gap-1.5">
      {recent.map((t) => (
        <button
          key={t.uuid}
          type="button"
          disabled={loading}
          onClick={() => handleSelect(t.uuid)}
          className={
            'rounded-md border px-2 py-1 text-xs transition-colors ' +
            (t.uuid === uuid
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-slate-700 bg-slate-800/50 text-slate-300 hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100')
          }
        >
          <span className="font-medium">{t.name}</span>
          <span className="ml-1.5 font-mono text-[10px] text-slate-500">{t.uuid.slice(0, 8)}</span>
        </button>
      ))}
    </div>
  ) : null;

  if (compact) {
    return (
      <div className="space-y-2">
        {recentList}
        {search}
        {form}
        {value.trim() && !valid ? (
          <p className="mt-1 text-xs text-amber-300">Doesn't look like a UUID.</p>
        ) : null}
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center gap-3">
        <h1 className="text-base font-semibold text-slate-100">Tiny Teams Analyzer</h1>
        <span className="text-xs text-slate-500">— scrapes public team-search page</span>
      </div>
      <div className="mt-3 space-y-3">
        {recentList}
        {search}
        {form}
      </div>
      {value.trim() && !valid ? (
        <p className="mt-2 text-xs text-amber-300">Doesn't look like a UUID.</p>
      ) : null}
    </section>
  );
}
