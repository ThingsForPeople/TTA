// Expected-outcome model — the sim's "Statcast". Maps a batted ball's
// trajectory (launch angle × exit velocity) to its expected value, fit
// empirically from replay `batter.contact` + `batter.result` pairs
// (scripts/fit-expected-outcome.ts). Two outputs from one model:
//   • expectedWobaCon(ev, la) — for OFFENSIVE xwOBA (luck-adjusted hitting:
//     what a hitter's contact "should" have produced, stripping defense/luck).
//   • expectedBases(ev, la)   — for DEFENSIVE expected-bases (the baseline a
//     fielding play is credited against in the bases-saved metric).
//
// RE-FIT 2026-07-08 from 1318 POST-PATCH batted balls (the July 2026 patch
// rebalanced offense: league wOBA-on-contact fell 0.659 → 0.551). Dense cells
// reliable; extreme-combo cells filled to their nearest in-row neighbor. NO
// balls landed in the 40°+ LA buckets post-patch (launch angles compressed) —
// those rows keep near-zero "it's basically an out" fills.
// Re-fit: `REPLAY_DIR=<harvest dir> npx tsx scripts/fit-expected-outcome.ts`.
//
// EV is sim-internal (not mph); EV_CUTS are this sim's batted-ball quintiles.
const EV_CUTS = [32.5, 35.3, 39.7, 45];

// Launch-angle buckets: <0 (chopper) / 0-10 / 10-20 / 20-30 / 30-40 / 40-55 / >55.
function laBucket(la: number): number {
  return la < 0 ? 0 : la < 10 ? 1 : la < 20 ? 2 : la < 30 ? 3 : la < 40 ? 4 : la < 55 ? 5 : 6;
}
function evBucket(ev: number): number {
  return ev < EV_CUTS[0] ? 0 : ev < EV_CUTS[1] ? 1 : ev < EV_CUTS[2] ? 2 : ev < EV_CUTS[3] ? 3 : 4;
}

// [laBucket 0-6][evBucket 0-4]. Empty extreme cells filled to nearest neighbor.
const E_BASES: number[][] = [
  [0.14, 0.13, 0.06, 0.07, 0.07], // <0  grounders (top-EV cell filled)
  [0.35, 0.35, 0.43, 0.33, 0.33], // 0-10 (edge cells filled)
  [0.67, 0.67, 0.67, 0.98, 1.20], // 10-20 line drives (low-EV cells filled)
  [0.60, 0.66, 0.97, 1.49, 2.02], // 20-30
  [0.43, 0.41, 1.09, 2.15, 4.00], // 30-40 fly balls → HR at top EV
  [0.05, 0.05, 0.05, 0.05, 0.05], // 40-55 unobserved post-patch (near-out fill)
  [0.00, 0.05, 0.05, 0.05, 0.05], // >55  unobserved post-patch (near-out fill)
];
const WOBACON: number[][] = [
  [0.124, 0.102, 0.058, 0.065, 0.065],
  [0.314, 0.314, 0.381, 0.297, 0.297],
  [0.583, 0.583, 0.571, 0.773, 0.859],
  [0.534, 0.584, 0.724, 0.938, 1.231],
  [0.381, 0.281, 0.663, 1.169, 2.100],
  [0.040, 0.040, 0.040, 0.040, 0.040],
  [0.000, 0.040, 0.040, 0.040, 0.040],
];

/** League average wOBA-on-contact (the baseline xwOBAcon compares against). */
export const LEAGUE_WOBACON = 0.551;

/** Expected total bases for a batted ball of this trajectory (defense baseline). */
export function expectedBases(exitVelocity: number, launchAngle: number): number {
  return E_BASES[laBucket(launchAngle)][evBucket(exitVelocity)];
}

/** Expected wOBA-on-contact for a batted ball of this trajectory (offense xwOBA). */
export function expectedWobaCon(exitVelocity: number, launchAngle: number): number {
  return WOBACON[laBucket(launchAngle)][evBucket(exitVelocity)];
}

/** Mean expected wOBA-on-contact over a set of batted balls — a hitter's
 *  contact-quality "deserved" production, independent of defense/luck. */
export function xWobaConFromBattedBalls(balls: readonly { ev: number; la: number }[]): number | null {
  if (!balls.length) return null;
  let s = 0;
  for (const b of balls) s += expectedWobaCon(b.ev, b.la);
  return s / balls.length;
}

export { EV_CUTS, E_BASES, WOBACON };
