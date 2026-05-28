import { useState } from 'react';
import { CollapsiblePanel } from './CollapsiblePanel';
import type { Team } from '../lib/types';
import { BoxScoreModal } from './BoxScoreModal';

interface Props {
  team: Team;
}

export function RecentGamesPanel({ team }: Props) {
  const games = team.recentGames;
  const [activeGameId, setActiveGameId] = useState<string | null>(null);

  return (
    <CollapsiblePanel title="Recent games" defaultOpen={false}>
      {games.length === 0 ? (
        <p className="text-sm text-slate-400">No recent games on the page.</p>
      ) : (
        <ul className="space-y-1">
          {games.map((g) => (
            <li key={g.gameId}>
              <button
                type="button"
                onClick={() => setActiveGameId(g.gameId)}
                className="flex w-full items-center gap-2 rounded-md bg-slate-950/60 px-3 py-1.5 text-sm text-left transition-colors hover:bg-slate-800"
              >
                <span
                  className={
                    'inline-block w-5 text-center font-mono text-xs ' +
                    (g.won ? 'text-emerald-300' : 'text-red-300')
                  }
                  title={g.won ? 'Won' : 'Lost'}
                >
                  {g.won ? 'W' : 'L'}
                </span>
                <span className="font-mono text-xs text-slate-300">
                  {g.ourScore}–{g.opponentScore}
                </span>
                <span className="text-xs text-slate-500">{g.wasHome ? 'vs' : '@'}</span>
                <span className="flex-1 truncate text-sm text-slate-200">{g.opponentName}</span>
                <span className="font-mono text-[10px] text-slate-500">
                  {formatDate(g.completedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {activeGameId && team.uuid ? (
        <BoxScoreModal
          teamUuid={team.uuid}
          gameId={activeGameId}
          onClose={() => setActiveGameId(null)}
        />
      ) : null}
    </CollapsiblePanel>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
