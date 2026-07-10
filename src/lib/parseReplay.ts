// Replay evaluator — turns the raw Tiny Teams replay JSON
// (GET /api/replay/:gameId, ~2.8 MB) into a compact, team-oriented evaluation.
// Parsed server-side so the client only receives the small summary.
//
// The replay is a deterministic event log. Each "pitch" segment carries one
// pitch.thrown plus the batter's reaction; the at-bat's outcome lands in a
// following "post" segment as batter.result. We join them by metadata.atBatId.
// See talentEffects.ts / CLAUDE.md for the broader replay schema.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { PitchTalent } from './playerMeta';
import { expectedBases, expectedWobaCon } from './expectedOutcome';

export interface BbMix {
  ground: number;
  line: number;
  fly: number;
  popup: number;
}

export interface BatterEval {
  playerId: string;
  name: string;
  bats?: string;
  pa: number;
  battedBalls: number;
  hits: number;
  k: number;
  bb: number;
  results: Record<string, number>;
  avgExitVelo: number | null;
  maxExitVelo: number | null;
  bbMix: BbMix;
  hardHit: number;
  hardHitOuts: number;
}

export interface PitchTypeStat {
  type: string;
  label: string;
  count: number;
  swings: number;
  whiffs: number;
  inPlay: number;
  // 2026-07-09: engine "overpower" roll (decoded: 82% whiff on swings when set
  // vs 49% when not — the lever Command talents push) + velocity (mph-like).
  overpowered: number;
  veloSum: number;
  veloCount: number;
}

export interface PitcherEval {
  playerId: string;
  name: string;
  pitches: number;
  swings: number;
  whiffs: number;
  calledStrikes: number;
  balls: number;
  inPlay: number;
  mistakes: number;
  overpowered: number; // pitches where the engine's overpower roll fired
  byType: PitchTypeStat[];
}

export interface TeamEval {
  side: 'home' | 'away';
  name: string;
  runs: number;
  hits: number;
  batters: BatterEval[];
  avgExitVelo: number | null;
  maxExitVelo: number | null;
  hardHit: number;
  hardHitOuts: number;
  bbMix: BbMix;
  k: number;
  bb: number;
  // batting plate discipline
  pitchesSeen: number;
  swings: number;
  whiffs: number;
  chases: number; // swings at pitches out of the zone
}

export interface TalentActivation {
  talentId: string;
  displayName: string;
  count: number;
}

// Per-player talent triggering for one game. `count` = times it triggered
// (talent.activated). `effects` = effect.applied count (effects/count > 1 means
// the talent applies multiple effects per trigger — the closest signal to
// compounding the log exposes). NOTE: `maxTier` is the talent's static LEVEL
// (effect.applied `tier` is constant per player = roster level), NOT an in-game
// stack/charge depth — the replay does not record per-game stacking. `stacked`
// is vestigial (kept for storage shape). Lets us show "Waste No Time fired ×16".
export interface PlayerTalentLine {
  playerId: string;
  name: string;
  talentId: string;
  displayName: string;
  count: number;
  effects: number;
  stacked: number;
  maxTier: number;
}

export interface FieldingLine {
  playerId: string;
  name: string;
  position: number | null;
  chances: number;
  putouts: number;
  assists: number;
  fieldErrors: number;
  plays: number;
  closePlays: number;
  rangeAvg: number | null;
  armMax: number | null;
  pae: number; // plays above expected, this game
  stealAttempts: number;
  caughtStealing: number;
  dp: number; // double plays involved in (any role)
  dpStarted: number;
  dpTurned: number;
  dpFinished: number;
}

export interface ReplayEvaluation {
  ourSide: 'home' | 'away';
  matched: boolean; // whether ourTeamId matched a side
  us: TeamEval;
  them: TeamEval;
  ourPitcher: PitcherEval | null;
  talentActivations: TalentActivation[]; // our team, most-active first
  talentBreakdown: PlayerTalentLine[]; // per-player triggering + stacking (our team)
  hardHitThreshold: number | null; // EV cutoff used for "hard-hit"
  fielding?: FieldingLine[]; // our team's per-player fielding for this game
  notes: string[];
}

// Builds the compact per-player fielding lines for one game from the full
// metrics extraction (used by the single-game Replay Analysis view).
export function fieldingLinesFromMetrics(metrics: GameMetrics): FieldingLine[] {
  return metrics.players
    .filter((p) => p.chances > 0 || p.putouts > 0 || p.assists > 0 || p.stealAttempts > 0)
    .map((p) => ({
      playerId: p.playerId,
      name: p.name,
      position: p.position,
      chances: p.chances,
      putouts: p.putouts,
      assists: p.assists,
      fieldErrors: p.fieldErrors,
      plays: p.putouts + p.assists,
      closePlays: p.closePlays,
      rangeAvg: p.rangeCount ? Math.round((p.rangeSum / p.rangeCount) * 10) / 10 : null,
      armMax: p.throwSpeedMax || null,
      pae: Math.round((p.engagedOuts - p.expectedOuts) * 10) / 10,
      stealAttempts: p.stealAttempts,
      caughtStealing: p.caughtStealing,
      dp: p.dpInvolved ?? 0,
      dpStarted: p.dpStarted ?? 0,
      dpTurned: p.dpTurned ?? 0,
      dpFinished: p.dpFinished ?? 0,
    }))
    .sort((a, b) => b.plays - a.plays || b.chances - a.chances);
}

const PITCH_LABELS: Record<string, string> = {
  fourSeamFastball: '4-Seam',
  twoSeamFastball: '2-Seam',
  cutter: 'Cutter',
  sinker: 'Sinker',
  slider: 'Slider',
  curveball: 'Curveball',
  splitter: 'Splitter',
  changeup: 'Changeup',
  knuckleball: 'Knuckleball',
};

const HIT_RESULTS = new Set(['single', 'double', 'triple', 'homerun']);

function bbBucket(launchAngle: number): keyof BbMix {
  if (launchAngle < 10) return 'ground';
  if (launchAngle < 25) return 'line';
  if (launchAngle < 50) return 'fly';
  return 'popup';
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

interface PlateAppearance {
  atBatId: number;
  batterId: string;
  side: 'home' | 'away';
  result: string;
  ev?: number;
  la?: number;
}

// ── Roster talent extraction ────────────────────────────────────────
// The team-search scrape carries NO talents — only the replay roster does
// (`players[].talents: [{ id, tier, displayName }]`). This pulls our side's
// per-player talents into the playerMeta shape so they can auto-seed the
// editor / batting-order optimizer. One replay covers the 9 who played that
// game; accumulating across games builds full-roster coverage.

export interface RosterTalents {
  name: string;
  talents: string[]; // batting/baserunning/fielding/zone displayNames
  talentLevels: Record<string, number>; // displayName → tier, only when > 1
  pitchTalents: PitchTalent[]; // pitch types with their sub-talents grouped in
}

// Pitch-TYPE ids (the arsenal). Mirrors talentClassify.ts PITCH_TYPE_ID_SET.
const PITCH_TYPE_IDS = new Set([
  'fastball', 'two_seam_fastball', 'cutter', 'sinker',
  'changeup', 'curveball', 'slider', 'splitter', 'knuckleball',
]);
// Pitch SUB-talent ids modify a specific pitch: `zone:<pitch>:<zone>:<effect>`,
// `base:<pitch>:...`, or legacy `pz_*`. The pitch key is the 2nd `:`-segment.
const isPitchSubId = (id: string) =>
  id.startsWith('zone:') || id.startsWith('base:') || id.startsWith('pz_');
// Normalize a pitch key so the type id (`two_seam_fastball`) and the sub
// segment (`twoSeamFastball`) collapse to the same bucket.
const normPitchKey = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();

export function extractRosterTalents(
  raw: any,
  teamUuid: string,
): { matched: boolean; players: Record<string, RosterTalents> } {
  const game = raw?.game ?? {};
  const home = game.home ?? {};
  const away = game.away ?? {};
  const matched = teamUuid === home.id || teamUuid === away.id;
  if (!matched) return { matched: false, players: {} };
  const ours = away.id === teamUuid ? away : home;

  const players: Record<string, RosterTalents> = {};
  for (const p of ours.players ?? []) {
    if (!p?.id) continue;
    const name = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || p.id;
    const talents: string[] = [];
    const talentLevels: Record<string, number> = {};
    const pitchByKey = new Map<string, PitchTalent>();
    const pendingSubs: { key: string; name: string; level: number }[] = [];

    for (const tal of p.talents ?? []) {
      const id: string = tal?.id ?? '';
      const display: string = tal?.displayName ?? id;
      const level: number = typeof tal?.tier === 'number' ? tal.tier : 1;
      if (!id) continue;
      if (PITCH_TYPE_IDS.has(id)) {
        pitchByKey.set(normPitchKey(id), { pitch: display, level, sub: [] });
      } else if (isPitchSubId(id)) {
        const seg = id.split(':')[1] ?? '';
        pendingSubs.push({ key: normPitchKey(seg), name: display, level });
      } else {
        talents.push(display);
        if (level > 1) talentLevels[display] = level; // match meta convention
      }
    }
    // Attach each sub to its parent pitch (skip orphans — a sub can't exist
    // without its pitch type, so an unmatched key just means it wasn't owned).
    for (const s of pendingSubs) {
      pitchByKey.get(s.key)?.sub.push({ name: s.name, level: s.level });
    }

    players[p.id] = { name, talents, talentLevels, pitchTalents: [...pitchByKey.values()] };
  }
  return { matched: true, players };
}

export function evaluateReplay(raw: any, ourTeamId?: string): ReplayEvaluation {
  const game = raw?.game ?? {};
  const home = game.home ?? {};
  const away = game.away ?? {};

  const playerById = new Map<string, { name: string; side: 'home' | 'away'; bats?: string }>();
  const talentNames = new Map<string, string>();
  for (const side of ['home', 'away'] as const) {
    const t = side === 'home' ? home : away;
    for (const p of t.players ?? []) {
      const name = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || p.id;
      playerById.set(p.id, { name, side, bats: p.bats });
      for (const tal of p.talents ?? []) talentNames.set(tal.id, tal.displayName ?? tal.id);
    }
  }

  const matched = ourTeamId === home.id || ourTeamId === away.id;
  const ourSide: 'home' | 'away' = away.id === ourTeamId ? 'away' : 'home';

  // Accumulators
  const contactByAB = new Map<number, { ev?: number; la?: number }>();
  const pas: PlateAppearance[] = [];
  const pitchers = new Map<string, PitcherEval & { _types: Map<string, PitchTypeStat> }>();
  const talentCounts = new Map<string, number>();
  // Weather transitions (post-patch mechanic) for a game-conditions note.
  const weatherEvents: { inning: number | null; layer: string; action: string; intensity?: string }[] = [];
  // Per (ownerId|talentId) triggering + stacking, our side, for the per-player breakdown.
  const talentStats = new Map<string, { playerId: string; talentId: string; acts: number; effects: number; stacked: number; maxTier: number }>();
  const tStat = (ownerId: string, talentId: string) => {
    const k = ownerId + '|' + talentId;
    let s = talentStats.get(k);
    if (!s) { s = { playerId: ownerId, talentId, acts: 0, effects: 0, stacked: 0, maxTier: 0 }; talentStats.set(k, s); }
    return s;
  };
  // batting discipline per side
  const disc: Record<'home' | 'away', { pitchesSeen: number; swings: number; whiffs: number; chases: number }> = {
    home: { pitchesSeen: 0, swings: 0, whiffs: 0, chases: 0 },
    away: { pitchesSeen: 0, swings: 0, whiffs: 0, chases: 0 },
  };

  const getPitcher = (id: string) => {
    let p = pitchers.get(id);
    if (!p) {
      p = {
        playerId: id,
        name: playerById.get(id)?.name ?? id,
        pitches: 0, swings: 0, whiffs: 0, calledStrikes: 0, balls: 0, inPlay: 0, mistakes: 0, overpowered: 0,
        byType: [], _types: new Map(),
      };
      pitchers.set(id, p);
    }
    return p;
  };

  for (const seg of raw?.segments ?? []) {
    const md = seg.metadata ?? {};
    const batterId: string | undefined = md.batterId ?? undefined;
    const pitcherId: string | undefined = md.pitcherId ?? undefined;
    const atBatId: number | undefined = md.atBatId ?? undefined;
    const batterSide = batterId ? playerById.get(batterId)?.side : undefined;

    // Segment-level pitch info (each pitch segment has exactly one pitch.thrown).
    let segPitchType: string | undefined;
    let segMistake = false;
    let segOverpowered = false;
    let segVelocity: number | undefined;
    let sawPitch = false;
    // Post-patch effect.activated dedup: first effect of a (player,talent) in a
    // segment is the activation; the rest are extra effects of that trigger.
    const segActivated = new Set<string>();
    for (const ev of seg.events ?? []) {
      if (ev.type === 'pitch.thrown') {
        sawPitch = true;
        segPitchType = ev.payload?.pitchType;
        segMistake = !!ev.payload?.mistake;
        segOverpowered = !!ev.payload?.overpowered;
        segVelocity = typeof ev.payload?.velocity === 'number' ? ev.payload.velocity : undefined;
      }
    }

    let pitcherTypeStat: PitchTypeStat | undefined;
    if (sawPitch && pitcherId) {
      const p = getPitcher(pitcherId);
      p.pitches++;
      if (segMistake) p.mistakes++;
      if (segOverpowered) p.overpowered++;
      const ptype = segPitchType ?? 'unknown';
      pitcherTypeStat = p._types.get(ptype);
      if (!pitcherTypeStat) {
        pitcherTypeStat = { type: ptype, label: PITCH_LABELS[ptype] ?? ptype, count: 0, swings: 0, whiffs: 0, inPlay: 0, overpowered: 0, veloSum: 0, veloCount: 0 };
        p._types.set(ptype, pitcherTypeStat);
      }
      pitcherTypeStat.count++;
      if (segOverpowered) pitcherTypeStat.overpowered++;
      if (segVelocity != null) { pitcherTypeStat.veloSum += segVelocity; pitcherTypeStat.veloCount++; }
    }
    if (sawPitch && batterSide) disc[batterSide].pitchesSeen++;

    for (const ev of seg.events ?? []) {
      const pl = ev.payload ?? {};
      switch (ev.type) {
        case 'pitch.result': {
          if (pitcherId) {
            const p = getPitcher(pitcherId);
            if (pl.outcome === 'ball') p.balls++;
            else if (pl.outcome === 'strike' && pl.action !== 'swing') p.calledStrikes++;
            else if (pl.outcome === 'in_play') {
              p.inPlay++;
              if (pitcherTypeStat) pitcherTypeStat.inPlay++;
            }
          }
          if (pl.action === 'swing' && pl.inZone === false && batterSide) disc[batterSide].chases++;
          break;
        }
        case 'batter.action': {
          if (pl.action === 'swing') {
            if (batterSide) {
              disc[batterSide].swings++;
              if (!pl.madeContact) disc[batterSide].whiffs++;
            }
            if (pitcherId) {
              const p = getPitcher(pitcherId);
              p.swings++;
              if (pitcherTypeStat) pitcherTypeStat.swings++;
              if (!pl.madeContact) {
                p.whiffs++;
                if (pitcherTypeStat) pitcherTypeStat.whiffs++;
              }
            }
          }
          break;
        }
        case 'batter.contact': {
          if (atBatId != null) {
            contactByAB.set(atBatId, { ev: pl.exitVelocity, la: pl.launchAngle });
          }
          break;
        }
        case 'batter.result': {
          if (batterId && batterSide) {
            const c = atBatId != null ? contactByAB.get(atBatId) : undefined;
            pas.push({
              atBatId: atBatId ?? -1,
              batterId,
              side: batterSide,
              result: pl.result ?? 'unknown',
              ev: c?.ev,
              la: c?.la,
            });
          }
          break;
        }
        case 'talent.activated': {
          // Pre-2026-07-08 format (kept for compat with cached old-format replays).
          const op = pl.ownerId ? playerById.get(pl.ownerId) : undefined;
          if (op && op.side === ourSide && pl.talentId) {
            talentCounts.set(pl.talentId, (talentCounts.get(pl.talentId) ?? 0) + 1);
            tStat(pl.ownerId, pl.talentId).acts++;
          }
          break;
        }
        case 'effect.applied': {
          // Pre-2026-07-08 format. `tier` is the talent's LEVEL, not a stack.
          const op = pl.ownerId ? playerById.get(pl.ownerId) : undefined;
          if (op && op.side === ourSide && pl.talentId && typeof pl.tier === 'number') {
            const s = tStat(pl.ownerId, pl.talentId);
            s.effects++;
            if (pl.tier >= 2) s.stacked++;
            if (pl.tier > s.maxTier) s.maxTier = pl.tier;
          }
          break;
        }
        case 'weather.transition': {
          // 2026-07-08 patch: weather (rain/wind) exists and physically affects
          // ball flight. Record transitions for a game-conditions note.
          const inning = seg.metadata?.inning;
          if (pl.layer && pl.action) {
            weatherEvents.push({ inning: typeof inning === 'number' ? inning : null, layer: pl.layer, action: pl.action, intensity: pl.intensity });
          }
          break;
        }
        case 'effect.activated': {
          // 2026-07-08 patch: talent.activated + effect.applied merged into one
          // event. source ∈ talent|weather|affliction; owner is targetEntityId.
          // No per-trigger event survives, so the first effect of a (player,
          // talent) in a segment counts as the activation, later ones as extra
          // effects of the same trigger.
          if (pl.source !== 'talent') break;
          const owner: string | undefined = pl.targetEntityId;
          const op = owner ? playerById.get(owner) : undefined;
          if (op && op.side === ourSide && pl.talentId) {
            const s = tStat(owner!, pl.talentId);
            const key = `${owner}|${pl.talentId}`;
            if (!segActivated.has(key)) {
              segActivated.add(key);
              talentCounts.set(pl.talentId, (talentCounts.get(pl.talentId) ?? 0) + 1);
              s.acts++;
            }
            s.effects++;
            if (typeof pl.tier === 'number') {
              if (pl.tier >= 2) s.stacked++;
              if (pl.tier > s.maxTier) s.maxTier = pl.tier;
            }
          }
          break;
        }
      }
    }
  }

  // Hard-hit threshold: 70th percentile of all batted-ball exit velocities.
  const allEv = pas.map((p) => p.ev).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  const hardHitThreshold = allEv.length >= 5 ? Math.round(percentile(allEv, 0.7) * 10) / 10 : null;

  const buildTeam = (side: 'home' | 'away'): TeamEval => {
    const t = side === 'home' ? home : away;
    const sidePas = pas.filter((p) => p.side === side);
    const batters = new Map<string, BatterEval>();
    const evByBatter = new Map<string, number[]>();

    for (const pa of sidePas) {
      let b = batters.get(pa.batterId);
      if (!b) {
        const pinfo = playerById.get(pa.batterId);
        b = {
          playerId: pa.batterId, name: pinfo?.name ?? pa.batterId, bats: pinfo?.bats,
          pa: 0, battedBalls: 0, hits: 0, k: 0, bb: 0, results: {},
          avgExitVelo: null, maxExitVelo: null,
          bbMix: { ground: 0, line: 0, fly: 0, popup: 0 }, hardHit: 0, hardHitOuts: 0,
        };
        batters.set(pa.batterId, b);
      }
      b.pa++;
      b.results[pa.result] = (b.results[pa.result] ?? 0) + 1;
      if (pa.result === 'strikeout') b.k++;
      else if (pa.result === 'walk') b.bb++;
      if (HIT_RESULTS.has(pa.result)) b.hits++;
      if (typeof pa.ev === 'number') {
        b.battedBalls++;
        (evByBatter.get(pa.batterId) ?? evByBatter.set(pa.batterId, []).get(pa.batterId)!).push(pa.ev);
        if (typeof pa.la === 'number') b.bbMix[bbBucket(pa.la)]++;
        if (hardHitThreshold != null && pa.ev >= hardHitThreshold) {
          b.hardHit++;
          if (!HIT_RESULTS.has(pa.result)) b.hardHitOuts++;
        }
      }
    }

    for (const [id, b] of batters) {
      const evs = evByBatter.get(id) ?? [];
      if (evs.length) {
        b.avgExitVelo = Math.round((evs.reduce((s, v) => s + v, 0) / evs.length) * 10) / 10;
        b.maxExitVelo = Math.round(Math.max(...evs) * 10) / 10;
      }
    }

    const batterList = [...batters.values()].sort((a, b) => b.pa - a.pa);
    const teamEvs = sidePas.map((p) => p.ev).filter((v): v is number => typeof v === 'number');
    const bbMix: BbMix = { ground: 0, line: 0, fly: 0, popup: 0 };
    for (const b of batterList) {
      bbMix.ground += b.bbMix.ground; bbMix.line += b.bbMix.line; bbMix.fly += b.bbMix.fly; bbMix.popup += b.bbMix.popup;
    }
    const lastState = lastGameState(raw);
    return {
      side,
      name: t.name ?? (side === 'home' ? 'Home' : 'Away'),
      runs: lastState?.score?.[side] ?? 0,
      hits: lastState?.hits?.[side] ?? batterList.reduce((s, b) => s + b.hits, 0),
      batters: batterList,
      avgExitVelo: teamEvs.length ? Math.round((teamEvs.reduce((s, v) => s + v, 0) / teamEvs.length) * 10) / 10 : null,
      maxExitVelo: teamEvs.length ? Math.round(Math.max(...teamEvs) * 10) / 10 : null,
      hardHit: batterList.reduce((s, b) => s + b.hardHit, 0),
      hardHitOuts: batterList.reduce((s, b) => s + b.hardHitOuts, 0),
      bbMix,
      k: batterList.reduce((s, b) => s + b.k, 0),
      bb: batterList.reduce((s, b) => s + b.bb, 0),
      pitchesSeen: disc[side].pitchesSeen,
      swings: disc[side].swings,
      whiffs: disc[side].whiffs,
      chases: disc[side].chases,
    };
  };

  const us = buildTeam(ourSide);
  const them = buildTeam(ourSide === 'home' ? 'away' : 'home');

  // Our pitcher = the pitcher who threw while the OTHER side batted.
  let ourPitcher: PitcherEval | null = null;
  let bestPitches = -1;
  for (const [id, p] of pitchers) {
    if (playerById.get(id)?.side === ourSide && p.pitches > bestPitches) {
      bestPitches = p.pitches;
      p.byType = [...p._types.values()].sort((a, b) => b.count - a.count);
      ourPitcher = p;
    }
  }

  const talentActivations: TalentActivation[] = [...talentCounts.entries()]
    .map(([talentId, count]) => ({ talentId, displayName: talentNames.get(talentId) ?? talentId, count }))
    .sort((a, b) => b.count - a.count);

  // Per-player breakdown, excluding pitch-arsenal ids (they fire every pitch and
  // aren't the "talents" managers reason about) — keep batting/fielding/zone.
  const talentBreakdown: PlayerTalentLine[] = [...talentStats.values()]
    .filter((s) => !PITCH_TYPE_IDS.has(s.talentId) && !isPitchSubId(s.talentId) && (s.acts > 0 || s.effects > 0))
    .map((s) => ({
      playerId: s.playerId,
      name: playerById.get(s.playerId)?.name ?? s.playerId,
      talentId: s.talentId,
      displayName: talentNames.get(s.talentId) ?? s.talentId,
      count: s.acts,
      effects: s.effects,
      stacked: s.stacked,
      maxTier: s.maxTier,
    }))
    .sort((a, b) => b.count - a.count || b.effects - a.effects);

  const notes = buildNotes(us, them, ourPitcher, hardHitThreshold);
  // Weather affects ball physics post-patch — surface it as a condition note.
  const wx = weatherEvents.filter((w) => w.action === 'activated');
  if (wx.length) {
    const spans = wx.map((w) => `${w.layer}${w.intensity ? ` (${w.intensity})` : ''}${w.inning != null ? ` from inning ${w.inning}` : ''}`);
    notes.unshift(`Weather: ${[...new Set(spans)].join('; ')} — rain/wind alter ball flight, so contact-quality numbers this game aren't directly comparable to clear-weather games.`);
  }

  return { ourSide, matched, us, them, ourPitcher, talentActivations, talentBreakdown, hardHitThreshold, notes };
}

// ── Per-player metrics extraction (for the advanced-stats sync) ──────────
// Produces per-player COUNTING stats for ONE game from our team's side, so
// they aggregate cleanly across games (averages are derived at query time).

export interface PlayerGameMetrics {
  playerId: string;
  name: string;
  position: number | null; // 1-9 standard scorekeeping number from the replay
  // batting
  pa: number;
  ab: number;
  hits: number;
  doubles: number;
  triples: number;
  hr: number;
  k: number;
  bb: number;
  bip: number; // balls in play (fair)
  evSum: number;
  evCount: number;
  evMax: number;
  sweetSpot: number; // launch angle 8–32° (threshold-free "good contact")
  // Σ expected wOBA-on-contact (from EV×launch-angle, see expectedOutcome.ts)
  // over balls in play. /bip = xwOBAcon — the hitter's deserved contact quality,
  // stripped of defense/luck. Compare to actual wOBAcon for a luck read.
  xwobaConSum: number;
  ground: number;
  line: number;
  fly: number;
  popup: number;
  swings: number;
  whiffs: number;
  chases: number;
  pitchesSeen: number;
  // fielding
  putouts: number;
  assists: number;
  fieldErrors: number; // fielder.miss
  chances: number; // batted balls fielded + missed
  closePlays: number; // difficult plays converted
  rangeSum: number; // distance covered start→catch on batted balls
  rangeCount: number;
  throwSpeedSum: number;
  throwSpeedCount: number;
  throwSpeedMax: number;
  releaseSum: number;
  releaseCount: number;
  // range-calibrated outs (see expectedOut): sum of P(out|distance) over the
  // fielder's batted-ball engagements, and how many actually became outs.
  expectedOuts: number;
  engagedOuts: number;
  // Σ P(1−P) over engagements — "skill leverage": how many outs are genuinely
  // in doubt (vs routine/hopeless) at this position. Drives position importance.
  leverageSum: number;
  // Bases-saved (OF extra-base suppression): on balls an outfielder RETRIEVES —
  // ground balls that already landed for a hit, which are NOT out chances and are
  // EXCLUDED from chances/PAE/leverage above — the bases prevented vs the
  // trajectory's expected bases (expectedOutcome.ts). Positive = held the hit
  // shorter than a typical fielder would. The OF value axis PAE can't see.
  basesSavedSum: number;
  basesSavedOpps: number;
  // catcher steal defense (opponent steal attempts faced + how many were caught)
  stealAttempts: number;
  caughtStealing: number;
  // Double-play participation (descriptive). `dpInvolved` = distinct DPs this
  // fielder took part in (any role); the three role tallies break that down and
  // are NOT mutually exclusive (a 3-6-3 starter is also the finisher), so they
  // can sum to more than dpInvolved. These are tags layered on the putouts/
  // assists already counted — not new outs. Detected from the `double_play`
  // outcome label + the ordered fielding chain.
  dpInvolved: number;
  dpStarted: number; // fielded the ball that began the DP (the feed)
  dpTurned: number; // recorded an out then relayed onward (the pivot)
  dpFinished: number; // recorded the final out of the DP
  // DP opportunities (denominator for DP-turn rate): an infield grounder fielded
  // by this player with a runner on 1st and < 2 outs. dpStarted/dpOpp = how often
  // a real DP chance was converted into a started DP.
  dpOpp: number;
  // Count of nearest-fielder range charges (see unreachedDists below).
  unreached: number;
  // ── 2026-07-09 data-audit additions (all counting stats; see docs/data-audit) ──
  // Close-play margins from runner.out/safe arrival times (seconds), stored as
  // runnerArrival − throwArrival ("beat"): POSITIVE = the throw arrived first.
  // (Verified corpus-wide: outs are 100% throw-first under this convention.)
  // throwMargin: credited to the THROWER on our defensive outs (assistedBy, else
  // the putout fielder). runMargin: our RUNNERS on outs + steal-safes —
  // NEGATIVE = the runner beat the throw (faster is better); return_pitch /
  // advance safes are excluded (not races).
  throwMarginSum: number;
  throwMarginCount: number;
  runMarginSum: number;
  runMarginCount: number;
  // Exchange quality on our throws: releaseBand categorial + bobbles.
  releaseGreat: number;
  releaseSlow: number;
  releaseBanded: number; // throws that carried a releaseBand at all
  bobbles: number;
  // Baserunning: steal-jump quality + leadoff size for OUR runners.
  jumpGreat: number;
  jumpSlow: number;
  jumpTotal: number;
  leadoffSum: number; // Σ leadoffDistancePercent
  leadoffCount: number;
  // Pitch-velocity exposure as a BATTER (mph-like sim units; Extinguisher scales
  // with mph over 85): Σv, count, and Σmax(0, v−85) over pitches seen.
  veloFacedSum: number;
  veloFacedCount: number;
  veloOver85Sum: number;
  // Query-time transients (never stored): range-aware expected/actual outs from
  // the combined engaged+unreached fit — see applyRangeCurve in the metrics route.
  rangeXOuts?: number;
  rangeEngagedOuts?: number;
  // Raw per-engaged-chance records: distance covered (`d`) + whether it was an
  // out (`o`), plus the integer field coordinates of the engagement (`x`,`y`,
  // quantized — origin = home plate, +x = RF side, −y = deeper). `d`/`o` let the
  // out-curve be re-fit and expectedOuts/PAE recomputed at QUERY time from the
  // visible set; `x`/`y` feed the fielded-ball heat map. Optional: rows synced
  // before a field existed fall back to stored values / are skipped until
  // re-synced (x/y were added after d/o).
  engageDists?: { d: number; o: boolean; x?: number; y?: number }[];
  // Nearest-fielder range charges (2026-07-08): opponent hits that fell with NO
  // fielder engaging them as an out chance, charged to the nearest range player
  // (positions 3–9; P/C excluded — P has no range role, C fields no batted
  // balls) at dist(start coords → spray landing point). Combined with
  // engageDists at query time to fit a range-aware out-curve: rPAE charges for
  // balls a fielder never reached, which plain PAE structurally cannot see.
  // Spray landing uses the categorical-depth mapping (sprayPoint), so distances
  // are approximate but unbiased across players.
  unreachedDists?: { d: number }[];
  // Opponent batted-ball SPRAY faced this game (a true "where it was hit" set,
  // including balls that got through — derived from batter.contact angle+depth,
  // not from where a fielder caught it). Team-level, so stored ONLY on our
  // pitcher's row to avoid duplication. `o` = we recorded the out (vs a hit).
  oppSpray?: { x: number; y: number; o: boolean }[];
  // Per-talent triggering this game (batting/fielding/zone only — pitch arsenal
  // excluded). Keyed by displayName. acts = triggers; effects = effect.applied
  // count; maxTier = talent LEVEL (static, not stacking). firedSwings/firedContact
  // = for batting talents that fire pre-swing, swings on which the talent fired
  // and how many made contact (so we can show "fired N×, contact X%"). Aggregated
  // for the cross-game talent overview.
  talentActs?: Record<string, { acts: number; effects: number; stacked: number; maxTier: number; firedSwings: number; firedContact: number; activeSwings?: number; activeContact?: number }>;
  // Pitch-zone mix faced as a batter: cell "1"–"9" (3×3 grid; numbering scheme
  // not yet decoded — treat as opaque ids) and "10" = out of the zone.
  zonesSeen?: Record<string, number>;
}

// Batted-ball spray geometry. `horizontalAngle` is a bearing where ≈ −90° is
// straight to CF; −139 → left-field line, −38 → right-field line. `hitDepth` is
// a categorical radial distance. Together they place the ball where it was HIT
// (independent of fielding), so we can chart balls that got through too.
const SPRAY_DEPTH_RADIUS: Record<string, number> = {
  shortInfield: 12, infield: 24, shortOutfield: 48,
  outfield: 64, warningTrack: 82, wall: 92, homerun: 100,
};
function sprayPoint(horizontalAngle: unknown, hitDepth: unknown): { x: number; y: number } | null {
  if (typeof horizontalAngle !== 'number' || typeof hitDepth !== 'string') return null;
  const r = SPRAY_DEPTH_RADIUS[hitDepth];
  if (r == null) return null;
  const theta = ((horizontalAngle + 90) * Math.PI) / 180; // 0 = straight CF
  if (Math.abs(theta) > (55 * Math.PI) / 180) return null; // foul territory guard
  return { x: Math.round(r * Math.sin(theta)), y: Math.round(-r * Math.cos(theta)) };
}

// Precise landing point from ball.flight (horizontalAngle + landingDistance) —
// same bearing convention and coordinate scale as sprayPoint (verified against
// the categorical radii: median ratio 0.91 over 842 balls). Preferred over
// sprayPoint when available; falls back for old-format replays.
function flightPoint(horizontalAngle: unknown, landingDistance: unknown): { x: number; y: number } | null {
  if (typeof horizontalAngle !== 'number' || typeof landingDistance !== 'number' || landingDistance <= 0) return null;
  const theta = ((horizontalAngle + 90) * Math.PI) / 180;
  if (Math.abs(theta) > (55 * Math.PI) / 180) return null;
  return { x: Math.round(landingDistance * Math.sin(theta)), y: Math.round(-landingDistance * Math.cos(theta)) };
}

// Empirical out-conversion probability given how far a fielder had to travel to
// the ball. PER-POSITION logistic, fit from replay data (~9 games, 60–130
// chances/pos). The shape matters as much as the midpoint: a steep curve (2B,
// a≈1.0) means binary routine plays = low skill leverage; a gentle curve (SS,
// CF) means many in-doubt plays = high leverage. Distances are sim coord units.
// Re-fit by logistic regression of out-vs-distance on ~32 games (was ~9), foul
// fetches excluded. Bucketed out-rates (out% at <6 / 6–12 / >12 dist units):
// infielders convert ~95–100% in close — only the long tail is in doubt, so
// their leverage is small and lives at distance; outfielders fall ~100%→8%
// across the 6–12 band where most OF balls land, so OF carries the real
// leverage. The old steep 2B curve (a=1.0) was a small-sample artifact; at this
// sample SS and 2B share nearly identical profiles.
// RE-FIT 2026-07-08 after the July patch's fielding buff (31 post-patch
// re-sims, ~340 chances). The rebalance changed the landscape: outfielders now
// convert ~100% of ENGAGED chances (71/71 across LF/CF/RF — no variance, so a
// logistic can't even be fit there; OF gets a near-1 plateau). Infielders sit
// at 93–99%. Consequence: engaged-chance leverage is small EVERYWHERE now —
// remaining OF skill differences live in balls never reached (range), which
// PAE can't see but post-patch spray data can (future nearest-fielder work).
// P (1) and C (2) are not fit — the pitcher rarely fields batted balls and the
// catcher fields none (steal defense is handled separately).
const POS_CURVE: Record<number, { a: number; d50: number }> = {
  1: { a: 0.35, d50: 12 }, // P  (not fit; rare, IF-ish fallback)
  2: { a: 0.35, d50: 10 }, // C  (not fit; no batted balls, steal D handled separately)
  3: { a: 0.11, d50: 26 },   // 1B — ~95% flat
  4: { a: 0.76, d50: 17.5 }, // 2B — ~99%, long-tail only
  5: { a: 0.44, d50: 14.3 }, // 3B
  6: { a: 0.39, d50: 16 },   // SS
  7: { a: 0.15, d50: 40 },   // LF — 100% observed; near-1 plateau (14 chances)
  8: { a: 0.15, d50: 40 },   // CF — 100% observed; near-1 plateau (38 chances)
  9: { a: 0.15, d50: 40 },   // RF — 100% observed; near-1 plateau (19 chances)
};
const DEFAULT_CURVE = { a: 0.35, d50: 11 };

export function expectedOut(distance: number, position: number | null): number {
  const c = (position != null && POS_CURVE[position]) || DEFAULT_CURVE;
  return 1 / (1 + Math.exp(c.a * (distance - c.d50)));
}

// Each steal attempt against the catcher is an in-doubt play (catcher arm/skill
// swings the out), so it contributes a fixed leverage like a coin-flip chance.
export const STEAL_LEVERAGE = 0.22;

export interface GameMetrics {
  ourSide: 'home' | 'away';
  matched: boolean;
  completedAt: string | null;
  players: PlayerGameMetrics[];
}

// One player's fielding split at a SINGLE position, across the games they
// played there. Lets us answer "what's this player's best position?" instead
// of pooling every position into one (position-mixed) line. PAE is position-
// relative by construction (each position's out-curve is fit so an average
// fielder ≈ 0), so paePerGame is comparable across a player's own splits —
// roughly. Caveats: PAE only scores balls ENGAGED (never charges for range a
// fielder lacks), and small per-position samples are noisy.
export interface PlayerPositionSplit {
  position: number; // 1-9 scorekeeping number
  games: number;
  chances: number;
  putouts: number;
  assists: number;
  plays: number;
  fieldErrors: number;
  fieldPct: number | null;
  pae: number; // total plays above expected at this position
  paePerGame: number;
  expectedOuts: number;
  rangeAvg: number | null;
  armAvg: number | null;
  leverage: number; // Σ P(1−P) skill-leverage at this position
  closePlays: number;
  stealAttempts: number;
  caughtStealing: number;
  dp: number; // double plays involved in at this position
  dpOpp: number; // DP opportunities (IF grounder, R1, <2 outs) at this position
  // OF extra-base suppression at this position (bases held below expected).
  basesSaved: number;
  basesSavedOpps: number;
  // Range-aware PAE at this position (charges unreached nearest-fielder balls);
  // null until unreachedDists is backfilled by a re-sync.
  rangePae: number | null;
  rangePaePerGame: number | null;
  unreached: number;
}

// Per-player aggregate across multiple games (derived rates), returned by the
// advanced-stats query route and rendered by the panel.
export interface AggregatedPlayer {
  playerId: string;
  name: string;
  position: number | null; // most-played fielding position (the primary)
  games: number;
  // batting
  pa: number; ab: number; hits: number; hr: number; k: number; bb: number; bip: number;
  avg: number; obp: number; kRate: number; bbRate: number;
  avgEV: number | null; maxEV: number | null; sweetSpotRate: number | null;
  // expected wOBA-on-contact (trajectory-based "deserved" production) vs the
  // actual wOBA-on-contact; their gap is a luck/defense read.
  xwobaCon: number | null; wobaCon: number | null;
  bbMix: { ground: number; line: number; fly: number; popup: number };
  swings: number; whiffs: number; chases: number; whiffRate: number | null;
  // fielding
  putouts: number; assists: number; fieldErrors: number; chances: number; plays: number;
  closePlays: number; fieldPct: number | null;
  rangeAvg: number | null; armAvg: number | null; armMax: number | null; releaseAvg: number | null;
  // range-calibrated plays above expected (engagedOuts − expectedOuts)
  pae: number; expectedOuts: number;
  // RANGE-AWARE PAE: like pae but the out-curve is fit over engaged chances PLUS
  // unreached hits charged to the nearest fielder — so it debits balls a fielder
  // never got to, the blind spot of plain PAE. Mean ≈ 0 per position over the
  // visible set (same MLE calibration). null until a re-sync backfills
  // unreachedDists. `unreached` = balls charged (fell for hits, nobody engaged).
  rangePae: number | null; rangePaePerGame: number | null; unreached: number;
  // ── 2026-07-09 data-audit additions ──
  // Close-play margins (seconds, runnerArrival − throwArrival = "beat"):
  // throwMargin = avg beat on out-recording throws (positive; larger =
  // comfortable outs, near 0 = bang-bang — continuous arm signal); runMargin =
  // avg beat against our RUNNERS on races (negative = runner beat the throw —
  // speed signal).
  throwMargin: number | null; throwMarginN: number;
  runMargin: number | null; runMarginN: number;
  // Exchange quality: bobbled throws + share of banded throws released 'great'.
  bobbles: number; releaseGreatRate: number | null;
  // Baserunning: steal-jump quality counts + avg leadoff size (%).
  jumpGreat: number; jumpSlow: number; jumpTotal: number; leadoffAvg: number | null;
  // Pitch-velocity exposure as a batter (Extinguisher valuation): avg velo
  // faced + avg mph-over-85 per pitch seen.
  veloFacedAvg: number | null; over85PerPitch: number | null;
  // Pitch-zone mix faced (cells "1"–"9", "10" = out of zone; numbering opaque).
  zonesSeen: Record<string, number> | null;
  // OF extra-base suppression (bases held below expected) — the value axis PAE
  // can't see; total, per-game, and the opportunity count it's based on.
  basesSaved: number | null; basesSavedPerGame: number | null; basesSavedOpps: number;
  // catcher steal defense
  stealAttempts: number; caughtStealing: number; csRate: number | null;
  // double-play participation (descriptive), summed across games
  dp: number; dpStarted: number; dpTurned: number; dpFinished: number; dpOpp: number;
  // cross-game talent triggering (batting/fielding/zone; pitch arsenal excluded).
  // acts = total triggers; effects = effect applications (effects/acts > 1 ⇒
  // multiple effects per trigger); maxTier = talent LEVEL (not a stack); perGame
  // = acts/games. Empty until games are (re-)synced with talent data.
  talents: { name: string; acts: number; effects: number; stacked: number; maxTier: number; firedSwings: number; firedContact: number; activeSwings: number; activeContact: number; perGame: number }[];
  // per-position fielding splits (best-position breakdown), most-played first
  byPosition: PlayerPositionSplit[];
}

// Data-derived defensive importance of a position, from the synced games.
export interface PositionImportance {
  position: string;
  chances: number;
  games: number; // fielder-games manned at this position (chances/game denominator)
  chancesPerGame: number; // batted-ball chances engaged per game — workload signal
  xOuts: number;
  leverage: number;
  impVolume: number; // chances share, normalized to mean 1.0
  impXouts: number; // expected-outs share, normalized to mean 1.0
  impLeverage: number | null; // skill-leverage share (null until leverage data exists)
  // Recommended importance the optimizer actually uses: a blend of leverage
  // (skill sensitivity) and xOuts (workload), with the catcher floored to its
  // default (its leverage is steals-only, so it under-counts real C value).
  // Blending damps the small-sample volume noise + chances-taken bias that
  // otherwise deflates high-range spots like SS. Normalized to mean 1.0.
  impRecommended: number;
}

function emptyMetrics(playerId: string, name: string, position: number | null): PlayerGameMetrics {
  return {
    playerId, name, position,
    pa: 0, ab: 0, hits: 0, doubles: 0, triples: 0, hr: 0, k: 0, bb: 0, bip: 0,
    evSum: 0, evCount: 0, evMax: 0, sweetSpot: 0, xwobaConSum: 0, ground: 0, line: 0, fly: 0, popup: 0,
    swings: 0, whiffs: 0, chases: 0, pitchesSeen: 0,
    putouts: 0, assists: 0, fieldErrors: 0, chances: 0, closePlays: 0,
    rangeSum: 0, rangeCount: 0,
    throwSpeedSum: 0, throwSpeedCount: 0, throwSpeedMax: 0, releaseSum: 0, releaseCount: 0,
    expectedOuts: 0, engagedOuts: 0, leverageSum: 0, basesSavedSum: 0, basesSavedOpps: 0, stealAttempts: 0, caughtStealing: 0,
    dpInvolved: 0, dpStarted: 0, dpTurned: 0, dpFinished: 0, dpOpp: 0,
    unreached: 0,
    throwMarginSum: 0, throwMarginCount: 0, runMarginSum: 0, runMarginCount: 0,
    releaseGreat: 0, releaseSlow: 0, releaseBanded: 0, bobbles: 0,
    jumpGreat: 0, jumpSlow: 0, jumpTotal: 0, leadoffSum: 0, leadoffCount: 0,
    veloFacedSum: 0, veloFacedCount: 0, veloOver85Sum: 0,
    engageDists: [],
  };
}

// Logistic fit (IRLS) of out-vs-distance → curve form P = 1/(1+exp(a(d−d50))).
// Shared by the query-time dynamic fit and the offline scripts/fit-curves.ts.
// Returns null below minN or on a degenerate fit (out-rate must fall with dist).
export function fitOutCurve(data: { d: number; o: boolean }[], minN = 40): { a: number; d50: number } | null {
  if (data.length < minN) return null;
  let b0 = 0, b1 = 0; // logit = b0 + b1·d
  for (let it = 0; it < 100; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (const { d, o } of data) {
      const p = 1 / (1 + Math.exp(-(b0 + b1 * d)));
      const w = Math.max(p * (1 - p), 1e-6);
      const r = (o ? 1 : 0) - p;
      g0 += r; g1 += r * d; h00 += w; h01 += w * d; h11 += w * d * d;
    }
    h00 += 1e-3; h11 += 1e-3; // ridge for near-separable infield
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-9) break;
    const s0 = (h11 * g0 - h01 * g1) / det;
    const s1 = (-h01 * g0 + h00 * g1) / det;
    b0 += s0; b1 += s1;
    if (Math.abs(s0) + Math.abs(s1) < 1e-8) break;
  }
  if (!(b1 < 0)) return null;
  return { a: Math.min(1.5, Math.max(0.05, -b1)), d50: Math.min(26, Math.max(4, -b0 / b1)) };
}

// expectedOut for an explicitly-supplied curve (the dynamic, query-time fit).
export function curveOut(c: { a: number; d50: number }, distance: number): number {
  return 1 / (1 + Math.exp(c.a * (distance - c.d50)));
}

const MOUND_BASE = 5; // fielder.throw targetBase used for returns to the pitcher
const OUTFIELD = new Set([7, 8, 9]); // LF/CF/RF scorekeeping numbers
const DP_STARTER = new Set([1, 3, 4, 5, 6]); // P/1B/2B/3B/SS — can start a double play
const RESULT_BASES: Record<string, number> = { single: 1, double: 2, triple: 3, homerun: 4 };

export function extractPlayerMetrics(raw: any, ourTeamId?: string): GameMetrics {
  const game = raw?.game ?? {};
  const home = game.home ?? {};
  const away = game.away ?? {};

  const playerById = new Map<string, { name: string; side: 'home' | 'away'; position: number | null; coord?: { x: number; y: number } }>();
  const talentNames = new Map<string, string>(); // talentId -> displayName
  for (const side of ['home', 'away'] as const) {
    const t = side === 'home' ? home : away;
    for (const p of t.players ?? []) {
      const name = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || p.id;
      playerById.set(p.id, { name, side, position: typeof p.position === 'number' ? p.position : null, coord: p.coordinates });
      for (const tal of p.talents ?? []) if (tal?.id) talentNames.set(tal.id, tal.displayName ?? tal.id);
    }
  }
  // Record a talent trigger / effect for one of our players (pitch arsenal excluded).
  const talentEntry = (ownerId: string, talentId: string) => {
    if (!isOurs(ownerId) || PITCH_TYPE_IDS.has(talentId) || isPitchSubId(talentId)) return null;
    const r = row(ownerId);
    const acc = (r.talentActs ??= {});
    const name = talentNames.get(talentId) ?? talentId;
    return (acc[name] ??= { acts: 0, effects: 0, stacked: 0, maxTier: 0, firedSwings: 0, firedContact: 0 });
  };
  const noteTalent = (ownerId: string, talentId: string, kind: 'act' | 'effect', tier = 0) => {
    const e = talentEntry(ownerId, talentId);
    if (!e) return;
    if (kind === 'act') e.acts++;
    else { e.effects++; if (tier >= 2) e.stacked++; if (tier > e.maxTier) e.maxTier = tier; }
  };
  // A batter-talent fired on a swing — record the swing + whether it made contact,
  // so we can show "fired N×, contact X%" (the observable effect of contact talents).
  // A talent was ACTIVE (per segment.activeEffects) on a swing — the buff-state
  // view: unlike noteFired it also counts carried-over effects still running,
  // so "contact% while buffed" is measured against the full active window.
  const noteActive = (ownerId: string, talentId: string, madeContact: boolean) => {
    const e = talentEntry(ownerId, talentId);
    if (!e) return;
    e.activeSwings = (e.activeSwings ?? 0) + 1;
    if (madeContact) e.activeContact = (e.activeContact ?? 0) + 1;
  };
  const noteFired = (ownerId: string, talentId: string, madeContact: boolean) => {
    const e = talentEntry(ownerId, talentId);
    if (!e) return;
    e.firedSwings++;
    if (madeContact) e.firedContact++;
  };

  const matched = ourTeamId === home.id || ourTeamId === away.id;
  const ourSide: 'home' | 'away' = away.id === ourTeamId ? 'away' : 'home';
  const isOurs = (id?: string) => !!id && playerById.get(id)?.side === ourSide;
  // Our starting catcher (position 2) — credited with steal defense; and our
  // pitcher (position 1) — carries the team-level opponent spray.
  let ourCatcherId: string | undefined;
  let ourPitcherId: string | undefined;
  for (const [id, info] of playerById) {
    if (info.side !== ourSide) continue;
    if (info.position === 2 && !ourCatcherId) ourCatcherId = id;
    if (info.position === 1 && !ourPitcherId) ourPitcherId = id;
  }
  const oppSpray: { x: number; y: number; o: boolean }[] = [];
  let lastOppContact: { ha: unknown; depth: unknown } | undefined;
  // Precise landing geometry from ball.flight (same coordinate scale as player
  // coords — verified median ratio 0.91 vs the categorical depth radii). Used
  // in preference to the categorical sprayPoint when present.
  let lastOppFlight: { ha: unknown; dist: unknown } | undefined;

  const rows = new Map<string, PlayerGameMetrics>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) {
      const p = playerById.get(id);
      r = emptyMetrics(id, p?.name ?? id, p?.position ?? null);
      rows.set(id, r);
    }
    return r;
  };

  let curAB: number | undefined;
  let abR1 = false; // runner on 1st at the start of the current at-bat
  let abOuts = 0; // outs at the start of the current at-bat (for DP opportunities)
  let lastContact: { ev?: number; la?: number } | undefined;
  let throwBuf: { throwerId: string; targetOut: string | null; base: number }[] = [];
  // Per-at-bat fielding state for the range-calibrated expected-outs metric.
  const engageBuf = new Map<string, { dist: number; pos: number | null; x?: number; y?: number }>();
  // Outfield ground-ball RETRIEVALS this at-bat — balls that already landed for a
  // hit (0% out potential), so they're NOT out chances. Credited to bases-saved
  // (extra-base suppression) when the at-bat's result lands. See dead-touch notes.
  const retrievalBuf: { fid: string; ev?: number; la?: number }[] = [];
  const outCredit = new Set<string>(); // fielders who recorded a PO/A this at-bat
  const stealRunners = new Set<string>(); // opponent runners who attempted a steal
  const outRunners = new Set<string>(); // runners retired this at-bat

  const flushFielding = () => {
    for (const [fid, e] of engageBuf) {
      const r = row(fid);
      const p = expectedOut(e.dist, e.pos);
      r.expectedOuts += p;
      r.leverageSum += p * (1 - p);
      const isOut = outCredit.has(fid);
      if (isOut) r.engagedOuts++;
      const pt: { d: number; o: boolean; x?: number; y?: number } = { d: e.dist, o: isOut };
      if (typeof e.x === 'number' && typeof e.y === 'number') {
        pt.x = Math.round(e.x); // quantize to integer field units — sub-unit is noise
        pt.y = Math.round(e.y);
      }
      (r.engageDists ??= []).push(pt);
    }
    // Catcher steal defense: each opponent steal attempt is an in-doubt play.
    if (ourCatcherId && stealRunners.size > 0) {
      const c = row(ourCatcherId);
      for (const runner of stealRunners) {
        c.stealAttempts++;
        c.leverageSum += STEAL_LEVERAGE;
        if (outRunners.has(runner)) c.caughtStealing++;
      }
    }
    engageBuf.clear();
    retrievalBuf.length = 0;
    outCredit.clear();
    stealRunners.clear();
    outRunners.clear();
  };

  for (const seg of raw?.segments ?? []) {
    const md = seg.metadata ?? {};
    const abId: number | undefined = md.atBatId ?? undefined;
    const batterId: string | undefined = md.batterId ?? undefined;
    const batterSide = batterId ? playerById.get(batterId)?.side : undefined;

    if (abId != null && abId !== curAB) {
      flushFielding();
      curAB = abId;
      // Capture the base-out state entering this at-bat (first segment's
      // gameState is pre-PA) for DP-opportunity detection.
      const gs0 = seg.gameState;
      abR1 = !!gs0?.runners?.[0];
      abOuts = typeof gs0?.outs === 'number' ? gs0.outs : 0;
      lastContact = undefined;
      lastOppContact = undefined;
      lastOppFlight = undefined;
      throwBuf = [];
    }

    let sawPitch = false;
    let segPitch: { velocity?: unknown; pitchZone?: unknown } | undefined;
    // A foul-ball pitch where the corner fielder merely retrieves a dead ball
    // is NOT a fielding chance. We detect the foul context per pitch-segment and
    // skip the chance accounting unless an out is actually recorded (a caught
    // foul pop-out), so 1B/3B/LF don't get polluted by foul grounders.
    let segIsFoul = false;
    let segHasOut = false;
    for (const ev of seg.events ?? []) {
      if (ev.type === 'pitch.thrown') { sawPitch = true; segPitch = ev.payload; }
      else if (ev.type === 'batter.foul') segIsFoul = true;
      else if (ev.type === 'pitch.result' && ev.payload?.outcome === 'foul') segIsFoul = true;
      else if (ev.type === 'runner.out') segHasOut = true;
    }
    const skipFoulFetch = segIsFoul && !segHasOut;
    if (sawPitch && batterId && batterSide === ourSide) {
      const r = row(batterId);
      r.pitchesSeen++;
      // Velocity exposure (Extinguisher scales with mph over 85) + zone mix.
      const v = segPitch?.velocity;
      if (typeof v === 'number') {
        r.veloFacedSum += v;
        r.veloFacedCount++;
        if (v > 85) r.veloOver85Sum += v - 85;
      }
      const z = segPitch?.pitchZone;
      if (z != null) {
        const zs = (r.zonesSeen ??= {});
        zs[String(z)] = (zs[String(z)] ?? 0) + 1;
      }
    }

    // Batter talents that fired this pitch (pre-swing) — credited with the swing
    // outcome below, so contact talents show "fired N×, contact X%".
    const segFired: string[] = [];
    // Talents ACTIVE on the batter this segment (from segment.activeEffects —
    // includes carried-over durations the fired-this-segment view misses).
    const segActiveTalents: string[] = [];
    if (batterId && Array.isArray(seg.activeEffects)) {
      const seen = new Set<string>();
      for (const ae of seg.activeEffects) {
        if (ae?.targetEntityId === batterId && ae?.source === 'talent' && ae?.talentId && !seen.has(ae.talentId)) {
          seen.add(ae.talentId);
          segActiveTalents.push(ae.talentId);
        }
      }
    }
    // Post-patch effect.activated dedup (see evaluateReplay).
    const segActivated = new Set<string>();
    for (const ev of seg.events ?? []) {
      const pl = ev.payload ?? {};
      switch (ev.type) {
        case 'talent.activated': {
          // Pre-2026-07-08 format (compat).
          if (pl.ownerId && pl.talentId) {
            noteTalent(pl.ownerId, pl.talentId, 'act');
            if (pl.ownerId === batterId) segFired.push(pl.talentId);
          }
          break;
        }
        case 'effect.applied': {
          // Pre-2026-07-08 format (compat).
          if (pl.ownerId && pl.talentId && typeof pl.tier === 'number') noteTalent(pl.ownerId, pl.talentId, 'effect', pl.tier);
          break;
        }
        case 'effect.activated': {
          // 2026-07-08 patch: merged talent event; owner is targetEntityId,
          // source filters out weather ('wet') and affliction effects. First
          // effect of a (player,talent) per segment = the activation.
          if (pl.source !== 'talent') break;
          const owner: string | undefined = pl.targetEntityId;
          if (owner && pl.talentId) {
            const key = `${owner}|${pl.talentId}`;
            if (!segActivated.has(key)) {
              segActivated.add(key);
              noteTalent(owner, pl.talentId, 'act');
              if (owner === batterId) segFired.push(pl.talentId);
            }
            noteTalent(owner, pl.talentId, 'effect', typeof pl.tier === 'number' ? pl.tier : undefined);
          }
          break;
        }
        case 'batter.action': {
          if (pl.action === 'swing' && batterId && batterSide === ourSide) {
            const r = row(batterId);
            r.swings++;
            if (!pl.madeContact) r.whiffs++;
            // Credit each talent that fired pre-swing with this swing's outcome.
            for (const tid of segFired) noteFired(batterId, tid, !!pl.madeContact);
            // And each talent ACTIVE during the swing (buff-state view).
            for (const tid of segActiveTalents) noteActive(batterId, tid, !!pl.madeContact);
          }
          break;
        }
        case 'pitch.result': {
          if (pl.action === 'swing' && pl.inZone === false && batterId && batterSide === ourSide) {
            row(batterId).chases++;
          }
          break;
        }
        case 'batter.contact': {
          lastContact = { ev: pl.exitVelocity, la: pl.launchAngle };
          // Opponent contact → buffer its spray geometry for when the at-bat
          // outcome lands (skip fouls; those aren't balls in play).
          if (batterSide && batterSide !== ourSide && !/^Foul/.test(pl.hitDirection ?? '')) {
            lastOppContact = { ha: pl.horizontalAngle, depth: pl.hitDepth };
            lastOppFlight = undefined; // reset until this ball's flight arrives
          }
          break;
        }
        case 'ball.flight': {
          if (batterSide && batterSide !== ourSide) {
            lastOppFlight = { ha: pl.horizontalAngle, dist: pl.landingDistance };
          }
          break;
        }
        case 'batter.result': {
          if (batterId && batterSide === ourSide) {
            const r = row(batterId);
            const result = pl.result ?? 'unknown';
            r.pa++;
            if (result === 'walk') r.bb++;
            else r.ab++;
            if (result === 'strikeout') r.k++;
            if (HIT_RESULTS.has(result)) {
              r.hits++;
              if (result === 'double') r.doubles++;
              else if (result === 'triple') r.triples++;
              else if (result === 'homerun') r.hr++;
            }
            if (result !== 'walk' && result !== 'strikeout' && lastContact?.ev != null) {
              r.bip++;
              r.evSum += lastContact.ev;
              r.evCount++;
              if (lastContact.ev > r.evMax) r.evMax = lastContact.ev;
              if (typeof lastContact.la === 'number') {
                r[bbBucket(lastContact.la)]++;
                if (lastContact.la >= 8 && lastContact.la <= 32) r.sweetSpot++;
                r.xwobaConSum += expectedWobaCon(lastContact.ev, lastContact.la);
              }
            }
          }
          // Opponent batted ball → record its spray point + whether we got the out.
          // Prefer the precise ball.flight landing (same coordinate scale,
          // verified) over the categorical-depth approximation.
          if (batterSide && batterSide !== ourSide && (lastOppFlight || lastOppContact)) {
            const pt = (lastOppFlight ? flightPoint(lastOppFlight.ha, lastOppFlight.dist) : null)
              ?? (lastOppContact ? sprayPoint(lastOppContact.ha, lastOppContact.depth) : null);
            if (pt) {
              oppSpray.push({ x: pt.x, y: pt.y, o: !HIT_RESULTS.has(pl.result ?? '') });
              // Nearest-fielder range charge: the ball fell for a hit and NO
              // fielder engaged it as an out chance (engageBuf empty — an
              // engaged miss/infield single is already an o:false chance for
              // that fielder; an OF pickup of a landed hit is a retrieval, not
              // an engagement). HRs clear the wall — nobody could reach them.
              const result = pl.result ?? '';
              if (HIT_RESULTS.has(result) && result !== 'homerun' && engageBuf.size === 0) {
                let best: { id: string; d: number } | null = null;
                for (const [pid, info] of playerById) {
                  if (info.side !== ourSide || info.position == null || info.position < 3 || !info.coord) continue;
                  const d = Math.hypot(pt.x - info.coord.x, pt.y - info.coord.y);
                  if (!best || d < best.d) best = { id: pid, d };
                }
                if (best) {
                  const r = row(best.id);
                  r.unreached++;
                  (r.unreachedDists ??= []).push({ d: Math.round(best.d * 10) / 10 });
                }
              }
            }
          }
          // Bases-saved: credit each OF retrieval for holding the hit below its
          // trajectory's expected bases (positive = suppressed extra bases).
          if (batterSide && batterSide !== ourSide && retrievalBuf.length) {
            const actualBases = RESULT_BASES[pl.result ?? ''] ?? 0;
            for (const rt of retrievalBuf) {
              if (typeof rt.ev !== 'number' || typeof rt.la !== 'number') continue;
              const r = row(rt.fid);
              r.basesSavedSum += expectedBases(rt.ev, rt.la) - actualBases;
              r.basesSavedOpps++;
            }
            retrievalBuf.length = 0;
          }
          lastContact = undefined;
          lastOppContact = undefined;
          lastOppFlight = undefined;
          break;
        }
        case 'fielder.catch': {
          if (skipFoulFetch) break; // dead foul-ball retrieval, not a real chance
          if (isOurs(pl.fielderId) && (pl.catchType === 'ground' || pl.catchType === 'fly')) {
            const info = playerById.get(pl.fielderId);
            // Outfield ground ball = a hit already on the ground being retrieved,
            // not an out chance (replay: ~0% become outs). Route to bases-saved
            // instead of polluting chances/PAE/range with a non-opportunity.
            if (info && OUTFIELD.has(info.position ?? 0) && pl.catchType === 'ground') {
              retrievalBuf.push({ fid: pl.fielderId, ev: lastContact?.ev, la: lastContact?.la });
              break;
            }
            const r = row(pl.fielderId);
            r.chances++;
            // DP opportunity: an infield grounder fielded with R1 and < 2 outs.
            if (pl.catchType === 'ground' && DP_STARTER.has(info?.position ?? 0) && abR1 && abOuts < 2) r.dpOpp++;
            const start = info?.coord;
            const cp = pl.catchPoint;
            if (start && cp && typeof cp.x === 'number' && typeof cp.y === 'number') {
              const dist = Math.hypot(cp.x - start.x, cp.y - start.y);
              r.rangeSum += dist;
              r.rangeCount++;
              engageBuf.set(pl.fielderId, { dist, pos: info?.position ?? null, x: cp.x, y: cp.y });
            }
          }
          break;
        }
        case 'fielder.miss': {
          if (skipFoulFetch) break; // dropped foul ball isn't a fielding chance
          if (isOurs(pl.fielderId)) {
            const info = playerById.get(pl.fielderId);
            const r = row(pl.fielderId);
            r.fieldErrors++; // every miss is an error (reconciles with the box score)
            // A muffed outfield grounder is still a retrieval (the ball was a hit),
            // not a missed out chance — keep it out of chances/PAE.
            if (info && OUTFIELD.has(info.position ?? 0) && pl.isGroundBall === true) {
              retrievalBuf.push({ fid: pl.fielderId, ev: lastContact?.ev, la: lastContact?.la });
              break;
            }
            r.chances++;
            const start = info?.coord;
            const cp = pl.catchPoint;
            if (start && cp && typeof cp.x === 'number' && typeof cp.y === 'number') {
              engageBuf.set(pl.fielderId, { dist: Math.hypot(cp.x - start.x, cp.y - start.y), pos: info?.position ?? null, x: cp.x, y: cp.y });
            }
          }
          break;
        }
        case 'fielder.throw': {
          const base = pl.targetBase;
          if (isOurs(pl.throwerId) && base !== MOUND_BASE) {
            const r = row(pl.throwerId);
            if (typeof pl.ballSpeed === 'number') {
              r.throwSpeedSum += pl.ballSpeed;
              r.throwSpeedCount++;
              if (pl.ballSpeed > r.throwSpeedMax) r.throwSpeedMax = pl.ballSpeed;
            }
            if (typeof pl.releaseTime === 'number') {
              r.releaseSum += pl.releaseTime;
              r.releaseCount++;
            }
            // Exchange quality: categorical release band + bobbles (2026-07-09).
            if (typeof pl.releaseBand === 'string') {
              r.releaseBanded++;
              if (pl.releaseBand === 'great') r.releaseGreat++;
              else if (pl.releaseBand === 'slow') r.releaseSlow++;
            }
            if (pl.bobbled === true) r.bobbles++;
            throwBuf.push({ throwerId: pl.throwerId, targetOut: pl.targetOut ?? null, base });
          } else if (base !== MOUND_BASE && pl.throwerId) {
            // still buffer (for assist linking even if thrower not ours — harmless)
            throwBuf.push({ throwerId: pl.throwerId, targetOut: pl.targetOut ?? null, base });
          }
          break;
        }
        case 'runner.steal':
        case 'runner.stolen_base': {
          // An opponent steal attempt (we're fielding → our catcher defends).
          if (pl.runnerId && batterSide && batterSide !== ourSide) stealRunners.add(pl.runnerId);
          // OUR runner attempting a steal → jump quality (2026-07-09).
          if (pl.runnerId && isOurs(pl.runnerId)) {
            const r = row(pl.runnerId);
            r.jumpTotal++;
            if (pl.jumpQuality === 'great') r.jumpGreat++;
            else if (pl.jumpQuality === 'slow') r.jumpSlow++;
          }
          break;
        }
        case 'runner.leadoff': {
          // Leadoff size per pitch for OUR runners (2026-07-09).
          if (pl.runnerId && isOurs(pl.runnerId) && typeof pl.leadoffDistancePercent === 'number') {
            const r = row(pl.runnerId);
            r.leadoffSum += pl.leadoffDistancePercent;
            r.leadoffCount++;
          }
          break;
        }
        case 'runner.safe': {
          // Close-play margin for OUR runner on a genuine race (steals only —
          // return_pitch/advance safes aren't races): runnerArrival − throwArrival,
          // negative = beat the throw. Out-side margins are in runner.out below.
          if (pl.reason === 'steal' && pl.runnerId && isOurs(pl.runnerId) && typeof pl.throwArrivalTime === 'number' && typeof pl.runnerArrivalTime === 'number') {
            const r = row(pl.runnerId);
            r.runMarginSum += pl.runnerArrivalTime - pl.throwArrivalTime;
            r.runMarginCount++;
          }
          break;
        }
        case 'runner.out': {
          const fielderId = pl.fielderId;
          if (pl.runnerId) outRunners.add(pl.runnerId);
          // Close-play margins from arrival times (2026-07-09; absent on
          // strikeouts). Stored as runnerArrival − throwArrival ("beat", positive
          // = throw first — always the case on outs). Defensive credit goes to
          // the THROWER; runner credit measures pure speed (lower = faster).
          if (pl.outType !== 'strikeout' && typeof pl.throwArrivalTime === 'number' && typeof pl.runnerArrivalTime === 'number') {
            const beat = pl.runnerArrivalTime - pl.throwArrivalTime;
            if (pl.runnerId && isOurs(pl.runnerId)) {
              const r = row(pl.runnerId);
              r.runMarginSum += beat;
              r.runMarginCount++;
            }
            if (isOurs(fielderId)) {
              const thrower = typeof pl.assistedBy === 'string' && isOurs(pl.assistedBy) && pl.assistedBy !== fielderId ? pl.assistedBy : fielderId;
              const t = row(thrower);
              t.throwMarginSum += beat;
              t.throwMarginCount++;
            }
          }
          if (isOurs(fielderId)) {
            const r = row(fielderId);
            r.putouts++;
            outCredit.add(fielderId);
            if (pl.closePlay) r.closePlays++;
            if (typeof pl.assistedBy === 'string') {
              // 2026-07-08 patch: direct assist attribution on the out event.
              if (pl.assistedBy !== fielderId && isOurs(pl.assistedBy)) {
                row(pl.assistedBy).assists++;
                outCredit.add(pl.assistedBy);
              }
            } else {
              // Old format fallback: a different fielder whose throw targeted this out.
              const credited = new Set<string>();
              for (const th of throwBuf) {
                if (th.targetOut && th.targetOut === pl.runnerId && th.throwerId !== fielderId && isOurs(th.throwerId)) {
                  if (!credited.has(th.throwerId)) {
                    row(th.throwerId).assists++;
                    outCredit.add(th.throwerId);
                    credited.add(th.throwerId);
                  }
                }
              }
            }
          }
          break;
        }
      }
    }

    // Double-play participation: if this play was labeled a DP, credit our
    // fielders by role from the ordered fielding chain. Roles aren't exclusive
    // (a 3-6-3 starter is also the finisher). Descriptive tags only — the outs
    // themselves are already counted as putouts/assists above.
    const evs = seg.events ?? [];
    const isDP = evs.some((e: { type?: string; payload?: { result?: string } }) =>
      e.type === 'batter.result' && e.payload?.result === 'double_play');
    if (isDP) {
      let starter: string | undefined; // first fielder to field the ball
      const outs: { fid: string; i: number }[] = [];
      const throwsBy = new Map<string, number[]>(); // fielderId → throw event indices
      evs.forEach((e: { type?: string; payload?: Record<string, unknown> }, i: number) => {
        const p = e.payload ?? {};
        if (e.type === 'fielder.catch' && !starter && (p.catchType === 'ground' || p.catchType === 'fly')) {
          starter = p.fielderId as string;
        } else if (e.type === 'fielder.throw' && p.throwerId) {
          const arr = throwsBy.get(p.throwerId as string) ?? [];
          arr.push(i);
          throwsBy.set(p.throwerId as string, arr);
        } else if (e.type === 'runner.out' && p.fielderId) {
          outs.push({ fid: p.fielderId as string, i });
        }
      });
      if (outs.length >= 2) {
        const involved = new Set<string>();
        const credit = (fid: string | undefined, role: 'dpStarted' | 'dpTurned' | 'dpFinished') => {
          if (!fid || !isOurs(fid)) return;
          row(fid)[role]++;
          involved.add(fid);
        };
        credit(starter, 'dpStarted');
        credit(outs[outs.length - 1].fid, 'dpFinished');
        // Pivot: recorded an out, then threw onward (a throw after that out).
        for (const o of outs) {
          if ((throwsBy.get(o.fid) ?? []).some((ti) => ti > o.i)) credit(o.fid, 'dpTurned');
        }
        for (const fid of involved) row(fid).dpInvolved++;
      }
    }
  }

  flushFielding(); // resolve the final at-bat's fielding engagements

  // Stash the team-level opponent spray on our pitcher's row (single carrier,
  // no duplication). Ensure the row exists even if the pitcher did nothing else.
  if (oppSpray.length && ourPitcherId) row(ourPitcherId).oppSpray = oppSpray;

  return {
    ourSide,
    matched,
    completedAt: raw?.completedAt ?? raw?.game?.completedAt ?? null,
    players: [...rows.values()],
  };
}

// Raw per-chance fielding observations for our team — one record per engaged
// batted ball (the SAME population expectedOuts/PAE are computed over): the
// distance the fielder covered and whether it became an out. Used by the
// offline POS_CURVE fitter (scripts/fit-curves.ts) so the calibration matches
// exactly what PAE measures at runtime. Mirrors extractPlayerMetrics's
// engageBuf/outCredit logic; intentionally excludes batting/steal accounting.
export interface FieldingChance {
  position: number | null;
  distance: number;
  isOut: boolean;
}

export function collectFieldingChances(raw: any, ourTeamId?: string): FieldingChance[] {
  const game = raw?.game ?? {};
  const home = game.home ?? {};
  const away = game.away ?? {};
  const playerById = new Map<string, { side: 'home' | 'away'; position: number | null; coord?: { x: number; y: number } }>();
  for (const side of ['home', 'away'] as const) {
    const t = side === 'home' ? home : away;
    for (const p of t.players ?? []) {
      playerById.set(p.id, { side, position: typeof p.position === 'number' ? p.position : null, coord: p.coordinates });
    }
  }
  const ourSide: 'home' | 'away' = away.id === ourTeamId ? 'away' : 'home';
  const isOurs = (id?: string) => !!id && playerById.get(id)?.side === ourSide;

  const out: FieldingChance[] = [];
  let curAB: number | undefined;
  let throwBuf: { throwerId: string; targetOut: string | null; base: number }[] = [];
  const engageBuf = new Map<string, { dist: number; pos: number | null }>();
  const outCredit = new Set<string>();

  const flush = () => {
    for (const [fid, e] of engageBuf) out.push({ position: e.pos, distance: e.dist, isOut: outCredit.has(fid) });
    engageBuf.clear();
    outCredit.clear();
  };

  for (const seg of raw?.segments ?? []) {
    const md = seg.metadata ?? {};
    const abId: number | undefined = md.atBatId ?? undefined;
    if (abId != null && abId !== curAB) { flush(); curAB = abId; throwBuf = []; }

    let segIsFoul = false, segHasOut = false;
    for (const ev of seg.events ?? []) {
      if (ev.type === 'batter.foul') segIsFoul = true;
      else if (ev.type === 'pitch.result' && ev.payload?.outcome === 'foul') segIsFoul = true;
      else if (ev.type === 'runner.out') segHasOut = true;
    }
    const skipFoulFetch = segIsFoul && !segHasOut;

    for (const ev of seg.events ?? []) {
      const pl = ev.payload ?? {};
      if ((ev.type === 'fielder.catch' && !skipFoulFetch && isOurs(pl.fielderId) && (pl.catchType === 'ground' || pl.catchType === 'fly'))
        || (ev.type === 'fielder.miss' && !skipFoulFetch && isOurs(pl.fielderId))) {
        const info = playerById.get(pl.fielderId);
        // Match extractPlayerMetrics: outfield ground balls are retrievals, not
        // out chances — exclude so the fitted curve sees only real opportunities.
        const isOFGround = OUTFIELD.has(info?.position ?? 0) && (pl.catchType === 'ground' || pl.isGroundBall === true);
        const start = info?.coord;
        const cp = pl.catchPoint;
        if (!isOFGround && start && cp && typeof cp.x === 'number' && typeof cp.y === 'number') {
          engageBuf.set(pl.fielderId, { dist: Math.hypot(cp.x - start.x, cp.y - start.y), pos: info?.position ?? null });
        }
      } else if (ev.type === 'fielder.throw') {
        if (pl.targetBase !== MOUND_BASE && pl.throwerId) throwBuf.push({ throwerId: pl.throwerId, targetOut: pl.targetOut ?? null, base: pl.targetBase });
      } else if (ev.type === 'runner.out' && isOurs(pl.fielderId)) {
        outCredit.add(pl.fielderId);
        if (typeof pl.assistedBy === 'string') {
          // 2026-07-08 patch: direct assist attribution.
          if (isOurs(pl.assistedBy)) outCredit.add(pl.assistedBy);
        } else {
          const credited = new Set<string>();
          for (const th of throwBuf) {
            if (th.targetOut && th.targetOut === pl.runnerId && th.throwerId !== pl.fielderId && isOurs(th.throwerId) && !credited.has(th.throwerId)) {
              outCredit.add(th.throwerId);
              credited.add(th.throwerId);
            }
          }
        }
      }
    }
  }
  flush();
  return out;
}

function lastGameState(raw: any): any {
  const segs = raw?.segments ?? [];
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i]?.gameState) return segs[i].gameState;
  }
  return undefined;
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

function buildNotes(
  us: TeamEval,
  them: TeamEval,
  pitcher: PitcherEval | null,
  threshold: number | null,
): string[] {
  const notes: string[] = [];
  const won = us.runs > them.runs;
  notes.push(`${won ? 'Won' : us.runs === them.runs ? 'Tied' : 'Lost'} ${us.runs}–${them.runs} with ${us.hits} hits to ${them.hits}.`);

  if (us.hardHitOuts >= 2 && threshold != null) {
    notes.push(`${us.hardHitOuts} hard-hit balls (EV ≥ ${threshold}) were caught for outs — some bad batted-ball luck.`);
  }

  // Best batted ball
  let best: { name: string; ev: number; result: string } | null = null;
  for (const b of us.batters) {
    if (b.maxExitVelo != null && (!best || b.maxExitVelo > best.ev)) {
      const result = Object.entries(b.results).sort((a, c) => c[1] - a[1])[0]?.[0] ?? '';
      best = { name: b.name, ev: b.maxExitVelo, result };
    }
  }
  if (best) notes.push(`Hardest contact: ${best.name} at ${best.ev} EV.`);

  if (us.swings > 0) {
    notes.push(`Plate discipline: ${pct(us.whiffs, us.swings)}% whiff on ${us.swings} swings, ${us.chases} chases out of zone.`);
  }

  if (pitcher && pitcher.swings > 0) {
    const best = [...pitcher.byType].filter((t) => t.swings >= 3).sort((a, b) => (b.whiffs / b.swings) - (a.whiffs / a.swings))[0];
    notes.push(
      `Our pitcher: ${pct(pitcher.whiffs, pitcher.swings)}% whiff, ${pitcher.mistakes} mistake pitch${pitcher.mistakes === 1 ? '' : 'es'}` +
      (best ? `; best whiff pitch was ${best.label} (${pct(best.whiffs, best.swings)}%).` : '.'),
    );
  }

  return notes;
}
