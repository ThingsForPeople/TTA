import type { Player, Team } from './types';
import { POSITION_GUIDANCE } from './simData';
import {
  type PlayerMeta,
  type PlayerMetaStore,
  type SimStats,
  effectiveStats,
  isInjured,
  hasSim,
  MAX_TALENT_LEVEL,
} from './playerMeta';
import { recommendBattingOrder, type BattingMode, type BattingOrderResult } from './analysis';
import { empiricalFieldingBonus, type FieldingGrades } from './fieldingGrades';

export interface StatBreakdown {
  stat: string;
  label: string;
  value: number;
  weight: number;
  contribution: number;
}

export interface PositionFit {
  position: string;
  score: number;
  reason: string;
  breakdown: StatBreakdown[];
}

export interface RosterAssignment {
  player: Player;
  position: string;
  positionScore: number;
  currentPositionScore?: number;
  empiricalAdj?: number; // points added/removed from real replay fielding data
  reason: string;
  breakdown: StatBreakdown[];
  currentPosition?: string;
  moved: boolean;
  injured: boolean;
  talentSynergies: string[];
}

export interface BenchUpgrade {
  benchPlayer: Player;
  replacesPlayer: Player;
  position: string;
  benchScore: number;
  starterScore: number;
  gain: number;
}

export interface FieldOption {
  assignments: RosterAssignment[];
  /** Importance-weighted total fit (incl. combo bonuses) used to rank options. */
  totalScore: number;
}

export interface RosterOptimization {
  /** The best option's assignments (kept for back-compat / batting order). */
  assignments: RosterAssignment[];
  /** Up to 5 highest-scoring lineups, best first, for exploration. */
  options: FieldOption[];
  /** Importance-weighted total fit of the team's CURRENT positions. */
  currentTotalScore: number;
  bench: RosterAssignment[];
  benchUpgrades: BenchUpgrade[];
  battingOrder: BattingOrderResult;
  warnings: string[];
}

const FIELD_POSITIONS = ['C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF'] as const;
type FieldPosition = (typeof FIELD_POSITIONS)[number];

const PITCHER_CATCHER_TALENTS = [
  'Law & Order',
  'Battery Boost',
  'Signal Sync',
];

// Position importance: how costly a defensive mistake is at each spot — i.e.
// how much fielder skill swings outs there. Applied during optimization only
// (not displayed scores) so the search penalizes putting weak defenders at
// high-leverage positions. This is the cold-start PRIOR; syncing replays and
// hitting "Use derived weights" replaces it with the team's data-derived
// impRecommended (0.6·leverage + 0.4·workload) from the Advanced Stats panel.
//
// Re-ranked to the replay leverage finding for THIS sim (≈50 games): OUTFIELD
// carries the most leverage — fly balls land in the in-doubt 6–12u range band
// where a good glove vs a bad one swings the out — while infield grounders
// convert ~95–100% regardless of range, so IF leverage is low and lives only
// in the long tail. Hence CF/LF/RF > SS≈2B/3B > 1B, the OPPOSITE of the
// traditional MLB SS-premium hierarchy this used to encode. Catcher joins 1B
// at the bottom (2026-07-16 audit): its only leverage is steal defense, which
// is low-volume (~0.5 att/g) and barely catcher-controllable (CS% ↔ attributes
// weak/sign-unstable), and no framing/blocking events exist in the log — a
// +10pp CS% catcher saves ~0.5 runs per 18-game season. Real C value is the
// bat plus battery talents / Pop Time, scored separately. ~Mean 1.0;
// magnitudes kept moderate (the 0.4 workload term in the real blend tempers
// the spread, and this is just a prior).
export const DEFAULT_POSITION_IMPORTANCE: Record<string, number> = {
  CF:  1.22, // deepest range, most in-doubt fly balls → highest leverage
  LF:  1.10,
  RF:  1.10, // corner OF; arm slightly more valuable but leverage ≈ LF
  SS:  1.02, // most-leveraged IF spot (throw from the hole + DP), but well below OF
  '2B': 0.98,
  '3B': 0.95, // hot corner, but high conversion → lowest-leverage dirt spot
  C:   0.70, // bat-first — steal defense is tiny and mostly luck; talents carry real C value
  '1B': 0.70, // receiver/bat-dump; workload over-credits it
};

// ── Fielding talent bonus system ─────────────────────────────────────
// No raw defensive stats exist beyond sim stats, so fielding talents
// have meaningful weight on position fit (~10-20 points per Lv1 talent).
// Lv2 = 1.25x, Lv3 = 1.5x … +0.25x per level (magnitude of level gains is
// unknown, kept conservative). Indexed by level (1-MAX_TALENT_LEVEL).
const FIELDING_LEVEL_SCALE = [0, 1.0, 1.25, 1.5, 1.75, 2.0];

const INFIELD_POSITIONS = new Set<FieldPosition>(['C', '1B', '2B', 'SS', '3B']);
const OUTFIELD_POSITIONS = new Set<FieldPosition>(['LF', 'CF', 'RF']);
const MIDDLE_INFIELD = new Set<FieldPosition>(['SS', '2B']);

interface FieldingTalentRule {
  positions: Set<FieldPosition> | 'all';
  bonus: number;
  posBonus?: Partial<Record<FieldPosition, number>>;
}

export const FIELDING_TALENT_RULES: Record<string, FieldingTalentRule> = {
  'Charger':        { positions: INFIELD_POSITIONS, bonus: 12 },
  'No Doubles':     { positions: OUTFIELD_POSITIONS, bonus: 12 },
  'Hot Potato':     { positions: 'all', bonus: 6 },
  'Warmed Up':      { positions: 'all', bonus: 6, posBonus: { RF: 4, '3B': 4, C: 3 } },
  'Pop Time':       { positions: new Set(['C']), bonus: 5 },
  'Heads & Tails':  { positions: MIDDLE_INFIELD, bonus: 5 },
};

function fieldingTalentBonus(pos: FieldPosition, meta: PlayerMeta | undefined): { bonus: number; talents: string[] } {
  if (!meta?.talents?.length) return { bonus: 0, talents: [] };
  let bonus = 0;
  const matched: string[] = [];
  for (const talentName of meta.talents) {
    const rule = FIELDING_TALENT_RULES[talentName];
    if (!rule) continue;
    if (rule.positions !== 'all' && !rule.positions.has(pos)) continue;
    const lvl = meta.talentLevels?.[talentName] ?? 1;
    const scale = FIELDING_LEVEL_SCALE[Math.min(lvl, MAX_TALENT_LEVEL)] ?? 1;
    const posExtra = rule.posBonus?.[pos] ?? 0;
    bonus += (rule.bonus + posExtra) * scale;
    matched.push(lvl > 1 ? `${talentName} Lv${lvl}` : talentName);
  }
  return { bonus, talents: matched };
}

// Combo talents: both players must be at specific positions for the talent to activate.
// The individual fieldingTalentBonus handles per-player scoring, but this adds a pair
// bonus when the combo is actually formed (both in middle infield).
const COMBO_TALENTS: { talent: string; positions: Set<FieldPosition>; pairBonus: number }[] = [
  { talent: 'Heads & Tails', positions: MIDDLE_INFIELD, pairBonus: 5 },
];

const BATTERY_COMBO_BONUS = 12;

function comboBonus(
  assignments: Map<string, { pos: FieldPosition; score: number; reason: string }>,
  metaStore: PlayerMetaStore,
  pitcherMeta: PlayerMeta | undefined,
): number {
  let bonus = 0;
  for (const combo of COMBO_TALENTS) {
    const holders: string[] = [];
    for (const [uuid, a] of assignments) {
      const meta = metaStore[uuid];
      if (!meta?.talents?.includes(combo.talent)) continue;
      if (!combo.positions.has(a.pos)) continue;
      holders.push(uuid);
    }
    if (holders.length >= 2) {
      const minLevel = Math.min(
        ...holders.map((uuid) => {
          const meta = metaStore[uuid];
          return meta?.talentLevels?.[combo.talent] ?? 1;
        }),
      );
      const scale = FIELDING_LEVEL_SCALE[Math.min(minLevel, MAX_TALENT_LEVEL)] ?? 1;
      bonus += combo.pairBonus * scale;
    }
  }

  // Pitcher+catcher combo talents: bonus when the catcher at C shares a
  // battery talent with the pitcher
  if (pitcherMeta?.talents?.length) {
    for (const [uuid, a] of assignments) {
      if (a.pos !== 'C') continue;
      const meta = metaStore[uuid];
      if (!meta?.talents?.length) continue;
      for (const t of PITCHER_CATCHER_TALENTS) {
        if (meta.talents.includes(t) && pitcherMeta.talents.includes(t)) {
          const catcherLvl = meta.talentLevels?.[t] ?? 1;
          const pitcherLvl = pitcherMeta.talentLevels?.[t] ?? 1;
          const minLvl = Math.min(catcherLvl, pitcherLvl);
          const scale = FIELDING_LEVEL_SCALE[Math.min(minLvl, MAX_TALENT_LEVEL)] ?? 1;
          bonus += BATTERY_COMBO_BONUS * scale;
        }
      }
    }
  }

  return bonus;
}

export type StatWeights = Record<string, Record<string, number>>;

// In-sim stat meanings: FLD = catch chance + throw-exchange (hands/transfer),
// ARM = throw velocity, SPD = fielding range + baserunning. Each row sums to
// 1.0 so positions stay comparable (baseScore = Σ statValue × weight).
// Tuned to THIS sim, not real MLB.
//
// REVISED 2026-06-29 from outcome data (see docs/defense-analysis-findings.md):
// pooled all teams, joined era-aligned sim stats to actual fielding outcomes.
//  • Infield is FLD-led, NOT arm-led. FLD is the dominant, stable predictor of
//    converting plays (FLD→PAE: SS 0.94, 3B 0.92, 2B 0.87); once the
//    overall-quality halo is removed, ARM has ~0 marginal signal for out
//    conversion. The old "ARM #1 at SS/2B/3B" was an assumption the data
//    refutes. ARM is kept ~0.20 at the infield as an explicit PRIOR for DP
//    turns / throw margin / deterrence — none of which PAE can measure — not
//    because the data supports it.
//  • Outfield stays SPD-led (range). OF stats barely predict PAE (outs), but
//    the OF's real value is extra-base suppression (range to cut the ball off),
//    which PAE can't see; SPD is the most defensible OF stat. RF arm kept up
//    for the long throw / deterrence prior. (bases-saved metric is the planned
//    proper measure — see findings doc.)
//  • Catcher: LOW CONFIDENCE. Caught-stealing barely tracks sim ARM (n=15,
//    weak/unstable), so ARM moderated down; catcher defense is largely
//    unmeasured (blocking/framing/exchange never appear in the log).
export const DEFAULT_STAT_WEIGHTS: StatWeights = {
  SS:  { fld: 0.52, arm: 0.20, spd: 0.28 }, // FLD-led (r≈.94); arm = DP/throw prior, not measured
  '2B': { fld: 0.50, arm: 0.20, spd: 0.30 }, // FLD-led (r≈.87); arm = pivot prior
  '3B': { fld: 0.44, arm: 0.20, spd: 0.36 }, // FLD + range both strong; arm = throw prior
  C:   { fld: 0.45, arm: 0.35, spd: 0.20 }, // low confidence — CS barely tracks arm; C defense mostly unmeasured
  '1B': { fld: 0.52, arm: 0.12, spd: 0.36 }, // receiver — scoops throws, barely throws
  CF:  { fld: 0.20, arm: 0.18, spd: 0.62 }, // speed by a longshot; arm ≈ fld
  LF:  { fld: 0.22, arm: 0.15, spd: 0.63 }, // low-arm corner — range/speed; hide a weak arm here
  RF:  { fld: 0.22, arm: 0.28, spd: 0.50 }, // strong-arm corner — the long throw (3B/home) prior
};

const STAT_LABELS: Record<string, string> = { fld: 'FLD', arm: 'ARM', spd: 'SPD' };

const MIN_FIELDING_CHANCES = 30;

function fieldingPerformanceBonus(player: Player, candidatePos: FieldPosition): number {
  const f = player.fielding;
  if (!f) return 0;
  const totalChances = (f.putouts ?? 0) + (f.assists ?? 0) + (f.errors ?? 0);
  if (totalChances < MIN_FIELDING_CHANCES) return 0;

  let bonus = 0;

  // Reliability bonus based on fielding percentage
  const pct = f.fieldingPct;
  if (typeof pct === 'number') {
    if (pct >= 0.990)      bonus += 10;
    else if (pct >= 0.975) bonus += 6;
    else if (pct >= 0.960) bonus += 3;
    else if (pct >= 0.940) bonus += 0;
    else                   bonus -= 5;
  }

  // Affinity bonus: extra credit when the candidate position matches
  // the player's current position (proven performance there)
  if (player.position === candidatePos) {
    bonus += 8;
  }

  return bonus;
}

function positionScore(
  pos: FieldPosition,
  sim: SimStats,
  meta?: PlayerMeta,
  customStatWeights?: StatWeights,
  player?: Player,
): { score: number; reason: string; breakdown: StatBreakdown[] } {
  const sw = (customStatWeights ?? DEFAULT_STAT_WEIGHTS)[pos] ?? {};
  let baseScore = 0;
  const parts: string[] = [];
  const breakdown: StatBreakdown[] = [];
  for (const [stat, weight] of Object.entries(sw)) {
    if (weight <= 0) continue;
    const val = sim[stat as keyof SimStats] ?? 0;
    const contribution = val * weight * 2;
    baseScore += val * weight;
    parts.push(`${STAT_LABELS[stat] ?? stat.toUpperCase()} ${val}`);
    breakdown.push({
      stat,
      label: STAT_LABELS[stat] ?? stat.toUpperCase(),
      value: val,
      weight,
      contribution,
    });
  }
  baseScore *= 2;
  const { bonus } = fieldingTalentBonus(pos, meta);
  const fldBonus = player ? fieldingPerformanceBonus(player, pos) : 0;
  if (fldBonus !== 0 && player?.fielding?.fieldingPct != null) {
    breakdown.push({
      stat: 'fpct',
      label: 'F%',
      value: Math.round(player.fielding.fieldingPct * 1000),
      weight: 0,
      contribution: fldBonus,
    });
  }
  return { score: baseScore + bonus + fldBonus, reason: parts.join(' + '), breakdown };
}

function findTalentSynergies(
  player: Player,
  meta: PlayerMeta | undefined,
  pitcherMeta: PlayerMeta | undefined,
  assignedPos: FieldPosition,
  allAssigned: Map<string, { pos: FieldPosition }>,
  metaStore: PlayerMetaStore,
): string[] {
  if (!meta?.talents?.length) return [];
  const synergies: string[] = [];

  // Pitcher+catcher combo talents
  if (assignedPos === 'C' && pitcherMeta?.talents) {
    for (const t of PITCHER_CATCHER_TALENTS) {
      if (meta.talents.includes(t) && pitcherMeta.talents.includes(t)) {
        synergies.push(`${t} (pitcher+catcher)`);
      }
    }
  }

  // Fielding talent × position synergies
  for (const talentName of meta.talents) {
    const rule = FIELDING_TALENT_RULES[talentName];
    if (!rule) continue;
    if (rule.positions !== 'all' && !rule.positions.has(assignedPos)) continue;
    const lvl = meta.talentLevels?.[talentName] ?? 1;
    synergies.push(lvl > 1 ? `${talentName} Lv${lvl}` : talentName);
  }

  // Combo talent pairs (e.g. Heads & Tails on both middle infielders)
  for (const combo of COMBO_TALENTS) {
    if (!meta.talents.includes(combo.talent)) continue;
    if (!combo.positions.has(assignedPos)) continue;
    for (const [otherUuid, otherA] of allAssigned) {
      if (otherUuid === player.uuid) continue;
      if (!combo.positions.has(otherA.pos)) continue;
      const otherMeta = metaStore[otherUuid];
      if (otherMeta?.talents?.includes(combo.talent)) {
        synergies.push(`${combo.talent} combo (${assignedPos}+${otherA.pos})`);
        break;
      }
    }
  }

  return synergies;
}

export function optimizeRoster(
  team: Team,
  metaStore: PlayerMetaStore,
  positionImportance?: Record<string, number>,
  statWeights?: StatWeights,
  fieldingGrades?: FieldingGrades,
  battingMode: BattingMode = 'stat',
  platoonDelta?: Record<string, number>,
): RosterOptimization {
  const warnings: string[] = [];
  // How much each position values arm strength (drives the transferable arm
  // component of the empirical fielding bonus).
  const armImp = (pos: FieldPosition) => (statWeights ?? DEFAULT_STAT_WEIGHTS)[pos]?.arm ?? 0;
  const empBonus = (pos: FieldPosition, uuid: string | undefined) =>
    empiricalFieldingBonus(pos, uuid, fieldingGrades, armImp(pos));
  const all = team.players ?? [];
  const isPitcher = (p: Player) =>
    p.position === 'P' || p.position === 'SP' || p === team.pitcher;

  const pitcher = all.find(isPitcher);
  const nonPitchers = all.filter((p) => !isPitcher(p));
  const pitcherMeta = pitcher?.uuid ? metaStore[pitcher.uuid] : undefined;

  const starters = nonPitchers.filter((p) => !p.bench);
  const benchPlayers = nonPitchers.filter((p) => p.bench);

  const withSim = starters.filter((p) => p.uuid && hasSim(metaStore[p.uuid]));
  const withoutSim = starters.filter((p) => !p.uuid || !hasSim(metaStore[p.uuid]));

  if (withoutSim.length > 0) {
    warnings.push(
      `${withoutSim.length} player(s) have no sim stats: ${withoutSim.map((p) => p.name).join(', ')}. They'll keep their current positions.`,
    );
  }

  // Score every player at every position
  const scoreboard: { player: Player; pos: FieldPosition; score: number; reason: string }[] = [];
  for (const p of withSim) {
    const meta = metaStore[p.uuid!];
    const sim = effectiveStats(meta);
    for (const pos of FIELD_POSITIONS) {
      const { score, reason } = positionScore(pos, sim, meta, statWeights, p);
      const injuryPenalty = isInjured(meta) ? 0.5 : 0;
      scoreboard.push({ player: p, pos, score: score - injuryPenalty + empBonus(pos, p.uuid), reason });
    }
  }

  // Global optimal assignment: exhaustive search over all permutations.
  // 8 players × 8 positions = 40,320 evaluations — fast enough for real-time use.
  const positionPriority: FieldPosition[] = ['SS', 'CF', '2B', '3B', 'RF', 'LF', '1B', 'C'];

  const reservedPositions = new Set<FieldPosition>();
  for (const p of withoutSim) {
    const pos = p.position as FieldPosition;
    if (pos && FIELD_POSITIONS.includes(pos)) reservedPositions.add(pos);
  }
  const availablePositions = FIELD_POSITIONS.filter((p) => !reservedPositions.has(p));
  const playerUuids = withSim.map((p) => p.uuid!);

  const scoreMap = new Map<string, Map<FieldPosition, { score: number; reason: string }>>();
  for (const entry of scoreboard) {
    const uuid = entry.player.uuid!;
    if (!scoreMap.has(uuid)) scoreMap.set(uuid, new Map());
    scoreMap.get(uuid)!.set(entry.pos, { score: entry.score, reason: entry.reason });
  }
  const lookupScore = (uuid: string, pos: FieldPosition) =>
    scoreMap.get(uuid)?.get(pos) ?? { score: 0, reason: '' };

  const n = playerUuids.length;
  const posCount = availablePositions.length;
  const importance = positionImportance ?? DEFAULT_POSITION_IMPORTANCE;

  // Objective for a full assignment: importance-weighted position fit + combos.
  const assignmentObjective = (
    map: Map<string, { pos: FieldPosition; score: number; reason: string }>,
  ): number => {
    let sum = 0;
    for (const [, a] of map) sum += a.score * (importance[a.pos] ?? 1);
    return sum + comboBonus(map, metaStore, pitcherMeta);
  };

  // Exhaustive search, but keep the top-K distinct lineups by objective (not
  // just the single best) so the UI can offer alternatives to explore.
  const MAX_OPTIONS = 5;
  const topK: { score: number; perm: number[] }[] = [];
  const perm = availablePositions.map((_, i) => i);
  const trial = new Map<string, { pos: FieldPosition; score: number; reason: string }>();

  const considerPerm = () => {
    trial.clear();
    for (let i = 0; i < n; i++) {
      const pos = availablePositions[perm[i]];
      trial.set(playerUuids[i], { pos, ...lookupScore(playerUuids[i], pos) });
    }
    const score = assignmentObjective(trial);
    if (topK.length < MAX_OPTIONS) {
      topK.push({ score, perm: perm.slice(0, n) });
      topK.sort((a, b) => b.score - a.score);
    } else if (score > topK[topK.length - 1].score) {
      topK[topK.length - 1] = { score, perm: perm.slice(0, n) };
      topK.sort((a, b) => b.score - a.score);
    }
  };

  function searchPerms(depth: number) {
    if (depth === n) { considerPerm(); return; }
    for (let i = depth; i < posCount; i++) {
      [perm[depth], perm[i]] = [perm[i], perm[depth]];
      searchPerms(depth + 1);
      [perm[depth], perm[i]] = [perm[i], perm[depth]];
    }
  }

  searchPerms(0);

  const posOrder = new Map(positionPriority.map((pp, i) => [pp, i]));

  // Build a full, display-sorted assignment list (starters + kept players) for
  // one candidate permutation.
  const buildAssignments = (permVec: number[]): RosterAssignment[] => {
    const assigned = new Map<string, { pos: FieldPosition; score: number; reason: string }>();
    for (let i = 0; i < n; i++) {
      const pos = availablePositions[permVec[i]];
      assigned.set(playerUuids[i], { pos, ...lookupScore(playerUuids[i], pos) });
    }

    const list: RosterAssignment[] = [];
    for (const p of withSim) {
      const a = assigned.get(p.uuid!);
      const meta = metaStore[p.uuid!];
      if (a) {
        const sim = effectiveStats(meta);
        const { breakdown } = positionScore(a.pos, sim, meta, statWeights, p);
        const curPos = p.position as FieldPosition | undefined;
        const currentPosScore = curPos && FIELD_POSITIONS.includes(curPos as FieldPosition)
          ? Math.round(positionScore(curPos as FieldPosition, sim, meta, statWeights, p).score + empBonus(curPos as FieldPosition, p.uuid))
          : undefined;
        list.push({
          player: p,
          position: a.pos,
          positionScore: Math.round(a.score),
          currentPositionScore: currentPosScore,
          empiricalAdj: empBonus(a.pos, p.uuid) || undefined,
          reason: a.reason,
          breakdown,
          currentPosition: p.position ?? undefined,
          moved: p.position !== a.pos,
          injured: isInjured(meta),
          talentSynergies: findTalentSynergies(p, meta, pitcherMeta, a.pos, assigned, metaStore),
        });
      } else {
        list.push({
          player: p,
          position: p.position ?? 'BN',
          positionScore: 0,
          reason: 'No open position fit',
          breakdown: [],
          currentPosition: p.position ?? undefined,
          moved: false,
          injured: isInjured(meta),
          talentSynergies: [],
        });
      }
    }

    for (const p of withoutSim) {
      list.push({
        player: p,
        position: p.position ?? 'BN',
        positionScore: 0,
        reason: 'Kept current (no sim stats)',
        breakdown: [],
        currentPosition: p.position ?? undefined,
        moved: false,
        injured: false,
        talentSynergies: [],
      });
    }

    list.sort((a, b) =>
      (posOrder.get(a.position as FieldPosition) ?? 99) - (posOrder.get(b.position as FieldPosition) ?? 99),
    );
    return list;
  };

  const options: FieldOption[] = topK.map(({ score, perm: permVec }) => ({
    assignments: buildAssignments(permVec),
    totalScore: Math.round(score),
  }));

  // The best option drives batting order, bench upgrades, and back-compat.
  const assignments = options[0]?.assignments ?? [];

  // Importance-weighted fit of the CURRENT setup, for a "vs current" delta.
  const currentMap = new Map<string, { pos: FieldPosition; score: number; reason: string }>();
  for (const p of withSim) {
    const curPos = p.position as FieldPosition | undefined;
    if (curPos && FIELD_POSITIONS.includes(curPos)) {
      currentMap.set(p.uuid!, { pos: curPos, ...lookupScore(p.uuid!, curPos) });
    }
  }
  const currentTotalScore = Math.round(assignmentObjective(currentMap));

  // Build bench list
  const benchAssignments: RosterAssignment[] = benchPlayers.map((p) => ({
    player: p,
    position: 'BN',
    positionScore: 0,
    reason: 'Bench',
    breakdown: [],
    currentPosition: p.position ?? 'BN',
    moved: false,
    injured: p.uuid ? isInjured(metaStore[p.uuid]) : false,
    talentSynergies: [],
  }));

  // Compute bench upgrades: score each bench player at each assigned position
  const benchUpgrades: BenchUpgrade[] = [];
  for (const bp of benchPlayers) {
    if (!bp.uuid || !hasSim(metaStore[bp.uuid])) continue;
    const bMeta = metaStore[bp.uuid];
    const bSim = effectiveStats(bMeta);

    for (const a of assignments) {
      const pos = a.position as FieldPosition;
      if (!FIELD_POSITIONS.includes(pos)) continue;
      const benchFit = positionScore(pos, bSim, bMeta, statWeights, bp);
      const benchScoreWithEmp = benchFit.score + empBonus(pos, bp.uuid);
      const gain = Math.round(benchScoreWithEmp) - a.positionScore;
      if (gain > 0) {
        benchUpgrades.push({
          benchPlayer: bp,
          replacesPlayer: a.player,
          position: pos,
          benchScore: Math.round(benchScoreWithEmp),
          starterScore: a.positionScore,
          gain,
        });
      }
    }
  }
  benchUpgrades.sort((a, b) => b.gain - a.gain);

  // Build a virtual team with optimized positions for batting order (starters only)
  const virtualPlayers: Player[] = assignments.map((a) => ({
    ...a.player,
    position: a.position,
    bench: false,
  }));
  if (pitcher) virtualPlayers.push(pitcher);
  const virtualTeam: Team = {
    ...team,
    players: [...virtualPlayers, ...benchPlayers.map((b) => ({ ...b, bench: true }))],
    pitcher,
  };
  const battingOrder = recommendBattingOrder(virtualTeam, metaStore, battingMode, platoonDelta);

  return { assignments, options, currentTotalScore, bench: benchAssignments, benchUpgrades, battingOrder, warnings };
}
