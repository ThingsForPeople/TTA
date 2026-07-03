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
// PROVISIONAL (fit 2026-06-29 over ~300 half-innings): well-sampled states
// (bases empty / 1B / 2B / 1st+2nd, n≥40) are reliable; thin states (bases
// loaded, runner-on-3rd at 0-1 out — n<20) are noisy and not strictly monotonic
// yet. This is a high-offense sim: RE(empty,0) ≈ 0.87 runs/inning, ~2× MLB.
// Re-fit as more replays accrue: `npx tsx scripts/fit-run-expectancy.ts`.
//
// baseState bits: 1B=1, 2B=2, 3B=4 (so 0=empty … 7=loaded).
const RUN_EXPECTANCY: number[][] = [
  [0.871, 0.224, 0.097], // ___  empty
  [1.543, 0.667, 0.301], // 1__
  [2.246, 0.762, 0.395], // _2_
  [1.692, 0.727, 0.488], // 12_
  [3.444, 1.938, 0.565], // __3   (thin/noisy)
  [2.364, 1.667, 0.548], // 1_3   (thin)
  [2.800, 1.750, 0.577], // _23   (thin)
  [1.667, 1.667, 1.714], // 123   (thin/noisy)
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
