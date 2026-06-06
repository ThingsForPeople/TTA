export interface SimStats {
  con: number;
  pow: number;
  spd: number;
  fld: number;
  arm: number;
  pit: number;
  sta: number;
}

export type InjurySeverity = 'minor' | 'major' | 'catastrophic';

export interface Injury {
  severity: InjurySeverity;
  date: number;
  note?: string;
}

export interface InjuryRecord {
  severity: InjurySeverity;
  date: number;
  resolvedDate?: number;
  note?: string;
}

export interface PitchTalentSub {
  name: string;
  level: number;
}

export interface PitchTalent {
  pitch: string;
  level: number;
  sub: PitchTalentSub[];
}

export type Hand = 'R' | 'L';

export interface PlayerMeta {
  sim: SimStats;
  talents: string[];
  talentLevels?: Record<string, number>;
  pitchTalents?: PitchTalent[];
  injury?: Injury;
  injuryHistory?: InjuryRecord[];
  bats?: Hand;
  throws?: Hand;
  // Manual archetype override (the scraped roster may not include it). Used to
  // unlock pitch-talent editing for pitcher archetypes — see isPitcherArchetype.
  archetype?: string;
  // Manual age entry — NOT in the scraped roster feed. Powers retirement/
  // succession reasoning (players start ~18, retire ~30) in the AI advisors.
  age?: number;
}

// The 11 player archetypes (see the system prompt's Archetypes section).
export const ARCHETYPES = [
  'Slugger', 'Brute', 'Spark', 'Scout', 'Flash', 'Hawk',
  'Gunner', 'Weaver', 'Ace', 'Two Way', 'Wildcard',
] as const;

// Archetypes that pitch: they can carry pitch talents even when not listed at
// P (e.g. a Two Way playing a field position, or a bench arm).
export const PITCHER_ARCHETYPES = new Set<string>(['Ace', 'Gunner', 'Weaver', 'Two Way']);

// The scraped roster reports archetype lowercase (e.g. "scout", "two way"),
// while our canonical list is title-case. Normalize case/spacing to the
// canonical ARCHETYPES entry so scraped values match the dropdown and the
// pitcher-archetype gating. Returns undefined for unknown/empty input.
export function normalizeArchetype(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const key = raw.replace(/[^a-z]/gi, '').toLowerCase();
  return ARCHETYPES.find((a) => a.replace(/[^a-z]/gi, '').toLowerCase() === key);
}

export function isPitcherArchetype(archetype?: string | null): boolean {
  const canon = normalizeArchetype(archetype);
  return !!canon && PITCHER_ARCHETYPES.has(canon);
}

export type PlayerMetaStore = Record<string /* player uuid */, PlayerMeta>;

const STORAGE_KEY_PREFIX = 'tta:playerMeta';

function storageKey(userId?: string): string {
  return userId ? `${STORAGE_KEY_PREFIX}:${userId}` : STORAGE_KEY_PREFIX;
}

const ZERO_SIM: SimStats = { con: 0, pow: 0, spd: 0, fld: 0, arm: 0, pit: 0, sta: 0 };

export function emptyMeta(): PlayerMeta {
  return { sim: { ...ZERO_SIM }, talents: [], talentLevels: {}, pitchTalents: [] };
}

// Talents level up to this cap (the game offers upgrades past Lv3 — confirmed
// a 4th tier in-game; treated as 5 max). Single source of truth for the level
// pickers and the effect-scaling clamps.
export const MAX_TALENT_LEVEL = 5;

export function getTalentLevel(meta: PlayerMeta, talentName: string): number {
  return meta.talentLevels?.[talentName] ?? 1;
}

export function setInjury(meta: PlayerMeta, severity: InjurySeverity, note?: string): PlayerMeta {
  const record: InjuryRecord = { severity, date: Date.now(), note };
  return {
    ...meta,
    injury: { severity, date: Date.now(), note },
    injuryHistory: [...(meta.injuryHistory ?? []), record],
  };
}

export function clearInjury(meta: PlayerMeta): PlayerMeta {
  const history = [...(meta.injuryHistory ?? [])];
  for (let i = history.length - 1; i >= 0; i--) {
    if (!history[i].resolvedDate) {
      history[i] = { ...history[i], resolvedDate: Date.now() };
      break;
    }
  }
  return { ...meta, injury: undefined, injuryHistory: history };
}

export function isInjured(meta: PlayerMeta | undefined): boolean {
  return !!meta?.injury;
}

const INJURY_PENALTIES: Record<InjurySeverity, number> = {
  minor: 0.90,
  major: 0.70,
  catastrophic: 0.50,
};

export function injuryPenalty(severity: InjurySeverity): number {
  return INJURY_PENALTIES[severity];
}

export function effectiveStats(meta: PlayerMeta): SimStats {
  if (!meta.injury) return meta.sim;
  const mult = injuryPenalty(meta.injury.severity);
  return {
    con: Math.round(meta.sim.con * mult),
    pow: Math.round(meta.sim.pow * mult),
    spd: Math.round(meta.sim.spd * mult),
    fld: Math.round(meta.sim.fld * mult),
    arm: Math.round(meta.sim.arm * mult),
    pit: Math.round(meta.sim.pit * mult),
    sta: Math.round(meta.sim.sta * mult),
  };
}

export function loadStore(userId?: string): PlayerMetaStore {
  try {
    const key = storageKey(userId);
    const raw = localStorage.getItem(key);
    if (!raw && userId) {
      const legacy = localStorage.getItem(STORAGE_KEY_PREFIX);
      if (legacy) return JSON.parse(legacy) as PlayerMetaStore;
    }
    if (!raw) return {};
    return JSON.parse(raw) as PlayerMetaStore;
  } catch {
    return {};
  }
}

export function saveStore(store: PlayerMetaStore, userId?: string): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(store));
  } catch {
    // ignore quota / private mode
  }
}

export function clearStore(userId?: string): void {
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // ignore
  }
}

export const SIM_KEYS: (keyof SimStats)[] = ['con', 'pow', 'spd', 'fld', 'arm', 'pit', 'sta'];

export const SIM_LABELS: Record<keyof SimStats, string> = {
  con: 'CON',
  pow: 'POW',
  spd: 'SPD',
  fld: 'FLD',
  arm: 'ARM',
  pit: 'PIT',
  sta: 'STA',
};

export function hasSim(meta: PlayerMeta | undefined): boolean {
  if (!meta) return false;
  return SIM_KEYS.some((k) => meta.sim[k] > 0);
}
