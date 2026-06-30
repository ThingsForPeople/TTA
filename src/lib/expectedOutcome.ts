// Expected-outcome model — the sim's "Statcast". Maps a batted ball's
// trajectory (launch angle × exit velocity) to its expected value, fit
// empirically from replay `batter.contact` + `batter.result` pairs
// (scripts/fit-expected-outcome.ts). Two outputs from one model:
//   • expectedWobaCon(ev, la) — for OFFENSIVE xwOBA (luck-adjusted hitting:
//     what a hitter's contact "should" have produced, stripping defense/luck).
//   • expectedBases(ev, la)   — for DEFENSIVE expected-bases (the baseline a
//     fielding play is credited against in the bases-saved metric).
//
// PROVISIONAL (fit 2026-06-29, 979 batted balls): the EV×LA "barrel" structure
// is clear and reliable in the dense cells; extreme-combo cells (impossible
// pairings like high-LA + top-EV that rarely occur) are filled to their nearest
// in-row neighbor. This is a HIGH-offense sim — league wOBA-on-contact ≈ .659.
// Re-fit as more replays accrue: `npx tsx scripts/fit-expected-outcome.ts`.
//
// EV is sim-internal (not mph); EV_CUTS are this sim's batted-ball quintiles.
const EV_CUTS = [32.5, 36, 40.7, 45];

// Launch-angle buckets: <0 (chopper) / 0-10 / 10-20 / 20-30 / 30-40 / 40-55 / >55.
function laBucket(la: number): number {
  return la < 0 ? 0 : la < 10 ? 1 : la < 20 ? 2 : la < 30 ? 3 : la < 40 ? 4 : la < 55 ? 5 : 6;
}
function evBucket(ev: number): number {
  return ev < EV_CUTS[0] ? 0 : ev < EV_CUTS[1] ? 1 : ev < EV_CUTS[2] ? 2 : ev < EV_CUTS[3] ? 3 : 4;
}

// [laBucket 0-6][evBucket 0-4]. Empty extreme cells filled to nearest neighbor.
const E_BASES: number[][] = [
  [0.38, 0.21, 0.19, 0.24, 0.24], // <0  grounders
  [0.17, 0.41, 0.45, 0.80, 0.80], // 0-10
  [0.69, 0.69, 0.98, 1.05, 1.25], // 10-20 line drives
  [0.67, 1.00, 0.96, 1.65, 2.48], // 20-30
  [0.36, 0.53, 1.89, 2.29, 4.00], // 30-40 fly balls → HR at top EV
  [0.12, 0.12, 0.12, 0.12, 0.12], // 40-55 high flies
  [0.00, 0.15, 0.15, 0.15, 0.15], // >55  pop-ups
];
const WOBACON: number[][] = [
  [0.312, 0.163, 0.167, 0.180, 0.180],
  [0.153, 0.366, 0.400, 0.508, 0.508],
  [0.576, 0.576, 0.732, 0.782, 0.870],
  [0.537, 0.803, 0.745, 1.072, 1.445],
  [0.320, 0.377, 1.094, 1.200, 2.100],
  [0.105, 0.105, 0.105, 0.105, 0.105],
  [0.000, 0.137, 0.137, 0.137, 0.137],
];

/** League average wOBA-on-contact (the baseline xwOBAcon compares against). */
export const LEAGUE_WOBACON = 0.659;

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
