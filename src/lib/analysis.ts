import type { PlayerMetaStore } from './playerMeta';
import type { Player, Team } from './types';

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

  // Regress small samples toward league-average (.320 wOBA) so a 3-for-5
  // start doesn't outrank a proven hitter. Full weight at RELIABLE_PA.
  const confidence = Math.min(pa / RELIABLE_PA, 1);
  const LEAGUE_AVG_WOBA = 0.320;
  const LEAGUE_AVG_OBP = 0.320;
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
// so a fully-loaded Lv3 talent adds ~0.006 wOBA to the slot score.

type SlotRole = 'leadoff' | 'quality' | 'best' | 'cleanup' | 'protection' | 'lower';

const TALENT_WEIGHT = 0.15;

interface TalentValue {
  roles: Partial<Record<SlotRole, number>>;
  global?: number;
}

const TALENT_VALUES: Record<string, TalentValue> = {
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
  'Mental Warfare':     { roles: { best: 0.04, cleanup: 0.04, protection: 0.03 }, global: 0.02 },

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

// Directional zone talents get a tiny global bonus
const ZONE_DIR_EFFECTS = ['Dialed', 'Driver', 'Chopper', 'Popper', 'Hacker'];
const ZONE_DIR_PREFIXES = ['High', 'Low', 'Inside', 'Outside'];
for (const prefix of ZONE_DIR_PREFIXES) {
  for (const effect of ZONE_DIR_EFFECTS) {
    const name = `${prefix} ${effect}`;
    if (!TALENT_VALUES[name]) {
      TALENT_VALUES[name] = { roles: {}, global: 0.015 };
    }
  }
}

const LEVEL_SCALE = [0, 1.0, 1.5, 2.0];

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
    const scale = LEVEL_SCALE[Math.min(lvl, 3)] ?? 1;
    const roleVal = tv.roles[role] ?? 0;
    const globalVal = tv.global ?? 0;
    bonus += (roleVal + globalVal) * scale;
  }
  return bonus * TALENT_WEIGHT;
}

// ── Baserunning talent bonuses ──
// Stealing/speed talents get a bonus for leadoff and top-of-order slots
const BASERUNNING_VALUES: Record<string, Partial<Record<SlotRole, number>>> = {
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
    const scale = LEVEL_SCALE[Math.min(lvl, 3)] ?? 1;
    bonus += (rv[role] ?? 0) * scale;
  }
  return bonus * TALENT_WEIGHT;
}

function totalTalentBonus(uuid: string | undefined, ms: PlayerMetaStore, role: SlotRole): number {
  return talentBonus(uuid, ms, role) + baserunningBonus(uuid, ms, role);
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

/**
 * Lineup construction using linear-weight wOBA and component rates.
 *
 * Slots filled in priority order (3 → 1 → 2 → 4 → 5 → 8 → 6/7/9) so each
 * role claims its best-fit player first. Pitchers compete freely (two-way
 * archetypes can be strong hitters).
 *
 * Scoring references: Tango/Lichtman/Dolphin "The Book", FanGraphs wOBA
 * methodology. Linear weights are from the 2024 MLB run environment.
 */
export function recommendBattingOrder(team: Team, metaStore?: PlayerMetaStore): BattingOrderResult {
  const ms = metaStore ?? {};
  const all = team.players ?? [];
  const benched = all.filter((p) => p.bench === true);
  const active = all.filter((p) => p.bench !== true);

  const isPitcher = (p: Player) =>
    p.position === 'P' || p.position === 'SP' || p === team.pitcher;

  const remaining = new Set(active);
  const placed: { slot: number; player: Player; role: BattingSlotRole; reason: string }[] = [];

  const place = (
    slot: number,
    role: BattingSlotRole,
    reason: string,
    score: (p: Player) => number | undefined,
  ) => {
    const picked = pickHighest(Array.from(remaining), score);
    if (picked) {
      remaining.delete(picked);
      placed.push({ slot, player: picked, role, reason });
    }
  };

  // Slot 3: best overall hitter. Gets the most PAs with runners on base and
  // more total PAs than #4 over a season (The Book, ch. 5).
  place(3, 'best', '#3 — highest wOBA', (p) => {
    const pr = profile(p);
    return pr ? pr.woba + totalTalentBonus(p.uuid, ms, 'best') : undefined;
  });

  place(1, 'leadoff', 'Leadoff — OBP-driven, low K%', (p) => {
    const pr = profile(p);
    if (!pr) return undefined;
    return pr.obp * WOBA_SCALE + 0.3 * pr.bbRate - 0.4 * pr.kRate + totalTalentBonus(p.uuid, ms, 'leadoff');
  });

  place(2, 'quality', '#2 — wOBA + OBP tilt', (p) => {
    const pr = profile(p);
    if (!pr) return undefined;
    return pr.woba + 0.3 * pr.obp + totalTalentBonus(p.uuid, ms, 'quality');
  });

  place(4, 'cleanup', '#4 — wOBA + ISO power', (p) => {
    const pr = profile(p);
    if (!pr) return undefined;
    return pr.woba + 0.4 * pr.isoP + totalTalentBonus(p.uuid, ms, 'cleanup');
  });

  place(5, 'protection', '#5 — wOBA + contact', (p) => {
    const pr = profile(p);
    if (!pr) return undefined;
    return pr.woba - 0.4 * pr.kRate + totalTalentBonus(p.uuid, ms, 'protection');
  });

  // Fill 6-7-8-9: sort remaining by wOBA, then pick the best OBP from the
  // bottom half for #8 ("second leadoff"). This prevents a strong hitter from
  // being pulled down past weaker ones just because they also have good OBP.
  const tailPool = Array.from(remaining).sort((a, b) => {
    const pa = profile(a);
    const pb = profile(b);
    const ta = totalTalentBonus(a.uuid, ms, 'lower');
    const tb = totalTalentBonus(b.uuid, ms, 'lower');
    return ((pb?.woba ?? 0) + tb) - ((pa?.woba ?? 0) + ta);
  });

  let slot8Pick: Player | undefined;
  if (tailPool.length >= 3) {
    const bottomHalf = tailPool.slice(Math.floor(tailPool.length / 2));
    slot8Pick = pickHighest(bottomHalf, (p) => {
      const pr = profile(p);
      if (!pr) return undefined;
      return pr.obp - 0.3 * pr.kRate + totalTalentBonus(p.uuid, ms, 'lower');
    });
  }

  let nextSlot = 6;
  for (const p of tailPool) {
    if (nextSlot > 9) break;
    if (p === slot8Pick) continue;
    if (nextSlot === 8) {
      if (slot8Pick) {
        placed.push({ slot: 8, player: slot8Pick, role: 'lower', reason: '#8 — OBP, turns order over' });
        remaining.delete(slot8Pick);
      }
      nextSlot++;
    }
    if (nextSlot > 9) break;
    placed.push({ slot: nextSlot, player: p, role: 'lower', reason: `#${nextSlot} — wOBA` });
    remaining.delete(p);
    nextSlot++;
  }
  if (slot8Pick && !placed.some((x) => x.player === slot8Pick)) {
    if (!placed.some((x) => x.slot === 8)) {
      placed.push({ slot: 8, player: slot8Pick, role: 'lower', reason: '#8 — OBP, turns order over' });
      remaining.delete(slot8Pick);
    }
  }

  // Backfill any skipped slots — happens when stats were missing for the
  // criteria that slot relies on (e.g. brand-new team with no SLG anywhere).
  const usedSlots = new Set(placed.map((x) => x.slot));
  const placedPlayers = new Set(placed.map((x) => x.player));
  const leftovers = active.filter((p) => !placedPlayers.has(p));
  for (let s = 1; s <= 9; s++) {
    if (usedSlots.has(s)) continue;
    const next = leftovers.shift();
    if (!next) break;
    placed.push({ slot: s, player: next, role: 'lower', reason: '' });
    usedSlots.add(s);
  }

  placed.sort((a, b) => a.slot - b.slot);

  const recommended: BattingSlot[] = placed.map((x) => ({
    slot: x.slot,
    player: x.player,
    currentSlot: x.player.battingOrder,
    moved: x.player.battingOrder !== undefined && x.player.battingOrder !== x.slot,
    role: x.role,
    reason: x.reason,
  }));

  return { recommended, benched };
}

// ── Chain talents: batter N's talent boosts batter N+1 ──
const CHAIN_TALENTS: Record<string, { nextPrefers: 'power' | 'contact' | 'any' }> = {
  'Rally Time':        { nextPrefers: 'power' },
  'Clutch Cascade':    { nextPrefers: 'any' },
  'Confidence Shaker': { nextPrefers: 'any' },
};

function chainBonus(
  currentPlayer: Player,
  nextPlayer: Player,
  ms: PlayerMetaStore,
): number {
  const meta = currentPlayer.uuid ? ms[currentPlayer.uuid] : undefined;
  if (!meta?.talents?.length) return 0;

  let bonus = 0;
  for (const talentName of meta.talents) {
    const chain = CHAIN_TALENTS[talentName];
    if (!chain) continue;
    const lvl = meta.talentLevels?.[talentName] ?? 1;
    const scale = LEVEL_SCALE[Math.min(lvl, 3)] ?? 1;

    const nextProfile = profile(nextPlayer);
    let fit = 0.03;
    if (nextProfile && chain.nextPrefers === 'power') {
      fit = 0.03 + 0.03 * Math.min(nextProfile.isoP / 0.200, 1);
    } else if (nextProfile && chain.nextPrefers === 'contact') {
      fit = 0.03 + 0.03 * (1 - nextProfile.kRate);
    }
    bonus += fit * scale;
  }
  return bonus;
}

function totalChainScore(order: BattingSlot[], ms: PlayerMetaStore): number {
  let score = 0;
  for (let i = 0; i < order.length - 1; i++) {
    score += chainBonus(order[i].player, order[i + 1].player, ms);
  }
  // Wrap-around: #9 feeds into #1
  if (order.length === 9) {
    score += chainBonus(order[8].player, order[0].player, ms);
  }
  return score;
}

export function recommendSynergyBattingOrder(team: Team, metaStore?: PlayerMetaStore): BattingOrderResult {
  const base = recommendBattingOrder(team, metaStore);
  const ms = metaStore ?? {};
  if (base.recommended.length < 2) return base;

  const order = [...base.recommended];
  let bestChain = totalChainScore(order, ms);
  let improved = true;

  while (improved) {
    improved = false;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const swapped = [...order];
        swapped[i] = { ...order[j], slot: order[i].slot, role: order[i].role, reason: order[i].reason };
        swapped[j] = { ...order[i], slot: order[j].slot, role: order[j].role, reason: order[j].reason };

        // Recalculate individual slot talent bonuses after swap
        const oldSlotScore =
          totalTalentBonus(order[i].player.uuid, ms, order[i].role as SlotRole) +
          totalTalentBonus(order[j].player.uuid, ms, order[j].role as SlotRole);
        const newSlotScore =
          totalTalentBonus(swapped[i].player.uuid, ms, swapped[i].role as SlotRole) +
          totalTalentBonus(swapped[j].player.uuid, ms, swapped[j].role as SlotRole);

        const newChain = totalChainScore(swapped, ms);
        const net = (newChain - bestChain) + (newSlotScore - oldSlotScore);

        if (net > 0.001) {
          order[i] = swapped[i];
          order[j] = swapped[j];
          bestChain = newChain;
          improved = true;
        }
      }
    }
  }

  const recommended = order.map((s) => ({
    ...s,
    currentSlot: s.player.battingOrder,
    moved: s.player.battingOrder !== undefined && s.player.battingOrder !== s.slot,
  }));

  return { recommended, benched: base.benched };
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
