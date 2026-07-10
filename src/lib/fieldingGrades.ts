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

  const grades: FieldingGrades = {};
  for (const p of players) {
    const sp = primarySplit(p);
    const pae = sp?.pae ?? p.pae;
    const games = sp?.games ?? p.games;
    const armAvg = sp?.armAvg ?? p.armAvg;
    const speedZ = armAvg != null ? (armAvg - mean) / std : 0;
    const marginZ = p.throwMarginN >= 8 && p.throwMargin != null ? (p.throwMargin - mMean) / mStd : null;
    grades[p.playerId] = {
      games,
      primaryPos: p.position != null ? POS_NUM_TO_STR[p.position] ?? null : null,
      pae,
      paePerGame: games > 0 ? pae / games : 0,
      rangePaePerGame: sp?.rangePaePerGame ?? p.rangePaePerGame ?? null,
      armAvg,
      armZ: marginZ != null ? (1 - ARM_MARGIN_WEIGHT) * speedZ + ARM_MARGIN_WEIGHT * marginZ : speedZ,
      fieldPct: sp?.fieldPct ?? p.fieldPct,
      basesSavedPerGame: sp && sp.games > 0 ? (sp.basesSaved ?? 0) / sp.games : 0,
      releaseGreatRate: p.releaseGreatRate,
      bobblesPerGame: games > 0 ? p.bobbles / games : 0,
      runMargin: p.runMarginN >= 5 ? p.runMargin : null,
      jumpGreat: p.jumpGreat,
      jumpTotal: p.jumpTotal,
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

export function empiricalFieldingBonus(
  position: string,
  playerUuid: string | undefined,
  grades: FieldingGrades | undefined,
  armImportance: number, // 0–1, how much this position values arm
): number {
  if (!playerUuid || !grades) return 0;
  const g = grades[playerUuid];
  if (!g || g.games < MIN_GAMES) return 0;

  let bonus = 0;
  // Position-anchored PAE — the primary, non-redundant signal. Post-patch,
  // engaged-chance PAE is nearly saturated (fielders convert ~100% of reached
  // balls), so prefer the range-aware rPAE (charges unreached balls) when the
  // re-synced data provides it.
  if (g.primaryPos === position) {
    const conf = Math.min(g.games / 25, 1);
    const anchor = g.rangePaePerGame ?? g.paePerGame;
    bonus += clamp(anchor * PAE_SCALE, -PAE_CAP, PAE_CAP) * conf;
    // Outfield value PAE can't see: extra-base suppression (bases saved). Only
    // at OF, where most "chances" are retrievals rather than out opportunities.
    if (OF_POSITIONS.has(position) && g.basesSavedPerGame) {
      bonus += clamp(g.basesSavedPerGame * BASES_SAVED_SCALE, -BASES_SAVED_CAP, BASES_SAVED_CAP) * conf;
    }
    // Measured exchange quality: reward clean-hands throwers, debit bobblers.
    const exch = (g.releaseGreatRate != null ? (g.releaseGreatRate - 0.5) * 4 : 0) - g.bobblesPerGame * 6;
    bonus += clamp(exch, -EXCHANGE_CAP, EXCHANGE_CAP) * conf;
  }
  // Transferable arm: a measured strong/weak arm matters most where arm matters.
  // (armZ now blends throw speed with the close-play margin outcome signal.)
  bonus += g.armZ * ARM_SCALE * armImportance;
  return Math.round(bonus * 10) / 10;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
