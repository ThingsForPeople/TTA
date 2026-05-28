import type { Team } from '../lib/types';

interface Props {
  team: Team;
  onRefresh: () => void;
  onRecruitOpen?: () => void;
  loading: boolean;
}

export function TeamHeader({ team, onRefresh, onRecruitOpen, loading }: Props) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800 pb-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">{team.name ?? 'Unknown Team'}</h1>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
          {team.manager ? (
            <span>
              Manager: <span className="text-slate-200">{team.manager}</span>
            </span>
          ) : null}
          {team.recentRecord ? (
            <span>
              Recent: <span className="text-slate-200">{team.recentRecord}</span>
            </span>
          ) : null}
          <span>
            Roster: <span className="text-slate-200">{team.players.length}</span>
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {onRecruitOpen ? (
          <button
            type="button"
            onClick={onRecruitOpen}
            className="rounded-md border border-sky-500/40 px-3 py-1.5 text-sm text-sky-300 hover:bg-sky-500/10"
          >
            + Recruit
          </button>
        ) : null}
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </header>
  );
}
