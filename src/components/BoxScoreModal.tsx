import { useEffect, useState } from 'react';

interface Props {
  teamUuid: string;
  gameId: string;
  onClose: () => void;
}

interface Inning {
  home: number;
  away: number;
}

interface PlayerLine {
  player_id: string;
  first_name: string;
  last_name: string;
  batting_position: number;
  position: string;
  at_bats: number;
  hits: number;
  singles: number;
  doubles: number;
  triples: number;
  home_runs: number;
  walks: number;
  strikeouts: number;
  rbis: number;
  runs: number;
  batting_avg: number;
  on_base_pct: number;
  slugging_pct: number;
  ops: number;
  pitches_thrown: number;
  innings_pitched: number;
  era: number;
  whip: number;
  pitching_walks: number;
  pitching_hits: number;
  pitching_strikeouts: number;
  runs_allowed: number;
}

interface BoxScoreData {
  game_id: string;
  completed_at: string;
  home_team_name: string;
  away_team_name: string;
  score_home: number;
  score_away: number;
  game_mode: string;
  box_score: {
    innings: Inning[];
    home: { runs: number; hits: number; errors: number };
    away: { runs: number; hits: number; errors: number };
  };
  home_lines: PlayerLine[];
  away_lines: PlayerLine[];
}

function fmtRate(v: number): string {
  if (v >= 1) return v.toFixed(3);
  return v.toFixed(3).replace(/^0/, '');
}

function fmtPitch(v: number): string {
  return v.toFixed(2);
}

function gameModeName(mode: string): string {
  switch (mode) {
    case 'quick_play': return 'Quickplay';
    case 'challenge': return 'Challenge';
    case 'season': return 'Season';
    default: return mode;
  }
}

export function BoxScoreModal({ teamUuid, gameId, onClose }: Props) {
  const [data, setData] = useState<BoxScoreData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/team/${teamUuid}/games/${gameId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (!cancelled) {
          setData(json as BoxScoreData);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [teamUuid, gameId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">Box Score</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
          {loading ? (
            <p className="text-sm text-slate-400">Loading box score...</p>
          ) : error ? (
            <p className="text-sm text-red-300">Failed to load: {error}</p>
          ) : data ? (
            <BoxScoreContent data={data} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BoxScoreContent({ data }: { data: BoxScoreData }) {
  const { box_score, home_lines, away_lines } = data;
  const innings = box_score.innings;
  const awayWon = data.score_away > data.score_home;

  const date = new Date(data.completed_at);
  const dateStr = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <>
      {/* Header */}
      <div className="text-center">
        <div className="text-xs text-slate-500 uppercase tracking-wider">
          {gameModeName(data.game_mode)} &middot; {dateStr}
        </div>
        <div className="mt-1 flex items-center justify-center gap-4 text-lg">
          <span className={awayWon ? 'font-bold text-slate-100' : 'text-slate-400'}>
            {data.away_team_name}
          </span>
          <span className="font-mono font-bold text-slate-100">
            {data.score_away} – {data.score_home}
          </span>
          <span className={!awayWon ? 'font-bold text-slate-100' : 'text-slate-400'}>
            {data.home_team_name}
          </span>
        </div>
      </div>

      {/* Linescore */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-2 py-1 text-left w-40">Team</th>
              {innings.map((_, i) => (
                <th key={i} className="px-1.5 py-1 text-center w-7">{i + 1}</th>
              ))}
              <th className="px-2 py-1 text-center font-bold">R</th>
              <th className="px-2 py-1 text-center">H</th>
              <th className="px-2 py-1 text-center">E</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-800/60">
              <td className={'px-2 py-1 text-slate-200' + (awayWon ? ' font-semibold' : '')}>
                {data.away_team_name}
              </td>
              {innings.map((inn, i) => (
                <td key={i} className="px-1.5 py-1 text-center font-mono text-slate-300">
                  {inn.away}
                </td>
              ))}
              <td className="px-2 py-1 text-center font-mono font-bold text-slate-100">{box_score.away.runs}</td>
              <td className="px-2 py-1 text-center font-mono text-slate-300">{box_score.away.hits}</td>
              <td className="px-2 py-1 text-center font-mono text-slate-300">{box_score.away.errors}</td>
            </tr>
            <tr>
              <td className={'px-2 py-1 text-slate-200' + (!awayWon ? ' font-semibold' : '')}>
                {data.home_team_name}
              </td>
              {innings.map((inn, i) => (
                <td key={i} className="px-1.5 py-1 text-center font-mono text-slate-300">
                  {inn.home}
                </td>
              ))}
              <td className="px-2 py-1 text-center font-mono font-bold text-slate-100">{box_score.home.runs}</td>
              <td className="px-2 py-1 text-center font-mono text-slate-300">{box_score.home.hits}</td>
              <td className="px-2 py-1 text-center font-mono text-slate-300">{box_score.home.errors}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Away team lines */}
      <TeamLines label={data.away_team_name} lines={away_lines} />

      {/* Home team lines */}
      <TeamLines label={data.home_team_name} lines={home_lines} />
    </>
  );
}

function TeamLines({ label, lines }: { label: string; lines: PlayerLine[] }) {
  const sorted = [...lines].sort((a, b) => a.batting_position - b.batting_position);
  const pitcher = sorted.find((p) => p.position === 'P');

  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-2 py-1 text-left">Player</th>
              <th className="px-1.5 py-1 text-left">Pos</th>
              <th className="px-1.5 py-1 text-right">AB</th>
              <th className="px-1.5 py-1 text-right">H</th>
              <th className="px-1.5 py-1 text-right">1B</th>
              <th className="px-1.5 py-1 text-right">2B</th>
              <th className="px-1.5 py-1 text-right">3B</th>
              <th className="px-1.5 py-1 text-right">HR</th>
              <th className="px-1.5 py-1 text-right">BB</th>
              <th className="px-1.5 py-1 text-right">K</th>
              <th className="px-1.5 py-1 text-right">RBI</th>
              <th className="px-1.5 py-1 text-right">R</th>
              <th className="px-1.5 py-1 text-right">AVG</th>
              <th className="px-1.5 py-1 text-right">OBP</th>
              <th className="px-1.5 py-1 text-right">SLG</th>
              <th className="px-1.5 py-1 text-right">OPS</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={p.player_id} className="border-b border-slate-800/60 last:border-0">
                <td className="px-2 py-1 text-slate-200 whitespace-nowrap">
                  {p.first_name} {p.last_name}
                </td>
                <td className="px-1.5 py-1 text-slate-400">{p.position}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{p.at_bats}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{p.hits}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{p.singles}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{p.doubles}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{p.triples}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{p.home_runs}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{p.walks}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{p.strikeouts}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{p.rbis}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{p.runs}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-200">{fmtRate(p.batting_avg)}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-200">{fmtRate(p.on_base_pct)}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-200">{fmtRate(p.slugging_pct)}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-200">{fmtRate(p.ops)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pitcher line */}
      {pitcher && pitcher.pitches_thrown > 0 ? (
        <div className="mt-2 overflow-x-auto">
          <table className="border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-2 py-1 text-left">Pitcher</th>
                <th className="px-1.5 py-1 text-right">IP</th>
                <th className="px-1.5 py-1 text-right">H</th>
                <th className="px-1.5 py-1 text-right">R</th>
                <th className="px-1.5 py-1 text-right">BB</th>
                <th className="px-1.5 py-1 text-right">K</th>
                <th className="px-1.5 py-1 text-right">Pitches</th>
                <th className="px-1.5 py-1 text-right">ERA</th>
                <th className="px-1.5 py-1 text-right">WHIP</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="px-2 py-1 text-slate-200 whitespace-nowrap">
                  {pitcher.first_name} {pitcher.last_name}
                </td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{pitcher.innings_pitched}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{pitcher.pitching_hits}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{pitcher.runs_allowed}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{pitcher.pitching_walks}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{pitcher.pitching_strikeouts}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{pitcher.pitches_thrown}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-200">{fmtPitch(pitcher.era)}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-200">{fmtPitch(pitcher.whip)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
