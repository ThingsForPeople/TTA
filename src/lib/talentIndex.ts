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
  // Which index page this came from; entries reconstructed from siblings after
  // RSC dedup are marked "(synthesized from sibling — RSC dedup)".
  sourcePage?: string;
}

export const TALENT_INDEX = rawIndex as TalentIndexEntry[];

export const talentIndexById = new Map(TALENT_INDEX.map((t) => [t.id, t]));
export const talentIndexByName = new Map(TALENT_INDEX.map((t) => [t.displayName, t]));

// talents.ts uses DIRECTION-GENERIC ids for pitching zone/aim talents
// ("zone:high:velocity", "base:high") while the index carries per-pitch
// variants ("zone:cutter:high:velocity") — magnitudes are verified IDENTICAL
// across pitch types per (direction, effect), so a generic id resolves to any
// per-pitch sibling with the pitch mention stripped from the text.
function resolveGeneric(id: string): { entry: TalentIndexEntry; stripPitch: boolean } | null {
  const direct = talentIndexById.get(id);
  if (direct) return { entry: direct, stripPitch: false };
  let m = /^zone:(high|low|inside|outside):([a-z]+)$/.exec(id);
  if (m) {
    const suffix = `:${m[1]}:${m[2]}`;
    const sib = TALENT_INDEX.find((t) => t.id.startsWith('zone:') && t.id.endsWith(suffix) && t.id.split(':').length === 4);
    if (sib) return { entry: sib, stripPitch: true };
  }
  m = /^base:(high|low|inside|outside)$/.exec(id);
  if (m) {
    const suffix = `:${m[1]}`;
    const sib = TALENT_INDEX.find((t) => t.id.startsWith('base:') && t.id.endsWith(suffix) && t.id.split(':').length === 3);
    if (sib) return { entry: sib, stripPitch: true };
  }
  return null;
}
const PITCH_MENTION = / on (Four-Seam Fastballs|Two-Seam Fastballs|Cutters|Sinkers|Changeups|Curveballs|Sliders|Splitters|Knuckleballs)/;
function stripPitchMention(text: string): string {
  return text.replace(PITCH_MENTION, '');
}

/** Official magnitude prose for a talent (by internal id or display name), or null. */
export function talentMagnitude(idOrName: string): string | null {
  const byName = talentIndexByName.get(idOrName);
  if (byName) return byName.prose?.range ?? null;
  const res = resolveGeneric(idOrName);
  if (!res) return null;
  const range = res.entry.prose?.range ?? null;
  return range && res.stripPitch ? stripPitchMention(range) : range;
}

/** Magnitude prose at a specific tier (1–4), falling back to the range form. */
export function talentMagnitudeAtTier(idOrName: string, tier: number): string | null {
  const byName = talentIndexByName.get(idOrName);
  const res = byName ? { entry: byName, stripPitch: false } : resolveGeneric(idOrName);
  if (!res) return null;
  const text = res.entry.prose.perTier?.[String(tier)] ?? res.entry.prose.range ?? null;
  return text && res.stripPitch ? stripPitchMention(text) : text;
}
