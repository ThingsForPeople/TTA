// Validation harness for the batting-order leverage weighting (analysis.ts).
//
// Ground truth = a Monte-Carlo inning simulator (runs/game). We compare the
// lineup the optimizer's OLD objective picks (unweighted Σ slotFit) vs the NEW
// one (Σ SLOT_LEVERAGE·slotFit), both solved EXACTLY via the repo's Hungarian
// maxAssignment, against a naive wOBA-sort and a sim-derived 2-opt ceiling.
// If the leverage weighting is a real improvement, NEW should out-score OLD in
// simulated runs across many random rosters, and sit near the ceiling.
//
//   npx tsx scripts/sim-lineup.ts [numRosters] [gamesPerEval]

import { maxAssignment } from '../src/lib/assign';

// seeded PRNG (mulberry32) so results are reproducible
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A hitter = per-PA outcome probabilities (sum to 1) + the scoring profile the
// optimizer reads, derived the same way analysis.ts profile() does.
interface Hitter {
  bb: number; b1: number; b2: number; b3: number; hr: number; out: number;
  woba: number; obp: number; isoP: number; kRate: number; bbRate: number;
}

const W_BB = 0.69, W_1B = 0.89, W_2B = 1.27, W_3B = 1.62, W_HR = 2.10;
function makeHitter(r: () => number): Hitter {
  const bb = 0.04 + r() * 0.12;
  const k = 0.12 + r() * 0.20;
  const hr = 0.01 + r() * 0.06;
  const b3 = 0.002 + r() * 0.012;
  const b2 = 0.03 + r() * 0.06;
  const b1 = 0.10 + r() * 0.12;
  const hits = b1 + b2 + b3 + hr;
  const out0 = Math.max(0.15, 1 - bb - hits);
  const tot = bb + hits + out0;
  const h: Hitter = {
    bb: bb / tot, b1: b1 / tot, b2: b2 / tot, b3: b3 / tot, hr: hr / tot, out: out0 / tot,
    woba: 0, obp: 0, isoP: 0, kRate: k, bbRate: bb / tot,
  };
  const ab = h.b1 + h.b2 + h.b3 + h.hr + h.out;
  h.woba = W_BB * h.bb + W_1B * h.b1 + W_2B * h.b2 + W_3B * h.b3 + W_HR * h.hr;
  h.obp = h.bb + h.b1 + h.b2 + h.b3 + h.hr;
  const slg = ab > 0 ? (h.b1 + 2 * h.b2 + 3 * h.b3 + 4 * h.hr) / ab : 0;
  const avg = ab > 0 ? (h.b1 + h.b2 + h.b3 + h.hr) / ab : 0;
  h.isoP = slg - avg;
  return h;
}

// slotFit, replicated from analysis.ts (stat mode → no talent bonus).
const WOBA_SCALE = 1.25;
function slotFit(h: Hitter, slot: number): number {
  switch (slot) {
    case 1: return h.obp * WOBA_SCALE + 0.3 * h.bbRate - 0.4 * h.kRate;
    case 2: return h.woba + 0.3 * h.obp;
    case 4: return h.woba + 0.4 * h.isoP;
    case 5: return h.woba - 0.4 * h.kRate;
    case 8: return h.obp - 0.3 * h.kRate;
    default: return h.woba; // 3,6,7,9
  }
}
const SLOT_LEVERAGE: Record<number, number> = {
  1: 1.099, 2: 1.075, 3: 1.049, 4: 1.026, 5: 1.000, 6: 0.976, 7: 0.950, 8: 0.926, 9: 0.900,
};

// Optimal slot assignment for 9 hitters under the chosen objective, via the real
// Hungarian helper. Returns hitters reordered into batting slots 1..9.
function optimize(hitters: Hitter[], weighted: boolean): Hitter[] {
  const weight = hitters.map((h) =>
    Array.from({ length: 9 }, (_, j) => (weighted ? SLOT_LEVERAGE[j + 1] : 1) * slotFit(h, j + 1)),
  );
  const assign = maxAssignment(weight);
  const order: Hitter[] = new Array(9);
  assign.forEach((slot, i) => { if (slot >= 0) order[slot] = hitters[i]; });
  return order;
}

// Monte-Carlo expected runs/game for a batting order. +base advancement model
// (1B +1, 2B +2, 3B→3rd, HR clears; walks force). No DPs — pure & consistent.
function simRuns(order: Hitter[], games: number, seed: number): number {
  const r = rng(seed);
  let total = 0;
  for (let g = 0; g < games; g++) {
    let runs = 0, idx = 0;
    for (let inning = 0; inning < 9; inning++) {
      let outs = 0, on1 = false, on2 = false, on3 = false;
      while (outs < 3) {
        const h = order[idx % 9]; idx++;
        const x = r();
        let c = h.bb;
        if (x < c) {                         // walk (force)
          if (!on1) on1 = true;
          else if (!on2) on2 = true;
          else if (!on3) on3 = true;
          else runs++;
        } else if (x < (c += h.b1)) {        // single
          if (on3) runs++;
          on3 = on2; on2 = on1; on1 = true;
        } else if (x < (c += h.b2)) {        // double
          runs += (on3 ? 1 : 0) + (on2 ? 1 : 0);
          on3 = on1; on2 = true; on1 = false;
        } else if (x < (c += h.b3)) {        // triple
          runs += (on1 ? 1 : 0) + (on2 ? 1 : 0) + (on3 ? 1 : 0);
          on1 = on2 = false; on3 = true;
        } else if (x < (c += h.hr)) {        // homer
          runs += (on1 ? 1 : 0) + (on2 ? 1 : 0) + (on3 ? 1 : 0) + 1;
          on1 = on2 = on3 = false;
        } else { outs++; }
      }
    }
    total += runs;
  }
  return total / games;
}

// Sim-as-objective 2-opt: a ground-truth ceiling for what order maximizes runs.
function simOptimal(hitters: Hitter[], searchGames: number, seed: number): Hitter[] {
  let order = [...hitters].sort((a, b) => b.woba - a.woba);
  let best = simRuns(order, searchGames, seed);
  let improved = true, guard = 0;
  while (improved && guard++ < 4) {
    improved = false;
    for (let i = 0; i < 9; i++) for (let j = i + 1; j < 9; j++) {
      const cand = [...order];
      [cand[i], cand[j]] = [cand[j], cand[i]];
      const v = simRuns(cand, searchGames, seed);
      if (v > best + 1e-6) { best = v; order = cand; improved = true; }
    }
  }
  return order;
}

// ── run ──
const numRosters = Number(process.argv[2] ?? 200);
const games = Number(process.argv[3] ?? 4000);

let sumOld = 0, sumNew = 0, sumWoba = 0, sumCeil = 0;
let newBeatsOld = 0, newTiesOrBeats = 0;
let topHitterTop3New = 0, topHitterTop3Old = 0;

for (let i = 0; i < numRosters; i++) {
  const r = rng(1000 + i);
  const hitters = Array.from({ length: 9 }, () => makeHitter(r));
  const evalSeed = 50_000 + i; // same luck stream for every ordering of this roster

  const oldOrder = optimize(hitters, false);
  const newOrder = optimize(hitters, true);
  const wobaOrder = [...hitters].sort((a, b) => b.woba - a.woba);
  const ceilOrder = simOptimal(hitters, Math.min(1000, games), evalSeed);

  const rOld = simRuns(oldOrder, games, evalSeed);
  const rNew = simRuns(newOrder, games, evalSeed);
  const rWoba = simRuns(wobaOrder, games, evalSeed);
  const rCeil = simRuns(ceilOrder, games, evalSeed);

  sumOld += rOld; sumNew += rNew; sumWoba += rWoba; sumCeil += rCeil;
  if (rNew > rOld + 1e-6) newBeatsOld++;
  if (rNew >= rOld - 1e-6) newTiesOrBeats++;

  // Where does the single best hitter (by wOBA) bat under each objective?
  const top = hitters.reduce((a, b) => (b.woba > a.woba ? b : a));
  if (newOrder.slice(0, 3).includes(top)) topHitterTop3New++;
  if (oldOrder.slice(0, 3).includes(top)) topHitterTop3Old++;
}

const f = (x: number) => (x / numRosters).toFixed(3);
const pct = (x: number) => ((x / numRosters) * 100).toFixed(0) + '%';
console.log(`\nrosters=${numRosters}  games/eval=${games}\n`);
console.log(`mean runs/game:`);
console.log(`  OLD  (unweighted objective):   ${f(sumOld)}`);
console.log(`  NEW  (leverage-weighted):      ${f(sumNew)}   Δ vs OLD = ${(((sumNew - sumOld) / numRosters)).toFixed(3)} (${(((sumNew - sumOld) / sumOld) * 100).toFixed(2)}%)`);
console.log(`  naive wOBA-descending:         ${f(sumWoba)}`);
console.log(`  sim 2-opt ceiling:             ${f(sumCeil)}`);
console.log(`\nNEW beats OLD in ${pct(newBeatsOld)} of rosters; ties-or-beats ${pct(newTiesOrBeats)}.`);
console.log(`gap to ceiling — OLD: ${(((sumCeil - sumOld) / numRosters)).toFixed(3)}, NEW: ${(((sumCeil - sumNew) / numRosters)).toFixed(3)} runs/game.`);
console.log(`best hitter bats in top-3 slots: OLD ${pct(topHitterTop3Old)}, NEW ${pct(topHitterTop3New)}.`);
