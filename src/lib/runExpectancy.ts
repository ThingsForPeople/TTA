// Run-expectancy / run-value engine (RE24) for Tiny Teams.
//
// Foundation for value-weighting events on BOTH sides of the ball: the run
// value of a fielding play (bases-saved), of a hit, of a batting-order slot, of
// a "clutch" moment. Built from the replay `gameState` (base/out/score), which
// the rest of the pipeline didn't use.
//
// RUN_EXPECTANCY[baseState 0-7][outs 0-2] = expected runs scored from that
// base-out state to the END of the half-inning, fit empirically from replays
// (scripts/fit-run-expectancy.ts) — standard RE24, complete innings only.
//
// RE-FIT 2026-07-08 over 524 complete half-innings of POST-PATCH re-sims —
// the July 2026 patch nearly halved scoring, so the old high-offense matrix
// (RE(empty,0) ≈ 0.87) over-valued everything ~2×. Post-patch RE(empty,0) ≈
// 0.43, close to real-MLB scale. Well-sampled states (n≥50) reliable; thin
// states marked. Two cells are estimates: __3@0out (unobserved, interpolated
// between _2_ and 1_3) and 123@0out (n=3 measured a nonsense 0.667 — below
// 12_@0out; replaced with 12_ scaled by MLB's loaded/12_ ratio ≈1.5). Re-fit
// as more post-patch replays accrue:
// `REPLAY_DIR=<harvest dir> npx tsx scripts/fit-run-expectancy.ts`.
//
// baseState bits: 1B=1, 2B=2, 3B=4 (so 0=empty … 7=loaded).
const RUN_EXPECTANCY: number[][] = [
  [0.426, 0.221, 0.076], // ___  empty
  [0.862, 0.496, 0.167], // 1__
  [0.833, 0.731, 0.268], // _2_
  [1.318, 0.840, 0.400], // 12_
  [0.950, 0.833, 0.333], // __3   (0out estimated; 1-2out thin)
  [1.333, 1.227, 0.647], // 1_3   (thin)
  [2.462, 1.400, 0.697], // _23   (0out thin n=13)
  [2.000, 0.800, 0.676], // 123   (0out estimated from 12_; 1out thin n=10)
];

export interface BaseOut {
  /** [1B, 2B, 3B] occupancy. */
  bases: [boolean, boolean, boolean];
  /** 0, 1, or 2 (3 = inning over → 0 expectancy). */
  outs: number;
}

/** Base-occupancy → state index 0-7 (1B=1, 2B=2, 3B=4). Accepts a replay
 *  `runners` array ([first, second, third] of playerId|null) or 3 booleans. */
export function baseStateIndex(runners: readonly (string | null | boolean | undefined)[]): number {
  return (runners[0] ? 1 : 0) + (runners[1] ? 2 : 0) + (runners[2] ? 4 : 0);
}

/** Expected runs to end of half-inning from this base-out state. 3+ outs → 0. */
export function runExpectancy(baseStateIdx: number, outs: number): number {
  if (outs >= 3) return 0;
  const row = RUN_EXPECTANCY[baseStateIdx] ?? RUN_EXPECTANCY[0];
  return row[Math.max(0, Math.min(2, outs))];
}

/**
 * RE24 run value of a play: the change in run expectancy plus runs that scored.
 *   value = RE(after) − RE(before) + runsScored
 * A play that ends the inning has RE(after) = 0. Positive = the play added
 * run expectancy for the batting team (good for offense / bad for defense).
 */
export function runValue(
  before: { baseStateIdx: number; outs: number },
  after: { baseStateIdx: number; outs: number },
  runsScored: number,
): number {
  return runExpectancy(after.baseStateIdx, after.outs) - runExpectancy(before.baseStateIdx, before.outs) + runsScored;
}

/**
 * Defensive run value of converting (or failing to convert) a play, from the
 * fielding side's perspective: the runs PREVENTED vs. the expected outcome.
 * `outValue` = run value the defense gains by recording the out here;
 * `hitValue` = run value the defense concedes if it becomes the given hit.
 * Used by the planned bases-saved / fielding-RE metric. Sign convention:
 * positive = good for the defense.
 */
export function defensiveRunValue(
  before: { baseStateIdx: number; outs: number },
  afterOut: { baseStateIdx: number; outs: number },
  afterHit: { baseStateIdx: number; outs: number },
  runsOnHit = 0,
): { outValue: number; hitValue: number; swing: number } {
  // Out: negative offensive run value → positive for defense.
  const outValue = -runValue(before, afterOut, 0);
  const hitValue = -runValue(before, afterHit, runsOnHit);
  // How much the play swings: the defensive run difference between the two.
  return { outValue, hitValue, swing: outValue - hitValue };
}

export { RUN_EXPECTANCY };
