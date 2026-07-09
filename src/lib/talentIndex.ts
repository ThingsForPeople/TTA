// Typed accessors over the official Talent Index (src/lib/talentIndex.json,
// scraped from https://www.tiny-teams.com/talents by scripts/sync-talent-index.ts).
// This is the ONLY source of talent effect MAGNITUDES — per-tier "+N%" numbers
// the game shows in-app but exposes nowhere else — plus trigger tags and
// synergy (battery-partner) bonuses. Ids are the game's internal talent ids,
// the same ones replays emit in `effect.activated.talentId` and talents.ts uses.
// Talents tier 1–4 (there is no tier 5). Zone (hz:*) and pitch-arsenal talents
// are NOT in the index — they're generated variants; see talents.ts for those.
import rawIndex from './talentIndex.json';

export interface TalentProse {
  // Compact all-tiers form, e.g. "+6/8/10/12% Power per charge\n…"
  range: string;
  // Fully expanded per-tier text, keys "1"–"4".
  perTier: Record<string, string>;
  source?: string;
  partnerCondition?: string | null;
}

export interface TalentSynergy {
  partnerCondition: string; // e.g. "when your catcher also has Law & Order"
  partnerRoles: string[];
  partnerTalent: string; // internal id of the partner's required talent
  bonus: { range: string; perTier: Record<string, string> };
}

export interface TalentIndexEntry {
  id: string; // internal engine id (== replay effect.activated.talentId)
  displayName: string;
  description: string;
  category: 'hitting' | 'pitching' | 'fielding' | 'baserunning' | 'gauntlet';
  tags: string[];
  prose: TalentProse;
  synergy: TalentSynergy | null;
  zone: unknown | null;
}

export const TALENT_INDEX = rawIndex as TalentIndexEntry[];

export const talentIndexById = new Map(TALENT_INDEX.map((t) => [t.id, t]));
export const talentIndexByName = new Map(TALENT_INDEX.map((t) => [t.displayName, t]));

/** Official magnitude prose for a talent (by internal id or display name), or null. */
export function talentMagnitude(idOrName: string): string | null {
  const t = talentIndexById.get(idOrName) ?? talentIndexByName.get(idOrName);
  return t?.prose?.range ?? null;
}

/** Magnitude prose at a specific tier (1–4), falling back to the range form. */
export function talentMagnitudeAtTier(idOrName: string, tier: number): string | null {
  const t = talentIndexById.get(idOrName) ?? talentIndexByName.get(idOrName);
  if (!t) return null;
  return t.prose.perTier?.[String(tier)] ?? t.prose.range ?? null;
}
