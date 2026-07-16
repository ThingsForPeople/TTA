import { MAX_TALENT_LEVEL, isInjured, type PlayerMeta, type PlayerMetaStore } from './playerMeta';
import { talentIndexByName } from './talentIndex';
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
  // Expected runs/game for the recommended order from the exact Markov lineup
  // run model. Present when there are enough hitters to evaluate.
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

// Post-patch league anchors (2026-07-08 rebalance; 34 box scores / 2587 PA):
// league AVG .397→.307, K% 33→39, runs/g nearly halved. Pre-patch anchors were
// .440/.430 — do not revert. Refit as more post-patch data lands.
const LEAGUE_AVG_WOBA = 0.352;
const LEAGUE_AVG_OBP = 0.320;
// Rate anchors for the tilt inputs (derived from LEAGUE_RATES below): a
// tiny-sample line must not hijack the ISO/K% tilts either (a 3-PA player
// with one HR carried raw ISO 1.0 → +0.40 of cleanup fit, bigger than a
// proven hitter's whole wOBA term).
const LEAGUE_ISO = 0.19;
const LEAGUE_K_RATE = 0.394;
const LEAGUE_BB_RATE = 0.019;

// Regression target multiplier vs league average. Default is REPLACEMENT
// (0.85× — an unproven bat ranks below demonstrated performers), but when the
// user has entered CON/POW sim stats the anchor moves with them: a 90-POW
// recruit with 5 PA should not be ordered like a replacement-level bat.
// avg attribute (50) → league mean; 0 → 0.85×; 100 → 1.15×.
function anchorMult(meta?: PlayerMeta): number {
  const con = meta?.sim?.con ?? 0;
  const pow = meta?.sim?.pow ?? 0;
  if (con <= 0 && pow <= 0) return 0.85; // no attribute info → replacement
  const attr01 = Math.min(Math.max((con + pow) / 200, 0), 1);
  return 0.85 + 0.3 * attr01;
}

// Injured players play through attribute penalties that their historical
// stats don't reflect — discount current expected production by severity.
const INJURY_DISCOUNT: Record<string, number> = { minor: 0.97, major: 0.93, catastrophic: 0.88 };
function injuryFactor(meta?: PlayerMeta): number {
  if (!isInjured(meta)) return 1;
  return INJURY_DISCOUNT[meta?.injury?.severity ?? 'minor'] ?? 0.97;
}

interface PlayerProfile {
  pa: number;
  woba: number;
  isoP: number;
  kRate: number;
  bbRate: number;
  obp: number;
}

function profile(p: Player, meta?: PlayerMeta): PlayerProfile | undefined {
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

  // Regress small samples toward the anchor so a 3-for-5 start doesn't
  // outrank a proven hitter; full weight at RELIABLE_PA. The anchor sits at
  // replacement (0.85× league) unless entered CON/POW attributes move it —
  // regressing to the MEAN let tiny-sample unknowns float above proven
  // hitters in filtered small-PA windows. ALL profile inputs regress on the
  // same ramp (wOBA, OBP, and the ISO/K%/BB% tilt inputs — previously the
  // tilts were raw, leaving a small-sample hijack path into slots 1/4).
  const confidence = Math.min(pa / RELIABLE_PA, 1);
  const m = anchorMult(meta);
  const inj = injuryFactor(meta);
  const mix = (raw: number, anchor: number) => confidence * raw + (1 - confidence) * anchor;
  const rawObp = b.obp ?? (pa > 0 ? ((b.h ?? 0) + bb) / pa : 0);

  return {
    pa,
    woba: mix(woba, LEAGUE_AVG_WOBA * m) * inj,
    isoP: mix(slg - avg, LEAGUE_ISO * m),
    kRate: mix(k / pa, LEAGUE_K_RATE),
    bbRate: mix(bb / pa, LEAGUE_BB_RATE * m),
    obp: mix(rawObp, LEAGUE_AVG_OBP * m) * inj,
  };
}

// ── Talent value system ─────────────────────────────────────────────
// Talents influence the batting order ONLY through slot-role affinity
// ("slot synergies"): a talent scores where its effect is worth more in a
// specific lineup spot (Table Setter at leadoff, runners-on talents in the
// 3–5 pocket). Slot-AGNOSTIC talent value (Breakout Season, Night Owl, zone
// boosts, …) already shows up in the player's stats — scoring it again just
// lifted talent-stacked players at every slot without changing which slot
// fits them (removed 2026-07-16; entries with empty roles are kept as
// explicit "no slot lean" documentation).
//
// Values are in wOBA-equivalent units, scaled by TALENT_WEIGHT (0.15)
// so a Tier-3 talent adds ~0.006 wOBA to the slot score (more at Tier 4, the max).

type SlotRole = 'leadoff' | 'quality' | 'best' | 'cleanup' | 'protection' | 'lower';

// Batting-order optimization modes. Stat-heavy (default) is PURE wOBA/role
// scoring — slot-affinity talents have zero influence on placement and
// slot-locks (e.g. The Janitor → cleanup) are ignored (chain talents still
// shape the run model in both modes — they're real run value, not tiebreak
// folklore). Talent-heavy turns the locks back on and amplifies the
// slot-affinity contribution so those talents drive placement (a player lands
// in his talent's preferred slot unless a clearly better bat outweighs it).
export type BattingMode = 'stat' | 'talent';
const TALENT_MODE_MULT: Record<BattingMode, number> = { stat: 0, talent: 5 };

const TALENT_WEIGHT = 0.15;

interface TalentValue {
  roles: Partial<Record<SlotRole, number>>;
}

export const TALENT_VALUES: Record<string, TalentValue> = {
  // ── Slot-specific talents — strong affinity for their named role,
  //    penalty elsewhere so they aren't grabbed by earlier picks ──
  // Magnitudes sanity-checked against the Talent Index 2026-07-16: Table
  // Setter is +4-10% Contact at leadoff only, so it must NOT outrank the
  // runners-on family below (Clutch is +24-27% Contact/Power and fires on
  // ~40% of PAs). The Janitor's placement is enforced by its slot LOCK in
  // talent mode; these values only pick among multiple holders.
  'Table Setter':       { roles: { leadoff: 0.05, quality: -0.04, best: -0.06, cleanup: -0.06, protection: -0.04, lower: -0.02 } },
  'The Janitor':        { roles: { cleanup: 0.12, best: -0.20, quality: -0.20, leadoff: -0.20, protection: -0.08, lower: -0.08 } },

  // ── OBP / plate discipline → leadoff, quality ──
  'Disciplined':        { roles: { leadoff: 0.06, quality: 0.04 } },
  'Fear Me':            { roles: { leadoff: 0.05, quality: 0.03 } },
  'Battler':            { roles: { leadoff: 0.04, quality: 0.03 } },

  // ── Contact / early-count → leadoff, quality ──
  'Set the Tone':       { roles: { leadoff: 0.05, quality: 0.04 } },
  'Early Bird':         { roles: { leadoff: 0.06, quality: 0.05 } },
  'Off Speed Tracker':  { roles: {} },

  // ── Power talents → cleanup, best, protection ──
  'Sweet Tooth':        { roles: { cleanup: 0.06, best: 0.04, protection: 0.04 } },
  'Knowledge is Power': { roles: { cleanup: 0.04, protection: 0.03 } },

  // ── Runners-on talents → best(3), cleanup(4), protection(5) ──
  // Bumped 2026-07-16: index magnitudes (+24-27% Contact/Power with runners
  // on, firing on ~40% of PAs) make these the strongest slot-synergy family.
  'Clutch':             { roles: { best: 0.10, cleanup: 0.09, protection: 0.07 } },
  'Pressure Cooker':    { roles: { best: 0.07, cleanup: 0.07, protection: 0.05 } },
  // Bumped 2026-06-29: replay analysis found Mental Warfare the single biggest
  // contact-quality swing of any hitting talent (+7.8 EV when it fires, with
  // runners on), so it earns a stronger runners-on (best/cleanup/protection) tilt.
  'Mental Warfare':     { roles: { best: 0.07, cleanup: 0.07, protection: 0.05 } },

  // ── Chain / next-batter talents → higher in order to maximize downstream ──
  'Clutch Cascade':     { roles: { best: 0.05, cleanup: 0.04, quality: 0.04 } },
  'Rally Time':         { roles: { leadoff: 0.05, quality: 0.05, best: 0.04 } },
  'Confidence Shaker':  { roles: { leadoff: 0.04, quality: 0.04, best: 0.03 } },
  'Waste No Time':      { roles: { leadoff: 0.05, quality: 0.04 } },

  // ── Exhausting / grind talents → quality, leadoff (more PAs) ──
  'Exhausting':         { roles: { leadoff: 0.04, quality: 0.04 } },
  'Pattern Recognition':{ roles: { quality: 0.03 } },

  // ── Situational / conditional — no slot lean; value is in the stats ──
  'Breakout Season':    { roles: {} },
  'Sun Glasses':        { roles: {} },
  'Night Owl':          { roles: {} },
  'Lefty Loosey':       { roles: {} },
  'Righty Tighty':      { roles: {} },
  'Hard to Handle':     { roles: {} },

  // ── Zone hitting talents (general and directional) ──
  'Zone Dialed':        { roles: {} },
  'Zone Driver':        { roles: { best: 0.02, cleanup: 0.02 } },
  'Zone Chopper':       { roles: { leadoff: 0.02 } },
  'Zone Popper':        { roles: { cleanup: 0.02 } },
  'Zone Hacker':        { roles: { cleanup: 0.02, best: 0.01 } },
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

// Directional zone talents ("High Driver", "Inside Popper", …) carry only
// their effect family's slot-role tilt (Driver → best/cleanup, Chopper →
// leadoff, …); the raw magnitude of the boost is already in the stats.
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
    TALENT_VALUES[name] = { roles: ZONE_EFFECT_ROLES[effect] };
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
    const roleVal = TALENT_VALUES[talentName]?.roles[role];
    if (!roleVal) continue;
    const lvl = meta.talentLevels?.[talentName] ?? 1;
    const scale = LEVEL_SCALE[Math.min(lvl, MAX_TALENT_LEVEL)] ?? 1;
    bonus += roleVal * scale;
  }
  return bonus * TALENT_WEIGHT;
}

// NOTE: the old baserunning/steal talent bonuses (Thief, Quick Silver, … at
// leadoff) were retired 2026-07-16 — measured post-patch, steal attempts are
// run-NEGATIVE to neutral in this engine (36% CS; RE24 EV per attempt ≈ −0.001
// at 1 out, −0.25 at 0 outs) and the run model doesn't simulate them. Rewarding
// steal talents in the order taught users the wrong lesson.

function totalTalentBonus(
  uuid: string | undefined,
  ms: PlayerMetaStore,
  role: SlotRole,
  mult = 1,
): number {
  return talentBonus(uuid, ms, role) * mult;
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
    const roleVal = TALENT_VALUES[talentName]?.roles[role as SlotRole];
    if (roleVal && roleVal > 0) {
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
  1: 'Leadoff — OBP-driven, most PAs',
  2: '#2 — wOBA + OBP tilt',
  3: '#3 — highest wOBA',
  4: '#4 — wOBA + ISO power',
  5: '#5 — best remaining bat',
  6: '#6 — wOBA',
  7: '#7 — wOBA',
  8: '#8 — wOBA',
  9: '#9 — weakest bat, fewest PAs',
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

// (The measured-baserunning leadoff bonus was retired with the steal talent
// bonuses — see the note above BASERUNNING removal: steals are run-negative
// in this engine, so speed-on-the-bases isn't lineup-slot value.)

function slotFit(
  p: Player,
  slot: number,
  ms: PlayerMetaStore,
  mult = 1,
  platoonDelta?: Record<string, number>,
): number {
  const role = SLOT_ROLES[slot];
  const tb = totalTalentBonus(p.uuid, ms, role, mult);
  const pd = (p.uuid && platoonDelta?.[p.uuid]) || 0;
  const pr = profile(p, p.uuid ? ms[p.uuid] : undefined);
  if (!pr) return tb; // no stats yet → sorts to the bottom, still placeable
  switch (slot) {
    // K% mostly double-counts OBP (which already reflects strikeouts), so its
    // marginal leadoff value is ~0 in the data — trimmed 0.4→0.15 (2026-06-29).
    case 1: return (pr.obp + pd) * WOBA_SCALE + 0.3 * pr.bbRate - 0.15 * pr.kRate + tb;
    case 2: return pr.woba + pd + 0.3 * (pr.obp + pd) + tb;
    case 4: return pr.woba + pd + 0.4 * pr.isoP + tb;
    // #5 is just the next-best bat. The old −0.4·K% "protection" tilt imported
    // MLB pitch-around folklore: at league BB% 1.9 nobody pitches around
    // anyone, and it was the largest tilt coefficient in the engine (±0.06 fit
    // for a ±15pt K% spread — bigger than most real wOBA gaps). Slot 8's old
    // "second leadoff" OBP tilt died with it: the pattern it produced measures
    // +0.000 R/g in the exact run model.
    default: return pr.woba + pd + tb; // 3, 5, 6, 7, 8, 9
  }
}

// ── Exact lineup run model (RE-optimal order) ───────────────────────
// Replaces the Monte-Carlo simulator (2026-07-16). The MC's common-random-
// number noise floor measured sd ≈ 0.032–0.043 R/g per comparison — ABOVE the
// old 0.02 acceptance threshold — so "sim gains" were often dice, and the real
// adjacent-slot gains (~0.005–0.01 R/g) were always blocked. This computes
// E[runs] EXACTLY by propagating the full probability distribution over
// (outs, bases, active chain buff) states one PA at a time: within an inning
// the batter due up is a deterministic function of the PA count, so per-step
// states are tiny, and expected runs are a linear accumulator (score never
// feeds back into transitions). Per starting batter we get the inning's
// expected runs and the next-inning leadoff distribution; nine innings
// compose by propagating that distribution. Deterministic, noise-free, and
// cheaper than 1000 simulated games.
// Advancement model unchanged from the old sim (single: runners +1, 3rd
// scores; double: +2; walk: force only; HR clears). No steals/DP/errors —
// those side-effects exist but are near-order-independent.

interface BatterRates { out: number; bb: number; b1: number; b2: number; b3: number; hr: number }
// Re-measured 2026-07-08 from post-patch box scores (34 games / 2587 PA) after
// the offense rebalance. Triples are near-extinct post-patch (measured 0.000);
// a small floor keeps the model from treating them as impossible. `out` is the
// exact residual 1−Σ(others) so the table sums to 1 (the old 0.68 summed to
// 1.004 and silently clipped ~12% of the HR tail via the residual branch).
const LEAGUE_RATES: BatterRates = { out: 0.676, bb: 0.020, b1: 0.185, b2: 0.084, b3: 0.003, hr: 0.032 };

// Scale the on-base event rates by f, outs absorbing the difference — used for
// the replacement/attribute anchor (f<1 → worse than league) and the injury
// discount, so the run model and the role layer share one notion of quality.
function scaleRates(r: BatterRates, f: number): BatterRates {
  const bb = r.bb * f, b1 = r.b1 * f, b2 = r.b2 * f, b3 = r.b3 * f, hr = r.hr * f;
  return { out: Math.max(0, 1 - (bb + b1 + b2 + b3 + hr)), bb, b1, b2, b3, hr };
}

// Per-batter PA outcome probabilities from box stats, regressed toward the
// SAME anchor as profile() (replacement 0.85× league, moved by entered
// CON/POW). The old version regressed toward the league MEAN while the role
// layer regressed to replacement — so the run model systematically promoted
// small-sample bats the role layer demoted, and a stat-less player (or a
// pitcher with no line) "simmed" as exactly league-average, inflating
// expectedRuns and over-crediting unproven bench bats.
function batterRates(p: Player, meta?: PlayerMeta): BatterRates {
  const anchor = scaleRates(LEAGUE_RATES, anchorMult(meta));
  const inj = injuryFactor(meta);
  const b = p.batting;
  const ab = b?.ab ?? 0, bb = b?.bb ?? 0, pa = ab + bb;
  if (pa <= 0) return scaleRates(anchor, inj);
  const hr = b?.hr ?? 0, t3 = b?.triples ?? 0, t2 = b?.doubles ?? 0;
  const b1 = b?.singles ?? Math.max(0, (b?.h ?? 0) - t2 - t3 - hr);
  const raw = { bb: bb / pa, hr: hr / pa, b3: t3 / pa, b2: t2 / pa, b1: b1 / pa };
  const conf = Math.min(pa / RELIABLE_PA, 1);
  const mix = (r: number, lg: number) => conf * r + (1 - conf) * lg;
  const mixed = {
    bb: mix(raw.bb, anchor.bb), b1: mix(raw.b1, anchor.b1), b2: mix(raw.b2, anchor.b2),
    b3: mix(raw.b3, anchor.b3), hr: mix(raw.hr, anchor.hr),
  };
  const out = Math.max(0, 1 - (mixed.bb + mixed.b1 + mixed.b2 + mixed.b3 + mixed.hr));
  return scaleRates({ out, ...mixed }, inj);
}

// Expected runs/game for a batting order. `rates` is the per-slot outcome table
// (precomputed once and reordered by the optimizer to avoid recompute churn).
// Next-batter chain buff (Rally Time / Clutch Cascade): when the holder's PA
// resolves as a qualifying hit, the NEXT batter's rates improve for one PA.
// contactBoost shrinks the out probability; powerBoost tilts the freed mass
// toward extra bases. Magnitudes come from the official Talent Index at the
// player's tier, damped by CHAIN_CAL because the stated "+N% Contact" acts on
// an engine lever we can't map 1:1 onto PA outcome rates — the point is the
// ORDERING signal (put chain holders ahead of good bats), not exact runs.
export interface ChainBuff {
  trigger: 'early_hit' | 'hit_runners_on';
  contactBoost: number; // fraction removed from P(out)
  powerBoost: number;   // extra-base tilt on the freed probability mass
  // How many following batters the buff covers. Clutch Cascade's index prose
  // says "the next two batters" (the old sim applied it to one — under-modeled
  // by half); Rally Time is one.
  duration: number;
}
const CHAIN_CAL = 0.4;
// Share of hits that count as "early-count" for Rally Time's trigger.
const EARLY_HIT_SHARE = 0.55;

function applyChainBuffs(r: BatterRates, buffs: ChainBuff[]): BatterRates {
  let out = r.out;
  let { bb, b1, b2, b3, hr } = r;
  for (const bf of buffs) {
    // "+X% Contact" scales the batter's CONTACT side (his on-base event mass),
    // not his miss rate: a better hitter gains more from the same buff. The
    // old form (out × (1−boost)) freed mass proportional to P(out), so buffing
    // a BAD hitter was worth more in absolute runs — the exact optimizer then
    // provably "gained" by batting the pitcher right behind a Clutch Cascade
    // holder (the noisy Monte-Carlo had masked this by never resolving it).
    const freed = Math.min(out, (1 - out - bb) * bf.contactBoost);
    out -= freed;
    // Distribute the freed mass over hit types, tilted toward power.
    const w1 = b1, w2 = b2 * (1 + bf.powerBoost), w3 = b3 * (1 + bf.powerBoost), wh = hr * (1 + bf.powerBoost);
    const wsum = w1 + w2 + w3 + wh || 1;
    b1 += freed * (w1 / wsum);
    b2 += freed * (w2 / wsum);
    b3 += freed * (w3 / wsum);
    hr += freed * (wh / wsum);
  }
  return { out, bb, b1, b2, b3, hr };
}

// Base-state advancement tables, index = bitmask (1st|2nd<<1|3rd<<2).
// Each entry: [newBases, runsScored]. Mirrors the old sim's advancement.
const ADV_BB: [number, number][] = [
  [0b001, 0], [0b011, 0], [0b011, 0], [0b111, 0],
  [0b101, 0], [0b111, 0], [0b111, 0], [0b111, 1],
];
const ADV_1B: [number, number][] = [
  // single: batter to 1st, 3rd scores, others +1 base
  [0b001, 0], [0b011, 0], [0b101, 0], [0b111, 0],
  [0b001, 1], [0b011, 1], [0b101, 1], [0b111, 1],
];
const ADV_2B: [number, number][] = [
  // double: batter to 2nd, 2nd/3rd score, 1st to 3rd
  [0b010, 0], [0b110, 0], [0b010, 1], [0b110, 1],
  [0b010, 1], [0b110, 1], [0b010, 2], [0b110, 2],
];
function adv3B(bases: number): [number, number] {
  // triple: everyone scores, batter to 3rd
  return [0b100, popcount3(bases)];
}
function advHR(bases: number): [number, number] {
  return [0, popcount3(bases) + 1];
}
function popcount3(m: number): number {
  return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1);
}

// Distinct "active buff" variants for a lineup: 0 = none, otherwise an index
// into `variants` plus a remaining-batters counter. When multiple buffs fire
// on the same hit they merge into one variant covering the max duration (the
// only over-count is a player holding BOTH chain talents firing both — rare
// and second-order). A new firing REPLACES an active buff (old sim semantics).
interface BuffVariant { buffs: ChainBuff[]; duration: number }

const MAX_INNING_PA = 45; // P(<3 outs after 45 PAs) is ~0 at out-rates ≥ 0.5

// Exact expected runs for one half-inning starting with `start` due up and no
// active buff. Returns the inning's expected runs plus the probability
// distribution of who leads off the next inning.
function inningExpectation(
  rates: BatterRates[],
  buffedRates: (v: number, batter: number) => BatterRates, // variant id ≥ 1
  fireDist: (batter: number, runnersOn: boolean) => [number, number][] | null, // [variantCode, prob]
  start: number,
): { runs: number; nextLeadoff: number[] } {
  const n = rates.length;
  // state key packs (outs 0-2, bases 0-7, buffCode 0-63); buffCode 0 = none,
  // else (variantId − 1) * 2 + (remaining − 1) + 1.
  const key = (outs: number, bases: number, buff: number) => (outs * 8 + bases) * 64 + buff;
  let states = new Map<number, number>([[key(0, 0, 0), 1]]);
  const decode = (k: number) => ({ buff: k % 64, bases: Math.floor(k / 64) % 8, outs: Math.floor(k / 512) });
  const buffOf = (code: number) => ({ variant: Math.floor((code - 1) / 2) + 1, remaining: ((code - 1) % 2) + 1 });
  const codeOf = (variant: number, remaining: number) => (variant - 1) * 2 + (remaining - 1) + 1;

  let runsAcc = 0;
  const nextLeadoff = new Array<number>(n).fill(0);

  for (let t = 0; t < MAX_INNING_PA && states.size > 0; t++) {
    const batter = (start + t) % n;
    const next = new Map<number, number>();
    const add = (k: number, p: number) => next.set(k, (next.get(k) ?? 0) + p);

    for (const [k, mass] of states) {
      const { buff, bases, outs } = decode(k);
      let r = rates[batter];
      let buffAfterCode = 0;
      if (buff > 0) {
        const { variant, remaining } = buffOf(buff);
        r = buffedRates(variant, batter);
        if (remaining > 1) buffAfterCode = codeOf(variant, remaining - 1);
      }
      const runnersOn = bases !== 0;

      // out
      if (r.out > 0) {
        const p = mass * r.out;
        if (outs === 2) nextLeadoff[(batter + 1) % n] += p;
        else add(key(outs + 1, bases, buffAfterCode), p);
      }
      // walk
      if (r.bb > 0) {
        const [nb, sc] = ADV_BB[bases];
        runsAcc += mass * r.bb * sc;
        add(key(outs, nb, buffAfterCode), mass * r.bb);
      }
      // hits — each may arm this batter's chain buffs for the following PAs
      const hitOutcomes: [number, [number, number]][] = [
        [r.b1, ADV_1B[bases]], [r.b2, ADV_2B[bases]], [r.b3, adv3B(bases)], [r.hr, advHR(bases)],
      ];
      const fires = fireDist(batter, runnersOn);
      for (const [pHit, [nb, sc]] of hitOutcomes) {
        if (pHit <= 0) continue;
        const p = mass * pHit;
        runsAcc += p * sc;
        if (!fires) { add(key(outs, nb, buffAfterCode), p); continue; }
        for (const [vCode, vProb] of fires) {
          // vCode 0 = nothing fired → the pre-existing buff keeps ticking.
          add(key(outs, nb, vCode === 0 ? buffAfterCode : vCode), p * vProb);
        }
      }
    }
    states = next;
  }
  // Truncation residual (astronomically small): treat as inning over.
  for (const [k, mass] of states) {
    void k;
    nextLeadoff[(start + MAX_INNING_PA) % n] += mass;
  }
  return { runs: runsAcc, nextLeadoff };
}

// Expected runs/game for a batting order over 9 innings, exactly.
// (Exported for offline verification harnesses/scripts.)
export function expectedLineupRuns(rates: BatterRates[], chains?: (ChainBuff[] | null)[]): number {
  const n = rates.length;
  if (n === 0) return 0;

  // Build the buff-variant registry for this lineup: for each batter with
  // chain talents, the possible fired combinations and their probabilities
  // (hit_runners_on fires deterministically given runners on; early_hit fires
  // with EARLY_HIT_SHARE).
  const variants: BuffVariant[] = [];
  const variantIdByKey = new Map<string, number>();
  const registerVariant = (buffs: ChainBuff[]): number => {
    const vk = buffs.map((b) => `${b.trigger}:${b.contactBoost}:${b.powerBoost}:${b.duration}`).sort().join('|');
    let id = variantIdByKey.get(vk);
    if (!id) {
      variants.push({ buffs, duration: Math.min(2, Math.max(...buffs.map((b) => b.duration))) });
      id = variants.length; // 1-based
      variantIdByKey.set(vk, id);
    }
    return id;
  };
  // Per batter × runnersOn: [variantCode, prob][] over fired outcomes, where
  // variantCode 0 = nothing fired and otherwise encodes (variant, remaining =
  // its full duration). null when the batter has no chain talents at all.
  const fireTable: ([number, number][] | null)[][] = [];
  for (let i = 0; i < n; i++) {
    const ch = chains?.[i] ?? null;
    if (!ch || ch.length === 0) { fireTable.push([null, null]); continue; }
    const perRunners: ([number, number][] | null)[] = [];
    for (const runnersOn of [false, true]) {
      // Enumerate fired subsets with probabilities.
      let outcomes: { buffs: ChainBuff[]; prob: number }[] = [{ buffs: [], prob: 1 }];
      for (const bf of ch) {
        const pFire = bf.trigger === 'hit_runners_on' ? (runnersOn ? 1 : 0) : EARLY_HIT_SHARE;
        const nextOutcomes: typeof outcomes = [];
        for (const o of outcomes) {
          if (pFire > 0) nextOutcomes.push({ buffs: [...o.buffs, bf], prob: o.prob * pFire });
          if (pFire < 1) nextOutcomes.push({ buffs: o.buffs, prob: o.prob * (1 - pFire) });
        }
        outcomes = nextOutcomes;
      }
      const dist: [number, number][] = outcomes.map((o) => {
        if (o.buffs.length === 0) return [0, o.prob];
        const v = registerVariant(o.buffs);
        return [(v - 1) * 2 + (variants[v - 1].duration - 1) + 1, o.prob];
      });
      perRunners.push(dist);
    }
    fireTable.push(perRunners);
  }

  const buffedCache = new Map<number, BatterRates>();
  const buffedRates = (variant: number, batter: number): BatterRates => {
    const ck = variant * 32 + batter;
    let r = buffedCache.get(ck);
    if (!r) { r = applyChainBuffs(rates[batter], variants[variant - 1].buffs); buffedCache.set(ck, r); }
    return r;
  };
  const fireDist = (batter: number, runnersOn: boolean) => fireTable[batter][runnersOn ? 1 : 0];

  // One inning DP per possible leadoff batter, then compose 9 innings.
  const perStart = Array.from({ length: n }, (_, b) => inningExpectation(rates, buffedRates, fireDist, b));
  let leadoff = new Array<number>(n).fill(0);
  leadoff[0] = 1;
  let total = 0;
  for (let inning = 0; inning < 9; inning++) {
    const nextDist = new Array<number>(n).fill(0);
    for (let b = 0; b < n; b++) {
      const p = leadoff[b];
      if (p <= 0) continue;
      total += p * perStart[b].runs;
      for (let j = 0; j < n; j++) nextDist[j] += p * perStart[b].nextLeadoff[j];
    }
    leadoff = nextDist;
  }
  return total;
}

// Extract a player's next-batter chain buffs from their meta talents, with
// magnitudes from the official Talent Index at the recorded tier.
const CHAIN_TALENTS: Record<string, { trigger: ChainBuff['trigger']; duration: number }> = {
  'Rally Time': { trigger: 'early_hit', duration: 1 },
  // Index prose: "the next two batters" — modeled as such since 2026-07-16.
  'Clutch Cascade': { trigger: 'hit_runners_on', duration: 2 },
};
export function chainBuffsFor(talents: string[] | undefined, levelFor: (name: string) => number): ChainBuff[] {
  const out: ChainBuff[] = [];
  for (const name of talents ?? []) {
    const spec = CHAIN_TALENTS[name];
    if (!spec) continue;
    const { trigger, duration } = spec;
    const idx = talentIndexByName.get(name);
    const tier = Math.min(Math.max(levelFor(name), 1), MAX_TALENT_LEVEL);
    const prose = idx?.prose?.perTier?.[String(tier)] ?? idx?.prose?.range ?? '';
    const contact = /([+-]?\d+(?:\.\d+)?)% Contact/.exec(prose);
    const power = /([+-]?\d+(?:\.\d+)?)% Power/.exec(prose);
    const c = contact ? Number(contact[1]) / 100 : 0.15;
    const p = power ? Number(power[1]) / 100 : 0.15;
    out.push({ trigger, duration, contactBoost: Math.max(0, c) * CHAIN_CAL, powerBoost: Math.max(0, p) });
  }
  return out;
}

/**
 * Lineup construction by global assignment.
 *
 * 1. Hard-pin slot-locked talents (e.g. The Janitor → cleanup).
 * 2. Pick the best N hitters to fill N slots (pinned holders always play).
 * 3. Seed an assignment greedily, then run 2-opt swaps to maximize total
 *    lineup fit (role + per-slot leverage). Talent value is baked into slotFit.
 * 4. In stat mode, a final RE-based 2-opt refines the order to maximize actual
 *    expected runs (the exact Markov model above) — seeded from the already-
 *    good role order, so it only moves a hitter for a real gain.
 */
function buildBattingOrder(
  team: Team,
  ms: PlayerMetaStore,
  mode: BattingMode = 'stat',
  platoonDelta?: Record<string, number>,
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
    const best = pickHighest(holders, (p) => slotFit(p, slot, ms, mult, platoonDelta));
    if (best) {
      lockedHolders.set(slot, best);
      lockedPlayers.add(best);
    }
  }

  // 2. Choose the lineup: locked holders always play; fill the rest by wOBA.
  const wobaOf = (p: Player) => profile(p, p.uuid ? ms[p.uuid] : undefined)?.woba ?? -1;
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
    const pick = pickHighest(starters.filter((p) => !used.has(p)), (p) => slotFit(p, slot, ms, mult, platoonDelta));
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
    for (const [slot, p] of a) s += SLOT_LEVERAGE[slot] * slotFit(p, slot, ms, mult, platoonDelta);
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
  //     Seeded from the role order above, a 2-opt over the EXACT Markov run
  //     model moves a hitter only when it genuinely raises expected runs.
  const filledSlots = slotList.filter((s) => assign.has(s));
  let expectedRuns: number | undefined;
  if (filledSlots.length >= 2) {
    const rateCache = new Map<Player, BatterRates>();
    const ratesFor = (p: Player) => {
      let r = rateCache.get(p);
      if (!r) {
        r = batterRates(p, p.uuid ? ms[p.uuid] : undefined);
        // Platoon shift: the wOBA-unit split delta moved between P(single) and
        // P(out), so the run model sees the same vs-hand quality shift the
        // role layer scores (Δwoba ≈ ΔP(1B) × W_1B).
        const pd = (p.uuid && platoonDelta?.[p.uuid]) || 0;
        if (pd !== 0) {
          const shift = Math.max(-r.b1 * 0.5, Math.min(r.out * 0.5, pd / W_1B));
          r = { ...r, b1: r.b1 + shift, out: r.out - shift };
        }
        rateCache.set(p, r);
      }
      return r;
    };
    // Chain (next-batter) buffs per player — makes the 2-opt adjacency-aware:
    // a Rally Time / Clutch Cascade holder is worth more directly AHEAD of a
    // strong bat, which pure per-slot scoring cannot see.
    const chainCache = new Map<Player, ChainBuff[]>();
    const chainsFor = (p: Player) => {
      let c = chainCache.get(p);
      if (!c) {
        const meta = p.uuid ? ms[p.uuid] : undefined;
        c = chainBuffsFor(meta?.talents, (name) => meta?.talentLevels?.[name] ?? 1);
        chainCache.set(p, c);
      }
      return c;
    };
    const orderRates = () => filledSlots.map((s) => ratesFor(assign.get(s)!));
    const orderChains = () => filledSlots.map((s) => { const c = chainsFor(assign.get(s)!); return c.length ? c : null; });
    let bestRuns = expectedLineupRuns(orderRates(), orderChains());
    // Pure indifference band — the model is exact (no noise floor), so this
    // only exists to keep the role-based order's readable shape when the run
    // surface is genuinely flat (real adjacent-slot gains measure ~0.005–0.01
    // R/g; the old Monte-Carlo needed 0.02 to fight its own noise and ended
    // up blocking every legitimate move while passing dice).
    const MIN_SIM_GAIN = 0.005;
    if (!useLocks) {
      let reImproved = true, reGuard = 0;
      while (reImproved && reGuard++ < 30) {
        reImproved = false;
        for (let i = 0; i < filledSlots.length; i++) {
          for (let j = i + 1; j < filledSlots.length; j++) {
            const si = filledSlots[i], sj = filledSlots[j];
            const pi = assign.get(si)!, pj = assign.get(sj)!;
            assign.set(si, pj); assign.set(sj, pi);
            const cand = expectedLineupRuns(orderRates(), orderChains());
            if (cand > bestRuns + MIN_SIM_GAIN) { bestRuns = cand; reImproved = true; }
            else { assign.set(si, pi); assign.set(sj, pj); } // revert
          }
        }
      }
    }
    expectedRuns = Math.round(bestRuns * 100) / 100;
  }

  // (The old "pitcher bats 8th" narrative is gone: measured with the exact
  // model, that shape is worth ~0.000 R/g — it was a Monte-Carlo noise
  // artifact, and the label fired even when the sim never made the swap.)

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

// ── Bench offense impact ──────────────────────────────────────────────
// For each benched hitter: the single best straight swap into the recommended
// order, valued in expected runs/game by the exact Markov run model (deltas
// are exact, not simulation noise). Defense is deliberately excluded here —
// the optimizer's benchUpgrades table already covers the fielding side; read
// the two together.
export interface BenchOffenseImpact {
  bench: Player;
  replaces: Player;
  slot: number; // 1-9 slot the bench player would take
  runsDelta: number; // expected runs/game gained (can be negative)
}

export function benchOffenseImpacts(team: Team, ms: PlayerMetaStore): BenchOffenseImpact[] {
  const rec = buildBattingOrder(team, ms, 'stat');
  const order = rec.recommended.map((s) => s.player);
  if (order.length < 2 || rec.benched.length === 0) return [];
  const chainsOf = (p: Player) => {
    const meta = p.uuid ? ms[p.uuid] : undefined;
    const c = chainBuffsFor(meta?.talents, (name) => meta?.talentLevels?.[name] ?? 1);
    return c.length ? c : null;
  };
  const metaOf = (p: Player) => (p.uuid ? ms[p.uuid] : undefined);
  const ratesOf = new Map(order.map((p) => [p, batterRates(p, metaOf(p))]));
  const simFor = (lineup: Player[]) =>
    expectedLineupRuns(lineup.map((p) => ratesOf.get(p) ?? batterRates(p, metaOf(p))), lineup.map(chainsOf));
  const baseline = simFor(order);
  const out: BenchOffenseImpact[] = [];
  for (const b of rec.benched) {
    if (!b.batting) continue;
    ratesOf.set(b, batterRates(b, metaOf(b)));
    let best: BenchOffenseImpact | null = null;
    for (let i = 0; i < order.length; i++) {
      const starter = order[i];
      // Never recommend removing the pitcher (he must play).
      if (starter.position === 'P' || starter.position === 'SP') continue;
      const swapped = order.slice();
      swapped[i] = b;
      const delta = simFor(swapped) - baseline;
      if (!best || delta > best.runsDelta) {
        best = { bench: b, replaces: starter, slot: rec.recommended[i].slot, runsDelta: Math.round(delta * 100) / 100 };
      }
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.runsDelta - a.runsDelta);
}

export function recommendBattingOrder(
  team: Team,
  metaStore?: PlayerMetaStore,
  mode: BattingMode = 'stat',
  platoonDelta?: Record<string, number>,
): BattingOrderResult {
  return buildBattingOrder(team, metaStore ?? {}, mode, platoonDelta);
}

// ── Platoon splits (vs LHP / vs RHP order variant) ───────────────────
// Per-player wOBA-equivalent adjustment for facing a given pitcher hand,
// from the replay-derived platoon counting stats (hits/AB per side — the
// re-sims record the opposing pitcher's throwing hand per PA). Splits are
// large in this engine (regulars show 50–110-point AVG splits over 100+ AB
// per side) and ~32% of PA come vs LHP, so a Challenge/matchup order should
// see them. AVG-based because per-side XBH isn't recorded; a hit-rate delta
// maps ≈1:1 onto wOBA at W_1B. Confidence-ramped by side AB; capped.
const PLATOON_RELIABLE_AB = 75;
const PLATOON_CAP = 0.06;
export interface PlatoonSplitSource {
  playerId: string;
  abVsL: number; hitsVsL: number;
  abVsR: number; hitsVsR: number;
}
export function platoonDeltas(players: PlatoonSplitSource[], vs: 'L' | 'R'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of players) {
    const abSide = vs === 'L' ? p.abVsL : p.abVsR;
    const hitsSide = vs === 'L' ? p.hitsVsL : p.hitsVsR;
    const abAll = p.abVsL + p.abVsR;
    if (!abSide || !abAll) continue;
    const avgSide = hitsSide / abSide;
    const avgAll = (p.hitsVsL + p.hitsVsR) / abAll;
    const conf = Math.min(abSide / PLATOON_RELIABLE_AB, 1);
    const delta = conf * (avgSide - avgAll) * W_1B;
    if (delta !== 0) out[p.playerId] = Math.max(-PLATOON_CAP, Math.min(PLATOON_CAP, delta));
  }
  return out;
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
