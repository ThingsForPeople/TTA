import { getUser } from '@/lib/auth';
import { and, eq, gte } from 'drizzle-orm';
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

// How much the derived per-position ARM weight trusts the data vs the hand-tuned
// prior. Arm's deterrence value (holding runners) never appears in the event
// log, so we keep half the prior to avoid systematically under-reading it (RF).
const ARM_DATA_WEIGHT = 0.5;

// Position importance derived from real fielding workload: how much defensive
// action (and how much skill-sensitive action) flows through each spot.
function buildPositionImportance(rows: { position: number | null; metrics: PlayerGameMetrics }[]): PositionImportance[] {
  const acc: Record<string, { ch: number; xo: number; lev: number }> = {};
  for (const r of rows) {
    if (r.position == null) continue;
    const ps = POS_NUM_TO_STR[r.position];
    if (!ps || ps === 'P') continue;
    (acc[ps] ??= { ch: 0, xo: 0, lev: 0 });
    acc[ps].ch += r.metrics.chances ?? 0;
    acc[ps].xo += r.metrics.expectedOuts ?? 0;
    acc[ps].lev += r.metrics.leverageSum ?? 0;
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
      // Floor the catcher to its default AFTER normalizing — its only leverage
      // signal is caught-stealing, which structurally under-counts real C value.
      let rec = r2(blended[i] / mBlend);
      if (p === 'C') rec = Math.max(rec, DEFAULT_POSITION_IMPORTANCE['C'] ?? 0.95);
      return {
        position: p,
        chances: acc[p].ch,
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
// The data sets the *profile* (which spot is range- vs arm-heavy); the overall
// magnitude is anchored to the hand-tuned defaults' averages so derived weights
// stay on the same scale. Each position's row is renormalized to sum to 1.0.
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
    const spd = mSpd > 0 ? SPD_AVG * (spdRaw[p] / mSpd) : SPD_AVG;
    const arm = mArm > 0 ? ARM_AVG * (armRaw[p] / mArm) : 0;
    const fld = FLD_AVG;
    const sum = spd + arm + fld || 1;
    const dFld = fld / sum, dArm = arm / sum, dSpd = spd / sum; // derived, sums to 1

    // Shrink the derived ARM toward the hand-tuned prior. Arm value is partly
    // DETERRENCE (a strong corner-OF arm holds runners and prevents extra
    // bases) which never appears in the event log, so the data systematically
    // under-reads it — most visibly at RF. The prior encodes that; blending
    // also tempers data overshoots (e.g. 2B/1B). FLD/SPD keep their data-driven
    // ratio, splitting whatever arm leaves behind.
    const prior = DEFAULT_STAT_WEIGHTS[p];
    if (!prior) { out[p] = { fld: r2(dFld), arm: r2(dArm), spd: r2(dSpd) }; continue; }
    const armFinal = ARM_DATA_WEIGHT * dArm + (1 - ARM_DATA_WEIGHT) * (prior.arm ?? dArm);
    const rest = Math.max(0, 1 - armFinal);
    const fs = dFld + dSpd || 1;
    out[p] = { fld: r2((rest * dFld) / fs), arm: r2(armFinal), spd: r2((rest * dSpd) / fs) };
  }
  return out;
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
    if (r.position != null && (m.chances > 0 || m.putouts > 0 || m.assists > 0 || m.stealAttempts > 0)) {
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
      stealAttempts: s.stealAttempts,
      caughtStealing: s.caughtStealing,
      csRate: s.stealAttempts > 0 ? Math.round((s.caughtStealing / s.stealAttempts) * 1000) / 1000 : null,
      byPosition,
    });
  }
  out.sort((x, y) => y.plays - x.plays || y.pa - x.pa);
  return out;
}

const NUMERIC_KEYS: (keyof PlayerGameMetrics)[] = [
  'pa', 'ab', 'hits', 'doubles', 'triples', 'hr', 'k', 'bb', 'bip',
  'evSum', 'evCount', 'sweetSpot', 'ground', 'line', 'fly', 'popup',
  'swings', 'whiffs', 'chases', 'pitchesSeen',
  'putouts', 'assists', 'fieldErrors', 'chances', 'closePlays',
  'rangeSum', 'rangeCount', 'throwSpeedSum', 'throwSpeedCount', 'releaseSum', 'releaseCount',
  'expectedOuts', 'engagedOuts', 'leverageSum', 'stealAttempts', 'caughtStealing',
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
  if (mode) conds.push(eq(replayMetrics.gameMode, mode));

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
  const players = aggregate(filtered.map((r) => ({ playerId: r.playerId, playerName: r.playerName, position: r.position, metrics: r.metrics })));
  const forImportance = filtered.map((r) => ({ position: r.position, metrics: r.metrics }));
  const positionImportance = buildPositionImportance(forImportance);
  const statWeights = buildStatWeights(forImportance);

  return Response.json({ hasDb: true, players, totalGames, positionImportance, statWeights });
}
