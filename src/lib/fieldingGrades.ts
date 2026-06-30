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
  armAvg: number | null;
  armZ: number; // arm speed relative to the team (z-score)
  fieldPct: number | null;
  basesSavedPerGame: number; // OF extra-base suppression per game (the range PAE can't see)
}

export type FieldingGrades = Record<string, FieldingGrade>;

// The player's primary (most-played) position split — the route sorts
// byPosition most-played-first, so [0] is it. We grade off this split rather
// than the position-mixed totals so PAE/arm are position-pure: a player who
// split games between SS and 2B no longer has his SS bonus diluted by 2B reps.
function primarySplit(p: AggregatedPlayer) {
  return p.byPosition?.find((s) => s.position === p.position) ?? p.byPosition?.[0];
}

export function buildFieldingGrades(players: AggregatedPlayer[]): FieldingGrades {
  // Arm z-score is normalized over each player's PRIMARY-position throw speed.
  const arms = players
    .map((p) => primarySplit(p)?.armAvg ?? p.armAvg)
    .filter((v): v is number => typeof v === 'number');
  const mean = arms.length ? arms.reduce((s, v) => s + v, 0) / arms.length : 0;
  const variance = arms.length ? arms.reduce((s, v) => s + (v - mean) ** 2, 0) / arms.length : 0;
  const std = Math.sqrt(variance) || 1;

  const grades: FieldingGrades = {};
  for (const p of players) {
    const sp = primarySplit(p);
    const pae = sp?.pae ?? p.pae;
    const games = sp?.games ?? p.games;
    const armAvg = sp?.armAvg ?? p.armAvg;
    grades[p.playerId] = {
      games,
      primaryPos: p.position != null ? POS_NUM_TO_STR[p.position] ?? null : null,
      pae,
      paePerGame: games > 0 ? pae / games : 0,
      armAvg,
      armZ: armAvg != null ? (armAvg - mean) / std : 0,
      fieldPct: sp?.fieldPct ?? p.fieldPct,
      basesSavedPerGame: sp && sp.games > 0 ? (sp.basesSaved ?? 0) / sp.games : 0,
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
  // Position-anchored PAE — the primary, non-redundant signal.
  if (g.primaryPos === position) {
    const conf = Math.min(g.games / 25, 1);
    bonus += clamp(g.paePerGame * PAE_SCALE, -PAE_CAP, PAE_CAP) * conf;
    // Outfield value PAE can't see: extra-base suppression (bases saved). Only
    // at OF, where most "chances" are retrievals rather than out opportunities.
    if (OF_POSITIONS.has(position) && g.basesSavedPerGame) {
      bonus += clamp(g.basesSavedPerGame * BASES_SAVED_SCALE, -BASES_SAVED_CAP, BASES_SAVED_CAP) * conf;
    }
  }
  // Transferable arm: a measured strong/weak arm matters most where arm matters.
  bonus += g.armZ * ARM_SCALE * armImportance;
  return Math.round(bonus * 10) / 10;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
