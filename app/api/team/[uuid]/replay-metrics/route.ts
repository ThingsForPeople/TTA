import { getUser } from '@/lib/auth';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db, hasDb } from '@/db';
import { replayMetrics } from '@/db/schema';
import type { PlayerGameMetrics, AggregatedPlayer, PositionImportance, PlayerPositionSplit } from '@/lib/parseReplay';
import { fitOutCurve, curveOut, expectedOut } from '@/lib/parseReplay';
import { POS_NUM_TO_STR } from '@/lib/fieldingGrades';
import { DEFAULT_POSITION_IMPORTANCE, DEFAULT_STAT_WEIGHTS, type StatWeights } from '@/lib/rosterOptimizer';

const FIELD_POS_STR = ['C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF'];

// How much the recommended importance leans on skill-leverage vs raw workload.
// Pure leverage is noisy at small samples and structurally undercounts high-
// range positions (we only score balls a fielder engaged, not balls a rangy
// fielder could have reached); blending with xOuts (workload) damps both.
const LEVERAGE_BLEND = 0.6;

// How much the derived per-position weights trust the replay data vs the
// hand-tuned prior (DEFAULT_STAT_WEIGHTS), applied to ALL THREE stats. The log
// can't see the signals that matter most — DP/relay value (infield arm) and
// runner deterrence (outfield arm) — so the prior, which encodes them, stays
// dominant; the data nudges the profile toward a team's actual range/arm
// tendencies. The prior keeps arm-led infields and speed-led outfields intact.
const DATA_WEIGHT = 0.35;

// Position importance derived from real fielding workload: how much defensive
// action (and how much skill-sensitive action) flows through each spot.
function buildPositionImportance(rows: { position: number | null; metrics: PlayerGameMetrics }[]): PositionImportance[] {
  const acc: Record<string, { ch: number; xo: number; lev: number; games: number }> = {};
  for (const r of rows) {
    if (r.position == null) continue;
    const ps = POS_NUM_TO_STR[r.position];
    if (!ps || ps === 'P') continue;
    (acc[ps] ??= { ch: 0, xo: 0, lev: 0, games: 0 });
    acc[ps].ch += r.metrics.chances ?? 0;
    acc[ps].xo += r.metrics.expectedOuts ?? 0;
    acc[ps].lev += r.metrics.leverageSum ?? 0;
    acc[ps].games++; // one row = one fielder-game manned here
  }
  const present = FIELD_POS_STR.filter((p) => acc[p]);
  if (present.length === 0) return [];
  const mean = (sel: (a: { ch: number; xo: number; lev: number }) => number) =>
    present.reduce((s, p) => s + sel(acc[p]), 0) / present.length;
  const mCh = mean((a) => a.ch), mXo = mean((a) => a.xo);
  // Mean leverage over positions that actually HAVE leverage, so a position we
  // can't assess this way (e.g. the catcher before steal-defense data exists)
  // doesn't deflate the others — it just falls back to its default importance.
  const levered = present.filter((p) => acc[p].lev > 0);
  const mLev = levered.length ? levered.reduce((s, p) => s + acc[p].lev, 0) / levered.length : 0;
  const r2 = (v: number) => Math.round(v * 100) / 100;

  // Per-position raw shares (un-rounded, for the blend below).
  const rawLev = (p: string) => (acc[p].lev > 0 && mLev > 0 ? acc[p].lev / mLev : null);
  const rawXo = (p: string) => (mXo ? acc[p].xo / mXo : 1);

  // Blend leverage with workload, normalize to mean 1.0 so the recommended
  // weights stay comparable to the hand-tuned defaults.
  const blended = present.map((p) => {
    const lev = rawLev(p);
    const xo = rawXo(p);
    return lev != null ? LEVERAGE_BLEND * lev + (1 - LEVERAGE_BLEND) * xo : xo;
  });
  const mBlend = blended.reduce((s, v) => s + v, 0) / blended.length || 1;

  return present
    .map((p, i) => {
      // Floor/cap two structurally-misread spots AFTER normalizing.
      //  • Catcher floored UP: its only leverage signal is caught-stealing, which
      //    under-counts real C value.
      //  • 1B capped DOWN: workload over-credits it (routine grounders, and it's
      //    the end-point of many putouts), so the data props it above where it
      //    belongs (it's the lowest-leverage spot — the bat-dump position).
      let rec = r2(blended[i] / mBlend);
      if (p === 'C') rec = Math.max(rec, DEFAULT_POSITION_IMPORTANCE['C'] ?? 0.95);
      if (p === '1B') rec = Math.min(rec, DEFAULT_POSITION_IMPORTANCE['1B'] ?? 0.70);
      return {
        position: p,
        chances: acc[p].ch,
        games: acc[p].games,
        chancesPerGame: acc[p].games ? Math.round((acc[p].ch / acc[p].games) * 100) / 100 : 0,
        xOuts: Math.round(acc[p].xo * 10) / 10,
        leverage: Math.round(acc[p].lev * 10) / 10,
        impVolume: mCh ? r2(acc[p].ch / mCh) : 1,
        impXouts: mXo ? r2(acc[p].xo / mXo) : 1,
        impLeverage: acc[p].lev > 0 && mLev > 0 ? r2(acc[p].lev / mLev) : null,
        impRecommended: rec,
      };
    })
    .sort((a, b) => b.impRecommended - a.impRecommended);
}

// Per-position FLD/ARM/SPD weight derivation from real fielding.
//
// We can directly measure two of the three demands and infer the third:
//   • SPD  ← how far fielders actually move to make plays (avg range distance).
//   • ARM  ← how much throwing matters here: throw-share × avg throw speed,
//            where throw-share = throws / (throws + balls fielded). We use the
//            throw RATE, not assists — outfielders make ~6 throws/game (cutoffs,
//            holding runners) but rarely get a credited assist, so an assist-
//            based signal wrongly zeroes their arms. The catcher never fields a
//            batted ball, so its share→1 and its fast caught-stealing pegs rate
//            a high arm weight.
//   • FLD  ← the universal catch/exchange demand every chance needs. We can't
//            isolate "scoop/receive" skill from the log, so FLD is a constant
//            baseline — which naturally dominates at low-range, low-throw spots
//            (1B, C), matching intuition.
//
// The data profile is then blended TOWARD the hand-tuned prior per stat
// (prior-dominant: see DATA_WEIGHT) — the prior carries what the log can't see
// (DP/relay value → infield arm; deterrence → outfield arm), so arm-led
// infields and speed-led outfields survive while the data nudges the magnitudes
// toward a team's real range/arm tendencies. Each row sums to 1.0.
function buildStatWeights(rows: { position: number | null; metrics: PlayerGameMetrics }[]): StatWeights {
  const acc: Record<string, { rangeSum: number; rangeCount: number; throwSum: number; throwCount: number; chances: number }> = {};
  for (const r of rows) {
    if (r.position == null) continue;
    const ps = POS_NUM_TO_STR[r.position];
    if (!ps || ps === 'P') continue;
    (acc[ps] ??= { rangeSum: 0, rangeCount: 0, throwSum: 0, throwCount: 0, chances: 0 });
    acc[ps].rangeSum += r.metrics.rangeSum ?? 0;
    acc[ps].rangeCount += r.metrics.rangeCount ?? 0;
    acc[ps].throwSum += r.metrics.throwSpeedSum ?? 0;
    acc[ps].throwCount += r.metrics.throwSpeedCount ?? 0;
    acc[ps].chances += r.metrics.chances ?? 0;
  }
  const present = FIELD_POS_STR.filter((p) => acc[p]);
  if (present.length === 0) return {};

  // Raw, comparable-within-signal demands per position.
  const spdRaw: Record<string, number> = {};
  const armRaw: Record<string, number> = {};
  for (const p of present) {
    const a = acc[p];
    const avgRange = a.rangeCount > 0 ? a.rangeSum / a.rangeCount : 0;
    const avgThrow = a.throwCount > 0 ? a.throwSum / a.throwCount : 0;
    // Throw-share: of this position's defensive touches, how many are throws.
    // Catcher (no batted balls) → 1; pure receivers (rare throws) → low.
    const throwShare = (a.throwCount + a.chances) > 0 ? a.throwCount / (a.throwCount + a.chances) : 0;
    spdRaw[p] = avgRange;
    armRaw[p] = throwShare * avgThrow;
  }
  const mean = (m: Record<string, number>) => present.reduce((s, p) => s + m[p], 0) / present.length;
  const mSpd = mean(spdRaw), mArm = mean(armRaw);

  // Anchor levels to the defaults' cross-position averages.
  const avgOf = (stat: 'fld' | 'arm' | 'spd') =>
    Object.values(DEFAULT_STAT_WEIGHTS).reduce((s, w) => s + (w[stat] ?? 0), 0) / Object.keys(DEFAULT_STAT_WEIGHTS).length;
  const SPD_AVG = avgOf('spd'), ARM_AVG = avgOf('arm'), FLD_AVG = avgOf('fld');

  const r2 = (v: number) => Math.round(v * 100) / 100;
  const out: StatWeights = {};
  for (const p of present) {
    // Data PROFILE for this position (SPD from range, ARM from throw demand,
    // FLD the flat catch/exchange baseline), normalized to sum 1.
    const spd = mSpd > 0 ? SPD_AVG * (spdRaw[p] / mSpd) : SPD_AVG;
    const arm = mArm > 0 ? ARM_AVG * (armRaw[p] / mArm) : 0;
    const fld = FLD_AVG;
    const sum = spd + arm + fld || 1;
    const dFld = fld / sum, dArm = arm / sum, dSpd = spd / sum;

    // Blend the data profile TOWARD the prior, per stat. The prior carries the
    // signals the log can't see (DP/relay value → infield arm; runner
    // deterrence → outfield arm), so it stays dominant (1 - DATA_WEIGHT) while
    // the data nudges toward the team's real range/arm tendencies. Both inputs
    // sum to 1, so the convex blend sums to 1 too — no renormalization needed.
    const prior = DEFAULT_STAT_WEIGHTS[p];
    if (!prior) { out[p] = { fld: r2(dFld), arm: r2(dArm), spd: r2(dSpd) }; continue; }
    const mix = (d: number, pr: number) => (1 - DATA_WEIGHT) * pr + DATA_WEIGHT * d;
    out[p] = {
      fld: r2(mix(dFld, prior.fld ?? dFld)),
      arm: r2(mix(dArm, prior.arm ?? dArm)),
      spd: r2(mix(dSpd, prior.spd ?? dSpd)),
    };
  }
  return out;
}

// Fielded-ball heat map. Bins the per-chance engagement coords (x,y) into a
// coarse grid PER POSITION and counts outs vs hits, so the client gets a small,
// directly-renderable set instead of thousands of raw points. Binning here (not
// at store time) means the resolution can change without a re-sync. Caveat: this
// is where balls were FIELDED, not a true spray chart — a ball that gets through
// is logged wherever the next fielder picked it up (see route notes / CLAUDE.md).
export interface HeatBin { x: number; y: number; pos: string; outs: number; hits: number }
const HEAT_BIN = 4; // field units per cell

function buildHeatBins(rows: { position: number | null; metrics: PlayerGameMetrics }[]): HeatBin[] {
  const map = new Map<string, HeatBin>();
  for (const r of rows) {
    const ed = r.metrics.engageDists;
    if (!ed || r.position == null) continue;
    const pos = POS_NUM_TO_STR[r.position];
    if (!pos || pos === 'P') continue;
    for (const e of ed) {
      if (typeof e.x !== 'number' || typeof e.y !== 'number') continue;
      const gx = Math.round(e.x / HEAT_BIN) * HEAT_BIN;
      const gy = Math.round(e.y / HEAT_BIN) * HEAT_BIN;
      const key = `${gx}|${gy}|${pos}`;
      let b = map.get(key);
      if (!b) { b = { x: gx, y: gy, pos, outs: 0, hits: 0 }; map.set(key, b); }
      if (e.o) b.outs++; else b.hits++;
    }
  }
  return [...map.values()];
}

// Opponent batted-ball SPRAY (where balls were HIT against us — a true spray
// including balls that got through, derived from contact angle+depth). Stored
// only on pitcher rows (`oppSpray`); binned the same way as the fielding map so
// the two render side-by-side in the same coordinate space.
export interface SprayBin { x: number; y: number; outs: number; hits: number }

function buildSprayBins(rows: { metrics: PlayerGameMetrics }[]): SprayBin[] {
  const map = new Map<string, SprayBin>();
  for (const r of rows) {
    for (const e of r.metrics.oppSpray ?? []) {
      const gx = Math.round(e.x / HEAT_BIN) * HEAT_BIN;
      const gy = Math.round(e.y / HEAT_BIN) * HEAT_BIN;
      const key = `${gx}|${gy}`;
      let b = map.get(key);
      if (!b) { b = { x: gx, y: gy, outs: 0, hits: 0 }; map.set(key, b); }
      if (e.o) b.outs++; else b.hits++;
    }
  }
  return [...map.values()];
}

type Sums = Record<(typeof NUMERIC_KEYS)[number], number>;
const zeroSums = (): Sums => Object.fromEntries(NUMERIC_KEYS.map((k) => [k, 0])) as Sums;

// Build the per-position fielding splits for one player from their per-position
// summed metrics, most-played position first. PAE here is position-pure (each
// game's expectedOuts were computed with that game's own position curve) and
// the curve is calibrated mean-0 per position, so PAE/game is comparable across
// a player's positions for best-fit ranking.
function buildSplits(byPos: Map<number, { games: number; sum: Sums }>): PlayerPositionSplit[] {
  const splits: PlayerPositionSplit[] = [];
  for (const [position, { games, sum: s }] of byPos) {
    const plays = s.putouts + s.assists;
    const pae = s.engagedOuts - s.expectedOuts;
    splits.push({
      position,
      games,
      chances: s.chances,
      putouts: s.putouts,
      assists: s.assists,
      plays,
      fieldErrors: s.fieldErrors,
      fieldPct: plays + s.fieldErrors > 0 ? Math.round((plays / (plays + s.fieldErrors)) * 1000) / 1000 : null,
      pae: Math.round(pae * 10) / 10,
      paePerGame: games > 0 ? Math.round((pae / games) * 100) / 100 : 0,
      expectedOuts: Math.round(s.expectedOuts * 10) / 10,
      rangeAvg: s.rangeCount ? Math.round((s.rangeSum / s.rangeCount) * 10) / 10 : null,
      armAvg: s.throwSpeedCount ? Math.round((s.throwSpeedSum / s.throwSpeedCount) * 10) / 10 : null,
      leverage: Math.round(s.leverageSum * 10) / 10,
      closePlays: s.closePlays,
      stealAttempts: s.stealAttempts,
      caughtStealing: s.caughtStealing,
      dp: s.dpInvolved,
      dpOpp: s.dpOpp,
      basesSaved: Math.round(s.basesSavedSum * 100) / 100,
      basesSavedOpps: s.basesSavedOpps,
    });
  }
  // Most-played first (tie-break by chances), so [0] is the primary position.
  return splits.sort((a, b) => b.games - a.games || b.chances - a.chances);
}

// Re-fit the per-position out-curve from the VISIBLE rows, then rewrite each
// row's curve-dependent metrics (expectedOuts / leverageSum / engagedOuts) in
// place from its raw `engageDists`. Positions with too few visible chances fall
// back to the static POS_CURVE; rows lacking `engageDists` (synced before the
// field existed) are left as stored. Mean PAE/chance ≈ 0 per position over the
// visible set by construction — so PAE always self-calibrates to what's shown.
const DYNAMIC_MIN_CHANCES = 40;
function applyDynamicCurve(rows: { position: number | null; metrics: PlayerGameMetrics }[]) {
  const byPos = new Map<number, { d: number; o: boolean }[]>();
  for (const r of rows) {
    const ed = r.metrics.engageDists;
    if (!ed || r.position == null) continue;
    const arr = byPos.get(r.position) ?? [];
    for (const e of ed) arr.push(e);
    byPos.set(r.position, arr);
  }
  const curves = new Map<number, { a: number; d50: number }>();
  for (const [pos, data] of byPos) {
    const fit = fitOutCurve(data, DYNAMIC_MIN_CHANCES);
    if (fit) curves.set(pos, fit);
  }
  for (const r of rows) {
    const ed = r.metrics.engageDists;
    if (!ed || ed.length === 0) continue;
    const c = r.position != null ? curves.get(r.position) : undefined;
    let eo = 0, xo = 0, lev = 0;
    for (const { d, o } of ed) {
      const p = c ? curveOut(c, d) : expectedOut(d, r.position);
      xo += p; lev += p * (1 - p); if (o) eo++;
    }
    r.metrics = { ...r.metrics, expectedOuts: xo, engagedOuts: eo, leverageSum: lev };
  }
}

// Remove the shared per-GAME fielding-difficulty component from PAE so players
// compare fairly ACROSS games. The out-curve conditions only on (position,
// distance) — it can't see that some games were just harder to field (tough
// opponent, bad pitching, a blowout). A backup whose innings cluster in those
// games would read low for reasons of context, not skill. We estimate each
// game's difficulty from the REST of the team that game (leave-one-out, so a
// fielder can't set his own bar), credit/debit each row by it, then re-center
// per position so the "0 = average fielder here" semantics (and the importance
// derivation, which is left untouched) are preserved. Runs after the dynamic
// curve, on the same visible set — query-time, no re-sync needed.
const MIN_REST_CHANCES = 5;
function applyGameContext(rows: { gameId: string; position: number | null; metrics: PlayerGameMetrics }[]) {
  // Only rows the dynamic curve actually (re)computed participate; pre-backfill
  // rows (no engageDists) keep their stored values.
  const live = rows.filter((r) => r.metrics.engageDists && r.metrics.engageDists.length > 0);
  if (live.length === 0) return;

  // Per-game team totals across all our fielders.
  const game = new Map<string, { outs: number; exp: number; ch: number }>();
  for (const r of live) {
    const g = game.get(r.gameId) ?? { outs: 0, exp: 0, ch: 0 };
    g.outs += r.metrics.engagedOuts ?? 0;
    g.exp += r.metrics.expectedOuts ?? 0;
    g.ch += r.metrics.chances ?? 0;
    game.set(r.gameId, g);
  }

  // Leave-one-out shift: δ = rest-of-team per-chance PAE that game.
  // expectedOuts += δ·chances ⇒ PAE −= δ·chances, so a hard day (rest
  // underperformed, δ<0) credits this fielder up; an easy day debits him.
  for (const r of live) {
    const g = game.get(r.gameId)!;
    const ch = r.metrics.chances ?? 0;
    const restCh = g.ch - ch;
    if (restCh < MIN_REST_CHANCES) continue;
    const restPae = (g.outs - (r.metrics.engagedOuts ?? 0)) - (g.exp - (r.metrics.expectedOuts ?? 0));
    const delta = restPae / restCh;
    r.metrics = { ...r.metrics, expectedOuts: (r.metrics.expectedOuts ?? 0) + delta * ch };
  }

  // Re-center per position so mean PAE/chance ≈ 0 again (the LOO step can drift
  // it). Shift each row's expectedOuts by the position's mean PAE/chance ×
  // chances — sums to exactly zero per position, restoring "0 = average here".
  const pos = new Map<number, { pae: number; ch: number }>();
  for (const r of live) {
    if (r.position == null) continue;
    const a = pos.get(r.position) ?? { pae: 0, ch: 0 };
    a.pae += (r.metrics.engagedOuts ?? 0) - (r.metrics.expectedOuts ?? 0);
    a.ch += r.metrics.chances ?? 0;
    pos.set(r.position, a);
  }
  for (const r of live) {
    if (r.position == null) continue;
    const a = pos.get(r.position)!;
    if (a.ch <= 0) continue;
    const meanPaePerCh = a.pae / a.ch;
    r.metrics = { ...r.metrics, expectedOuts: (r.metrics.expectedOuts ?? 0) + meanPaePerCh * (r.metrics.chances ?? 0) };
  }
}

function aggregate(rows: { playerId: string; playerName: string; position: number | null; metrics: PlayerGameMetrics }[]): AggregatedPlayer[] {
  const acc = new Map<string, { name: string; games: number; sum: Sums; maxEV: number; armMax: number; byPos: Map<number, { games: number; sum: Sums }> }>();
  for (const r of rows) {
    const m = r.metrics;
    let a = acc.get(r.playerId);
    if (!a) {
      a = { name: r.playerName, games: 0, sum: zeroSums(), maxEV: 0, armMax: 0, byPos: new Map() };
      acc.set(r.playerId, a);
    }
    a.games++;
    for (const k of NUMERIC_KEYS) a.sum[k] += (m[k] as number) ?? 0;
    a.maxEV = Math.max(a.maxEV, m.evMax ?? 0);
    a.armMax = Math.max(a.armMax, m.throwSpeedMax ?? 0);
    // Per-position split: only count a game toward a position if the player
    // actually fielded there (had a chance or recorded an out/steal-defense).
    // Catcher (2) is the exception: by model design it has no batted-ball
    // chances, so this gate would collapse its game count to "games with a
    // steal attempt" — badly under-reporting games CAUGHT. Count any game the
    // player was the catcher; steal-relevant counts live in their own columns.
    const fieldedHere = r.position === 2 || m.chances > 0 || m.putouts > 0 || m.assists > 0 || m.stealAttempts > 0 || m.basesSavedOpps > 0;
    if (r.position != null && fieldedHere) {
      let bp = a.byPos.get(r.position);
      if (!bp) { bp = { games: 0, sum: zeroSums() }; a.byPos.set(r.position, bp); }
      bp.games++;
      for (const k of NUMERIC_KEYS) bp.sum[k] += (m[k] as number) ?? 0;
    }
  }

  const out: AggregatedPlayer[] = [];
  for (const [playerId, a] of acc) {
    const s = a.sum;
    const r1 = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0);
    const plays = s.putouts + s.assists;
    const byPosition = buildSplits(a.byPos);
    // Primary = most-played fielding position (replaces the old last-row anchor).
    const primary = byPosition[0]?.position ?? null;
    out.push({
      playerId, name: a.name, position: primary, games: a.games,
      pa: s.pa, ab: s.ab, hits: s.hits, hr: s.hr, k: s.k, bb: s.bb, bip: s.bip,
      avg: r1(s.hits, s.ab), obp: r1(s.hits + s.bb, s.pa), kRate: r1(s.k, s.pa), bbRate: r1(s.bb, s.pa),
      avgEV: s.evCount ? Math.round((s.evSum / s.evCount) * 10) / 10 : null,
      maxEV: a.maxEV || null,
      sweetSpotRate: s.bip ? Math.round((s.sweetSpot / s.bip) * 1000) / 1000 : null,
      xwobaCon: s.bip ? Math.round((s.xwobaConSum / s.bip) * 1000) / 1000 : null,
      wobaCon: s.bip
        ? Math.round(((0.89 * (s.hits - s.doubles - s.triples - s.hr) + 1.27 * s.doubles + 1.62 * s.triples + 2.10 * s.hr) / s.bip) * 1000) / 1000
        : null,
      bbMix: { ground: s.ground, line: s.line, fly: s.fly, popup: s.popup },
      swings: s.swings, whiffs: s.whiffs, chases: s.chases,
      whiffRate: s.swings ? Math.round((s.whiffs / s.swings) * 1000) / 1000 : null,
      putouts: s.putouts, assists: s.assists, fieldErrors: s.fieldErrors, chances: s.chances, plays,
      closePlays: s.closePlays,
      fieldPct: plays + s.fieldErrors > 0 ? Math.round((plays / (plays + s.fieldErrors)) * 1000) / 1000 : null,
      rangeAvg: s.rangeCount ? Math.round((s.rangeSum / s.rangeCount) * 10) / 10 : null,
      armAvg: s.throwSpeedCount ? Math.round((s.throwSpeedSum / s.throwSpeedCount) * 10) / 10 : null,
      armMax: a.armMax || null,
      releaseAvg: s.releaseCount ? Math.round((s.releaseSum / s.releaseCount) * 1000) / 1000 : null,
      pae: Math.round((s.engagedOuts - s.expectedOuts) * 10) / 10,
      expectedOuts: Math.round(s.expectedOuts * 10) / 10,
      basesSaved: s.basesSavedOpps > 0 ? Math.round(s.basesSavedSum * 100) / 100 : null,
      basesSavedPerGame: s.basesSavedOpps > 0 && a.games > 0 ? Math.round((s.basesSavedSum / a.games) * 100) / 100 : null,
      basesSavedOpps: s.basesSavedOpps,
      stealAttempts: s.stealAttempts,
      caughtStealing: s.caughtStealing,
      csRate: s.stealAttempts > 0 ? Math.round((s.caughtStealing / s.stealAttempts) * 1000) / 1000 : null,
      dp: s.dpInvolved, dpStarted: s.dpStarted, dpTurned: s.dpTurned, dpFinished: s.dpFinished, dpOpp: s.dpOpp,
      byPosition,
    });
  }
  out.sort((x, y) => y.plays - x.plays || y.pa - x.pa);
  return out;
}

const NUMERIC_KEYS: (keyof PlayerGameMetrics)[] = [
  'pa', 'ab', 'hits', 'doubles', 'triples', 'hr', 'k', 'bb', 'bip',
  'evSum', 'evCount', 'sweetSpot', 'xwobaConSum', 'ground', 'line', 'fly', 'popup',
  'swings', 'whiffs', 'chases', 'pitchesSeen',
  'putouts', 'assists', 'fieldErrors', 'chances', 'closePlays',
  'rangeSum', 'rangeCount', 'throwSpeedSum', 'throwSpeedCount', 'releaseSum', 'releaseCount',
  'expectedOuts', 'engagedOuts', 'leverageSum', 'basesSavedSum', 'basesSavedOpps', 'stealAttempts', 'caughtStealing',
  'dpInvolved', 'dpStarted', 'dpTurned', 'dpFinished', 'dpOpp',
];

// GET — aggregated advanced stats across stored replay metrics.
// Filters: ?days=N (completed within last N days), ?mode=season|quick_play|challenge, ?games=N (last N games).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ uuid: string }> },
) {
  const userId = await getUser();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const { uuid } = await params;
  if (!hasDb()) return Response.json({ hasDb: false, players: [], totalGames: 0 });

  const { searchParams } = new URL(req.url);
  const days = Number(searchParams.get('days')) || 0;
  const mode = searchParams.get('mode') || '';
  const lastN = Number(searchParams.get('games')) || 0;

  const conds = [eq(replayMetrics.userId, userId), eq(replayMetrics.teamUuid, uuid)];
  if (days > 0) conds.push(gte(replayMetrics.completedAt, new Date(Date.now() - days * 86_400_000)));
  // A specific mode isolates that mode (incl. gauntlet); the default "All" view
  // EXCLUDES gauntlet so its non-representative roster doesn't pollute aggregate
  // stats/importance. `is distinct from` keeps null-mode rows (pre-mode syncs).
  if (mode) conds.push(eq(replayMetrics.gameMode, mode));
  else conds.push(sql`${replayMetrics.gameMode} is distinct from 'gauntlet'`);

  const rows = await db
    .select({
      playerId: replayMetrics.playerId,
      playerName: replayMetrics.playerName,
      position: replayMetrics.position,
      gameId: replayMetrics.gameId,
      completedAt: replayMetrics.completedAt,
      metrics: replayMetrics.metrics,
    })
    .from(replayMetrics)
    .where(and(...conds));

  let filtered = rows;
  if (lastN > 0) {
    // restrict to the most recent N distinct games
    const byGame = new Map<string, number>();
    for (const r of rows) byGame.set(r.gameId, r.completedAt ? r.completedAt.getTime() : 0);
    const keep = new Set([...byGame.entries()].sort((a, b) => b[1] - a[1]).slice(0, lastN).map(([g]) => g));
    filtered = rows.filter((r) => keep.has(r.gameId));
  }

  const totalGames = new Set(filtered.map((r) => r.gameId)).size;
  // Re-fit the out-curve from the VISIBLE set and recompute the curve-dependent
  // metrics (expectedOuts / leverage / PAE) per row, so calibration always
  // tracks what's on screen. Rows without raw chance data (pre-`engageDists`)
  // keep their stored, static-curve values.
  applyDynamicCurve(filtered);
  // Strip the shared per-game fielding-difficulty component from PAE so a
  // backup whose reps cluster in tougher games isn't penalized for context.
  applyGameContext(filtered);
  const players = aggregate(filtered.map((r) => ({ playerId: r.playerId, playerName: r.playerName, position: r.position, metrics: r.metrics })));
  const forImportance = filtered.map((r) => ({ position: r.position, metrics: r.metrics }));
  const positionImportance = buildPositionImportance(forImportance);
  const statWeights = buildStatWeights(forImportance);
  const heatBins = buildHeatBins(forImportance);
  const sprayBins = buildSprayBins(filtered.map((r) => ({ metrics: r.metrics })));

  return Response.json({ hasDb: true, players, totalGames, positionImportance, statWeights, heatBins, sprayBins });
}
