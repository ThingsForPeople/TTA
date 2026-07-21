import { emptyMeta, type PitchTalent, type PlayerMetaStore } from './playerMeta';

// Shared talent-detection helpers used by both the standalone "Detect talents
// from replay" button and the "Sync attributes" flow (which folds talents in as
// a best-effort background step). Kept in one place so the two paths can't drift.

export interface DetectedTalents {
  name: string;
  talents: string[];
  talentLevels: Record<string, number>;
  pitchTalents: PitchTalent[];
}

// Order-insensitive signature of a player's talent bundle, so a merge only
// rewrites players whose talents actually changed (avoids churn / API writes).
export function talentSig(
  talents: string[],
  levels: Record<string, number> | undefined,
  pitch: PitchTalent[] | undefined,
): string {
  const lv = Object.entries(levels ?? {}).filter(([, v]) => v > 1).sort();
  const pt = (pitch ?? [])
    .map((p) => [p.pitch, p.level, [...p.sub].map((s) => [s.name, s.level]).sort()])
    .sort();
  return JSON.stringify([[...talents].sort(), lv, pt]);
}

// Pull talents + pitch talents from the team's latest game replay.
export async function fetchReplayTalents(teamUuid: string): Promise<Record<string, DetectedTalents>> {
  const res = await fetch(`/api/team/${teamUuid}/talents`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return (json.players ?? {}) as Record<string, DetectedTalents>;
}

// Merge detected talents into a store, preserving every other field (sim stats,
// injuries, etc.). Returns a new store and how many players actually changed.
export function mergeTalentsIntoStore(
  store: PlayerMetaStore,
  detected: Record<string, DetectedTalents>,
): { next: PlayerMetaStore; changed: number; found: number } {
  const next: PlayerMetaStore = { ...store };
  let changed = 0;
  for (const [uuid, d] of Object.entries(detected)) {
    const cur = next[uuid] ?? emptyMeta();
    if (talentSig(cur.talents, cur.talentLevels, cur.pitchTalents) ===
        talentSig(d.talents, d.talentLevels, d.pitchTalents)) {
      continue; // already matches the replay — leave the object reference
    }
    next[uuid] = { ...cur, talents: d.talents, talentLevels: d.talentLevels, pitchTalents: d.pitchTalents };
    changed++;
  }
  return { next, changed, found: Object.keys(detected).length };
}
