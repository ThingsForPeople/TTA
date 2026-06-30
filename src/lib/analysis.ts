import { MAX_TALENT_LEVEL, type PlayerMetaStore } from './playerMeta';
import type { Player, Team } from './types';
import { ZONE_HIT_EFFECT, type ZoneHitEffect } from './talentEffects';

export type BattingSlotRole =
  | 'leadoff'
  | 'quality'
  | 'best'
  | 'cleanup'
  | 'protection'
  | 'lower';

export interface BattingSlot {
  slot: number; // 1-9
  player: Player;
  currentSlot?: number;
  moved: boolean;
  role: BattingSlotRole;
  reason: string;
}

export interface BattingOrderResult {
  recommended: BattingSlot[];
  benched: Player[];
  // Expected runs/game for the recommended order from the lineup simulator
  // (deterministic Monte Carlo). Present when there are enough hitters to sim.
  expectedRuns?: number;
}

// Standard linear weights (2024 MLB environment, close enough for game sims).
const W_BB = 0.69;
const W_1B = 0.89;
const W_2B = 1.27;
const W_3B = 1.62;
const W_HR = 2.10;
const WOBA_SCALE = 1.25;

const RELIABLE_PA = 50;

interface PlayerProfile {
  pa: number;
  woba: number;
  isoP: number;
  kRate: number;
  bbRate: number;
  obp: number;
}

function profile(p: Player): PlayerProfile | undefined {
  const b = p.batting;
  if (!b) return undefined;
  const ab = b.ab ?? 0;
  const bb = b.bb ?? 0;
  const pa = ab + bb;
  if (pa <= 0) return undefined;

  const singles = b.singles ?? Math.max(0, (b.h ?? 0) - (b.doubles ?? 0) - (b.triples ?? 0) - (b.hr ?? 0));
  const doubles = b.doubles ?? 0;
  const triples = b.triples ?? 0;
  const hr = b.hr ?? 0;
  const k = b.k ?? 0;

  const woba = (W_BB * bb + W_1B * singles + W_2B * doubles + W_3B * triples + W_HR * hr) / pa;
  const slg = b.slg ?? (ab > 0 ? (singles + 2 * doubles + 3 * triples + 4 * hr) / ab : 0);
  const avg = b.avg ?? (ab > 0 ? (b.h ?? 0) / ab : 0);

  // Regress small samples toward league-average so a 3-for-5 start doesn't
  // outrank a proven hitter. Full weight at RELIABLE_PA.
  // NOTE (2026-06-29): Tiny Teams is a HIGH-offense sim — measured league
  // ≈ .444 wOBA / .428 OBP across all teams (docs/offense-hitting-findings.md),
  // not the ~.320 of real MLB. The old .320 anchors dragged every low-PA hitter
  // down ~.12, systematically under-rating small-sample players. These match
  // the sim environment (same raw-linear-weights/PA scale as `woba` above).
  // TODO: derive from the team/league population at runtime for self-calibration.
  const confidence = Math.min(pa / RELIABLE_PA, 1);
  const LEAGUE_AVG_WOBA = 0.440;
  const LEAGUE_AVG_OBP = 0.430;
  const regressedWoba = confidence * woba + (1 - confidence) * LEAGUE_AVG_WOBA;
  const rawObp = b.obp ?? (pa > 0 ? ((b.h ?? 0) + bb) / pa : 0);
  const regressedObp = confidence * rawObp + (1 - confidence) * LEAGUE_AVG_OBP;

  return {
    pa,
    woba: regressedWoba,
    isoP: slg - avg,
    kRate: k / pa,
    bbRate: bb / pa,
    obp: regressedObp,
  };
}

// ── Talent value system ─────────────────────────────────────────────
// Talents already show in stats, so these bonuses are small refinements
// that tip tiebreakers — not primary drivers. A talent-stacked player
// won't leapfrog someone with clearly better stats.
//
// Values are in wOBA-equivalent units, scaled by TALENT_WEIGHT (0.15)
// so a Lv3 talent adds ~0.006 wOBA to the slot score (more at Lv4/Lv5).

type SlotRole = 'leadoff' | 'quality' | 'best' | 'cleanup' | 'protection' | 'lower';

// Batting-order optimization modes. Stat-heavy (default) is PURE wOBA/role
// scoring — talents have zero influence on placement and slot-locks (e.g. The
// Janitor → cleanup) are ignored. Talent-heavy turns the locks back on and
// amplifies the talent + baserunning contribution so slot-affinity talents
// drive placement (a player lands in his talent's preferred slot unless a
// clearly better bat outweighs it).
export type BattingMode = 'stat' | 'talent';
const TALENT_MODE_MULT: Record<BattingMode, number> = { stat: 0, talent: 5 };

const TALENT_WEIGHT = 0.15;

interface TalentValue {
  roles: Partial<Record<SlotRole, number>>;
  global?: number;
}

export const TALENT_VALUES: Record<string, TalentValue> = {
  // ── Slot-specific talents — strong affinity for their named role,
  //    penalty elsewhere so they aren't grabbed by earlier picks ──
  'Table Setter':       { roles: { leadoff: 0.08, quality: -0.04, best: -0.06, cleanup: -0.06, protection: -0.04, lower: -0.02 } },
  'The Janitor':        { roles: { cleanup: 0.20, best: -0.40, quality: -0.40, leadoff: -0.40, protection: -0.10, lower: -0.10 } },

  // ── OBP / plate discipline → leadoff, quality ──
  'Disciplined':        { roles: { leadoff: 0.06, quality: 0.04 }, global: 0.02 },
  'Fear Me':            { roles: { leadoff: 0.05, quality: 0.03 }, global: 0.01 },
  'Battler':            { roles: { leadoff: 0.04, quality: 0.03 }, global: 0.02 },

  // ── Contact / early-count → leadoff, quality ──
  'Set the Tone':       { roles: { leadoff: 0.05, quality: 0.04 }, global: 0.03 },
  'Early Bird':         { roles: { leadoff: 0.06, quality: 0.05 }, global: 0.03 },
  'Off Speed Tracker':  { roles: {}, global: 0.03 },

  // ── Power talents → cleanup, best, protection ──
  'Sweet Tooth':        { roles: { cleanup: 0.06, best: 0.04, protection: 0.04 }, global: 0.02 },
  'Knowledge is Power': { roles: { cleanup: 0.04, protection: 0.03 }, global: 0.02 },

  // ── Runners-on talents → best(3), cleanup(4), protection(5) ──
  'Clutch':             { roles: { best: 0.07, cleanup: 0.06, protection: 0.05 }, global: 0.02 },
  'Pressure Cooker':    { roles: { best: 0.05, cleanup: 0.05, protection: 0.04 }, global: 0.01 },
  // Bumped 2026-06-29: replay analysis found Mental Warfare the single biggest
  // contact-quality swing of any hitting talent (+7.8 EV when it fires, with
  // runners on), so it earns a stronger runners-on (best/cleanup/protection) tilt.
  'Mental Warfare':     { roles: { best: 0.05, cleanup: 0.05, protection: 0.04 }, global: 0.03 },

  // ── Chain / next-batter talents → higher in order to maximize downstream ──
  'Clutch Cascade':     { roles: { best: 0.05, cleanup: 0.04, quality: 0.04 }, global: 0.02 },
  'Rally Time':         { roles: { leadoff: 0.05, quality: 0.05, best: 0.04 }, global: 0.02 },
  'Confidence Shaker':  { roles: { leadoff: 0.04, quality: 0.04, best: 0.03 }, global: 0.02 },
  'Waste No Time':      { roles: { leadoff: 0.05, quality: 0.04 }, global: 0.02 },

  // ── Exhausting / grind talents → quality, leadoff (more PAs) ──
  'Exhausting':         { roles: { leadoff: 0.04, quality: 0.04 }, global: 0.02 },
  'Pattern Recognition':{ roles: { quality: 0.03 }, global: 0.02 },

  // ── Situational / conditional ──
  'Breakout Season':    { roles: {}, global: 0.03 },
  'Sun Glasses':        { roles: {}, global: 0.02 },
  'Night Owl':          { roles: {}, global: 0.02 },
  'Lefty Loosey':       { roles: {}, global: 0.03 },
  'Righty Tighty':      { roles: {}, global: 0.03 },
  'Hard to Handle':     { roles: {}, global: 0.02 },

  // ── Zone hitting talents (general and directional) ──
  'Zone Dialed':        { roles: {}, global: 0.03 },
  'Zone Driver':        { roles: { best: 0.02, cleanup: 0.02 }, global: 0.02 },
  'Zone Chopper':       { roles: { leadoff: 0.02 }, global: 0.01 },
  'Zone Popper':        { roles: { cleanup: 0.02 }, global: 0.01 },
  'Zone Hacker':        { roles: { cleanup: 0.02, best: 0.01 }, global: 0.01 },
};

// Role tilts per directional-zone effect family. The effect word (Driver,
// Dialed, …) — not the High/Low/Inside/Outside prefix — sets the offensive
// character, because the prefix only changes WHICH cells get the effect, while
// the effect word maps to the engine stat (see ZONE_HIT_EFFECT in talentEffects).
const ZONE_EFFECT_ROLES: Record<ZoneHitEffect, Partial<Record<SlotRole, number>>> = {
  Driver:  { best: 0.03, cleanup: 0.03, quality: 0.02 }, // line drives → hits
  Dialed:  { leadoff: 0.02, quality: 0.02 },             // contact → on-base/early order
  Popper:  { cleanup: 0.03, protection: 0.02 },          // fly balls → power/HR
  Chopper: { leadoff: 0.02 },                            // grounders → speed beats the throw
  Hacker:  {},                                           // raw aggression, double-edged → no slot lean
};

// Directional zone talents ("High Driver", "Inside Popper", …) are differentiated
// by their effect family's batted-ball outcome rank instead of a flat bonus, so a
// line-drive Driver outweighs a swing-only Hacker as a lineup tiebreaker.
const ZONE_DIR_PREFIXES = ['High', 'Low', 'Inside', 'Outside'];
// Names of the directional zone talents. They influence slot SCORING but are
// hidden from the displayed "synergies" list — every hitter tends to carry
// several, so they'd drown out the meaningful slot-defining talents.
const ZONE_DIR_TALENT_NAMES = new Set<string>();
for (const prefix of ZONE_DIR_PREFIXES) {
  for (const effect of Object.keys(ZONE_HIT_EFFECT) as ZoneHitEffect[]) {
    const name = `${prefix} ${effect}`;
    ZONE_DIR_TALENT_NAMES.add(name);
    if (TALENT_VALUES[name]) continue;
    const { rank } = ZONE_HIT_EFFECT[effect];
    TALENT_VALUES[name] = {
      roles: ZONE_EFFECT_ROLES[effect],
      global: 0.008 + 0.004 * rank, // Driver 0.028 … Hacker 0.012
    };
  }
}

// Index by talent level (1-MAX_TALENT_LEVEL); +0.5 per level above Lv1.
const LEVEL_SCALE = [0, 1.0, 1.5, 2.0, 2.5, 3.0];

function talentBonus(
  playerUuid: string | undefined,
  metaStore: PlayerMetaStore,
  role: SlotRole,
): number {
  if (!playerUuid) return 0;
  const meta = metaStore[playerUuid];
  if (!meta?.talents?.length) return 0;

  let bonus = 0;
  for (const talentName of meta.talents) {
    const tv = TALENT_VALUES[talentName];
    if (!tv) continue;
    const lvl = meta.talentLevels?.[talentName] ?? 1;
    const scale = LEVEL_SCALE[Math.min(lvl, MAX_TALENT_LEVEL)] ?? 1;
    const roleVal = tv.roles[role] ?? 0;
    const globalVal = tv.global ?? 0;
    bonus += (roleVal + globalVal) * scale;
  }
  return bonus * TALENT_WEIGHT;
}

// ── Baserunning talent bonuses ──
// Stealing/speed talents get a bonus for leadoff and top-of-order slots
export const BASERUNNING_VALUES: Record<string, Partial<Record<SlotRole, number>>> = {
  'Thief':              { leadoff: 0.06, quality: 0.03 },
  'Quick Silver':       { leadoff: 0.04, quality: 0.02 },
  'Evasive':            { leadoff: 0.03, quality: 0.02 },
  'Anticipation':       { leadoff: 0.03, quality: 0.02 },
  'Hustler':            { leadoff: 0.03 },
  'Worthy Sacrifice':   { leadoff: 0.02 },
};

function baserunningBonus(
  playerUuid: string | undefined,
  metaStore: PlayerMetaStore,
  role: SlotRole,
): number {
  if (!playerUuid) return 0;
  const meta = metaStore[playerUuid];
  if (!meta?.talents?.length) return 0;

  let bonus = 0;
  for (const talentName of meta.talents) {
    const rv = BASERUNNING_VALUES[talentName];
    if (!rv) continue;
    const lvl = meta.talentLevels?.[talentName] ?? 1;
    const scale = LEVEL_SCALE[Math.min(lvl, MAX_TALENT_LEVEL)] ?? 1;
    bonus += (rv[role] ?? 0) * scale;
  }
  return bonus * TALENT_WEIGHT;
}

function totalTalentBonus(
  uuid: string | undefined,
  ms: PlayerMetaStore,
  role: SlotRole,
  mult = 1,
): number {
  return (talentBonus(uuid, ms, role) + baserunningBonus(uuid, ms, role)) * mult;
}

export function getSlotTalents(
  playerUuid: string | undefined,
  metaStore: PlayerMetaStore,
  role: BattingSlotRole,
): string[] {
  if (!playerUuid || role === 'lower') return [];
  const meta = metaStore[playerUuid];
  if (!meta?.talents?.length) return [];
  const matched: string[] = [];
  for (const talentName of meta.talents) {
    // Directional zone talents still affect scoring, but they're too numerous
    // and generic to belong in the surfaced synergy list.
    if (ZONE_DIR_TALENT_NAMES.has(talentName)) continue;
    const tv = TALENT_VALUES[talentName];
    const rv = BASERUNNING_VALUES[talentName];
    const hasRole = tv?.roles[role as SlotRole] && tv.roles[role as SlotRole]! > 0;
    const hasBaserunning = rv?.[role as SlotRole] && rv[role as SlotRole]! > 0;
    if (hasRole || hasBaserunning) {
      const lvl = meta.talentLevels?.[talentName] ?? 1;
      matched.push(lvl > 1 ? `${talentName} Lv${lvl}` : talentName);
    }
  }
  return matched;
}

function pickHighest<T>(pool: T[], score: (x: T) => number | undefined): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const item of pool) {
    const s = score(item);
    if (s === undefined) continue;
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return best;
}

// ── Slot scoring & global assignment ────────────────────────────────
// Every player is scored against every slot (wOBA with role-specific tilts
// plus talent bonuses), then we solve for the assignment that maximizes
// TOTAL lineup fit. This replaces the old greedy fill, which decided #3
// before #4 (so a high-wOBA bat got grabbed for #3 before cleanup was even
// considered) and let raw wOBA override slot-locked talents. Talents whose
// effect only works at one slot are hard-pinned there first.
//
// Scoring references: Tango/Lichtman/Dolphin "The Book", FanGraphs wOBA.

const SLOT_ROLES: Record<number, BattingSlotRole> = {
  1: 'leadoff', 2: 'quality', 3: 'best', 4: 'cleanup', 5: 'protection',
  6: 'lower', 7: 'lower', 8: 'lower', 9: 'lower',
};

// Per-slot run leverage — how much a slot's hitter quality matters to scoring,
// used to WEIGHT the assignment objective. Without it the objective was an
// unweighted sum of per-slot fit, so it was literally indifferent to whether
// your best bat hit 3rd or 7th (both pure-wOBA slots scored identically), and
// nothing encoded the top-of-order plate-appearance premium. These are MLB
// plate-appearances-per-game by lineup slot (≈4.65 leadoff → 3.81 ninth),
// normalized to mean 1.0 — the dominant, least-disputable driver of slot value.
// The finer "men-on" context (#4 RBI leverage, #2 over #3) is approximated by
// the existing per-slot stat tilts in slotFit (ISO at #4, OBP at #2) rather than
// fabricated run-expectancy coefficients. Maximizing Σ leverage·fit then pulls
// better hitters up the order (rearrangement inequality) and breaks the tie.
const SLOT_LEVERAGE: Record<number, number> = {
  1: 1.099, 2: 1.075, 3: 1.049, 4: 1.026, 5: 1.000,
  6: 0.976, 7: 0.950, 8: 0.926, 9: 0.900,
};

const SLOT_REASON: Record<number, string> = {
  1: 'Leadoff — OBP-driven, low K%',
  2: '#2 — wOBA + OBP tilt',
  3: '#3 — highest wOBA',
  4: '#4 — wOBA + ISO power',
  5: '#5 — wOBA + contact',
  6: '#6 — wOBA',
  7: '#7 — wOBA',
  8: '#8 — OBP, turns the order over',
  9: '#9 — wOBA',
};

// Talents whose effect only functions at a specific slot, so the holder is
// hard-pinned there — the talent is dead weight anywhere else. The Janitor's
// power boost applies only "when batting cleanup".
const SLOT_LOCKED_TALENTS: Record<string, number> = {
  'The Janitor': 4,
};

// Fill priority for the greedy seed (refined afterward by 2-opt). Highest-
// leverage slots claim their best-fit hitter first, matching the weighted
// objective so 2-opt starts near the optimum.
const SLOT_SEED_PRIORITY = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function slotFit(p: Player, slot: number, ms: PlayerMetaStore, mult = 1): number {
  const role = SLOT_ROLES[slot];
  const tb = totalTalentBonus(p.uuid, ms, role, mult);
  const pr = profile(p);
  if (!pr) return tb; // no stats yet → sorts to the bottom, still placeable
  switch (slot) {
    // K% mostly double-counts OBP (which already reflects strikeouts), so its
    // marginal leadoff value is ~0 in the data — trimmed 0.4→0.15 (2026-06-29).
    case 1: return pr.obp * WOBA_SCALE + 0.3 * pr.bbRate - 0.15 * pr.kRate + tb;
    case 2: return pr.woba + 0.3 * pr.obp + tb;
    case 4: return pr.woba + 0.4 * pr.isoP + tb;
    case 5: return pr.woba - 0.4 * pr.kRate + tb;
    case 8: return pr.obp - 0.3 * pr.kRate + tb;
    default: return pr.woba + tb; // 3, 6, 7, 9
  }
}

// ── Lineup run-expectancy simulator (RE-optimal order) ──────────────
// Deterministic Monte Carlo: play the order through 9-inning games and average
// runs. Used to refine the role-based order toward maximum run production. Two
// design choices keep it sound: (1) a SEEDED RNG (mulberry32) → stable, non-
// flickering recommendations; (2) COMMON RANDOM NUMBERS — every order is scored
// on the SAME seed, so order-vs-order comparisons cancel the simulation noise
// and reflect the lineup, not the dice. Advancement is standard and simplified
// (single: runners +1 base, 3rd scores; double: +2, batter to 2nd; etc.); the
// model is approximate but CONSISTENT across orders, which is what ordering
// needs. Expected runs land near RE(empty,0)×9 for this sim (~7-8/game).
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BatterRates { out: number; bb: number; b1: number; b2: number; b3: number; hr: number }
const LEAGUE_RATES: BatterRates = { out: 0.50, bb: 0.08, b1: 0.24, b2: 0.09, b3: 0.02, hr: 0.07 };

// Per-batter PA outcome probabilities from box stats, regressed toward league
// for small samples (same confidence ramp as profile()).
function batterRates(p: Player): BatterRates {
  const b = p.batting;
  if (!b) return LEAGUE_RATES;
  const ab = b.ab ?? 0, bb = b.bb ?? 0, pa = ab + bb;
  if (pa <= 0) return LEAGUE_RATES;
  const hr = b.hr ?? 0, t3 = b.triples ?? 0, t2 = b.doubles ?? 0;
  const b1 = b.singles ?? Math.max(0, (b.h ?? 0) - t2 - t3 - hr);
  const raw = { bb: bb / pa, hr: hr / pa, b3: t3 / pa, b2: t2 / pa, b1: b1 / pa };
  const out = Math.max(0, 1 - (raw.bb + raw.hr + raw.b3 + raw.b2 + raw.b1));
  const conf = Math.min(pa / RELIABLE_PA, 1);
  const mix = (r: number, lg: number) => conf * r + (1 - conf) * lg;
  return {
    out: mix(out, LEAGUE_RATES.out), bb: mix(raw.bb, LEAGUE_RATES.bb), b1: mix(raw.b1, LEAGUE_RATES.b1),
    b2: mix(raw.b2, LEAGUE_RATES.b2), b3: mix(raw.b3, LEAGUE_RATES.b3), hr: mix(raw.hr, LEAGUE_RATES.hr),
  };
}

const SIM_GAMES = 1000;
const SIM_SEED = 0x9e3779b9; // fixed → deterministic + common-random-numbers

// Expected runs/game for a batting order. `rates` is the per-slot outcome table
// (precomputed once and reordered by the optimizer to avoid recompute churn).
function simulateLineupRuns(rates: BatterRates[], games = SIM_GAMES, seed = SIM_SEED): number {
  const n = rates.length;
  if (n === 0) return 0;
  const rand = mulberry32(seed);
  let total = 0;
  for (let g = 0; g < games; g++) {
    let batter = 0, runs = 0;
    for (let inning = 0; inning < 9; inning++) {
      let outs = 0, first = false, second = false, third = false;
      while (outs < 3) {
        const r = rates[batter % n]; batter++;
        let x = rand();
        if (x < r.out) { outs++; continue; }
        x -= r.out;
        if (x < r.bb) { // walk — force only
          if (first && second && third) runs++;
          else if (first && second) third = true;
          else if (first) second = true;
          first = true;
        } else if ((x -= r.bb) < r.b1) { // single
          if (third) runs++;
          third = second; second = first; first = true;
        } else if ((x -= r.b1) < r.b2) { // double
          if (third) runs++; if (second) runs++;
          third = first; second = true; first = false;
        } else if ((x -= r.b2) < r.b3) { // triple
          if (first) runs++; if (second) runs++; if (third) runs++;
          first = false; second = false; third = true;
        } else { // home run
          runs += 1 + (first ? 1 : 0) + (second ? 1 : 0) + (third ? 1 : 0);
          first = second = third = false;
        }
      }
    }
    total += runs;
  }
  return total / games;
}

/**
 * Lineup construction by global assignment.
 *
 * 1. Hard-pin slot-locked talents (e.g. The Janitor → cleanup).
 * 2. Pick the best N hitters to fill N slots (pinned holders always play).
 * 3. Seed an assignment greedily, then run 2-opt swaps to maximize total
 *    lineup fit (role + per-slot leverage). Talent value is baked into slotFit.
 * 4. In stat mode, a final RE-based 2-opt refines the order to maximize actual
 *    expected runs (the simulator above) — seeded from the already-good role
 *    order, so it only moves a hitter when it genuinely scores more runs.
 */
function buildBattingOrder(
  team: Team,
  ms: PlayerMetaStore,
  mode: BattingMode = 'stat',
): BattingOrderResult {
  const mult = TALENT_MODE_MULT[mode];
  const all = team.players ?? [];
  const benched = all.filter((p) => p.bench === true);
  const active = all.filter((p) => p.bench !== true);
  if (active.length === 0) return { recommended: [], benched };

  const numSlots = Math.min(9, active.length);
  const slotList: number[] = [];
  for (let s = 1; s <= numSlots; s++) slotList.push(s);

  const hasTalent = (p: Player, t: string) =>
    !!p.uuid && !!ms[p.uuid]?.talents?.includes(t);

  // 1. Hard-pin slot-locked talents — best holder claims the locked slot.
  //    Only in talent-heavy mode; stat-heavy is pure stats (no talent overrides).
  const useLocks = mode === 'talent';
  const lockedHolders = new Map<number, Player>(); // slot → player
  const lockedPlayers = new Set<Player>();
  for (const [talent, slot] of useLocks ? Object.entries(SLOT_LOCKED_TALENTS) : []) {
    if (slot > numSlots || lockedHolders.has(slot)) continue;
    const holders = active.filter((p) => hasTalent(p, talent) && !lockedPlayers.has(p));
    const best = pickHighest(holders, (p) => slotFit(p, slot, ms, mult));
    if (best) {
      lockedHolders.set(slot, best);
      lockedPlayers.add(best);
    }
  }

  // 2. Choose the lineup: locked holders always play; fill the rest by wOBA.
  const wobaOf = (p: Player) => profile(p)?.woba ?? -1;
  const starters: Player[] = [...lockedPlayers];
  for (const p of active.filter((x) => !lockedPlayers.has(x)).sort((a, b) => wobaOf(b) - wobaOf(a))) {
    if (starters.length >= numSlots) break;
    starters.push(p);
  }

  // 3a. Seed: pins first, then greedy best-fit per slot in priority order.
  const assign = new Map<number, Player>();
  const used = new Set<Player>();
  for (const [slot, p] of lockedHolders) { assign.set(slot, p); used.add(p); }
  for (const slot of SLOT_SEED_PRIORITY) {
    if (slot > numSlots || assign.has(slot)) continue;
    const pick = pickHighest(starters.filter((p) => !used.has(p)), (p) => slotFit(p, slot, ms, mult));
    if (pick) { assign.set(slot, pick); used.add(pick); }
  }
  for (const slot of slotList) {
    if (assign.has(slot)) continue;
    const pick = starters.find((p) => !used.has(p));
    if (pick) { assign.set(slot, pick); used.add(pick); }
  }

  // 3b. Objective = total LEVERAGE-WEIGHTED slot fit. The per-slot weight makes
  //     the assignment prefer better hitters in higher-PA slots (and breaks the
  //     old indifference among pure-wOBA slots). Talent value is inside slotFit.
  const objective = (a: Map<number, Player>): number => {
    let s = 0;
    for (const [slot, p] of a) s += SLOT_LEVERAGE[slot] * slotFit(p, slot, ms, mult);
    return s;
  };

  // 3c. 2-opt: swap non-locked slot pairs while the total improves. This
  //     repairs the compounding errors of a one-pass greedy fill.
  const lockedSlots = new Set(lockedHolders.keys());
  let best = objective(assign);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < slotList.length; i++) {
      for (let j = i + 1; j < slotList.length; j++) {
        const si = slotList[i], sj = slotList[j];
        if (lockedSlots.has(si) || lockedSlots.has(sj)) continue;
        const pi = assign.get(si), pj = assign.get(sj);
        if (!pi || !pj) continue;
        assign.set(si, pj); assign.set(sj, pi);
        const cand = objective(assign);
        if (cand > best + 1e-9) { best = cand; improved = true; }
        else { assign.set(si, pi); assign.set(sj, pj); } // revert
      }
    }
  }

  // 3d. RE-optimal refinement (stat mode only — talent mode keeps slot affinity).
  //     Seeded from the role order above, a 2-opt over the lineup SIMULATOR moves
  //     a hitter only when it raises expected runs (common-random-numbers, so the
  //     comparison is noise-free). Worst case it changes nothing.
  const filledSlots = slotList.filter((s) => assign.has(s));
  let expectedRuns: number | undefined;
  if (filledSlots.length >= 2) {
    const rateCache = new Map<Player, BatterRates>();
    const ratesFor = (p: Player) => {
      let r = rateCache.get(p);
      if (!r) { r = batterRates(p); rateCache.set(p, r); }
      return r;
    };
    const orderRates = () => filledSlots.map((s) => ratesFor(assign.get(s)!));
    let bestRuns = simulateLineupRuns(orderRates());
    if (!useLocks) {
      let reImproved = true, reGuard = 0;
      while (reImproved && reGuard++ < 30) {
        reImproved = false;
        for (let i = 0; i < filledSlots.length; i++) {
          for (let j = i + 1; j < filledSlots.length; j++) {
            const si = filledSlots[i], sj = filledSlots[j];
            const pi = assign.get(si)!, pj = assign.get(sj)!;
            assign.set(si, pj); assign.set(sj, pi);
            const cand = simulateLineupRuns(orderRates());
            if (cand > bestRuns + 1e-9) { bestRuns = cand; reImproved = true; }
            else { assign.set(si, pi); assign.set(sj, pj); } // revert
          }
        }
      }
    }
    expectedRuns = Math.round(bestRuns * 100) / 100;
  }

  const recommended: BattingSlot[] = slotList
    .filter((slot) => assign.has(slot))
    .map((slot) => {
      const player = assign.get(slot)!;
      let reason = SLOT_REASON[slot];
      if (useLocks) {
        for (const [talent, lockedSlot] of Object.entries(SLOT_LOCKED_TALENTS)) {
          if (lockedSlot === slot && hasTalent(player, talent)) {
            reason = `#${slot} — ${talent} (talent locks here)`;
          }
        }
      }
      return {
        slot,
        player,
        currentSlot: player.battingOrder,
        moved: player.battingOrder !== undefined && player.battingOrder !== slot,
        role: SLOT_ROLES[slot],
        reason,
      };
    });

  return { recommended, benched, expectedRuns };
}

export function recommendBattingOrder(
  team: Team,
  metaStore?: PlayerMetaStore,
  mode: BattingMode = 'stat',
): BattingOrderResult {
  return buildBattingOrder(team, metaStore ?? {}, mode);
}

export interface ColumnExtremes {
  high: number;
  low: number;
}

const STAT_KEYS = ['avg', 'obp', 'slg', 'ops', 'ab', 'runs', 'h', 'hr', 'rbi', 'bb', 'k'] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export const ALL_STAT_KEYS = STAT_KEYS;

const COUNTING_STAT_KEYS = new Set<StatKey>(['ab', 'runs', 'h', 'hr', 'rbi', 'bb', 'k']);

export function computeExtremes(
  players: Player[],
  perGame = false,
): Partial<Record<StatKey, ColumnExtremes>> {
  const out: Partial<Record<StatKey, ColumnExtremes>> = {};
  for (const key of STAT_KEYS) {
    const values = players
      .map((p) => {
        const v = p.batting?.[key];
        if (v === undefined) return undefined;
        if (perGame && COUNTING_STAT_KEYS.has(key)) {
          const g = p.batting?.games;
          return g ? v / g : undefined;
        }
        return v;
      })
      .filter((v): v is number => typeof v === 'number');
    if (values.length < 2) continue;
    out[key] = { high: Math.max(...values), low: Math.min(...values) };
  }
  return out;
}

export function formatStat(key: StatKey, v: number | undefined): string {
  if (v === undefined) return '—';
  if (key === 'avg' || key === 'obp' || key === 'slg' || key === 'ops') {
    return v >= 1 ? v.toFixed(3) : v.toFixed(3).replace(/^0/, '');
  }
  return String(v);
}

export function formatPitch(key: 'era' | 'whip' | 'ip' | 'k' | 'bb', v: number | undefined): string {
  if (v === undefined) return '—';
  if (key === 'era' || key === 'whip') return v.toFixed(2);
  if (key === 'ip') return v.toFixed(1);
  return String(v);
}
