// Turns a parsed single-game ReplayEvaluation into a compact markdown context
// string for the AI game analyzer. Kept separate from the React component so it
// can be reused to build a MULTI-game context later (build per game, concat
// with a trends-oriented prompt).
import type { ReplayEvaluation } from './parseReplay';
import { POS_NUM_TO_STR } from './fieldingGrades';

const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 100) : 0);

function resultsStr(results: Record<string, number>): string {
  return Object.entries(results)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`)
    .join(', ');
}

// Since the 2026-07-08 game patch, replays are re-simulations, not recordings —
// every AI context built from one must carry this framing exactly once.
const RESIM_NOTE =
  'NOTE: since the 2026-07-08 game patch, replays are RE-SIMULATIONS, not recordings. Verified: they use the GAME-TIME rosters, fielding positions, batting order, and talent loadouts (identical to the official box score in all audited games) — only the play-by-play OUTCOME is re-rolled under the current engine, so the score/lines here may differ from the official result. Treat this as a faithful re-roll of the same matchup (process quality, tendencies), NOT as the literal game that happened. Do not reconcile it against the official result.';

// Concatenate several games into one context for a multi-game (matchup) read.
export function buildGamesContext(evals: ReplayEvaluation[], opponentName?: string): string {
  if (!evals.length) return '';
  const header = `# ${evals.length} matchup sim${evals.length === 1 ? '' : 's'}${opponentName ? ` vs ${opponentName}` : ''} (most recent first)`;
  return [header, '', RESIM_NOTE, '', evals.map((ev) => buildGameContext(ev, false)).join('\n\n---\n\n')].join('\n');
}

export function buildGameContext(ev: ReplayEvaluation, includeNote = true): string {
  const { us, them } = ev;
  const outcome = us.runs > them.runs ? 'WIN' : us.runs === them.runs ? 'TIE' : 'LOSS';
  const lines: string[] = [];

  lines.push(`# Single-game matchup sim: ${us.name} vs ${them.name} — ${outcome} ${us.runs}-${them.runs}`);
  if (includeNote) {
    lines.push('');
    lines.push(RESIM_NOTE);
  }
  lines.push('');
  lines.push('## Team comparison (us vs them)');
  lines.push(`- Runs: ${us.runs} vs ${them.runs} | Hits: ${us.hits} vs ${them.hits}`);
  lines.push(`- Avg exit velo: ${us.avgExitVelo ?? '—'} vs ${them.avgExitVelo ?? '—'} | Max EV: ${us.maxExitVelo ?? '—'} vs ${them.maxExitVelo ?? '—'}`);
  if (ev.hardHitThreshold != null) {
    lines.push(`- Hard-hit balls (EV≥${ev.hardHitThreshold}): us ${us.hardHit} (${us.hardHitOuts} caught for outs) vs them ${them.hardHit}`);
  }
  lines.push(`- K / BB: us ${us.k}/${us.bb} vs them ${them.k}/${them.bb}`);
  lines.push(`- Our plate discipline: ${pct(us.whiffs, us.swings)}% whiff on ${us.swings} swings, ${us.chases} chases out of zone`);
  lines.push(`- Our batted-ball mix: ${us.bbMix.line} line, ${us.bbMix.fly} fly, ${us.bbMix.ground} ground, ${us.bbMix.popup} pop`);
  lines.push('');

  if (us.batters.length) {
    lines.push('## Our batting (per player)');
    for (const b of us.batters) {
      const extra = resultsStr(b.results);
      lines.push(
        `- ${b.name}: ${b.hits}-for-${b.pa} PA, ${b.k}K ${b.bb}BB, ${b.battedBalls} BIP, ` +
        `avgEV ${b.avgExitVelo ?? '—'} maxEV ${b.maxExitVelo ?? '—'}, hard-hit ${b.hardHit} (${b.hardHitOuts} caught)` +
        (extra ? ` — ${extra}` : ''),
      );
    }
    lines.push('');
  }

  if (ev.ourPitcher) {
    const p = ev.ourPitcher;
    lines.push('## Our pitching');
    lines.push(
      `- ${p.name}: ${p.pitches} pitches, ${pct(p.whiffs, p.swings)}% whiff (${p.swings} swings), ` +
      `${p.calledStrikes} called strikes, ${p.balls} balls, ${p.mistakes} mistake pitches, ` +
      `${pct(p.overpowered ?? 0, p.pitches)}% overpowered (the engine roll behind whiffs — higher is better for the pitcher)`,
    );
    for (const t of p.byType) {
      const velo = t.veloCount > 0 ? `, ${(t.veloSum / t.veloCount).toFixed(1)} avg velo` : '';
      lines.push(`  - ${t.label}: ${t.count} thrown, ${t.swings} sw, ${t.whiffs} whiff (${pct(t.whiffs, t.swings)}%), ${t.inPlay} in play, ${pct(t.overpowered ?? 0, t.count)}% overpowered${velo}`);
    }
    lines.push('');
  }

  if (ev.fielding && ev.fielding.length) {
    lines.push('## Our fielding');
    for (const f of ev.fielding) {
      const pos = f.position != null ? POS_NUM_TO_STR[f.position] ?? String(f.position) : '?';
      lines.push(
        `- ${f.name} (${pos}): ${f.putouts}PO ${f.assists}A ${f.fieldErrors}E, ${f.chances} ch, ` +
        `PAE ${f.pae > 0 ? '+' : ''}${f.pae}` +
        (f.closePlays ? `, ${f.closePlays} tough plays` : '') +
        (f.stealAttempts ? `, threw out ${f.caughtStealing}/${f.stealAttempts} stealers` : ''),
      );
    }
    lines.push('');
  }

  if (ev.talentActivations.length) {
    lines.push('## Talents fired (our team)');
    lines.push(ev.talentActivations.map((t) => `${t.displayName} ×${t.count}`).join(', '));
    lines.push('');
  }

  if (ev.notes.length) {
    lines.push('## Pre-computed notes');
    for (const n of ev.notes) lines.push(`- ${n}`);
  }

  return lines.join('\n').trim();
}
