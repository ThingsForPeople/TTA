import type { AggregatedPlayer } from './parseReplay';

// Turns aggregated replay metrics into a per-player empirical fielding signal
// that the position optimizer can fold into its (otherwise sim-stat-based)
// scoring. Keyed by player uuid (== replay player_id == roster uuid).

export const POS_NUM_TO_STR: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF',
};

export interface FieldingGrade {
  games: number;
  primaryPos: string | null; // the position these metrics were earned at
  pae: number; // total plays above expected
  paePerGame: number;
  // Range-aware PAE/game (charges unreached nearest-fielder balls) — the
  // post-patch skill separator. Preferred over paePerGame when populated.
  rangePaePerGame: number | null;
  // Per-POSITION anchors from the byPosition splits (2026-07-10 audit fix):
  // the empirical bonus anchors at ANY position with enough games, not just
  // the most-played one — a player with 20 G at 2B and 12 G at SS previously
  // got ZERO empirical anchor when evaluated at SS despite 12 games of data.
  byPos: Record<string, { games: number; anchorPerGame: number; basesSavedPerGame: number }>;
  armAvg: number | null;
  armZ: number; // arm evidence relative to the team (z-score; speed + margin)
  fieldPct: number | null;
  basesSavedPerGame: number; // OF extra-base suppression per game (the range PAE can't see)
  // Exchange quality (2026-07-09): share of banded throws released 'great',
  // and bobbles per game — a small measured hands/exchange signal.
  releaseGreatRate: number | null;
  bobblesPerGame: number;
  // Baserunning (for the batting-order side): avg beat against this RUNNER on
  // races (negative = beats throws) + steal-jump quality counts.
  runMargin: number | null;
  jumpGreat: number;
  jumpTotal: number;
  // Caught-stealing above the team-mean rate, per game caught (2026-07-16
  // audit): the one measured catcher skill, previously invisible to the
  // optimizer. null below MIN_STEAL_ATT attempts.
  csAboveMeanPerGame: number | null;
}

export type FieldingGrades = Record<string, FieldingGrade>;

// The player's primary (most-played) position split — the route sorts
// byPosition most-played-first, so [0] is it. We grade off this split rather
// than the position-mixed totals so PAE/arm are position-pure: a player who
// split games between SS and 2B no longer has his SS bonus diluted by 2B reps.
function primarySplit(p: AggregatedPlayer) {
  return p.byPosition?.find((s) => s.position === p.position) ?? p.byPosition?.[0];
}

// Weight of the close-play-margin term inside the arm z-score. Margin is an
// OUTCOME arm read (did throws comfortably beat runners?) but is noisier and
// position-shaped, so raw throw speed stays dominant.
const ARM_MARGIN_WEIGHT = 0.3;

// Minimum steal attempts against before a catcher's CS rate is trusted
// (matches the Advanced Stats panel's CatcherCompare gate).
const MIN_STEAL_ATT = 5;

export function buildFieldingGrades(players: AggregatedPlayer[]): FieldingGrades {
  // Arm evidence combines primary-position throw speed with the close-play
  // margin (both z-scored over the team, then blended).
  const arms = players
    .map((p) => primarySplit(p)?.armAvg ?? p.armAvg)
    .filter((v): v is number => typeof v === 'number');
  const mean = arms.length ? arms.reduce((s, v) => s + v, 0) / arms.length : 0;
  const variance = arms.length ? arms.reduce((s, v) => s + (v - mean) ** 2, 0) / arms.length : 0;
  const std = Math.sqrt(variance) || 1;
  const margins = players
    .map((p) => (p.throwMarginN >= 8 ? p.throwMargin : null))
    .filter((v): v is number => typeof v === 'number');
  const mMean = margins.length ? margins.reduce((s, v) => s + v, 0) / margins.length : 0;
  const mVar = margins.length ? margins.reduce((s, v) => s + (v - mMean) ** 2, 0) / margins.length : 0;
  const mStd = Math.sqrt(mVar) || 1;

  // Team-mean CS rate, the baseline a catcher's steal defense is judged against.
  const totAtt = players.reduce((s, p) => s + (p.stealAttempts ?? 0), 0);
  const totCs = players.reduce((s, p) => s + (p.caughtStealing ?? 0), 0);
  const teamCsRate = totAtt > 0 ? totCs / totAtt : 0;

  const grades: FieldingGrades = {};
  for (const p of players) {
    const sp = primarySplit(p);
    const pae = sp?.pae ?? p.pae;
    const games = sp?.games ?? p.games;
    const armAvg = sp?.armAvg ?? p.armAvg;
    const speedZ = armAvg != null ? (armAvg - mean) / std : 0;
    const marginZ = p.throwMarginN >= 8 && p.throwMargin != null ? (p.throwMargin - mMean) / mStd : null;
    const byPos: FieldingGrade['byPos'] = {};
    for (const s of p.byPosition ?? []) {
      const ps = POS_NUM_TO_STR[s.position];
      if (!ps || s.games <= 0) continue;
      byPos[ps] = {
        games: s.games,
        anchorPerGame: s.rangePaePerGame ?? s.paePerGame,
        basesSavedPerGame: s.games > 0 ? (s.basesSaved ?? 0) / s.games : 0,
      };
    }
    grades[p.playerId] = {
      games,
      primaryPos: p.position != null ? POS_NUM_TO_STR[p.position] ?? null : null,
      pae,
      paePerGame: games > 0 ? pae / games : 0,
      rangePaePerGame: sp?.rangePaePerGame ?? p.rangePaePerGame ?? null,
      byPos,
      armAvg,
      armZ: marginZ != null ? (1 - ARM_MARGIN_WEIGHT) * speedZ + ARM_MARGIN_WEIGHT * marginZ : speedZ,
      fieldPct: sp?.fieldPct ?? p.fieldPct,
      basesSavedPerGame: sp && sp.games > 0 ? (sp.basesSaved ?? 0) / sp.games : 0,
      releaseGreatRate: p.releaseGreatRate,
      bobblesPerGame: games > 0 ? p.bobbles / games : 0,
      runMargin: p.runMarginN >= 5 ? p.runMargin : null,
      jumpGreat: p.jumpGreat,
      jumpTotal: p.jumpTotal,
      csAboveMeanPerGame: (() => {
        if ((p.stealAttempts ?? 0) < MIN_STEAL_ATT) return null;
        // Steal attempts only accrue while catching, so rate over C-split games.
        const cGames = p.byPosition?.find((s) => s.position === 2)?.games ?? (p.position === 2 ? p.games : 0);
        if (!cGames) return null;
        return (p.caughtStealing - teamCsRate * p.stealAttempts) / cGames;
      })(),
    };
  }
  return grades;
}

// ── Empirical position-fit adjustment ────────────────────────────────
// We only adjust a player at the position they ACTUALLY played (anchored to
// real outcomes): a proven-bad fielder there is penalized so the optimizer is
// willing to move them; a proven-great one is rewarded to keep them. We do NOT
// invent an empirical score for positions a player has never played — there's
// no data, so those fall back to sim-stat scoring.
const MIN_GAMES = 10;
const PAE_SCALE = 60; // ~0.25 PAE/game → ~15 pts (enough to flip close calls)
const PAE_CAP = 25;
const ARM_SCALE = 9; // small transferable nudge from a real cannon / weak arm
const OF_POSITIONS = new Set(['LF', 'CF', 'RF']);
const BASES_SAVED_SCALE = 18; // ~0.3 bases-saved/game → ~5 pts
const BASES_SAVED_CAP = 12;
// Exchange term: small — the log can't fully separate hands from luck.
const EXCHANGE_CAP = 3;
// Catcher steal defense: ~0.5 runs per CS (RE24 swing) at ~0.5 att/game keeps
// this small by construction; a +10pp CS% catcher earns ~1.5 pts.
const CS_SCALE = 30;
const CS_CAP = 8;

export function empiricalFieldingBonus(
  position: string,
  playerUuid: string | undefined,
  grades: FieldingGrades | undefined,
  armImportance: number, // 0–1, how much this position values arm
): number {
  if (!playerUuid || !grades) return 0;
  const g = grades[playerUuid];
  if (!g) return 0;

  let bonus = 0;
  // Position-anchored PAE — anchored at the split the player actually earned AT
  // THIS position (2026-07-10 audit fix: previously only the most-played
  // position anchored, so real data at a secondary spot was ignored).
  // Post-patch, engaged-chance PAE is nearly saturated, so the split's anchor
  // prefers the range-aware rPAE (falls back to plain PAE pre-re-sync).
  const split = g.byPos[position];
  if (split && split.games >= MIN_GAMES) {
    const conf = Math.min(split.games / 25, 1);
    bonus += clamp(split.anchorPerGame * PAE_SCALE, -PAE_CAP, PAE_CAP) * conf;
    // Outfield value PAE can't see: extra-base suppression (bases saved). Only
    // at OF, where most "chances" are retrievals rather than out opportunities.
    if (OF_POSITIONS.has(position) && split.basesSavedPerGame) {
      bonus += clamp(split.basesSavedPerGame * BASES_SAVED_SCALE, -BASES_SAVED_CAP, BASES_SAVED_CAP) * conf;
    }
    // Measured exchange quality (player-level): clean hands travel with the
    // player, so apply wherever an anchor exists.
    const exch = (g.releaseGreatRate != null ? (g.releaseGreatRate - 0.5) * 4 : 0) - g.bobblesPerGame * 6;
    bonus += clamp(exch, -EXCHANGE_CAP, EXCHANGE_CAP) * conf;
    // Catcher: the one measured C skill is steal defense — the batted-ball
    // anchor above is ≈0 there by construction (no chances), so credit CS
    // above the team mean instead. A proven steal-stopper keeps his job.
    if (position === 'C' && g.csAboveMeanPerGame != null) {
      bonus += clamp(g.csAboveMeanPerGame * CS_SCALE, -CS_CAP, CS_CAP) * conf;
    }
  }
  // Transferable arm: a measured strong/weak arm matters most where arm matters.
  // (armZ blends throw speed with the close-play margin outcome signal.) Gated
  // on overall sample so tiny-sample z-scores don't leak in.
  if (g.games >= MIN_GAMES) bonus += g.armZ * ARM_SCALE * armImportance;
  return Math.round(bonus * 10) / 10;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
