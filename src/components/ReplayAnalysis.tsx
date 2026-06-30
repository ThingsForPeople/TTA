import { useEffect, useMemo, useState } from 'react';
import type { ReplayEvaluation, TeamEval, BbMix, PitcherEval, FieldingLine } from '../lib/parseReplay';
import { POS_NUM_TO_STR } from '../lib/fieldingGrades';
import { buildGameContext } from '../lib/gameSummary';
import { GameAiAnalysis } from './GameAiAnalysis';

interface Props {
  teamUuid: string;
  gameId: string;
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

export function ReplayAnalysis({ teamUuid, gameId }: Props) {
  const [data, setData] = useState<ReplayEvaluation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/team/${teamUuid}/games/${gameId}/replay`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
        return json as ReplayEvaluation;
      })
      .then((json) => { if (!cancelled) { setData(json); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [teamUuid, gameId]);

  const gameContext = useMemo(() => (data ? buildGameContext(data) : ''), [data]);

  if (loading) return <p className="text-sm text-slate-400">Analyzing replay…</p>;
  if (error) return <p className="text-sm text-red-300">Couldn’t analyze replay: {error}</p>;
  if (!data) return null;

  return (
    <div className="space-y-5">
      {!data.matched && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
          Couldn’t match this team to the replay — showing the home side as “us”.
        </div>
      )}

      {/* AI game analysis (rate-limited via /api/advise) */}
      <GameAiAnalysis context={gameContext} teamUuid={teamUuid} />

      {/* Insights */}
      {data.notes.length > 0 && (
        <ul className="space-y-1 rounded-md border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300">
          {data.notes.map((n, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-emerald-400">›</span>
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Team comparison */}
      <TeamCompare us={data.us} them={data.them} threshold={data.hardHitThreshold} />

      {/* Our batting */}
      <BattingTable team={data.us} threshold={data.hardHitThreshold} />

      {/* Our fielding */}
      {data.fielding && data.fielding.length > 0 && <FieldingTable lines={data.fielding} />}

      {/* Our pitching */}
      {data.ourPitcher && <PitchingTable pitcher={data.ourPitcher} />}

      {/* Talent triggering + compounding, per player */}
      {data.talentBreakdown.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Talents fired (our team) — ×triggers this game; <span className="text-amber-300/80">Lv</span> = talent level
          </h3>
          <div className="space-y-1.5">
            {Array.from(
              data.talentBreakdown.reduce((m, t) => {
                (m.get(t.playerId) ?? m.set(t.playerId, []).get(t.playerId)!).push(t);
                return m;
              }, new Map<string, typeof data.talentBreakdown>()).values(),
            ).map((lines) => (
              <div key={lines[0].playerId} className="flex flex-wrap items-baseline gap-1.5">
                <span className="mr-1 text-xs text-slate-400">{lines[0].name}:</span>
                {lines.map((t) => (
                  <span
                    key={t.talentId}
                    className="rounded bg-purple-500/15 px-2 py-0.5 text-xs text-purple-200"
                    title={`${t.count} trigger${t.count === 1 ? '' : 's'} this game` + (t.effects && t.count ? ` · ${(t.effects / t.count).toFixed(1)} effect(s) applied per trigger` : '') + (t.maxTier > 1 ? ` · talent level ${t.maxTier}` : '')}
                  >
                    {t.displayName} <span className="font-mono text-purple-300/70">×{t.count}</span>
                    {t.maxTier > 1 && <span className="ml-1 font-mono text-amber-300/80">Lv{t.maxTier}</span>}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[10px] text-slate-600">
        Exit-velocity / launch-angle figures are sim-internal units, useful for comparison within and across games — not real MLB mph/degrees.
      </p>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="font-mono text-sm text-slate-100">{value}</div>
      {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}

function TeamCompare({ us, them, threshold }: { us: TeamEval; them: TeamEval; threshold: number | null }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
        {us.name} vs {them.name}
      </h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Runs" value={`${us.runs} – ${them.runs}`} />
        <Stat label="Hits" value={`${us.hits} – ${them.hits}`} />
        <Stat label="Avg exit velo" value={us.avgExitVelo ?? '—'} sub={`opp ${them.avgExitVelo ?? '—'}`} />
        <Stat
          label="Hard-hit"
          value={threshold != null ? `${us.hardHit}` : '—'}
          sub={threshold != null ? `${us.hardHitOuts} caught · EV ≥ ${threshold}` : undefined}
        />
        <Stat label="K / BB" value={`${us.k} / ${us.bb}`} />
        <Stat label="Whiff%" value={`${pct(us.whiffs, us.swings)}%`} sub={`${us.swings} swings`} />
        <Stat label="Chases" value={us.chases} sub="swings out of zone" />
        <Stat label="Max exit velo" value={us.maxExitVelo ?? '—'} />
      </div>
      <BbMixBar mix={us.bbMix} />
    </div>
  );
}

function BbMixBar({ mix }: { mix: BbMix }) {
  const total = mix.ground + mix.line + mix.fly + mix.popup;
  if (total === 0) return null;
  const segs: { key: keyof BbMix; label: string; color: string }[] = [
    { key: 'line', label: 'Line', color: 'bg-emerald-500' },
    { key: 'fly', label: 'Fly', color: 'bg-sky-500' },
    { key: 'ground', label: 'Ground', color: 'bg-amber-500' },
    { key: 'popup', label: 'Pop', color: 'bg-red-500' },
  ];
  return (
    <div className="mt-2">
      <div className="flex h-2 overflow-hidden rounded">
        {segs.map((s) => mix[s.key] > 0 && (
          <div key={s.key} className={s.color} style={{ width: `${(mix[s.key] / total) * 100}%` }} title={`${s.label}: ${mix[s.key]}`} />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
        {segs.map((s) => mix[s.key] > 0 && (
          <span key={s.key} className="inline-flex items-center gap-1">
            <span className={`h-2 w-2 rounded-sm ${s.color}`} />
            {s.label} {mix[s.key]}
          </span>
        ))}
      </div>
    </div>
  );
}

function BattingTable({ team, threshold }: { team: TeamEval; threshold: number | null }) {
  if (team.batters.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">Our batting</h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-2 py-1 text-left">Player</th>
              <th className="px-1.5 py-1 text-right">PA</th>
              <th className="px-1.5 py-1 text-right">H</th>
              <th className="px-1.5 py-1 text-right">K</th>
              <th className="px-1.5 py-1 text-right">BB</th>
              <th className="px-1.5 py-1 text-right" title="Balls put in play">BIP</th>
              <th className="px-1.5 py-1 text-right" title="Average exit velocity">Avg EV</th>
              <th className="px-1.5 py-1 text-right" title="Max exit velocity">Max EV</th>
              <th className="px-1.5 py-1 text-right" title={`Hard-hit (EV ≥ ${threshold ?? '?'}) — caught for outs in parens`}>HH</th>
            </tr>
          </thead>
          <tbody>
            {team.batters.map((b) => (
              <tr key={b.playerId} className="border-b border-slate-800/60 last:border-0">
                <td className="px-2 py-1 text-slate-200 whitespace-nowrap">{b.name}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{b.pa}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{b.hits}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{b.k || '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{b.bb || '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-400">{b.battedBalls || '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{b.avgExitVelo ?? '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-200">{b.maxExitVelo ?? '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">
                  {b.hardHit || '·'}
                  {b.hardHitOuts > 0 && <span className="text-red-400/80"> ({b.hardHitOuts})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FieldingTable({ lines }: { lines: FieldingLine[] }) {
  const signed = (v: number) => (v > 0 ? '+' : '') + v;
  const top = [...lines].sort((a, b) => b.pae - a.pae)[0];
  const errs = lines.filter((l) => l.fieldErrors > 0);
  const catcher = lines.find((l) => l.stealAttempts > 0);
  const showHighlight = (top && top.pae >= 0.8) || errs.length > 0 || !!catcher;
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">Our fielding</h3>
      {showHighlight ? (
        <p className="mb-1.5 text-[11px] text-slate-400">
          {top && top.pae >= 0.8 && (
            <>Best glove: <span className="text-emerald-300">{top.name}</span> ({signed(top.pae)} above expected){errs.length > 0 || catcher ? '. ' : '.'}</>
          )}
          {errs.length > 0 && <>Misplays: <span className="text-red-300">{errs.map((e) => `${e.name} (${e.fieldErrors})`).join(', ')}</span>{catcher ? '. ' : '.'}</>}
          {catcher && <>Catcher <span className="text-slate-200">{catcher.name}</span> caught {catcher.caughtStealing}/{catcher.stealAttempts} stealers.</>}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-2 py-1 text-left">Player</th>
              <th className="px-1.5 py-1 text-left">Pos</th>
              <th className="px-1.5 py-1 text-right" title="Batted balls fielded or missed">Ch</th>
              <th className="px-1.5 py-1 text-right">PO</th>
              <th className="px-1.5 py-1 text-right">A</th>
              <th className="px-1.5 py-1 text-right" title="Misplays">E</th>
              <th className="px-1.5 py-1 text-right" title="Double plays turned (any role: started / pivoted / finished)">DP</th>
              <th className="px-1.5 py-1 text-right" title="Difficult plays converted">Tough</th>
              <th className="px-1.5 py-1 text-right" title="Avg distance covered to field a ball (sim units)">Range</th>
              <th className="px-1.5 py-1 text-right" title="Top throw speed">Arm↑</th>
              <th className="px-1.5 py-1 text-right" title="Plays above expected, this game (range-calibrated; noisy in a single game)">PAE</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((f) => (
              <tr key={f.playerId} className="border-b border-slate-800/60 last:border-0">
                <td className="px-2 py-1 text-slate-200 whitespace-nowrap">{f.name}</td>
                <td className="px-1.5 py-1 text-slate-400">{f.position != null ? POS_NUM_TO_STR[f.position] ?? f.position : '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-400">{f.chances || '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{f.putouts || '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{f.assists || '·'}</td>
                <td className={'px-1.5 py-1 text-right font-mono ' + (f.fieldErrors ? 'text-red-400' : 'text-slate-600')}>{f.fieldErrors || '·'}</td>
                <td
                  className={'px-1.5 py-1 text-right font-mono ' + (f.dp ? 'text-emerald-300' : 'text-slate-600')}
                  title={f.dp ? `${[f.dpStarted && `started ${f.dpStarted}`, f.dpTurned && `pivoted ${f.dpTurned}`, f.dpFinished && `finished ${f.dpFinished}`].filter(Boolean).join(', ')}` : undefined}
                >{f.dp || '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{f.closePlays || '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{f.rangeAvg ?? '·'}</td>
                <td className="px-1.5 py-1 text-right font-mono text-slate-300">{f.armMax ? Math.round(f.armMax) : '·'}</td>
                <td className={'px-1.5 py-1 text-right font-mono ' + (f.pae > 0 ? 'text-emerald-400' : f.pae < 0 ? 'text-red-400' : 'text-slate-500')}>
                  {signed(f.pae)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] text-slate-600">
        Single-game fielding is noisy — PAE swings a lot game to game. The Advanced Stats panel (Stats tab) aggregates this across all synced games for stable reads.
      </p>
    </div>
  );
}

function PitchingTable({ pitcher }: { pitcher: PitcherEval }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Our pitching — {pitcher.name}
      </h3>
      <div className="mb-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
        <Stat label="Pitches" value={pitcher.pitches} />
        <Stat label="Swings" value={pitcher.swings} />
        <Stat label="Whiff%" value={`${pct(pitcher.whiffs, pitcher.swings)}%`} />
        <Stat label="Called K" value={pitcher.calledStrikes} />
        <Stat label="Balls" value={pitcher.balls} />
        <Stat label="Mistakes" value={pitcher.mistakes} />
      </div>
      {pitcher.byType.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-2 py-1 text-left">Pitch</th>
                <th className="px-1.5 py-1 text-right">#</th>
                <th className="px-1.5 py-1 text-right">Swings</th>
                <th className="px-1.5 py-1 text-right">Whiffs</th>
                <th className="px-1.5 py-1 text-right">Whiff%</th>
                <th className="px-1.5 py-1 text-right">In play</th>
              </tr>
            </thead>
            <tbody>
              {pitcher.byType.map((t) => (
                <tr key={t.type} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-2 py-1 text-slate-200">{t.label}</td>
                  <td className="px-1.5 py-1 text-right font-mono text-slate-300">{t.count}</td>
                  <td className="px-1.5 py-1 text-right font-mono text-slate-300">{t.swings}</td>
                  <td className="px-1.5 py-1 text-right font-mono text-slate-300">{t.whiffs}</td>
                  <td className="px-1.5 py-1 text-right font-mono text-slate-200">{pct(t.whiffs, t.swings)}%</td>
                  <td className="px-1.5 py-1 text-right font-mono text-slate-400">{t.inPlay}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
